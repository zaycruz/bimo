import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOrganizerController } from "../src/organizer-controller.mjs";

const CATALOG = [
  {
    template: "react-app",
    templateDigest: "a".repeat(64),
    acceptedOptions: ["--deployment", "--task-file"],
    kind: "workflow",
    roles: ["engineering", "qa", "testing"],
    maxSteps: 15,
  },
  {
    template: "react-solo",
    templateDigest: "b".repeat(64),
    acceptedOptions: ["--deployment", "--task-file"],
    kind: "workflow",
    roles: ["engineering"],
    maxSteps: 1,
  },
];
const PROMPT = "Build a small status page with a readable health indicator.";
const BASE_INSTRUCTIONS = "You are a bounded, read-only template planner.";
const MODEL = "openrouter/deepseek/deepseek-v4-flash";
const IMAGE_DIGEST = "sha256:organizer-image";

function receipt(template = "react-app", reason = "The installed template matches the assignment.") {
  const entry = CATALOG.find(candidate => candidate.template === template);
  return {
    version: 1,
    template,
    templateDigest: entry.templateDigest,
    reason,
  };
}

async function fixture(t, runId) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-organizer-controller-"));
  const stateRoot = path.join(temporary, "state");
  const worktreesRoot = path.join(temporary, "worktrees");
  await Promise.all([
    mkdir(stateRoot, { mode: 0o700 }),
    mkdir(worktreesRoot, { mode: 0o700 }),
  ]);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return {
    temporary,
    stateRoot,
    worktreesRoot,
    runDir: path.join(stateRoot, runId),
    workspaceRunDir: path.join(worktreesRoot, runId),
  };
}

function controllerInput(locations, runtime, signalEmitter = new EventEmitter(), overrides = {}) {
  return {
    prompt: PROMPT,
    agents: 3,
    catalog: CATALOG,
    baseInstructions: BASE_INSTRUCTIONS,
    model: MODEL,
    runtime,
    stateRoot: locations.stateRoot,
    worktreesRoot: locations.worktreesRoot,
    runId: path.basename(locations.runDir),
    now: () => new Date("2026-08-25T12:00:00.000Z"),
    clock: () => 1_000,
    signalEmitter,
    ...overrides,
  };
}

function mode(stat) {
  return stat.mode & 0o777;
}

async function exists(target) {
  return Boolean(await lstat(target).catch(() => null));
}

test("runs a majority organizer with read-only exact workspaces and durable completion state", async t => {
  const runId = "organizer-success";
  const locations = await fixture(t, runId);
  const signalEmitter = new EventEmitter();
  const calls = { imageDigest: [], start: [], executions: [], cancel: 0, close: 0 };
  const runtime = {
    async imageDigest(input) {
      calls.imageDigest.push(input);
      return IMAGE_DIGEST;
    },
    async start(input) {
      calls.start.push(input);
    },
    async runAgentExecution(input) {
      calls.executions.push(input);
      assert.deepEqual(await readdir(locations.workspaceRunDir), [
        "organizer-1",
        "organizer-2",
        "organizer-3",
      ]);
      const gitMaskTarget = await lstat(path.join(
        locations.workspaceRunDir,
        input.workspaceId,
        ".git",
      ));
      assert.equal(gitMaskTarget.isFile(), true);
      assert.equal(gitMaskTarget.isSymbolicLink(), false);
      assert.equal(mode(gitMaskTarget), 0o444);
      return receipt(input.executionId === "organizer-3" ? "react-solo" : "react-app");
    },
    async cancel() {
      calls.cancel += 1;
    },
    async close() {
      calls.close += 1;
    },
  };

  const result = await runOrganizerController(controllerInput(locations, runtime, signalEmitter));

  assert.equal(result.status, "planned");
  assert.equal(result.template, "react-app");
  assert.equal(result.runId, runId);
  assert.deepEqual(calls.imageDigest, [{ deadlineAt: 601_000 }]);
  assert.deepEqual(calls.start, [{ deadlineAt: 601_000, bootstrap: false }]);
  assert.equal(calls.executions.length, 3);
  assert.deepEqual(calls.executions.map(input => input.executionId), [
    "organizer-1",
    "organizer-2",
    "organizer-3",
  ]);
  assert.deepEqual(calls.executions.map(input => input.workspaceId), [
    "organizer-1",
    "organizer-2",
    "organizer-3",
  ]);
  assert(calls.executions.every(input => input.role === "organizer"));
  assert(calls.executions.every(input => input.attempt === 1));
  assert(calls.executions.every(input => input.access === "read"));
  assert(calls.executions.every(input => input.timeoutSeconds === 300));
  assert(calls.executions.every(input => input.runId === runId));
  assert(calls.executions.every(input => Array.isArray(input.writeDirectories)
    && input.writeDirectories.length === 0));
  assert.equal(new Set(calls.executions.map(input => input.prompt)).size, 1);
  assert.notEqual(calls.executions[0].prompt, PROMPT);
  assert.match(calls.executions[0].prompt, /bounded, read-only template planner/);
  assert.match(calls.executions[0].prompt, /Original assignment/);
  assert.match(calls.executions[0].prompt, /react-app/);
  assert.equal(calls.cancel, 0);
  assert.equal(calls.close, 1);
  assert.equal(signalEmitter.listenerCount("SIGINT"), 0);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);

  assert.equal(await exists(locations.workspaceRunDir), false);
  assert.equal(mode(await lstat(locations.stateRoot)), 0o700);
  assert.equal(mode(await lstat(locations.worktreesRoot)), 0o700);
  assert.equal(mode(await lstat(locations.runDir)), 0o700);
  assert.equal(mode(await lstat(path.join(locations.runDir, "run.json"))), 0o600);
  assert.equal(mode(await lstat(path.join(locations.runDir, "events.jsonl"))), 0o600);
  assert.equal(mode(await lstat(path.join(locations.runDir, "CHANGELOG.md"))), 0o600);
  assert.equal(mode(await lstat(path.join(locations.stateRoot, "latest"))), 0o600);
  assert.equal(await readFile(path.join(locations.stateRoot, "latest"), "utf8"), `${runId}\n`);

  const run = JSON.parse(await readFile(path.join(locations.runDir, "run.json"), "utf8"));
  assert.equal(run.status, "completed");
  assert.equal(run.runId, runId);
  assert.deepEqual(run.result, result);
  assert.equal(run.finishedAt, "2026-08-25T12:00:00.000Z");

  const events = (await readFile(path.join(locations.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["run.started", "run.completed"]);
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.equal(events[0].agents, 3);
  assert.equal(events[0].model, MODEL);
  assert.equal(events[0].agentRuntime, "unspecified");
  assert.equal(events[0].imageDigest, IMAGE_DIGEST);
  assert.equal(events[1].template, "react-app");
  assert.equal(events[1].templateDigest, CATALOG[0].templateDigest);

  const changelog = await readFile(path.join(locations.runDir, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`Run: ${runId}`));
  assert.match(changelog, new RegExp(`Prompt SHA-256: ${run.promptSha256}`));
  assert.match(changelog, /Organizers: 3/);
  assert.match(changelog, /Template: react-app/);
  assert.match(changelog, new RegExp(`Template digest: ${CATALOG[0].templateDigest}`));
});

test("cancels and durably fails on a malformed receipt without handing off", async t => {
  const runId = "organizer-malformed";
  const locations = await fixture(t, runId);
  const calls = { executions: 0, cancel: 0, close: 0 };
  const runtime = {
    async imageDigest() {
      return IMAGE_DIGEST;
    },
    async start() {},
    async runAgentExecution() {
      calls.executions += 1;
      return { version: 1, template: "react-app" };
    },
    async cancel() {
      calls.cancel += 1;
    },
    async close() {
      calls.close += 1;
    },
  };

  await assert.rejects(
    runOrganizerController(controllerInput(locations, runtime)),
    /invalid receipt|exactly version, template, templateDigest, reason/,
  );

  assert.equal(calls.executions, 3);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.close, 1);
  assert.equal(await exists(locations.workspaceRunDir), false);
  const run = JSON.parse(await readFile(path.join(locations.runDir, "run.json"), "utf8"));
  assert.equal(run.status, "failed");
  assert.equal(Object.hasOwn(run, "result"), false);
  assert.match(run.reason, /invalid receipt|exactly version, template, templateDigest, reason/);
  const events = (await readFile(path.join(locations.runDir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ["run.started", "run.failed"]);
  assert.equal(events.at(-1).reason, run.reason);
  const changelog = await readFile(path.join(locations.runDir, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## Failure/);
  assert.match(changelog, new RegExp(run.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("signal cancellation aborts the controller and always removes listeners and closes runtime", async t => {
  const runId = "organizer-signal";
  const locations = await fixture(t, runId);
  const signalEmitter = new EventEmitter();
  const calls = { cancel: 0, close: 0, executions: 0 };
  const runtime = {
    async imageDigest() {
      return IMAGE_DIGEST;
    },
    async start() {
      signalEmitter.emit("SIGTERM");
    },
    async runAgentExecution() {
      calls.executions += 1;
      return receipt();
    },
    async cancel() {
      calls.cancel += 1;
    },
    async close() {
      calls.close += 1;
    },
  };

  await assert.rejects(
    runOrganizerController(controllerInput(locations, runtime, signalEmitter)),
    /organizer controller interrupted/,
  );

  assert.equal(calls.executions, 0);
  assert.ok(calls.cancel >= 1);
  assert.equal(calls.close, 1);
  assert.equal(signalEmitter.listenerCount("SIGINT"), 0);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
  assert.equal(await exists(locations.workspaceRunDir), false);
  const run = JSON.parse(await readFile(path.join(locations.runDir, "run.json"), "utf8"));
  assert.equal(run.status, "failed");
  assert.match(run.reason, /organizer controller interrupted/);
});
