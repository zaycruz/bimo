import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { runEngineeringPod } from "../src/pod-controller.mjs";

const SHA = {
  base: "a".repeat(40),
  engineeringA: "b".repeat(40),
  engineeringB: "c".repeat(40),
  qaTests: "d".repeat(40),
  candidate: "e".repeat(40),
  diffA: "1".repeat(64),
  diffB: "2".repeat(64),
  diffQa: "3".repeat(64),
};

const DIFF_BY_SLOT = {
  "engineering-a": SHA.diffA,
  "engineering-b": SHA.diffB,
  "qa-tests": SHA.diffQa,
};

const ROLE_PROMPTS = Object.freeze({
  planner: "BAKED PLANNER SENTINEL",
  "engineering-a": "BAKED ENGINEERING A SENTINEL",
  "engineering-b": "BAKED ENGINEERING B SENTINEL",
  "qa-tests": "BAKED QA WRITER SENTINEL",
  checker: "BAKED CHECKER SENTINEL",
  qa: "BAKED QA CONFORMANCE SENTINEL",
  testing: "BAKED TESTING SENTINEL",
});

function promptContext(prompt) {
  const marker = "\n\n# Controller context (untrusted JSON)\n";
  const index = prompt.indexOf(marker);
  assert(index >= 0, "controller prompt marker is required");
  return JSON.parse(prompt.slice(index + marker.length));
}

function bakedPrompt(prompt) {
  const marker = "\n\n# Controller context (untrusted JSON)\n";
  const index = prompt.indexOf(marker);
  assert(index >= 0, "controller prompt marker is required");
  return prompt.slice(0, index);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plan(attempt = 1) {
  return {
    version: 1,
    attempt,
    baseSha: SHA.base,
    requirements: [
      { id: "REQ-1", text: "Ship the product behavior." },
      { id: "REQ-2", text: "Prove the product behavior." },
    ],
    acceptanceCriteria: [
      { id: "AC-1", requirementIds: ["REQ-1"], text: "The behavior is observable." },
      { id: "AC-2", requirementIds: ["REQ-2"], text: "The tests exercise it." },
    ],
    writers: {
      "engineering-a": {
        requirementIds: ["REQ-1"],
        acceptanceIds: ["AC-1"],
        brief: "Implement part A.",
        writePaths: ["src"],
      },
      "engineering-b": {
        requirementIds: ["REQ-1"],
        acceptanceIds: ["AC-1"],
        brief: "Implement part B.",
        writePaths: ["starters"],
      },
      "qa-tests": {
        requirementIds: ["REQ-1", "REQ-2"],
        acceptanceIds: ["AC-1", "AC-2"],
        brief: "Write the tests.",
        writePaths: ["test"],
      },
    },
  };
}

function writerReceipt(writerId, attemptPlan = plan(), overrides = {}) {
  const writer = attemptPlan.writers[writerId];
  return {
    outcome: "completed",
    baseSha: SHA.base,
    what: `Completed ${writerId}.`,
    why: "The assignment requires it.",
    evidence: [`evidence:${writerId}`],
    requirementIds: [...writer.requirementIds],
    acceptanceIds: [...writer.acceptanceIds],
    inboxCursor: 0,
    dependencyRequest: null,
    ...overrides,
  };
}

function createStore() {
  const records = {
    events: [],
    plans: [],
    workResults: [],
    gates: [],
    finished: [],
  };
  return {
    runDir: "/state/pod-run-1",
    records,
    async appendEvent(type, details) {
      records.events.push({ type, ...details });
    },
    async writeAttemptPlan(attempt, value) {
      records.plans.push({ attempt, value: structuredClone(value) });
    },
    async writeWorkResult(attempt, value) {
      records.workResults.push({ attempt, value: structuredClone(value) });
    },
    async writeGateReceipt(attempt, value) {
      records.gates.push({ attempt, value: structuredClone(value) });
    },
    async enqueueInbox() {
      throw new Error("the happy path must not use the inbox");
    },
    async readInbox() {
      return [];
    },
    async finish(status, details) {
      records.finished.push({ status, details: structuredClone(details) });
    },
  };
}

function createSource(calls) {
  const resultBySlot = {
    "engineering-a": SHA.engineeringA,
    "engineering-b": SHA.engineeringB,
    "qa-tests": SHA.qaTests,
  };
  const readViewIds = new Set();
  return {
    async prepareAssignment(input) {
      calls.push({ type: "prepare", input });
      return {
        baseSha: SHA.base,
        baseSnapshot: { id: "base", sha: SHA.base },
        existingDirectories: ["src", "starters", "test"],
      };
    },
    async createReadView(input) {
      if (readViewIds.has(input.id)) throw new Error(`duplicate read view: ${input.id}`);
      readViewIds.add(input.id);
      calls.push({ type: "read-view", input });
      return { id: input.id, root: `/worktrees/pod-run-1/${input.id}` };
    },
    async createWorktree(input) {
      calls.push({ type: "worktree", input });
      return {
        id: `${input.attempt}-${input.workItem.ownerSlot}`,
        root: `/worktrees/pod-run-1/${input.attempt}-${input.workItem.ownerSlot}`,
        baseSha: input.baseSha,
        writePaths: [...input.workItem.writePaths],
        writeDirectories: [...input.workItem.writePaths],
      };
    },
    async createSnapshot(input) {
      calls.push({ type: "snapshot", input });
      return {
        id: input.id,
        root: `/snapshots/${input.id}`,
        sha: input.sha,
        receipt: {
          files: 10,
          bytes: 1_000,
          sha256: input.sha.padEnd(64, "0").slice(0, 64),
        },
      };
    },
    async validateAndCommit(input) {
      calls.push({ type: "commit", input });
      const changedPaths = {
        "engineering-a": ["src/a.mjs"],
        "engineering-b": ["starters/b.mjs"],
        "qa-tests": ["test/feature.test.mjs"],
      }[input.workItem.ownerSlot];
      return {
        baseSha: input.workspace.baseSha,
        resultSha: resultBySlot[input.workItem.ownerSlot],
        changedPaths,
        changedBytes: 100,
        diffSha256: DIFF_BY_SLOT[input.workItem.ownerSlot],
        diff: `diff:${input.workItem.ownerSlot}`,
      };
    },
    async integrate(input) {
      calls.push({ type: "integrate", input });
      return {
        candidateSha: SHA.candidate,
        workspaceId: "candidate",
        workspaceRoot: "/candidate",
        candidateSnapshot: { id: "candidate", sha: SHA.candidate },
      };
    },
    async scan(input) {
      calls.push({ type: "scan", input });
      return { status: "passed", candidateSha: input.candidateSha, evidence: ["scan:clean"] };
    },
    async close(input) {
      calls.push({ type: "close", input });
    },
  };
}

function controllerInput({
  agents,
  source,
  store,
  verifyCandidate,
  clock,
  deadlineAt,
  prompts = ROLE_PROMPTS,
} = {}) {
  return {
    template: {
      version: 1,
      name: "parallel-engineering-pod",
      maxAttempts: 2,
      timeouts: { executionSeconds: 60, attemptSeconds: 300, workflowSeconds: 600 },
      changes: { maxFiles: 100, maxBytes: 1_048_576 },
      writers: {
        "engineering-a": { prompt: "roles/engineering.md", allowedWriteRoots: ["src"] },
        "engineering-b": { prompt: "roles/engineering.md", allowedWriteRoots: ["starters"] },
        "qa-tests": { prompt: "roles/qa-tests.md", allowedWriteRoots: ["test"] },
      },
      prompts: {
        planner: "roles/planner.md",
        checker: "roles/checker.md",
        qa: "roles/qa.md",
        testing: "roles/testing.md",
      },
      verificationProfile: "monolith-repo-v1",
    },
    templateDigest: "f".repeat(64),
    prompts,
    assignment: { task: "Build and prove the feature." },
    repository: "https://github.com/zaycruz/monolith-v2.git",
    baseRevision: "main",
    targetBranch: "main",
    runId: "pod-run-1",
    stateRoot: "/state",
    agents,
    source,
    verifyCandidate,
    store,
    clock: clock ?? (() => 1_800_000_000_000),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };
}

test("rejects missing or oversized digest-bound role prompts before source access", async () => {
  const calls = [];
  const source = createSource(calls);
  const agents = { async runAgentExecution() {}, async cancel() {} };
  const verifyCandidate = async () => ({ status: "passed" });

  const missing = { ...ROLE_PROMPTS };
  delete missing.testing;
  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store: createStore(),
    verifyCandidate,
    prompts: missing,
  })), /prompts must contain exactly/);

  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store: createStore(),
    verifyCandidate,
    prompts: { ...ROLE_PROMPTS, planner: "x".repeat((32 * 1024) + 1) },
  })), /prompt planner must be non-empty and at most 32768 bytes/);

  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store: createStore(),
    verifyCandidate,
    prompts: { ...ROLE_PROMPTS, unexpected: "not digest-bound" },
  })), /prompts must contain exactly/);

  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store: createStore(),
    verifyCandidate,
    deadlineAt: 1_800_000_600_001,
  })), /deadlineAt cannot extend the workflow budget/);

  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store: createStore(),
    verifyCandidate,
    deadlineAt: 1_800_000_000_000,
  })), /deadlineAt must be a safe integer strictly in the future/);
  assert.deepEqual(calls, []);
});

test("fans out all three writers, checks exact results, and marks the tested candidate ready", async () => {
  const calls = [];
  const store = createStore();
  const source = createSource(calls);
  const attemptPlan = plan();
  const startedWriters = new Set();
  let releaseWriters;
  const writerBarrier = new Promise(resolve => {
    releaseWriters = resolve;
  });

  const agents = {
    async cancel() {
      calls.push({ type: "cancel" });
    },
    async runAgentExecution(input) {
      calls.push({ type: "agent", input });
      if (input.role === "planner") return { receipt: attemptPlan };
      if (["engineering-a", "engineering-b", "qa-tests"].includes(input.role)) {
        assert.equal(input.access, "write");
        assert.equal(input.writeDirectories.length, 1);
        assert.equal(input.runId, "pod-run-1");
        assert.match(input.workspaceId, new RegExp(`^${input.attempt}-`));
        startedWriters.add(input.role);
        if (startedWriters.size === 3) releaseWriters();
        await writerBarrier;
        return { receipt: writerReceipt(input.role, attemptPlan) };
      }
      if (input.role === "checker") {
        const writerId = ["engineering-a", "engineering-b", "qa-tests"]
          .find(slot => input.executionId.endsWith(slot));
        const commit = calls.find(call => call.type === "commit" && call.input.workItem.id === writerId).input;
        const resultSha = {
          "engineering-a": SHA.engineeringA,
          "engineering-b": SHA.engineeringB,
          "qa-tests": SHA.qaTests,
        }[writerId];
        return {
          receipt: {
            outcome: "passed",
            baseSha: commit.workspace.baseSha,
            resultSha,
            diffSha256: DIFF_BY_SLOT[writerId],
            what: `Checked ${writerId}.`,
            why: "The exact result satisfies its requirements.",
            evidence: [`checked:${writerId}`],
            requirementIds: [...attemptPlan.writers[writerId].requirementIds],
            acceptanceIds: [...attemptPlan.writers[writerId].acceptanceIds],
            files: [],
            deliveredInbox: [],
          },
        };
      }
      if (input.role === "qa") {
        return {
          receipt: {
            gate: "qa",
            outcome: "passed",
            candidateSha: SHA.candidate,
            what: "The exact integrated candidate conforms.",
            why: "The product and tests conform.",
            evidence: ["qa:passed"],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      if (input.role === "testing") {
        const prompt = promptContext(input.prompt);
        assert.equal(input.access, "read");
        assert.equal(input.workspaceId, "candidate");
        assert.equal(prompt.candidateSha, SHA.candidate);
        return {
          receipt: {
            gate: "testing",
            outcome: "passed",
            candidateSha: SHA.candidate,
            what: "The exact candidate is ready for trusted verification.",
            why: "The testing review found no red condition.",
            evidence: ["testing:passed"],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      throw new Error(`unexpected role: ${input.role}`);
    },
  };

  const verified = [];
  const verifyCandidate = async input => {
    calls.push({ type: "verify", input });
    verified.push(input);
    return { status: "passed", candidateSha: input.expectedSha, evidence: ["tests:passed"] };
  };
  const result = await runEngineeringPod(controllerInput({
    agents,
    source,
    store,
    verifyCandidate,
    deadlineAt: 1_800_000_120_000,
  }));

  assert.deepEqual([...startedWriters].sort(), ["engineering-a", "engineering-b", "qa-tests"]);
  const agentCalls = calls.filter(call => call.type === "agent");
  assert.deepEqual(
    [...new Set(agentCalls.map(call => call.input.role))].sort(),
    Object.keys(ROLE_PROMPTS).sort(),
  );
  for (const call of agentCalls) {
    assert.equal(bakedPrompt(call.input.prompt), ROLE_PROMPTS[call.input.role]);
  }
  assert(agentCalls
    .filter(call => !["engineering-a", "engineering-b", "qa-tests"].includes(call.input.role))
    .every(call => call.input.access === "read" && call.input.writeDirectories.length === 0));
  const integration = calls.find(call => call.type === "integrate").input;
  assert.deepEqual(integration.commits.map(commit => commit.resultSha), [
    SHA.engineeringA,
    SHA.engineeringB,
    SHA.qaTests,
  ]);
  assert.deepEqual(integration.integrationOrder, ["engineering-a", "engineering-b", "qa-tests"]);
  assert(calls
    .filter(call => call.type === "commit")
    .every(call => !Object.hasOwn(call.input, "receipt")));
  const checkerViews = calls.filter(call => (
    call.type === "read-view" && call.input.id.startsWith("c-")
  ));
  assert.equal(checkerViews.length, 3);
  assert(checkerViews.every(call => call.input.id.length <= 64));
  assert.equal(new Set(checkerViews.map(call => call.input.id)).size, checkerViews.length);
  assert.deepEqual(
    store.records.workResults.map(({ value }) => ({
      ownerSlot: value.ownerSlot,
      files: value.files,
      changedBytes: value.changedBytes,
    })),
    [
      { ownerSlot: "engineering-a", files: ["src/a.mjs"], changedBytes: 100 },
      { ownerSlot: "engineering-b", files: ["starters/b.mjs"], changedBytes: 100 },
      { ownerSlot: "qa-tests", files: ["test/feature.test.mjs"], changedBytes: 100 },
    ],
  );
  assert.deepEqual(verified, [{
    workspaceRoot: "/candidate",
    candidateView: { id: "candidate", root: "/candidate", sha: SHA.candidate },
    candidateSnapshot: {
      id: "attempt-1-candidate",
      root: "/snapshots/attempt-1-candidate",
      sha: SHA.candidate,
      receipt: {
        files: 10,
        bytes: 1_000,
        sha256: SHA.candidate.padEnd(64, "0").slice(0, 64),
      },
    },
    baseSnapshot: {
      id: "run-base",
      root: "/snapshots/run-base",
      sha: SHA.base,
      receipt: {
        files: 10,
        bytes: 1_000,
        sha256: SHA.base.padEnd(64, "0").slice(0, 64),
      },
    },
    expectedSha: SHA.candidate,
    profile: "monolith-repo-v1",
    timeoutSeconds: 120,
  }]);
  assert.equal(calls.find(call => call.type === "prepare").input.deadlineAt, 1_800_000_120_000);
  assert.equal(calls.findIndex(call => call.type === "scan") < calls.findIndex(call => call.type === "close"), true);
  assert.deepEqual(calls.find(call => call.type === "close").input, { retainForPublication: true });
  assert.equal(result.status, "ready");
  assert.equal(result.baseSha, SHA.base);
  assert.equal(result.candidateSha, SHA.candidate);
  assert(store.records.gates.some(({ value }) => (
    value.gate === "publication-ready" && value.subjectSha === SHA.candidate
  )));
  assert.deepEqual(
    store.records.events.find(event => event.type === "publication.ready"),
    {
      type: "publication.ready",
      attempt: 1,
      repository: "https://github.com/zaycruz/monolith-v2.git",
      targetBranch: "main",
      baseSha: SHA.base,
      candidateSha: SHA.candidate,
      headBranch: "monolith/pod-run-1",
    },
  );
  assert.deepEqual(store.records.finished, []);
  const qaIndex = calls.findIndex(call => call.type === "agent" && call.input.role === "qa");
  const testingIndex = calls.findIndex(call => call.type === "agent" && call.input.role === "testing");
  const verifyIndex = calls.findIndex(call => call.type === "verify");
  const scanIndex = calls.findIndex(call => call.type === "scan");
  assert(qaIndex >= 0 && qaIndex < testingIndex);
  assert(testingIndex < verifyIndex);
  assert(verifyIndex < scanIndex);
});

test("rejects a non-canonical controller delta before recording a work result", async () => {
  const calls = [];
  const store = createStore();
  const source = createSource(calls);
  source.validateAndCommit = async input => {
    calls.push({ type: "commit", input });
    return {
      baseSha: input.workspace.baseSha,
      resultSha: SHA.engineeringA,
      changedPaths: ["src/../README.md"],
      changedBytes: 100,
      diffSha256: DIFF_BY_SLOT["engineering-a"],
      diff: "invalid out-of-scope diff",
    };
  };
  const agents = {
    async cancel() {},
    async runAgentExecution(input) {
      const attemptPlan = plan(input.attempt);
      if (input.role === "planner") return { receipt: attemptPlan };
      if (["engineering-a", "engineering-b", "qa-tests"].includes(input.role)) {
        return { receipt: writerReceipt(input.role, attemptPlan) };
      }
      throw new Error(`unexpected role: ${input.role}`);
    },
  };

  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store,
    verifyCandidate: async () => {
      throw new Error("verification must not start");
    },
  })), /commit changedPaths\[0\] must be a canonical relative file path/);

  assert.deepEqual(store.records.workResults, []);
  assert.deepEqual(store.records.finished.map(entry => entry.status), ["failed"]);
});

test("queues one active-owner dependency and resumes the requester only after the owner passes", async () => {
  const calls = [];
  const timeline = [];
  const store = createStore();
  const attemptPlan = plan();
  let queuedEntry;
  let releaseOwner;
  const ownerMayCheckpoint = new Promise(resolve => {
    releaseOwner = resolve;
  });
  store.enqueueInbox = async (attempt, owner, request) => {
    timeline.push("inbox-queued");
    queuedEntry = {
      sequence: 1,
      requester: request.requester,
      owner: request.owner,
      path: request.path,
      requirementIds: request.requirementIds,
      acceptanceIds: request.acceptanceIds,
      ownerBriefSha256: request.ownerBriefSha256,
      need: request.need,
      why: request.why,
      requesterCheckpointSha: request.requesterCheckpointSha,
    };
    assert.equal(attempt, 1);
    assert.equal(owner, "engineering-b");
    releaseOwner();
    return queuedEntry;
  };
  store.readInbox = async (attempt, owner, { afterSequence }) => {
    assert.equal(attempt, 1);
    assert.equal(owner, "engineering-b");
    assert.equal(afterSequence, 0);
    return [queuedEntry];
  };

  const checkpointA = "4".repeat(40);
  const checkpointB = "5".repeat(40);
  const combinedBase = "6".repeat(40);
  const commitCounts = new Map();
  const source = createSource(calls);
  source.validateAndCommit = async input => {
    calls.push({ type: "commit", input });
    const slot = input.workItem.ownerSlot;
    const count = (commitCounts.get(slot) ?? 0) + 1;
    commitCounts.set(slot, count);
    const resultSha = {
      "engineering-a": count === 1 ? checkpointA : SHA.engineeringA,
      "engineering-b": count === 1 ? checkpointB : SHA.engineeringB,
      "qa-tests": SHA.qaTests,
    }[slot];
    const baseSha = slot === "engineering-b" && count === 2
      ? checkpointB
      : input.workspace.baseSha;
    return {
      baseSha,
      resultSha,
      changedPaths: {
        "engineering-a": ["src/a.mjs"],
        "engineering-b": ["starters/b.mjs"],
        "qa-tests": ["test/feature.test.mjs"],
      }[slot],
      changedBytes: 100,
      diffSha256: DIFF_BY_SLOT[slot],
      diff: `diff:${slot}:${count}`,
    };
  };
  source.combineBase = async input => {
    timeline.push("requester-base-combined");
    calls.push({ type: "combine", input });
    assert.equal(input.requesterCheckpointSha, checkpointA);
    assert.equal(input.dependencyResultSha, SHA.engineeringB);
    return {
      id: "1-engineering-a-combined",
      root: "/worktrees/pod-run-1/1-engineering-a-combined",
      baseSha: combinedBase,
      writeDirectories: ["src"],
    };
  };

  const agents = {
    async cancel() {
      calls.push({ type: "cancel" });
    },
    async runAgentExecution(input) {
      calls.push({ type: "agent", input });
      if (input.role === "planner") return { receipt: attemptPlan };
      if (input.executionId === "attempt-1-engineering-a") {
        timeline.push("requester-stopped");
        return {
          receipt: writerReceipt("engineering-a", attemptPlan, {
            outcome: "blocked",
            dependencyRequest: {
              owner: "engineering-b",
              path: "starters/b.mjs",
              requirementIds: ["REQ-1"],
              acceptanceIds: ["AC-1"],
              ownerBriefSha256: sha256(attemptPlan.writers["engineering-b"].brief),
              need: "Expose the interface required by engineering-a.",
              why: "The shared acceptance criterion depends on the owner implementation.",
            },
          }),
        };
      }
      if (input.executionId === "attempt-1-engineering-b") {
        await ownerMayCheckpoint;
        timeline.push("owner-checkpointed");
        return { receipt: writerReceipt("engineering-b", attemptPlan) };
      }
      if (input.executionId === "attempt-1-qa-tests") {
        return { receipt: writerReceipt("qa-tests", attemptPlan) };
      }
      if (input.executionId === "attempt-1-engineering-b-inbox") {
        timeline.push("owner-read-inbox");
        const prompt = promptContext(input.prompt);
        assert.deepEqual(prompt.inbox, [queuedEntry]);
        return {
          receipt: writerReceipt("engineering-b", attemptPlan, {
            baseSha: checkpointB,
            inboxCursor: 1,
          }),
        };
      }
      if (input.executionId === "attempt-1-engineering-a-resume") {
        timeline.push("requester-resumed");
        return {
          receipt: writerReceipt("engineering-a", attemptPlan, { baseSha: combinedBase }),
        };
      }
      if (input.role === "checker") {
        const prompt = promptContext(input.prompt);
        const writer = prompt.workItem;
        if (writer.ownerSlot === "engineering-a" && prompt.resultSha === checkpointA) {
          timeline.push("requester-checkpoint-checked");
        }
        if (writer.ownerSlot === "engineering-b" && prompt.deliveredInbox.length) {
          timeline.push("owner-inbox-result-checked");
        }
        return {
          receipt: {
            outcome: "passed",
            baseSha: prompt.baseSha,
            resultSha: prompt.resultSha,
            diffSha256: prompt.diffSha256,
            what: `Checked ${writer.ownerSlot}.`,
            why: "The exact result satisfies its requirements.",
            evidence: [`checked:${writer.ownerSlot}`],
            requirementIds: [...writer.requirementIds],
            acceptanceIds: [...writer.acceptanceIds],
            files: [],
            deliveredInbox: prompt.deliveredInbox,
          },
        };
      }
      if (input.role === "qa") {
        return {
          receipt: {
            gate: "qa",
            outcome: "passed",
            candidateSha: SHA.candidate,
            what: "The exact integrated candidate conforms.",
            why: "The product and tests conform.",
            evidence: ["qa:passed"],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      if (input.role === "testing") {
        return {
          receipt: {
            gate: "testing",
            outcome: "passed",
            candidateSha: SHA.candidate,
            what: "The exact candidate is ready for trusted verification.",
            why: "The testing review found no red condition.",
            evidence: ["testing:passed"],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      throw new Error(`unexpected execution: ${input.executionId}`);
    },
  };

  const result = await runEngineeringPod(controllerInput({
    agents,
    source,
    store,
    verifyCandidate: async input => ({
      status: "passed",
      candidateSha: input.expectedSha,
      evidence: ["tests:passed"],
    }),
  }));

  assert.equal(result.status, "ready");
  assert.deepEqual(store.records.finished, []);
  assert(timeline.indexOf("requester-stopped") < timeline.indexOf("requester-checkpoint-checked"));
  assert(timeline.indexOf("requester-checkpoint-checked") < timeline.indexOf("inbox-queued"));
  assert(timeline.indexOf("inbox-queued") < timeline.indexOf("owner-checkpointed"));
  assert(timeline.indexOf("owner-read-inbox") < timeline.indexOf("owner-inbox-result-checked"));
  assert(timeline.indexOf("owner-inbox-result-checked") < timeline.indexOf("requester-resumed"));
  assert(timeline.indexOf("requester-base-combined") < timeline.indexOf("requester-resumed"));
  const integration = calls.find(call => call.type === "integrate").input;
  assert.deepEqual(integration.commits.map(commit => commit.resultSha), [
    SHA.engineeringA,
    SHA.engineeringB,
    SHA.qaTests,
  ]);
});

test("a red Testing gate starts a complete next attempt from the immutable run base", async () => {
  const calls = [];
  const store = createStore();
  const source = createSource(calls);
  const plannerHistory = [];

  const agents = {
    async cancel() {
      calls.push({ type: "cancel" });
    },
    async runAgentExecution(input) {
      calls.push({ type: "agent", input });
      if (input.role === "planner") {
        const prompt = promptContext(input.prompt);
        plannerHistory.push(prompt.priorAttempts);
        return { receipt: plan(input.attempt) };
      }
      if (["engineering-a", "engineering-b", "qa-tests"].includes(input.role)) {
        return { receipt: writerReceipt(input.role, plan(input.attempt)) };
      }
      if (input.role === "checker") {
        const prompt = promptContext(input.prompt);
        const writer = prompt.workItem;
        return {
          receipt: {
            outcome: "passed",
            baseSha: prompt.baseSha,
            resultSha: prompt.resultSha,
            diffSha256: prompt.diffSha256,
            what: `Checked ${writer.ownerSlot}.`,
            why: "The exact result passes.",
            evidence: [`checker:${writer.ownerSlot}:passed`],
            requirementIds: [...writer.requirementIds],
            acceptanceIds: [...writer.acceptanceIds],
            files: [],
            deliveredInbox: [],
          },
        };
      }
      if (input.role === "qa") {
        const attemptPlan = plan(input.attempt);
        return {
          receipt: {
            gate: "qa",
            outcome: "passed",
            candidateSha: SHA.candidate,
            what: "The exact integrated candidate conforms.",
            why: "The replacement attempt fixed the defect.",
            evidence: ["qa:passed"],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      if (input.role === "testing") {
        const attemptPlan = plan(input.attempt);
        const failed = input.attempt === 1;
        return {
          receipt: {
            gate: "testing",
            outcome: failed ? "failed" : "passed",
            candidateSha: SHA.candidate,
            what: failed ? "The exact candidate has a regression." : "The exact candidate is ready.",
            why: failed ? "The regression gate is red." : "The testing review found no red condition.",
            evidence: [failed ? "testing:failed" : "testing:passed"],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      throw new Error(`unexpected role: ${input.role}`);
    },
  };

  let verificationCalls = 0;
  const result = await runEngineeringPod(controllerInput({
    agents,
    source,
    store,
    verifyCandidate: async input => {
      verificationCalls += 1;
      return {
        status: "passed",
        candidateSha: input.expectedSha,
        evidence: ["tests:passed"],
      };
    },
  }));

  assert.equal(result.status, "ready");
  assert.deepEqual(store.records.plans.map(entry => entry.attempt), [1, 2]);
  assert.deepEqual(plannerHistory[0], []);
  assert.equal(plannerHistory[1].length, 1);
  assert.equal(plannerHistory[1][0].attempt, 1);
  assert.equal(plannerHistory[1][0].workResults.length, 3);
  assert(plannerHistory[1][0].workResults.every(result => !Object.hasOwn(result, "diff")));
  assert.equal(plannerHistory[1][0].gates.filter(gate => gate.gate === "checker").length, 3);
  assert(plannerHistory[1][0].gates.some(gate => gate.gate === "testing" && gate.outcome === "failed"));
  const worktrees = calls.filter(call => call.type === "worktree");
  assert.deepEqual(worktrees.map(call => call.input.attempt), [1, 1, 1, 2, 2, 2]);
  assert(worktrees.every(call => call.input.baseSha === SHA.base));
  const writerExecutions = calls.filter(call => (
    call.type === "agent" && ["engineering-a", "engineering-b", "qa-tests"].includes(call.input.role)
  ));
  assert.equal(writerExecutions.length, 6);
  assert.equal(verificationCalls, 1);
  assert.deepEqual(calls.filter(call => call.type === "integrate").map(call => call.input.attempt), [1, 2]);
});

test("a structural writer failure settles sibling executions before the replacement attempt", async () => {
  const calls = [];
  const timeline = [];
  const store = createStore();
  const source = createSource(calls);
  let attemptOneStarted = 0;
  let releaseAttemptOne;
  const allAttemptOneStarted = new Promise(resolve => {
    releaseAttemptOne = resolve;
  });
  let releaseLateWriters;
  const lateWritersMaySettle = new Promise(resolve => {
    releaseLateWriters = resolve;
  });
  let reportInvalidReceipt;
  const invalidReceiptReturned = new Promise(resolve => {
    reportInvalidReceipt = resolve;
  });

  const agents = {
    async cancel() {
      calls.push({ type: "cancel" });
    },
    async runAgentExecution(input) {
      calls.push({ type: "agent", input });
      const attemptPlan = plan(input.attempt);
      if (input.role === "planner") {
        timeline.push(`planner-${input.attempt}`);
        return { receipt: attemptPlan };
      }
      if (["engineering-a", "engineering-b", "qa-tests"].includes(input.role)) {
        if (input.attempt === 1) {
          attemptOneStarted += 1;
          if (attemptOneStarted === 3) releaseAttemptOne();
          await allAttemptOneStarted;
          if (input.role === "engineering-a") {
            reportInvalidReceipt();
            return { receipt: { outcome: "completed" } };
          }
          await lateWritersMaySettle;
          timeline.push(`${input.role}-attempt-1-settled`);
        }
        return { receipt: writerReceipt(input.role, attemptPlan) };
      }
      if (input.role === "checker") {
        const prompt = promptContext(input.prompt);
        const writer = prompt.workItem;
        return {
          receipt: {
            outcome: "passed",
            baseSha: prompt.baseSha,
            resultSha: prompt.resultSha,
            diffSha256: prompt.diffSha256,
            what: `Checked ${writer.ownerSlot}.`,
            why: "The exact result passes.",
            evidence: [`checker:${writer.ownerSlot}:passed`],
            requirementIds: [...writer.requirementIds],
            acceptanceIds: [...writer.acceptanceIds],
            files: [],
            deliveredInbox: [],
          },
        };
      }
      if (input.role === "qa" || input.role === "testing") {
        return {
          receipt: {
            gate: input.role,
            outcome: "passed",
            candidateSha: SHA.candidate,
            what: "The exact candidate passes.",
            why: "The replacement attempt is complete.",
            evidence: [`${input.role}:passed`],
            requirementIds: attemptPlan.requirements.map(item => item.id),
            acceptanceIds: attemptPlan.acceptanceCriteria.map(item => item.id),
            files: [],
          },
        };
      }
      throw new Error(`unexpected role: ${input.role}`);
    },
  };

  const run = runEngineeringPod(controllerInput({
    agents,
    source,
    store,
    verifyCandidate: async input => ({
      status: "passed",
      candidateSha: input.expectedSha,
      evidence: ["tests:passed"],
    }),
  }));
  await invalidReceiptReturned;
  await new Promise(resolve => setImmediate(resolve));
  timeline.push("late-writers-released");
  releaseLateWriters();
  const result = await run;

  assert.equal(result.status, "ready");
  const replacementPlanner = timeline.indexOf("planner-2");
  assert(replacementPlanner > timeline.indexOf("engineering-b-attempt-1-settled"));
  assert(replacementPlanner > timeline.indexOf("qa-tests-attempt-1-settled"));
  assert.deepEqual(store.records.plans.map(entry => entry.attempt), [1, 2]);
  assert.equal(calls.filter(call => (
    call.type === "agent" && ["engineering-a", "engineering-b", "qa-tests"].includes(call.input.role)
  )).length, 6);
});

test("cancellation settles every active writer and forbids late promotion", async () => {
  const calls = [];
  const timeline = [];
  const store = createStore();
  const originalFinish = store.finish;
  store.finish = async (...args) => {
    timeline.push("store-finished");
    return originalFinish(...args);
  };
  const source = createSource(calls);
  const attemptPlan = plan();
  let started = 0;
  let releaseStarted;
  const allStarted = new Promise(resolve => {
    releaseStarted = resolve;
  });
  const late = new Map();
  let cancellations = 0;

  const agents = {
    async cancel() {
      cancellations += 1;
      timeline.push("cancel-called");
      for (const resume of late.values()) resume();
    },
    async runAgentExecution(input) {
      calls.push({ type: "agent", input });
      if (input.role === "planner") return { receipt: attemptPlan };
      if (!["engineering-a", "engineering-b", "qa-tests"].includes(input.role)) {
        throw new Error(`unexpected role after cancellation: ${input.role}`);
      }
      started += 1;
      if (started === 3) releaseStarted();
      try {
        if (input.role === "engineering-a") {
          await allStarted;
          throw new Error("controller interrupted");
        }
        await new Promise(resolve => late.set(input.role, resolve));
        timeline.push(`${input.role}-late-result`);
        return { receipt: writerReceipt(input.role, attemptPlan) };
      } finally {
        timeline.push(`${input.role}-settled`);
      }
    },
  };
  let verificationCalls = 0;

  await assert.rejects(runEngineeringPod(controllerInput({
    agents,
    source,
    store,
    verifyCandidate: async () => {
      verificationCalls += 1;
      throw new Error("verification must not start");
    },
  })), /controller interrupted/);

  assert.equal(cancellations, 1);
  assert.equal(verificationCalls, 0);
  assert.equal(calls.some(call => ["commit", "integrate", "scan"].includes(call.type)), false);
  assert.equal(store.records.gates.some(({ value }) => value.gate === "publication-ready"), false);
  assert.deepEqual(store.records.finished.map(entry => entry.status), ["failed"]);
  assert.deepEqual(calls.find(call => call.type === "close").input, { retainForPublication: false });
  const finishedAt = timeline.indexOf("store-finished");
  assert(finishedAt > timeline.indexOf("engineering-a-settled"));
  assert(finishedAt > timeline.indexOf("engineering-b-settled"));
  assert(finishedAt > timeline.indexOf("qa-tests-settled"));
  assert(timeline.indexOf("cancel-called") < timeline.indexOf("engineering-b-late-result"));
  assert(timeline.indexOf("cancel-called") < timeline.indexOf("qa-tests-late-result"));
});
