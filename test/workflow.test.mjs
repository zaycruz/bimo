import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadWorkflow,
  runWorkflow,
  validateReceipt,
  validateWorkflow,
} from "../src/workflow.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monolith-workflow-"));
  return {
    stateRoot: path.join(temporary, "runs"),
    workspace: path.join(temporary, "workspace"),
  };
}

function receipt(outcome, label) {
  return {
    outcome,
    what: `${label} did the work`,
    why: `${label} chose the smallest correct change`,
    evidence: [`${label} check passed`],
    files: label === "engineering" ? ["src/App.jsx"] : [],
  };
}

function singleRoleWorkflow(loaded, { maxSteps = 1, looping = false } = {}) {
  const workflow = structuredClone(loaded.workflow);
  workflow.maxSteps = maxSteps;
  workflow.roles = {
    engineering: {
      prompt: "roles/engineering.md",
      write: true,
      on: looping ? { again: "engineering", completed: "done" } : { completed: "done" },
    },
  };
  return workflow;
}

test("the packaged React workflow is data-only and bounded", async () => {
  const loaded = await loadWorkflow("react-app", {
    templateRoot: path.join(root, "templates"),
  });

  assert.equal(loaded.workflow.start, "engineering");
  assert.equal(loaded.workflow.roles.qa.write, false);
  assert.equal(loaded.workflow.roles.testing.on.failed, "engineering");
  assert.ok(loaded.workflow.maxSteps <= 20);
  assert.deepEqual(loaded.workflow.roles.engineering.on, { completed: "qa" });

  assert.throws(
    () => validateWorkflow({ ...loaded.workflow, agent: ["sh", "-c", "id"] }),
    /unknown workflow field: agent/,
  );

  const nestedOutput = structuredClone(loaded.workflow);
  nestedOutput.output.directory = "dist/site";
  assert.throws(() => validateWorkflow(nestedOutput), /one safe path component/);

  const spacedOutput = structuredClone(loaded.workflow);
  spacedOutput.output.directory = "dist output";
  assert.throws(() => validateWorkflow(spacedOutput), /one safe path component/);

  const reservedSmoke = structuredClone(loaded.workflow);
  reservedSmoke.output.smoke.path = "/healthz";
  assert.throws(() => validateWorkflow(reservedSmoke), /reserved for server health/);
});

test("strict receipts reject extra fields and unsafe paths", () => {
  const role = { on: { passed: "done" }, write: false };
  assert.throws(
    () => validateReceipt({ ...receipt("passed", "qa"), surprise: true }, role),
    /exactly outcome, what, why, evidence, and files/,
  );
  const coerciveOutcome = { toString: () => { throw new Error("outcome was coerced"); } };
  assert.throws(
    () => validateReceipt({ ...receipt("passed", "qa"), outcome: coerciveOutcome }, role),
    /receipt.outcome must be a string/,
  );
  assert.throws(
    () => validateReceipt({ ...receipt("passed", "qa"), files: ["../outside"] }, { ...role, write: true }),
    /relative workspace path/,
  );
  assert.throws(
    () => validateReceipt({ ...receipt("passed", "qa"), files: ["changed.txt"] }, role),
    /read-only role must report an empty files array/,
  );

  const writableRole = { ...role, write: true };
  const directoryReceipt = validateReceipt(
    { ...receipt("passed", "engineering"), files: ["dist/", "node_modules/"] },
    writableRole,
  );
  assert.deepEqual(directoryReceipt.files, ["dist", "node_modules"]);
  assert.throws(
    () => validateReceipt(
      { ...receipt("passed", "engineering"), files: ["dist//"] },
      writableRole,
    ),
    /relative workspace path/,
  );

  const oversized = {
    outcome: "passed",
    what: "w".repeat(2_000),
    why: "y".repeat(2_000),
    evidence: Array.from({ length: 20 }, () => "e".repeat(1_000)),
    files: Array.from({ length: 100 }, (_, index) => `${index}-${"f".repeat(450)}`),
  };
  assert.throws(
    () => validateReceipt(oversized, writableRole),
    /serialize to at most 61440 bytes/,
  );
});

test("a failed review loops through Engineering and leaves durable why history", async () => {
  const { workflow, templateDir, prompts, digest } = await loadWorkflow("react-app", {
    templateRoot: path.join(root, "templates"),
  });
  const locations = await fixture();
  const outcomes = ["completed", "failed", "completed", "passed", "passed"];
  const seen = [];

  const first = await runWorkflow({
    workflow,
    templateDir,
    prompts,
    templateDigest: digest,
    task: "Build a tiny status page",
    runId: "run-a",
    ...locations,
    runRole: async input => {
      seen.push(input);
      return {
        receipt: receipt(outcomes.shift(), input.role),
        runtime: { containerId: `container-${input.step}`, exitCode: 0 },
      };
    },
    verify: async () => ({ status: "passed", evidence: ["npm test", "npm run build"] }),
    publish: async () => ({ url: "http://127.0.0.1:8080" }),
  });

  assert.equal(first.status, "completed");
  assert.deepEqual(seen.map(item => item.role), [
    "engineering", "qa", "engineering", "qa", "testing",
  ]);
  assert.match(seen[2].prompt, /qa did the work/);
  assert.match(seen[2].prompt, /qa chose the smallest correct change/);

  const eventsText = await readFile(path.join(locations.stateRoot, "run-a", "events.jsonl"), "utf8");
  const events = eventsText.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), [
    "run.started",
    "role.started", "role.finished",
    "role.started", "role.finished",
    "role.started", "role.finished",
    "role.started", "role.finished",
    "role.started", "role.finished",
    "verification.finished", "publication.finished", "run.finished",
  ]);
  assert.deepEqual(events.filter(event => event.type === "role.finished").map(event => event.outcome), [
    "completed", "failed", "completed", "passed", "passed",
  ]);

  const changelog = await readFile(path.join(locations.stateRoot, "run-a", "CHANGELOG.md"), "utf8");
  assert.match(changelog, /qa chose the smallest correct change/);
  assert.match(changelog, /http:\/\/127\.0\.0\.1:8080/);

  const secondSeen = [];
  const secondOutcomes = ["completed", "passed", "passed"];
  await runWorkflow({
    workflow,
    templateDir,
    prompts,
    templateDigest: digest,
    task: "Improve the status page",
    runId: "run-b",
    ...locations,
    runRole: async input => {
      secondSeen.push(input);
      return { receipt: receipt(secondOutcomes.shift(), input.role), runtime: { exitCode: 0 } };
    },
    verify: async () => ({ status: "passed", evidence: ["verified"] }),
    publish: async () => ({ url: "http://127.0.0.1:8081" }),
  });

  assert.match(secondSeen[0].prompt, /Previous deployment history/);
  assert.match(secondSeen[0].prompt, /run-a/);
  assert.match(secondSeen[0].prompt, /qa chose the smallest correct change/);
});

test("every failure path records a terminal event", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const locations = await fixture();

  await assert.rejects(
    runWorkflow({
      ...loaded,
      task: "fail safely",
      runId: "run-failure",
      ...locations,
      runRole: async () => {
        throw Object.assign(new Error("agent exited 7"), {
          runtime: { containerId: "container-failed", exitCode: 7 },
        });
      },
      verify: async () => ({ status: "passed", evidence: [] }),
      publish: async () => ({ url: "unused" }),
    }),
    /agent exited 7/,
  );

  const text = await readFile(path.join(locations.stateRoot, "run-failure", "events.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).reason, "agent exited 7");
  assert.deepEqual(events.at(-2).runtime, { containerId: "container-failed", exitCode: 7 });

  const invalidLocations = await fixture();
  await assert.rejects(
    runWorkflow({
      ...loaded,
      task: "reject an invalid receipt safely",
      runId: "run-invalid-receipt",
      ...invalidLocations,
      runRole: async () => ({
        receipt: { ...receipt("completed", "engineering"), files: ["../outside"] },
        runtime: { containerId: "container-invalid-receipt", exitCode: 0 },
      }),
      verify: async () => ({ status: "passed", evidence: ["unused"] }),
      publish: async () => ({ url: "unused" }),
    }),
    /relative workspace path/,
  );

  const invalidText = await readFile(
    path.join(invalidLocations.stateRoot, "run-invalid-receipt", "events.jsonl"),
    "utf8",
  );
  const invalidEvents = invalidText.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(invalidEvents.slice(-2).map(event => event.type), ["role.failed", "run.failed"]);
  assert.equal(invalidEvents.at(-2).runtime.containerId, "container-invalid-receipt");
});

test("carried history is deterministic, recent, and bounded below the agent prompt cap", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });

  async function runWithLargeHistory(runId) {
    const locations = await fixture();
    const previousRun = path.join(locations.stateRoot, "previous");
    await mkdir(previousRun, { recursive: true });
    await writeFile(path.join(locations.stateRoot, "latest"), "previous\n");
    await writeFile(
      path.join(previousRun, "CHANGELOG.md"),
      `BEGIN\n${"😀".repeat(100_000)}\nEND\n`,
    );

    const prompts = [];
    await runWorkflow({
      ...loaded,
      workflow: singleRoleWorkflow(loaded, { maxSteps: 4, looping: true }),
      prompts: { engineering: "i".repeat(32 * 1024) },
      task: "t".repeat(64 * 1024),
      runId,
      ...locations,
      runRole: async input => {
        prompts.push(input.prompt);
        return {
          receipt: {
            outcome: input.step === 4 ? "completed" : "again",
            what: `step ${input.step} ${"w".repeat(1_900)}`,
            why: `decision ${input.step} ${"y".repeat(1_890)}`,
            evidence: Array.from({ length: 20 }, (_, index) => `check-${index}-${"e".repeat(890)}`),
            files: Array.from({ length: 60 }, (_, index) => `generated/${index}-${"f".repeat(370)}`),
          },
          runtime: { exitCode: 0 },
        };
      },
      verify: async () => ({ status: "passed", evidence: ["verified"] }),
      publish: async () => ({ url: "http://127.0.0.1:8080" }),
    });
    return prompts;
  }

  const first = await runWithLargeHistory("history-a");
  const second = await runWithLargeHistory("history-b");

  assert.ok(first.every(prompt => Buffer.byteLength(prompt) < 262_144));
  assert.match(first[0], /BEGIN/);
  assert.match(first[0], /\[history truncated\]/);
  assert.match(first[0], /END/);
  assert.match(first.at(-1), /Earlier approved handoffs omitted: [1-9]/);
  assert.match(first.at(-1), /"step": 3/);
  assert.equal(first.at(-1), second.at(-1));
});

test("CHANGELOG renders agent-controlled prose as inert quoted text", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const locations = await fixture();

  await runWorkflow({
    ...loaded,
    workflow: singleRoleWorkflow(loaded),
    prompts: { engineering: loaded.prompts.engineering },
    task: "render untrusted prose safely",
    runId: "quoted-prose",
    ...locations,
    runRole: async () => ({
      receipt: {
        outcome: "completed",
        what: "# forged heading\nnormal text",
        why: "<script>alert(1)</script>\n```",
        evidence: ["- injected bullet", "[click](javascript:alert)"],
        files: ["[fake](javascript:alert)"],
      },
      runtime: { exitCode: 0 },
    }),
    verify: async () => ({ status: "passed", evidence: ["# forged verification"] }),
    publish: async () => ({ url: "https://example.invalid" }),
  });

  const changelog = await readFile(path.join(locations.stateRoot, "quoted-prose", "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^    # forged heading$/m);
  assert.match(changelog, /^    <script>alert\(1\)<\/script>$/m);
  assert.match(changelog, /^    ```$/m);
  assert.match(changelog, /^    - - injected bullet$/m);
  assert.doesNotMatch(changelog, /^(?:# forged heading|<script>|```|- - injected bullet)/m);
});

test("the workflow deadline includes verification and publication", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const workflow = singleRoleWorkflow(loaded);
  workflow.timeouts = { stepSeconds: 10, workflowSeconds: 10 };
  const locations = await fixture();
  const budgets = {};
  let currentMs = 0;

  await assert.rejects(
    runWorkflow({
      ...loaded,
      workflow,
      prompts: { engineering: loaded.prompts.engineering },
      task: "respect the whole-workflow deadline",
      runId: "deadline-run",
      clock: () => currentMs,
      ...locations,
      runRole: async input => {
        budgets.role = input.timeoutSeconds;
        currentMs = 4_000;
        return { receipt: receipt("completed", "engineering"), runtime: { exitCode: 0 } };
      },
      verify: async input => {
        budgets.verify = input.timeoutSeconds;
        currentMs = 7_000;
        return { status: "passed", evidence: ["verified"] };
      },
      publish: async input => {
        budgets.publish = input.timeoutSeconds;
        currentMs = 10_000;
        throw new Error("workflow timeout reached");
      },
    }),
    /workflow timeout reached/,
  );

  assert.deepEqual(budgets, { role: 10, verify: 6, publish: 3 });
  const text = await readFile(path.join(locations.stateRoot, "deadline-run", "events.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).reason, "workflow timeout reached");
  assert.ok(events.some(event => event.type === "verification.finished"));
  assert.ok(!events.some(event => event.type === "publication.finished"));
  assert.ok(!events.some(event => event.type === "run.finished"));
});

test("successful publication remains completed when bookkeeping crosses the deadline", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const workflow = singleRoleWorkflow(loaded);
  workflow.timeouts = { stepSeconds: 10, workflowSeconds: 10 };
  const locations = await fixture();
  let currentMs = 0;
  let committed = false;

  const result = await runWorkflow({
    ...loaded,
    workflow,
    prompts: { engineering: loaded.prompts.engineering },
    task: "finish bookkeeping after the publication commit point",
    runId: "post-commit-bookkeeping",
    clock: () => currentMs,
    now: () => {
      if (committed) currentMs += 1_500;
      return new Date(currentMs);
    },
    ...locations,
    runRole: async () => {
      currentMs = 4_000;
      return { receipt: receipt("completed", "engineering"), runtime: { exitCode: 0 } };
    },
    verify: async () => {
      currentMs = 7_000;
      return { status: "passed", evidence: ["verified"] };
    },
    publish: async input => {
      assert.equal(input.timeoutSeconds, 3);
      currentMs = 9_000;
      committed = true;
      return { url: "http://127.0.0.1:8080" };
    },
  });

  assert.equal(result.status, "completed");
  assert.ok(currentMs > 10_000);
  const text = await readFile(path.join(locations.stateRoot, "post-commit-bookkeeping", "events.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.slice(-2).map(event => event.type), ["publication.finished", "run.finished"]);
  assert.ok(!events.some(event => event.type === "run.failed"));
});

test("bootstrap time consumes a supplied absolute deadline before any role begins", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const workflow = singleRoleWorkflow(loaded);
  workflow.timeouts = { stepSeconds: 10, workflowSeconds: 10 };
  const locations = await fixture();
  let currentMs = 0;
  const deadlineAt = currentMs + (workflow.timeouts.workflowSeconds * 1_000);
  currentMs = deadlineAt;
  let roleCalls = 0;

  await assert.rejects(
    runWorkflow({
      ...loaded,
      workflow,
      prompts: { engineering: loaded.prompts.engineering },
      task: "count bootstrap against the workflow budget",
      runId: "bootstrap-deadline",
      deadlineAt,
      clock: () => currentMs,
      ...locations,
      runRole: async () => {
        roleCalls += 1;
        return { receipt: receipt("completed", "engineering"), runtime: { exitCode: 0 } };
      },
      verify: async () => ({ status: "passed", evidence: ["verified"] }),
      publish: async () => ({ url: "http://127.0.0.1:8080" }),
    }),
    /workflow timeout reached/,
  );

  assert.equal(roleCalls, 0);
  const text = await readFile(path.join(locations.stateRoot, "bootstrap-deadline", "events.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["run.started", "run.failed"]);
});

test("an interrupted controller clock prevents verification and publication", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const locations = await fixture();
  let interrupted = false;
  let verifyCalls = 0;
  let publishCalls = 0;

  await assert.rejects(runWorkflow({
    ...loaded,
    workflow: singleRoleWorkflow(loaded),
    prompts: { engineering: loaded.prompts.engineering },
    task: "stop after controller interruption",
    runId: "controller-interrupted",
    clock: () => {
      if (interrupted) throw new Error("controller interrupted");
      return 0;
    },
    ...locations,
    runRole: async () => {
      interrupted = true;
      return { receipt: receipt("completed", "engineering"), runtime: { exitCode: 0 } };
    },
    verify: async () => {
      verifyCalls += 1;
      return { status: "passed", evidence: ["verified"] };
    },
    publish: async () => {
      publishCalls += 1;
      return { url: "http://127.0.0.1:8080" };
    },
  }), /controller interrupted/);

  assert.equal(verifyCalls, 0);
  assert.equal(publishCalls, 0);
  const text = await readFile(path.join(locations.stateRoot, "controller-interrupted", "events.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.at(-1).reason, "controller interrupted");
});

test("a supplied absolute deadline is finite, non-negative, and cannot extend the workflow budget", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const workflow = singleRoleWorkflow(loaded);
  workflow.timeouts = { stepSeconds: 10, workflowSeconds: 10 };
  const locations = await fixture();
  const input = {
    ...loaded,
    workflow,
    prompts: { engineering: loaded.prompts.engineering },
    task: "validate the absolute deadline",
    runId: "invalid-deadline",
    clock: () => 0,
    ...locations,
    runRole: async () => ({ receipt: receipt("completed", "engineering"), runtime: { exitCode: 0 } }),
    verify: async () => ({ status: "passed", evidence: ["verified"] }),
    publish: async () => ({ url: "http://127.0.0.1:8080" }),
  };

  await assert.rejects(runWorkflow({ ...input, deadlineAt: Number.POSITIVE_INFINITY }), /deadlineAt must be/);
  await assert.rejects(runWorkflow({ ...input, deadlineAt: -1 }), /deadlineAt must be/);
  await assert.rejects(runWorkflow({ ...input, deadlineAt: 10_001 }), /deadlineAt cannot extend/);
});

test("a failed latest update records terminal failure and removes its atomic-write temporary", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const locations = await fixture();
  await mkdir(locations.stateRoot, { recursive: true });
  await mkdir(path.join(locations.stateRoot, "latest"));
  let roleCalls = 0;

  await assert.rejects(runWorkflow({
    ...loaded,
    workflow: singleRoleWorkflow(loaded),
    prompts: { engineering: loaded.prompts.engineering },
    task: "record a failed latest update",
    runId: "latest-write-failure",
    ...locations,
    runRole: async () => {
      roleCalls += 1;
      return { receipt: receipt("completed", "engineering"), runtime: { exitCode: 0 } };
    },
    verify: async () => ({ status: "passed", evidence: ["verified"] }),
    publish: async () => ({ url: "http://127.0.0.1:8080" }),
  }));

  assert.equal(roleCalls, 0);
  const text = await readFile(path.join(locations.stateRoot, "latest-write-failure", "events.jsonl"), "utf8");
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["run.started", "run.failed"]);
  const stateEntries = await readdir(locations.stateRoot);
  assert.ok(!stateEntries.some(entry => /^latest\..*\.tmp$/.test(entry)));
});

test("maxSteps bounds cycles that do not revisit the start", async () => {
  const loaded = await loadWorkflow("react-app", { templateRoot: path.join(root, "templates") });
  const locations = await fixture();
  const cyclic = structuredClone(loaded.workflow);
  cyclic.maxSteps = 3;
  cyclic.roles.qa.on = { passed: "testing" };
  cyclic.roles.testing.on = { passed: "done", failed: "qa" };
  validateWorkflow(cyclic);

  await assert.rejects(
    runWorkflow({
      ...loaded,
      workflow: cyclic,
      task: "bounded cycle",
      runId: "run-bounded",
      ...locations,
      runRole: async input => ({
        receipt: receipt(input.role === "engineering" ? "completed" : input.role === "qa" ? "passed" : "failed", input.role),
        runtime: { exitCode: 0 },
      }),
      verify: async () => ({ status: "passed", evidence: [] }),
      publish: async () => ({ url: "unused" }),
    }),
    /maxSteps 3 reached/,
  );

  const text = await readFile(path.join(locations.stateRoot, "run-bounded", "events.jsonl"), "utf8");
  assert.match(text, /"type":"run.failed"/);
});
