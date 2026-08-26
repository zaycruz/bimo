import {
  assertRepositoryFile,
  validateAttemptPlan,
  validateCheckerReceipt,
  validateConformanceReceipt,
  validatePodTemplate,
  validateWriterReceipt,
} from "./pod-contract.mjs";

const WRITER_SLOTS = ["engineering-a", "engineering-b", "qa-tests"];
const PROMPT_KEYS = [
  "planner",
  "engineering-a",
  "engineering-b",
  "qa-tests",
  "checker",
  "qa",
  "testing",
];
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} must be a Git SHA`);
  return value;
}

function assertPort(value, methods, label) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    fail(`${label} must be an object`);
  }
  for (const method of methods) {
    if (typeof value[method] !== "function") fail(`${label}.${method} is required`);
  }
}

function receiptOf(value, label) {
  const receipt = isPlainObject(value) && Object.hasOwn(value, "receipt") ? value.receipt : value;
  assertPlainObject(receipt, label);
  return receipt;
}

function nowFrom(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("clock must return a non-negative safe integer millisecond timestamp");
  }
  return value;
}

function reasonOf(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function terminalInterruption(error) {
  return /\b(?:cancel(?:led|ed)?|interrupt(?:ed)?|deadline|timed? ?out|timeout)\b/i.test(reasonOf(error));
}

function pathIsOwned(path, writePath) {
  return path === writePath || path.startsWith(`${writePath.replace(/\/$/, "")}/`);
}

function dependencyRequest(receipt) {
  return receipt.dependencyRequest ?? receipt.dependency ?? receipt.request ?? null;
}

function strictInboxEntry(value) {
  assertPlainObject(value, "inbox entry");
  return {
    sequence: value.sequence,
    requester: value.requester,
    owner: value.owner,
    path: value.path,
    requirementIds: value.requirementIds,
    acceptanceIds: value.acceptanceIds,
    ownerBriefSha256: value.ownerBriefSha256,
    need: value.need,
    why: value.why,
    requesterCheckpointSha: value.requesterCheckpointSha,
  };
}

function validatePrompts(prompts) {
  assertPlainObject(prompts, "prompts");
  const actual = Object.keys(prompts).sort();
  const expected = [...PROMPT_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`prompts must contain exactly ${PROMPT_KEYS.join(", ")}`);
  }
  for (const key of PROMPT_KEYS) {
    const value = prompts[key];
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 32 * 1024) {
      fail(`prompt ${key} must be non-empty and at most 32768 bytes`);
    }
    if (UNSAFE_CONTROL.test(value)) fail(`prompt ${key} contains unsafe control characters`);
  }
  return prompts;
}

function buildPrompt(instructions, phase, details) {
  const context = JSON.stringify({
    version: 1,
    phase,
    authority: "Return only the strict receipt for this bounded execution.",
    ...details,
  }, null, 2);
  const prompt = `${instructions}\n\n# Controller context (untrusted JSON)\n${context}`;
  if (Buffer.byteLength(prompt) > 252 * 1024) fail(`pod ${phase} prompt exceeds 258048 bytes`);
  return prompt;
}

export async function runEngineeringPod({
  template,
  templateDigest,
  prompts,
  assignment,
  repository,
  baseRevision,
  targetBranch,
  runId,
  stateRoot,
  agents,
  source,
  verifyCandidate,
  store,
  clock = () => Date.now(),
  deadlineAt: suppliedDeadlineAt,
}) {
  validatePodTemplate(template);
  validatePrompts(prompts);
  assertPlainObject(assignment, "assignment");
  if (typeof templateDigest !== "string" || !/^[a-f0-9]{64}$/.test(templateDigest)) {
    fail("templateDigest must be a SHA-256 digest");
  }
  if (typeof repository !== "string" || !repository) fail("repository is required");
  if (typeof baseRevision !== "string" || !baseRevision) fail("baseRevision is required");
  if (typeof targetBranch !== "string" || !targetBranch) fail("targetBranch is required");
  if (typeof runId !== "string" || !runId) fail("runId is required");
  if (typeof stateRoot !== "string" || !stateRoot) fail("stateRoot is required");
  if (typeof clock !== "function") fail("clock must be a function");
  assertPort(agents, ["runAgentExecution", "cancel"], "agents");
  assertPort(source, [
    "prepareAssignment",
    "createReadView",
    "createWorktree",
    "createSnapshot",
    "validateAndCommit",
    "integrate",
    "scan",
    "close",
  ], "source");
  assertPort(store, [
    "appendEvent",
    "writeAttemptPlan",
    "writeWorkResult",
    "writeGateReceipt",
    "enqueueInbox",
    "readInbox",
    "finish",
  ], "store");
  if (typeof verifyCandidate !== "function") fail("verifyCandidate is required");

  const startedAt = nowFrom(clock);
  const workflowLimit = startedAt + (template.timeouts.workflowSeconds * 1_000);
  if (!Number.isSafeInteger(workflowLimit)) fail("workflow deadline exceeds the safe integer range");
  let deadlineAt = workflowLimit;
  if (suppliedDeadlineAt !== undefined) {
    if (!Number.isSafeInteger(suppliedDeadlineAt) || suppliedDeadlineAt <= startedAt) {
      fail("deadlineAt must be a safe integer strictly in the future");
    }
    if (suppliedDeadlineAt > workflowLimit) fail("deadlineAt cannot extend the workflow budget");
    deadlineAt = suppliedDeadlineAt;
  }
  let readyCommitted = false;
  let cancellation;
  const activeExecutions = new Set();
  const priorAttempts = [];

  const remainingMs = (phaseDeadlineAt = deadlineAt) => {
    const remaining = Math.min(deadlineAt, phaseDeadlineAt) - nowFrom(clock);
    if (remaining <= 0) fail("pod workflow deadline exceeded");
    return remaining;
  };

  const executionSeconds = (phaseDeadlineAt = deadlineAt) => {
    const seconds = Math.floor(remainingMs(phaseDeadlineAt) / 1_000);
    if (seconds < 10) fail("pod workflow deadline exceeded");
    return Math.min(template.timeouts.executionSeconds, seconds);
  };

  const cancelActive = () => {
    cancellation ??= Promise.resolve().then(() => agents.cancel());
    return cancellation;
  };

  const runAgent = input => {
    const phaseDeadlineAt = input.deadlineAt ?? deadlineAt;
    const { deadlineAt: ignoredDeadline, ...agentInput } = input;
    void ignoredDeadline;
    remainingMs(phaseDeadlineAt);
    let tracked;
    const execution = Promise.resolve().then(() => agents.runAgentExecution({
      ...agentInput,
      attempt: agentInput.attempt,
      access: agentInput.access ?? "read",
      timeoutSeconds: executionSeconds(phaseDeadlineAt),
      runId,
    }));
    tracked = execution.finally(() => activeExecutions.delete(tracked));
    activeExecutions.add(tracked);
    return tracked;
  };

  const recordWorkResult = async (attemptState, result) => {
    const { diff, ...durable } = result;
    void diff;
    attemptState.workResults.push(structuredClone(durable));
    await store.writeWorkResult(attemptState.attempt, durable);
  };

  const recordGate = async (attemptState, receipt) => {
    attemptState.gates.push(structuredClone(receipt));
    await store.writeGateReceipt(attemptState.attempt, receipt);
  };

  const commitWriterResult = async ({ attemptState, workItem, workspace, receipt }) => {
    remainingMs(attemptState.deadlineAt);
    const committed = await source.validateAndCommit({
      workspace,
      workItem,
      deadlineAt: attemptState.deadlineAt,
      limits: template.changes,
    });
    assertPlainObject(committed, `commit result ${workItem.id}`);
    const committedBaseSha = assertSha(committed.baseSha, "writer baseSha");
    if (committedBaseSha !== receipt.baseSha) fail("writer receipt base does not match the committed delta");
    if (!Array.isArray(committed.changedPaths)
        || committed.changedPaths.length < 1
        || committed.changedPaths.length > template.changes.maxFiles) {
      fail("commit changedPaths are outside the fixed writer scope");
    }
    const seenPaths = new Set();
    for (let index = 0; index < committed.changedPaths.length; index += 1) {
      const repositoryPath = committed.changedPaths[index];
      assertRepositoryFile(repositoryPath, `commit changedPaths[${index}]`);
      const folded = repositoryPath.toLowerCase();
      if (seenPaths.has(folded)) fail(`commit changedPaths contains duplicate path: ${repositoryPath}`);
      seenPaths.add(folded);
      if (!workItem.writePaths.some(writePath => pathIsOwned(repositoryPath, writePath))) {
        fail("commit changedPaths are outside the fixed writer scope");
      }
    }
    if (!Number.isInteger(committed.changedBytes)
        || committed.changedBytes < 0
        || committed.changedBytes > template.changes.maxBytes) {
      fail("commit changedBytes are outside the fixed limit");
    }
    if (typeof committed.diffSha256 !== "string" || !/^[a-f0-9]{64}$/.test(committed.diffSha256)) {
      fail("commit diffSha256 must be a SHA-256 digest");
    }
    const result = {
      ...receipt,
      workItemId: workItem.id,
      ownerSlot: workItem.ownerSlot,
      baseSha: committedBaseSha,
      resultSha: assertSha(committed.resultSha, "writer resultSha"),
      files: [...committed.changedPaths],
      changedBytes: committed.changedBytes,
      diffSha256: committed.diffSha256,
      diff: committed.diff,
    };
    await recordWorkResult(attemptState, result);
    return result;
  };

  const checkWriterResult = async ({
    attemptState,
    workItem,
    result,
    deliveredInbox = [],
    previousInboxCursor = 0,
  }) => {
    const view = await source.createReadView({
      id: `c-${attemptState.attempt}-${workItem.ownerSlot}-${result.resultSha}`,
      sha: result.resultSha,
      deadlineAt: attemptState.deadlineAt,
    });
    assertPlainObject(view, "checker read view");
    if (typeof view.id !== "string" || !view.id) fail("checker read view ID is required");
    const raw = await runAgent({
      executionId: `attempt-${attemptState.attempt}-checker-${workItem.ownerSlot}`,
      role: "checker",
      attempt: attemptState.attempt,
      access: "read",
      prompt: buildPrompt(prompts.checker, "checker", {
        assignment,
        requirementIds: workItem.requirementIds,
        workItem,
        baseSha: result.baseSha,
        resultSha: result.resultSha,
        diffSha256: result.diffSha256,
        diff: result.diff,
        deliveredInbox,
      }),
      workspaceId: view.id,
      writeDirectories: [],
      deadlineAt: attemptState.deadlineAt,
    });
    const receipt = validateCheckerReceipt(
      {
        ...receiptOf(raw, `checker receipt ${workItem.id}`),
        files: [],
      },
      {
        plan: attemptState.plan,
        writerId: workItem.ownerSlot,
        workItem,
        baseSha: result.baseSha,
        resultSha: result.resultSha,
        diffSha256: result.diffSha256,
        deliveredInbox,
        previousInboxCursor,
      },
    );
    await recordGate(attemptState, {
      gate: "checker",
      workItemId: workItem.id,
      subjectSha: result.resultSha,
      ...receipt,
    });
    if (receipt.outcome !== "passed") fail(`checker rejected ${workItem.id}: ${receipt.why}`);
    return receipt;
  };

  const executeWriter = ({ attemptState, workItem, workspace, inbox, execution, executionBaseSha }) => runAgent({
    executionId: execution,
    role: workItem.ownerSlot,
    attempt: attemptState.attempt,
    access: "write",
    prompt: buildPrompt(prompts[workItem.ownerSlot], "writer", {
      assignment,
      plan: attemptState.plan,
      workItem,
      inbox,
      executionBaseSha,
    }),
    workspaceId: workspace.id,
    writeDirectories: workspace.writeDirectories,
    deadlineAt: attemptState.deadlineAt,
  });

  const validateWriter = (raw, {
    attemptState,
    workItem,
    executionBaseSha,
    deliveredInbox = [],
    previousInboxCursor = 0,
  }) => validateWriterReceipt(
    receiptOf(raw, `writer receipt ${workItem.id}`),
    {
      template,
      plan: attemptState.plan,
      writerId: workItem.ownerSlot,
      executionBaseSha,
      deliveredInbox,
      previousInboxCursor,
      workItem,
      lastInboxSequence: deliveredInbox.at(-1)?.sequence ?? previousInboxCursor,
    },
  );

  const runAttempt = async attemptState => {
    const workItemsBySlot = new Map(WRITER_SLOTS.map(slot => [slot, {
      id: slot,
      ownerSlot: slot,
      ...attemptState.plan.writers[slot],
    }]));
    const workspaces = new Map();
    for (const slot of WRITER_SLOTS) {
      const workItem = workItemsBySlot.get(slot);
      const workspace = await source.createWorktree({
        attempt: attemptState.attempt,
        workItem,
        baseSha: attemptState.baseSha,
        deadlineAt: attemptState.deadlineAt,
      });
      assertPlainObject(workspace, `workspace ${slot}`);
      if (typeof workspace.id !== "string" || !workspace.id) fail(`workspace ${slot} ID is required`);
      if (typeof workspace.root !== "string" || !workspace.root) fail(`workspace ${slot} root is required`);
      if (!Array.isArray(workspace.writeDirectories)) fail(`workspace ${slot} writeDirectories are required`);
      workspaces.set(slot, workspace);
    }

    await store.appendEvent("writers.started", { attempt: attemptState.attempt, slots: WRITER_SLOTS });
    const activeSlots = new Set(WRITER_SLOTS);
    const pending = new Map();
    const initial = new Map();
    let firstError;

    for (const slot of WRITER_SLOTS) {
      const workItem = workItemsBySlot.get(slot);
      const execution = executeWriter({
        attemptState,
        workItem,
        workspace: workspaces.get(slot),
        inbox: [],
        execution: `attempt-${attemptState.attempt}-${slot}`,
        executionBaseSha: attemptState.baseSha,
      }).then(
        value => ({ slot, value }),
        error => ({ slot, error }),
      ).finally(() => activeSlots.delete(slot));
      pending.set(slot, execution);
    }

    while (pending.size) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.slot);
      if (settled.error) {
        firstError ??= settled.error;
        if (terminalInterruption(settled.error)) {
          await cancelActive().catch(() => {});
        }
        continue;
      }
      if (firstError) continue;
      try {
        const workItem = workItemsBySlot.get(settled.slot);
        const receipt = validateWriter(settled.value, {
          attemptState,
          workItem,
          executionBaseSha: attemptState.baseSha,
        });
        initial.set(settled.slot, receipt);

        if (receipt.outcome === "failed") {
          firstError = new Error(`writer ${workItem.id} failed: ${receipt.why}`);
          continue;
        }
        if (receipt.outcome !== "blocked") continue;

        const request = dependencyRequest(receipt);
        const owner = workItemsBySlot.get("engineering-b");
        const requestRequirements = request?.requirementIds;
        const withinOwnerRequirements = Array.isArray(requestRequirements)
          && requestRequirements.length > 0
          && requestRequirements.every(id => owner.requirementIds.includes(id));
        const withinOwnerPaths = typeof request?.path === "string"
          && owner.writePaths.some(writePath => pathIsOwned(request.path, writePath));
        if (settled.slot !== "engineering-a"
            || request?.owner !== "engineering-b"
            || !activeSlots.has("engineering-b")
            || !withinOwnerRequirements
            || !withinOwnerPaths) {
          firstError = new Error("dependency request requires a replacement attempt");
          continue;
        }

        const checkpoint = await commitWriterResult({
          attemptState,
          workItem,
          workspace: workspaces.get(settled.slot),
          receipt,
        });
        await checkWriterResult({ attemptState, workItem, result: checkpoint });
        if (!activeSlots.has("engineering-b")) {
          firstError = new Error("dependency owner completed before the request could be queued");
          continue;
        }
        const entry = await store.enqueueInbox(attemptState.attempt, "engineering-b", {
          requester: workItem.ownerSlot,
          owner: request.owner,
          path: request.path,
          requirementIds: [...requestRequirements],
          acceptanceIds: [...request.acceptanceIds],
          ownerBriefSha256: request.ownerBriefSha256,
          need: request.need,
          why: request.why,
          requesterCheckpointSha: checkpoint.resultSha,
        });
        attemptState.inboxRequest = { request, entry: strictInboxEntry(entry), checkpoint };
        await store.appendEvent("inbox.queued", {
          attempt: attemptState.attempt,
          requestingWorkItemId: workItem.id,
          ownerSlot: "engineering-b",
        });
      } catch (error) {
        firstError ??= error;
        if (terminalInterruption(error)) {
          await cancelActive().catch(() => {});
        }
      }
    }

    await Promise.allSettled(pending.values());
    if (firstError) throw firstError;
    for (const slot of WRITER_SLOTS) {
      if (!initial.has(slot)) fail(`writer ${slot} did not return a receipt`);
    }

    const accepted = new Map();
    const completed = new Map();
    for (const slot of WRITER_SLOTS) {
      const receipt = initial.get(slot);
      if (receipt.outcome === "blocked") continue;
      const workItem = workItemsBySlot.get(slot);
      const result = await commitWriterResult({
        attemptState,
        workItem,
        workspace: workspaces.get(slot),
        receipt,
      });
      completed.set(slot, result);
    }
    let checkerFailure;
    for (const slot of WRITER_SLOTS) {
      const result = completed.get(slot);
      if (!result) continue;
      const workItem = workItemsBySlot.get(slot);
      try {
        await checkWriterResult({ attemptState, workItem, result });
        accepted.set(slot, result);
      } catch (error) {
        checkerFailure ??= error;
      }
    }
    if (checkerFailure) throw checkerFailure;

    if (attemptState.inboxRequest) {
      const ownerSlot = "engineering-b";
      const ownerItem = workItemsBySlot.get(ownerSlot);
      const priorOwner = accepted.get(ownerSlot);
      const inbox = (await store.readInbox(attemptState.attempt, ownerSlot, {
        afterSequence: initial.get(ownerSlot).inboxCursor,
      })).map(strictInboxEntry);
      if (!Array.isArray(inbox) || !inbox.length) fail("dependency owner did not receive its queued request");
      const ownerRaw = await executeWriter({
        attemptState,
        workItem: ownerItem,
        workspace: workspaces.get(ownerSlot),
        inbox,
        execution: `attempt-${attemptState.attempt}-${ownerSlot}-inbox`,
        executionBaseSha: priorOwner.resultSha,
      });
      const highestSequence = Math.max(...inbox.map(entry => entry.sequence));
      const ownerReceipt = validateWriter(ownerRaw, {
        attemptState,
        workItem: ownerItem,
        executionBaseSha: priorOwner.resultSha,
        deliveredInbox: inbox,
        previousInboxCursor: initial.get(ownerSlot).inboxCursor,
      });
      if (ownerReceipt.outcome !== "completed") fail("dependency owner did not complete its inbox request");
      const ownerResult = await commitWriterResult({
        attemptState,
        workItem: ownerItem,
        workspace: workspaces.get(ownerSlot),
        receipt: ownerReceipt,
      });
      await checkWriterResult({
        attemptState,
        workItem: ownerItem,
        result: ownerResult,
        deliveredInbox: inbox,
        previousInboxCursor: initial.get(ownerSlot).inboxCursor,
      });
      accepted.set(ownerSlot, ownerResult);

      if (typeof source.combineBase !== "function") fail("source.combineBase is required for dependency resumption");
      const requesterSlot = "engineering-a";
      const requesterItem = workItemsBySlot.get(requesterSlot);
      const combined = await source.combineBase({
        attempt: attemptState.attempt,
        requesterCheckpointSha: attemptState.inboxRequest.checkpoint.resultSha,
        dependencyResultSha: ownerResult.resultSha,
        deadlineAt: attemptState.deadlineAt,
      });
      assertPlainObject(combined, "combined requester base");
      const requesterWorkspace = combined.workspace ?? combined;
      const requesterBaseSha = combined.baseSha ?? requesterWorkspace.baseSha;
      const requesterRaw = await executeWriter({
        attemptState,
        workItem: requesterItem,
        workspace: requesterWorkspace,
        inbox: [],
        execution: `attempt-${attemptState.attempt}-${requesterSlot}-resume`,
        executionBaseSha: requesterBaseSha,
      });
      const requesterReceipt = validateWriter(requesterRaw, {
        attemptState,
        workItem: requesterItem,
        executionBaseSha: requesterBaseSha,
      });
      if (requesterReceipt.outcome !== "completed") fail("dependency requester did not complete after resumption");
      const requesterResult = await commitWriterResult({
        attemptState,
        workItem: requesterItem,
        workspace: { ...requesterWorkspace, baseSha: requesterBaseSha },
        receipt: requesterReceipt,
      });
      await checkWriterResult({ attemptState, workItem: requesterItem, result: requesterResult });
      accepted.set(requesterSlot, requesterResult);
      void priorOwner;
    }

    if (WRITER_SLOTS.some(slot => !accepted.has(slot))) fail("attempt did not produce three accepted writer results");
    const commits = WRITER_SLOTS.map(slot => accepted.get(slot));

    remainingMs(attemptState.deadlineAt);
    const branch = `bimo/${runId}`;
    const integrated = await source.integrate({
      attempt: attemptState.attempt,
      baseSha: attemptState.baseSha,
      commits,
      integrationOrder: WRITER_SLOTS,
      branch,
      deadlineAt: attemptState.deadlineAt,
    });
    assertPlainObject(integrated, "integration result");
    const candidateSha = assertSha(integrated.candidateSha, "candidateSha");
    const candidateView = integrated.workspaceRoot && integrated.workspaceId
      ? { id: integrated.workspaceId, root: integrated.workspaceRoot }
      : await source.createReadView({
        id: `attempt-${attemptState.attempt}-candidate`,
        sha: candidateSha,
        deadlineAt: attemptState.deadlineAt,
      });
    if (typeof candidateView.id !== "string" || !candidateView.id
        || typeof candidateView.root !== "string" || !candidateView.root) {
      fail("candidate read view is invalid");
    }
    const candidateSnapshot = await source.createSnapshot({
      id: `attempt-${attemptState.attempt}-candidate`,
      sha: candidateSha,
      deadlineAt: attemptState.deadlineAt,
    });
    assertPlainObject(candidateSnapshot, "candidate snapshot");

    const qaRaw = await runAgent({
      executionId: `attempt-${attemptState.attempt}-qa-conformance`,
      role: "qa",
      attempt: attemptState.attempt,
      access: "read",
      prompt: buildPrompt(prompts.qa, "qa-conformance", {
        assignment,
        plan: attemptState.plan,
        candidateSha,
      }),
      workspaceId: candidateView.id,
      writeDirectories: [],
      deadlineAt: attemptState.deadlineAt,
    });
    const qaReceipt = validateConformanceReceipt(
      {
        ...receiptOf(qaRaw, "QA conformance receipt"),
        files: [],
      },
      { plan: attemptState.plan, gate: "qa", candidateSha },
    );
    await recordGate(attemptState, {
      gate: "qa-conformance",
      subjectSha: candidateSha,
      ...qaReceipt,
    });
    if (qaReceipt.outcome !== "passed") fail(`QA conformance failed: ${qaReceipt.why}`);

    const testingRaw = await runAgent({
      executionId: `attempt-${attemptState.attempt}-testing`,
      role: "testing",
      attempt: attemptState.attempt,
      access: "read",
      prompt: buildPrompt(prompts.testing, "testing", {
        assignment,
        plan: attemptState.plan,
        candidateSha,
      }),
      workspaceId: candidateView.id,
      writeDirectories: [],
      deadlineAt: attemptState.deadlineAt,
    });
    const testingReceipt = validateConformanceReceipt(
      {
        ...receiptOf(testingRaw, "Testing receipt"),
        files: [],
      },
      { plan: attemptState.plan, gate: "testing", candidateSha },
    );
    await recordGate(attemptState, {
      subjectSha: candidateSha,
      ...testingReceipt,
    });
    if (testingReceipt.outcome !== "passed") fail(`Testing review failed: ${testingReceipt.why}`);

    const verification = await verifyCandidate({
      workspaceRoot: candidateView.root,
      candidateView: {
        id: candidateView.id,
        root: candidateView.root,
        sha: candidateSha,
      },
      candidateSnapshot,
      ...(attemptState.baseSnapshot ? { baseSnapshot: attemptState.baseSnapshot } : {}),
      expectedSha: candidateSha,
      profile: template.verificationProfile,
      timeoutSeconds: Math.min(900, Math.floor(remainingMs(attemptState.deadlineAt) / 1_000)),
    });
    assertPlainObject(verification, "trusted verification receipt");
    if (verification.status !== "passed" || verification.candidateSha !== candidateSha) {
      fail("trusted verification did not pass the exact candidate SHA");
    }
    await recordGate(attemptState, {
      gate: "trusted-verification",
      subjectSha: candidateSha,
      outcome: "passed",
      why: "Trusted verification passed the exact candidate SHA.",
      evidence: verification.evidence,
    });

    const scan = await source.scan({
      baseSha: attemptState.baseSha,
      candidateSha,
      deadlineAt: attemptState.deadlineAt,
    });
    assertPlainObject(scan, "pre-publication scan receipt");
    if (scan.status !== "passed" || scan.candidateSha !== candidateSha) {
      fail("pre-publication scan did not pass the exact candidate SHA");
    }
    await recordGate(attemptState, {
      gate: "pre-publication-scan",
      subjectSha: candidateSha,
      outcome: "passed",
      why: "The source and commit scan passed.",
      evidence: scan.evidence,
    });
    await recordGate(attemptState, {
      gate: "publication-ready",
      subjectSha: candidateSha,
      outcome: "passed",
      why: "The exact tested candidate is ready for isolated publication.",
      evidence: [
        `candidate:${candidateSha}`,
        `branch:bimo/${runId}`,
      ],
    });
    return { candidateSha, branch, workspaceRoot: candidateView.root };
  };

  let baseSha;
  let baseSnapshot;
  let existingDirectories;
  try {
    await store.appendEvent("run.started", {
      template: template.name,
      templateDigest,
      runId,
      stateRoot,
    });
    const prepared = await source.prepareAssignment({
      repository,
      baseRevision,
      targetBranch,
      deadlineAt,
    });
    assertPlainObject(prepared, "prepared assignment");
    baseSha = assertSha(prepared.baseSha, "baseSha");
    if (!Array.isArray(prepared.existingDirectories)) {
      fail("prepared assignment existingDirectories are required");
    }
    existingDirectories = prepared.existingDirectories;
    baseSnapshot = await source.createSnapshot({
      id: "run-base",
      sha: baseSha,
      deadlineAt,
    });
    assertPlainObject(baseSnapshot, "base snapshot");

    for (let attempt = 1; attempt <= template.maxAttempts; attempt += 1) {
      const attemptDeadlineAt = Math.min(
        deadlineAt,
        nowFrom(clock) + (template.timeouts.attemptSeconds * 1_000),
      );
      const attemptState = {
        attempt,
        baseSha,
        baseSnapshot,
        deadlineAt: attemptDeadlineAt,
        plan: null,
        workResults: [],
        gates: [],
        inboxRequest: null,
      };
      try {
        remainingMs(attemptDeadlineAt);
        await store.appendEvent("plan.started", { attempt, baseSha });
        const plannerView = await source.createReadView({
          id: `attempt-${attempt}-planner`,
          sha: baseSha,
          deadlineAt: attemptDeadlineAt,
        });
        const plannerRaw = await runAgent({
          executionId: `attempt-${attempt}-planner`,
          role: "planner",
          attempt,
          access: "read",
          prompt: buildPrompt(prompts.planner, "planner", {
            assignment,
            attempt,
            baseSha,
            priorAttempts,
          }),
          workspaceId: plannerView.id,
          writeDirectories: [],
          deadlineAt: attemptDeadlineAt,
        });
        attemptState.plan = validateAttemptPlan(
          receiptOf(plannerRaw, "attempt plan"),
          { template, runBaseSha: baseSha, existingDirectories },
        );
        if (attemptState.plan.attempt !== attempt) {
          fail("attempt plan does not match the active attempt");
        }
        await store.writeAttemptPlan(attempt, attemptState.plan);
        await store.appendEvent("plan.finished", { attempt });

        const candidate = await runAttempt(attemptState);
        await store.appendEvent("publication.ready", {
          attempt,
          repository,
          targetBranch,
          baseSha,
          candidateSha: candidate.candidateSha,
          headBranch: candidate.branch,
        });
        readyCommitted = true;
        const result = {
          status: "ready",
          runId,
          baseSha,
          candidateSha: candidate.candidateSha,
          branch: candidate.branch,
        };
        return result;
      } catch (error) {
        if (readyCommitted) throw error;
        const evidence = {
          attempt,
          plan: attemptState.plan,
          workResults: attemptState.workResults,
          gates: attemptState.gates,
          reason: reasonOf(error),
        };
        priorAttempts.push(structuredClone(evidence));
        await store.appendEvent("attempt.failed", { attempt, reason: evidence.reason });
        if (terminalInterruption(error) || attempt === template.maxAttempts) throw error;
      }
    }
    fail("pod exhausted attempts");
  } catch (error) {
    if (!readyCommitted) {
      try {
        await cancelActive();
      } catch {
        // The original failure remains authoritative.
      }
      await Promise.allSettled([...activeExecutions]);
      await store.finish("failed", {
        runId,
        ...(baseSha ? { baseSha } : {}),
        reason: reasonOf(error),
      });
    }
    throw error;
  } finally {
    try {
      await source.close({ retainForPublication: readyCommitted });
    } catch (error) {
      if (!readyCommitted) throw error;
    }
  }
}
