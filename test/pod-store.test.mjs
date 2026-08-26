import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPodRunStore, openPodRunStore, prunePodRuns } from "../src/pod-store.mjs";

function permissions(stat) {
  return stat.mode & 0o777;
}

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "runs");
  const timestamps = [
    "2026-08-25T12:00:00.000Z",
    "2026-08-25T12:00:01.000Z",
    "2026-08-25T12:00:02.000Z",
    "2026-08-25T12:00:03.000Z",
    "2026-08-25T12:00:04.000Z",
    "2026-08-25T12:00:05.000Z",
  ];
  let timestamp = 0;
  const store = await createPodRunStore({
    stateRoot,
    runId: "pod-run-1",
    assignment: {
      repository: "https://github.com/zaycruz/bimo.git",
      baseSha: "a".repeat(40),
      task: "Build the requested change.",
    },
    now: () => new Date(timestamps[timestamp++] ?? timestamps.at(-1)),
    ...options,
  });
  return { stateRoot, store };
}

async function storedRun(stateRoot, runId, { status, finishedAt }) {
  const times = ["2026-08-25T11:00:00.000Z", finishedAt];
  let index = 0;
  const store = await createPodRunStore({
    stateRoot,
    runId,
    assignment: { task: `retain ${runId}` },
    now: () => new Date(times[index++] ?? times.at(-1)),
  });
  if (status !== "running") await store.finish(status, { phase: "finished" });
  return store.runDir;
}

test("a pod run stores private metadata and contiguous audit events", async (t) => {
  const { store } = await fixture(t);

  const first = await store.appendEvent("plan.started", { attempt: 1 });
  const second = await store.appendEvent("plan.finished", { attempt: 1 });

  assert.equal(permissions(await lstat(store.runDir)), 0o700);
  assert.equal(permissions(await lstat(path.join(store.runDir, "run.json"))), 0o600);
  assert.equal(permissions(await lstat(path.join(store.runDir, "events.jsonl"))), 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(store.runDir, "run.json"), "utf8")), {
    version: 1,
    runId: "pod-run-1",
    assignment: {
      repository: "https://github.com/zaycruz/bimo.git",
      baseSha: "a".repeat(40),
      task: "Build the requested change.",
    },
    status: "running",
    phase: "created",
    currentAttempt: 0,
    startedAt: "2026-08-25T12:00:00.000Z",
    finishedAt: null,
  });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(
    (await readFile(path.join(store.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line)),
    [
      {
        attempt: 1,
        version: 1,
        sequence: 1,
        timestamp: "2026-08-25T12:00:01.000Z",
        runId: "pod-run-1",
        type: "plan.started",
      },
      {
        attempt: 1,
        version: 1,
        sequence: 2,
        timestamp: "2026-08-25T12:00:02.000Z",
        runId: "pod-run-1",
        type: "plan.finished",
      },
    ],
  );
});

test("an attempt plan is durable, private, and immutable", async (t) => {
  const { store } = await fixture(t);
  const plan = {
    requirements: [{ id: "REQ-1", text: "Keep the store bounded." }],
    workItems: [
      { id: "work-a", ownerSlot: "engineering-a", writePaths: ["src/a"] },
      { id: "work-b", ownerSlot: "engineering-b", writePaths: ["src/b"] },
      { id: "qa-tests", ownerSlot: "qa-tests", writePaths: ["test"] },
    ],
  };

  assert.deepEqual(await store.writeAttemptPlan(1, plan), plan);

  const attemptDir = path.join(store.runDir, "attempts", "1");
  const planPath = path.join(attemptDir, "plan.json");
  assert.equal(permissions(await lstat(path.join(store.runDir, "attempts"))), 0o700);
  assert.equal(permissions(await lstat(attemptDir)), 0o700);
  assert.equal(permissions(await lstat(planPath)), 0o600);
  assert.deepEqual(JSON.parse(await readFile(planPath, "utf8")), plan);
  assert.deepEqual(
    {
      currentAttempt: JSON.parse(await readFile(path.join(store.runDir, "run.json"), "utf8")).currentAttempt,
      phase: JSON.parse(await readFile(path.join(store.runDir, "run.json"), "utf8")).phase,
    },
    { currentAttempt: 1, phase: "planned" },
  );

  await assert.rejects(
    store.writeAttemptPlan(1, { ...plan, requirements: [] }),
    /attempt 1 plan already exists/,
  );
  assert.deepEqual(JSON.parse(await readFile(planPath, "utf8")), plan);
});

test("work results append without replacing earlier evidence", async (t) => {
  const { store } = await fixture(t);
  await store.writeAttemptPlan(1, { workItems: ["work-a", "work-b"] });
  const first = {
    workItemId: "work-a",
    baseSha: "a".repeat(40),
    resultSha: "b".repeat(40),
    outcome: "passed",
    inboxCursor: 0,
  };
  const second = {
    workItemId: "work-b",
    baseSha: "a".repeat(40),
    resultSha: "c".repeat(40),
    outcome: "blocked",
    inboxCursor: 1,
  };

  assert.deepEqual(await store.writeWorkResult(1, first), first);
  assert.deepEqual(await store.writeWorkResult(1, second), second);

  const resultsPath = path.join(store.runDir, "attempts", "1", "work-results.jsonl");
  assert.equal(permissions(await lstat(resultsPath)), 0o600);
  assert.deepEqual(
    (await readFile(resultsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
    [first, second],
  );
});

test("gate receipts append in the attempt they certify", async (t) => {
  const { store } = await fixture(t);
  await store.writeAttemptPlan(1, { workItems: [] });
  const checker = {
    gate: "checker-a",
    subjectSha: "b".repeat(40),
    outcome: "passed",
    why: "The exact writer result satisfies its brief.",
    evidence: ["focused unit test passed"],
  };
  const testing = {
    gate: "testing",
    subjectSha: "c".repeat(40),
    outcome: "failed",
    why: "A trusted regression test failed.",
    evidence: ["node --test exited 1"],
  };

  assert.deepEqual(await store.writeGateReceipt(1, checker), checker);
  assert.deepEqual(await store.writeGateReceipt(1, testing), testing);

  const receiptsPath = path.join(store.runDir, "attempts", "1", "gate-receipts.jsonl");
  assert.equal(permissions(await lstat(receiptsPath)), 0o600);
  assert.deepEqual(
    (await readFile(receiptsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
    [checker, testing],
  );
});

test("each Engineering inbox has a monotonic cursor and replay after a cursor", async (t) => {
  const { store } = await fixture(t);
  await store.writeAttemptPlan(1, { workItems: ["work-a", "work-b"] });
  const request = {
    requestingWorkItemId: "work-a",
    requestedPath: "src/b/interface.mjs",
    need: "Expose the parsed result.",
    why: "Engineering A consumes the interface.",
    requesterCheckpointSha: "a".repeat(40),
  };

  const first = await store.enqueueInbox(1, "engineering-b", request);
  const second = await store.enqueueInbox(1, "engineering-b", {
    ...request,
    requestedPath: "src/b/errors.mjs",
    need: "Export the typed error.",
  });
  const otherOwner = await store.enqueueInbox(1, "engineering-a", {
    ...request,
    requestingWorkItemId: "work-b",
    requestedPath: "src/a/client.mjs",
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(otherOwner.sequence, 1);
  assert.deepEqual(await store.readInbox(1, "engineering-b"), [first, second]);
  assert.deepEqual(
    await store.readInbox(1, "engineering-b", { afterSequence: 1 }),
    [second],
  );
  assert.deepEqual(
    await store.readInbox(1, "engineering-b", { afterSequence: 1 }),
    [second],
  );
  assert.deepEqual(
    await store.readInbox(1, "engineering-b", { afterSequence: 2 }),
    [],
  );

  const inboxDir = path.join(store.runDir, "attempts", "1", "inbox");
  const ownerPath = path.join(inboxDir, "engineering-b.jsonl");
  assert.equal(permissions(await lstat(inboxDir)), 0o700);
  assert.equal(permissions(await lstat(ownerPath)), 0o600);
  assert.deepEqual(
    (await readFile(ownerPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)),
    [first, second],
  );
});

test("finish atomically records one terminal summary and final audit event", async (t) => {
  const { store } = await fixture(t);
  const details = {
    phase: "published",
    testedSha: "d".repeat(40),
    prReceipt: { number: 42, url: "https://github.com/zaycruz/bimo/pull/42" },
  };

  const finished = await store.finish("completed", details);

  assert.equal(finished.status, "completed");
  assert.equal(finished.phase, "published");
  assert.equal(finished.finishedAt, "2026-08-25T12:00:01.000Z");
  assert.equal(finished.testedSha, "d".repeat(40));
  assert.deepEqual(
    JSON.parse(await readFile(path.join(store.runDir, "run.json"), "utf8")),
    finished,
  );
  assert.deepEqual(
    (await readFile(path.join(store.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line)),
    [{
      ...details,
      status: "completed",
      version: 1,
      sequence: 1,
      timestamp: "2026-08-25T12:00:01.000Z",
      runId: "pod-run-1",
      type: "run.finished",
    }],
  );
  await assert.rejects(store.finish("failed", { reason: "late" }), /run is already finished/);
  await assert.rejects(store.appendEvent("late.event"), /run is already finished/);
});

test("run and inbox paths are fixed to safe controller-owned locations", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-store-paths-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const common = {
    stateRoot: path.join(temporary, "runs"),
    assignment: { task: "bounded" },
  };
  for (const runId of ["../escape", "nested/run", ".hidden", "x".repeat(81)]) {
    await assert.rejects(createPodRunStore({ ...common, runId }), /invalid run ID/);
  }

  const outside = path.join(temporary, "outside");
  const linkedRoot = path.join(temporary, "linked-runs");
  await mkdir(outside);
  await symlink(outside, linkedRoot);
  await assert.rejects(
    createPodRunStore({ ...common, stateRoot: linkedRoot, runId: "linked-run" }),
    /stateRoot must be a regular directory/,
  );

  const { stateRoot, store } = await fixture(t);
  await assert.rejects(
    createPodRunStore({ ...common, stateRoot, runId: "pod-run-1" }),
    /run already exists: pod-run-1/,
  );
  await store.writeAttemptPlan(1, { workItems: [] });
  await assert.rejects(
    store.enqueueInbox(1, "qa-tests", { requestingWorkItemId: "qa" }),
    /inbox owner must be engineering-a or engineering-b/,
  );
  await assert.rejects(
    store.readInbox(1, "engineering-a", { afterSequence: -1 }),
    /afterSequence must be a non-negative safe integer/,
  );
});

test("every durable record rejects payloads larger than 64 KiB before writing", async (t) => {
  const oversized = { payload: "x".repeat(70 * 1024) };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-store-size-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await assert.rejects(
    createPodRunStore({
      stateRoot: path.join(temporary, "runs"),
      runId: "oversized-run",
      assignment: oversized,
    }),
    /run record must serialize to at most 65536 bytes/,
  );

  const { store } = await fixture(t);
  await assert.rejects(
    store.appendEvent("oversized.event", oversized),
    /event must serialize to at most 65536 bytes/,
  );
  await assert.rejects(
    store.writeAttemptPlan(1, oversized),
    /attempt plan must serialize to at most 65536 bytes/,
  );
  assert.equal(
    await lstat(path.join(store.runDir, "attempts", "1", "plan.json")).catch(() => null),
    null,
  );

  await store.writeAttemptPlan(1, { workItems: [] });
  await assert.rejects(
    store.writeWorkResult(1, oversized),
    /work result must serialize to at most 65536 bytes/,
  );
  await assert.rejects(
    store.writeGateReceipt(1, oversized),
    /gate receipt must serialize to at most 65536 bytes/,
  );
  await assert.rejects(
    store.enqueueInbox(1, "engineering-a", oversized),
    /inbox entry must serialize to at most 65536 bytes/,
  );
  await assert.rejects(
    store.finish("failed", oversized),
    /run record must serialize to at most 65536 bytes/,
  );

  assert.equal((await store.appendEvent("valid.event")).sequence, 1);
  assert.equal((await store.enqueueInbox(1, "engineering-a", { need: "small" })).sequence, 1);
});

test("concurrent event appends remain contiguous in durable order", async (t) => {
  const { store } = await fixture(t);

  const events = await Promise.all(
    Array.from({ length: 25 }, (_, index) => store.appendEvent("work.updated", { index })),
  );

  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.deepEqual(
    (await readFile(path.join(store.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line).sequence),
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
});

test("attempts and append-only per-owner records have fixed count limits", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.writeAttemptPlan(11, { workItems: [] }),
    /attempt must be between 1 and 10/,
  );
  await store.writeAttemptPlan(1, { workItems: [] });

  for (let index = 0; index < 100; index += 1) {
    const entry = await store.enqueueInbox(1, "engineering-a", { need: `request-${index}` });
    assert.equal(entry.sequence, index + 1);
  }
  await assert.rejects(
    store.enqueueInbox(1, "engineering-a", { need: "one-too-many" }),
    /inbox engineering-a for attempt 1 exceeds 100 entries/,
  );
  assert.equal((await store.readInbox(1, "engineering-a")).length, 100);
});

test("publication can narrowly reopen a validated active run and continue its audit sequence", async (t) => {
  const { stateRoot, store } = await fixture(t);
  const ready = await store.appendEvent("publication.ready", {
    repository: "https://github.com/zaycruz/bimo.git",
    targetBranch: "main",
    baseSha: "a".repeat(40),
    candidateSha: "b".repeat(40),
    headBranch: "bimo/pod-run-1",
  });

  const reopened = await openPodRunStore({
    stateRoot,
    runId: "pod-run-1",
    now: () => new Date("2026-08-25T12:01:00.000Z"),
  });

  assert.equal(reopened.run.status, "running");
  assert.deepEqual(reopened.events, [ready]);
  assert.deepEqual(Object.keys(reopened).sort(), [
    "appendEvent",
    "events",
    "finish",
    "run",
    "runDir",
  ]);
  assert.equal((await reopened.appendEvent("publication.finished", { number: 42 })).sequence, 2);
  const terminal = await reopened.finish("completed", { phase: "published" });
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.phase, "published");
  assert.deepEqual(
    (await readFile(path.join(store.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line).sequence),
    [1, 2, 3],
  );
});

test("pruning keeps the newest terminal runs by durable finished time", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-prune-order-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "runs");
  const oldest = await storedRun(stateRoot, "old-completed", {
    status: "completed",
    finishedAt: "2026-08-25T12:00:01.000Z",
  });
  const middle = await storedRun(stateRoot, "middle-failed", {
    status: "failed",
    finishedAt: "2026-08-25T12:00:02.000Z",
  });
  const newest = await storedRun(stateRoot, "new-cancelled", {
    status: "cancelled",
    finishedAt: "2026-08-25T12:00:03.000Z",
  });

  assert.deepEqual(await prunePodRuns({ stateRoot, keepTerminalRuns: 2 }), {
    examined: 3,
    retained: 2,
    deleted: 1,
  });
  assert.equal(await lstat(oldest).catch(() => null), null);
  assert.equal((await lstat(middle)).isDirectory(), true);
  assert.equal((await lstat(newest)).isDirectory(), true);
});

test("pruning never removes a running run", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-prune-running-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "runs");
  const running = await storedRun(stateRoot, "active-run", {
    status: "running",
    finishedAt: null,
  });
  const terminal = await storedRun(stateRoot, "finished-run", {
    status: "completed",
    finishedAt: "2026-08-25T12:00:01.000Z",
  });

  assert.deepEqual(await prunePodRuns({ stateRoot, keepTerminalRuns: 0 }), {
    examined: 2,
    retained: 1,
    deleted: 1,
  });
  assert.equal((await lstat(running)).isDirectory(), true);
  assert.equal(await lstat(terminal).catch(() => null), null);
});

test("pruning retains invalid entries and never follows run-directory symlinks", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-prune-invalid-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "runs");
  const terminal = await storedRun(stateRoot, "terminal-run", {
    status: "failed",
    finishedAt: "2026-08-25T12:00:01.000Z",
  });
  const invalid = path.join(stateRoot, "invalid-run");
  await mkdir(invalid, { mode: 0o700 });
  await writeFile(path.join(invalid, "run.json"), "{}\n", { mode: 0o600 });
  await writeFile(path.join(invalid, "events.jsonl"), "", { mode: 0o600 });
  const unsafe = path.join(stateRoot, ".not-a-run");
  await mkdir(unsafe, { mode: 0o700 });
  const outside = path.join(temporary, "outside");
  const sentinel = path.join(outside, "sentinel");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(sentinel, "preserve me", { mode: 0o600 });
  const linkedRun = path.join(stateRoot, "linked-run");
  await symlink(outside, linkedRun);

  assert.deepEqual(await prunePodRuns({ stateRoot, keepTerminalRuns: 0 }), {
    examined: 2,
    retained: 1,
    deleted: 1,
  });
  assert.equal(await lstat(terminal).catch(() => null), null);
  assert.equal((await lstat(invalid)).isDirectory(), true);
  assert.equal((await lstat(unsafe)).isDirectory(), true);
  assert.equal((await lstat(linkedRun)).isSymbolicLink(), true);
  assert.equal(await readFile(sentinel, "utf8"), "preserve me");

  const linkedRoot = path.join(temporary, "linked-root");
  await symlink(stateRoot, linkedRoot);
  await assert.rejects(
    prunePodRuns({ stateRoot: linkedRoot }),
    /stateRoot must be a private regular directory/,
  );
  await assert.rejects(
    prunePodRuns({ stateRoot: `${stateRoot}\/..\/runs` }),
    /stateRoot must be an absolute canonical path/,
  );
});

test("pruning fails closed before deletion when the run-directory cap is exceeded", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-pod-prune-cap-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "runs");
  const terminal = await storedRun(stateRoot, "terminal-run", {
    status: "completed",
    finishedAt: "2026-08-25T12:00:01.000Z",
  });
  const runIds = Array.from(
    { length: 1_000 },
    (_, index) => `run-${String(index).padStart(4, "0")}`,
  );
  await Promise.all(runIds.map(runId => mkdir(path.join(stateRoot, runId), { mode: 0o700 })));

  await assert.rejects(
    prunePodRuns({ stateRoot, keepTerminalRuns: 0 }),
    /stateRoot exceeds 1000 run directories/,
  );
  assert.equal((await lstat(terminal)).isDirectory(), true);
  assert.equal((await lstat(path.join(stateRoot, runIds[0]))).isDirectory(), true);
  assert.equal((await lstat(path.join(stateRoot, runIds.at(-1)))).isDirectory(), true);
});
