import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { runOrganizer, validateOrganizerInput } from "./organize.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const ORGANIZER_SECONDS = 300;
const CONTROLLER_SECONDS = 600;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

function fail(message) {
  throw new Error(message);
}

function isoTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail("now must return a valid Date");
  return value.toISOString();
}

function safeReason(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(UNSAFE_CONTROL, "")
    .slice(0, 2_000) || "unknown organizer failure";
}

async function atomicWrite(target, value, mode = 0o600) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { flag: "wx", mode });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function changelog(events) {
  const lines = ["# Organizer run", ""];
  for (const event of events) {
    if (event.type === "run.started") {
      lines.push(
        `- Run: ${event.runId}`,
        `- Prompt SHA-256: ${event.promptSha256}`,
        `- Organizers: ${event.agents}`,
        "",
      );
    } else if (event.type === "run.completed") {
      lines.push(
        "## Selection",
        "",
        `- Template: ${event.template}`,
        `- Template digest: ${event.templateDigest}`,
        "",
      );
    } else if (event.type === "run.failed") {
      lines.push("## Failure", "", event.reason, "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

async function prepareRun({ stateRoot, worktreesRoot, runId, agents, promptSha256, now }) {
  const [stateStat, worktreesStat] = await Promise.all([
    lstat(stateRoot).catch(() => null),
    lstat(worktreesRoot).catch(() => null),
  ]);
  for (const [stat, label] of [[stateStat, "state root"], [worktreesStat, "worktrees root"]]) {
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      fail(`${label} must be a private regular directory`);
    }
  }

  const runDir = path.join(stateRoot, runId);
  const workspaceRunDir = path.join(worktreesRoot, runId);
  await mkdir(runDir, { mode: 0o700 });
  try {
    await mkdir(workspaceRunDir, { mode: 0o755 });
    for (let index = 0; index < agents; index += 1) {
      const workspaceDir = path.join(workspaceRunDir, `organizer-${index + 1}`);
      await mkdir(workspaceDir, { mode: 0o755 });
      await writeFile(path.join(workspaceDir, ".git"), "", { flag: "wx", mode: 0o444 });
    }
    await writeFile(path.join(runDir, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
    await atomicWrite(path.join(stateRoot, "latest"), `${runId}\n`);
  } catch (error) {
    await Promise.all([
      rm(runDir, { recursive: true, force: true }),
      rm(workspaceRunDir, { recursive: true, force: true }),
    ]).catch(() => {});
    throw error;
  }

  const startedAt = isoTimestamp(now);
  const events = [];
  let sequence = 0;
  const record = async (type, details = {}) => {
    const event = {
      version: 1,
      sequence: ++sequence,
      timestamp: isoTimestamp(now),
      runId,
      type,
      ...details,
    };
    events.push(event);
    await appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await atomicWrite(path.join(runDir, "CHANGELOG.md"), changelog(events));
    return event;
  };
  const writeRun = value => atomicWrite(path.join(runDir, "run.json"), `${JSON.stringify(value, null, 2)}\n`);

  await writeRun({
    version: 1,
    runId,
    type: "organizer",
    status: "running",
    promptSha256,
    agents,
    startedAt,
    finishedAt: null,
  });
  return { runDir, workspaceRunDir, startedAt, record, writeRun };
}

export async function runOrganizerController({
  prompt,
  agents,
  catalog,
  baseInstructions,
  model,
  agentRuntime = "unspecified",
  runtime,
  stateRoot = "/state",
  worktreesRoot = "/worktrees",
  runId,
  now = () => new Date(),
  clock = () => Date.now(),
  signalEmitter = process,
} = {}) {
  const validated = validateOrganizerInput({ prompt, agents, catalog });
  if (!RUN_ID.test(runId ?? "")) fail("organizer run ID is invalid");
  if (!runtime || typeof runtime !== "object") fail("organizer runtime is invalid");
  for (const method of ["imageDigest", "start", "runAgentExecution", "cancel", "close"]) {
    if (typeof runtime[method] !== "function") fail(`organizer runtime requires ${method}`);
  }
  if (typeof baseInstructions !== "string" || !baseInstructions.trim()) {
    fail("organizer base instructions are required");
  }
  if (typeof model !== "string" || !model) fail("organizer model is required");
  if (typeof clock !== "function" || typeof now !== "function") fail("organizer clocks are invalid");
  if (!signalEmitter || typeof signalEmitter.once !== "function" || typeof signalEmitter.off !== "function") {
    fail("organizer signal emitter is invalid");
  }

  const invokedAt = clock();
  if (!Number.isSafeInteger(invokedAt) || invokedAt < 0) fail("clock must return safe millisecond time");
  const deadlineAt = invokedAt + CONTROLLER_SECONDS * 1_000;
  const promptSha256 = createHash("sha256").update(validated.prompt, "utf8").digest("hex");
  const state = await prepareRun({
    stateRoot: path.resolve(stateRoot),
    worktreesRoot: path.resolve(worktreesRoot),
    runId,
    agents: validated.agents,
    promptSha256,
    now,
  });

  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void runtime.cancel();
  };
  signalEmitter.once("SIGINT", stop);
  signalEmitter.once("SIGTERM", stop);
  try {
    const imageDigest = await runtime.imageDigest({ deadlineAt });
    await state.record("run.started", {
      promptSha256,
      agents: validated.agents,
      model,
      agentRuntime,
      imageDigest,
    });
    await runtime.start({ deadlineAt, bootstrap: false });
    if (interrupted) fail("organizer controller interrupted");

    const result = await runOrganizer({
      prompt: validated.prompt,
      agents: validated.agents,
      catalog: validated.catalog,
      baseInstructions,
      timeoutMs: (ORGANIZER_SECONDS + 30) * 1_000,
      runAgent: async ({ index, prompt: agentPrompt, signal }) => {
        if (interrupted) fail("organizer controller interrupted");
        const cancel = () => { void runtime.cancel(); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          return await runtime.runAgentExecution({
            executionId: `organizer-${index + 1}`,
            role: "organizer",
            attempt: 1,
            access: "read",
            prompt: agentPrompt,
            timeoutSeconds: ORGANIZER_SECONDS,
            runId,
            workspaceId: `organizer-${index + 1}`,
            writeDirectories: [],
          });
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      },
    });
    if (interrupted) fail("organizer controller interrupted");
    const finishedAt = isoTimestamp(now);
    const response = { ...result, runId };
    await state.record("run.completed", {
      template: response.template,
      templateDigest: response.templateDigest,
      votes: response.votes,
    });
    await state.writeRun({
      version: 1,
      runId,
      type: "organizer",
      status: "completed",
      promptSha256,
      agents: validated.agents,
      startedAt: state.startedAt,
      finishedAt,
      result: response,
    });
    return response;
  } catch (error) {
    await runtime.cancel().catch(() => {});
    const reason = safeReason(error);
    const finishedAt = isoTimestamp(now);
    await state.record("run.failed", { reason }).catch(() => {});
    await state.writeRun({
      version: 1,
      runId,
      type: "organizer",
      status: "failed",
      promptSha256,
      agents: validated.agents,
      startedAt: state.startedAt,
      finishedAt,
      reason,
    }).catch(() => {});
    throw error;
  } finally {
    signalEmitter.off("SIGINT", stop);
    signalEmitter.off("SIGTERM", stop);
    await runtime.close();
    await rm(state.workspaceRunDir, { recursive: true, force: true }).catch(() => {});
  }
}
