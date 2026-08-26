import { appendFile, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EVENT_TYPE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const INBOX_OWNERS = new Set(["engineering-a", "engineering-b"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_ATTEMPTS = 10;
const MAX_COLLECTION_RECORDS = 100;
const MAX_EVENTS = 1_000;
const MAX_RUN_DIRECTORIES = 1_000;

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function validateJson(value, label, depth = 0, ancestors = new Set()) {
  if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") fail(`${label} must contain only JSON values`);
  if (ancestors.has(value)) fail(`${label} must not contain cycles`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype) {
    fail(`${label} must contain only plain JSON objects`);
  }
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) fail(`${label} must not contain accessors`);
    validateJson(descriptor.value, label, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function cloneJson(value, label) {
  validateJson(value, label);
  return JSON.parse(JSON.stringify(value));
}

function serializeRecord(value, label, { pretty = false } = {}) {
  const cloned = cloneJson(value, label);
  const compact = JSON.stringify(cloned);
  const content = `${pretty ? JSON.stringify(cloned, null, 2) : compact}\n`;
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
    fail(`${label} must serialize to at most ${MAX_RECORD_BYTES} bytes`);
  }
  return { value: cloned, content };
}

function timestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail("now must return a valid Date");
  }
  return value.toISOString();
}

async function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicCreate(target, content) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function attemptNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ATTEMPTS) {
    fail(`attempt must be between 1 and ${MAX_ATTEMPTS}`);
  }
  return value;
}

function inboxOwner(value) {
  if (!INBOX_OWNERS.has(value)) fail("inbox owner must be engineering-a or engineering-b");
  return value;
}

function cursor(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("afterSequence must be a non-negative safe integer");
  }
  return value;
}

function validStoredTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

async function privateEntry(target, label, type, mode) {
  const stat = await lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat[type]() || (stat.mode & 0o777) !== mode) {
    fail(`${label} must be a private regular ${type === "isFile" ? "file" : "directory"}`);
  }
  return stat;
}

function parseStoredObject(content, label) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    fail(`${label} contains invalid JSON`);
  }
  plainObject(value, label);
  validateJson(value, label);
  return value;
}

export async function prunePodRuns({ stateRoot, keepTerminalRuns = 20 }) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || stateRoot.includes("\0")
      || !path.isAbsolute(stateRoot) || path.resolve(stateRoot) !== stateRoot) {
    fail("stateRoot must be an absolute canonical path");
  }
  if (!Number.isSafeInteger(keepTerminalRuns) || keepTerminalRuns < 0) {
    fail("keepTerminalRuns must be a non-negative safe integer");
  }
  await privateEntry(stateRoot, "stateRoot", "isDirectory", 0o700);

  const entries = await readdir(stateRoot, { withFileTypes: true });
  const runIds = entries
    .filter(entry => RUN_ID.test(entry.name) && entry.isDirectory())
    .map(entry => entry.name);
  if (runIds.length > MAX_RUN_DIRECTORIES) {
    fail(`stateRoot exceeds ${MAX_RUN_DIRECTORIES} run directories`);
  }

  const terminal = [];
  for (const runId of runIds) {
    const runDir = path.join(stateRoot, runId);
    const identity = await lstat(runDir).catch(() => null);
    if (!identity?.isDirectory() || identity.isSymbolicLink()
        || (identity.mode & 0o777) !== 0o700) {
      continue;
    }
    try {
      const store = await openPodRunStore({ stateRoot, runId });
      if (TERMINAL_STATUSES.has(store.run.status)) {
        terminal.push({ runId, runDir, identity, finishedAt: store.run.finishedAt });
      }
    } catch {
      // Invalid and changing entries are retained fail-closed.
    }
  }

  terminal.sort((left, right) => (
    right.finishedAt.localeCompare(left.finishedAt) || left.runId.localeCompare(right.runId)
  ));
  let deleted = 0;
  for (const candidate of terminal.slice(keepTerminalRuns)) {
    const current = await lstat(candidate.runDir).catch(() => null);
    if (!current?.isDirectory() || current.isSymbolicLink()
        || (current.mode & 0o777) !== 0o700
        || current.dev !== candidate.identity.dev || current.ino !== candidate.identity.ino) {
      continue;
    }
    await rm(candidate.runDir, { recursive: true, force: true });
    deleted += 1;
  }

  return Object.freeze({
    examined: runIds.length,
    retained: runIds.length - deleted,
    deleted,
  });
}

export async function createPodRunStore({ stateRoot, runId, assignment, now = () => new Date() }) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || stateRoot.includes("\0")) {
    fail("stateRoot must be a non-empty path");
  }
  if (!RUN_ID.test(runId)) fail("invalid run ID");
  plainObject(assignment, "assignment");
  if (typeof now !== "function") fail("now must be a function");

  const root = path.resolve(stateRoot);
  const runDir = path.join(root, runId);
  const attemptsDir = path.join(runDir, "attempts");
  const eventsPath = path.join(runDir, "events.jsonl");
  const runPath = path.join(runDir, "run.json");
  const startedAt = timestamp(now);
  const run = {
    version: 1,
    runId,
    assignment: cloneJson(assignment, "assignment"),
    status: "running",
    phase: "created",
    currentAttempt: 0,
    startedAt,
    finishedAt: null,
  };
  const initialRunRecord = serializeRecord(run, "run record", { pretty: true });

  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("stateRoot must be a regular directory");
  }
  try {
    await mkdir(runDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail(`run already exists: ${runId}`);
    throw error;
  }
  try {
    await atomicWrite(runPath, initialRunRecord.content);
    await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let eventSequence = 0;
  const inboxSequences = new Map();
  const workResultCounts = new Map();
  const gateReceiptCounts = new Map();
  let pending = Promise.resolve();
  let finished = false;

  const serialize = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };

  const appendEvent = (type, details = {}) => serialize(async () => {
    if (finished) fail("run is already finished");
    if (eventSequence >= MAX_EVENTS - 1) {
      fail(`events exceed ${MAX_EVENTS - 1} entries before the terminal event`);
    }
    if (typeof type !== "string" || !EVENT_TYPE.test(type)) fail("invalid event type");
    plainObject(details, "event details");
    const event = {
      ...cloneJson(details, "event details"),
      version: 1,
      sequence: eventSequence + 1,
      timestamp: timestamp(now),
      runId,
      type,
    };
    const record = serializeRecord(event, "event");
    await appendFile(eventsPath, record.content, { mode: 0o600 });
    eventSequence = event.sequence;
    return structuredClone(event);
  });

  const writeAttemptPlan = (attempt, plan) => serialize(async () => {
    if (finished) fail("run is already finished");
    attemptNumber(attempt);
    plainObject(plan, "attempt plan");
    const record = serializeRecord(plan, "attempt plan", { pretty: true });
    const stored = record.value;
    const attemptDir = path.join(attemptsDir, String(attempt));
    const planPath = path.join(attemptDir, "plan.json");
    const nextRun = {
      ...run,
      currentAttempt: Math.max(run.currentAttempt, attempt),
      phase: "planned",
    };
    const nextRunRecord = serializeRecord(nextRun, "run record", { pretty: true });
    await mkdir(attemptsDir, { recursive: true, mode: 0o700 });
    await mkdir(attemptDir, { recursive: true, mode: 0o700 });
    try {
      await atomicCreate(planPath, record.content);
    } catch (error) {
      if (error?.code === "EEXIST") fail(`attempt ${attempt} plan already exists`);
      throw error;
    }
    await atomicWrite(runPath, nextRunRecord.content);
    Object.assign(run, nextRun);
    return structuredClone(stored);
  });

  const writeWorkResult = (attempt, result) => serialize(async () => {
    if (finished) fail("run is already finished");
    attemptNumber(attempt);
    plainObject(result, "work result");
    const attemptDir = path.join(attemptsDir, String(attempt));
    const planStat = await lstat(path.join(attemptDir, "plan.json")).catch(() => null);
    if (!planStat?.isFile() || planStat.isSymbolicLink()) {
      fail(`attempt ${attempt} plan does not exist`);
    }
    const count = workResultCounts.get(attempt) ?? 0;
    if (count >= MAX_COLLECTION_RECORDS) {
      fail(`work results for attempt ${attempt} exceed ${MAX_COLLECTION_RECORDS} entries`);
    }
    const record = serializeRecord(result, "work result");
    const stored = record.value;
    await appendFile(
      path.join(attemptDir, "work-results.jsonl"),
      record.content,
      { mode: 0o600 },
    );
    workResultCounts.set(attempt, count + 1);
    return structuredClone(stored);
  });

  const writeGateReceipt = (attempt, receipt) => serialize(async () => {
    if (finished) fail("run is already finished");
    attemptNumber(attempt);
    plainObject(receipt, "gate receipt");
    const attemptDir = path.join(attemptsDir, String(attempt));
    const planStat = await lstat(path.join(attemptDir, "plan.json")).catch(() => null);
    if (!planStat?.isFile() || planStat.isSymbolicLink()) {
      fail(`attempt ${attempt} plan does not exist`);
    }
    const count = gateReceiptCounts.get(attempt) ?? 0;
    if (count >= MAX_COLLECTION_RECORDS) {
      fail(`gate receipts for attempt ${attempt} exceed ${MAX_COLLECTION_RECORDS} entries`);
    }
    const record = serializeRecord(receipt, "gate receipt");
    const stored = record.value;
    await appendFile(
      path.join(attemptDir, "gate-receipts.jsonl"),
      record.content,
      { mode: 0o600 },
    );
    gateReceiptCounts.set(attempt, count + 1);
    return structuredClone(stored);
  });

  const enqueueInbox = (attempt, ownerSlot, entry) => serialize(async () => {
    if (finished) fail("run is already finished");
    attemptNumber(attempt);
    inboxOwner(ownerSlot);
    plainObject(entry, "inbox entry");
    const attemptDir = path.join(attemptsDir, String(attempt));
    const planStat = await lstat(path.join(attemptDir, "plan.json")).catch(() => null);
    if (!planStat?.isFile() || planStat.isSymbolicLink()) {
      fail(`attempt ${attempt} plan does not exist`);
    }
    const key = `${attempt}:${ownerSlot}`;
    const count = inboxSequences.get(key) ?? 0;
    if (count >= MAX_COLLECTION_RECORDS) {
      fail(`inbox ${ownerSlot} for attempt ${attempt} exceeds ${MAX_COLLECTION_RECORDS} entries`);
    }
    const inboxEntry = {
      ...cloneJson(entry, "inbox details"),
      version: 1,
      sequence: count + 1,
      timestamp: timestamp(now),
      runId,
      attempt,
      ownerSlot,
    };
    const record = serializeRecord(inboxEntry, "inbox entry");
    const inboxDir = path.join(attemptDir, "inbox");
    await mkdir(inboxDir, { recursive: true, mode: 0o700 });
    await appendFile(
      path.join(inboxDir, `${ownerSlot}.jsonl`),
      record.content,
      { mode: 0o600 },
    );
    inboxSequences.set(key, inboxEntry.sequence);
    return structuredClone(inboxEntry);
  });

  const readInbox = (attempt, ownerSlot, { afterSequence = 0 } = {}) => serialize(async () => {
    attemptNumber(attempt);
    inboxOwner(ownerSlot);
    cursor(afterSequence);
    const attemptDir = path.join(attemptsDir, String(attempt));
    const planStat = await lstat(path.join(attemptDir, "plan.json")).catch(() => null);
    if (!planStat?.isFile() || planStat.isSymbolicLink()) {
      fail(`attempt ${attempt} plan does not exist`);
    }
    const inboxPath = path.join(attemptDir, "inbox", `${ownerSlot}.jsonl`);
    const content = await readFile(inboxPath, "utf8").catch(error => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    if (!content) return [];
    return content
      .trimEnd()
      .split("\n")
      .map(line => JSON.parse(line))
      .filter(entry => entry.sequence > afterSequence);
  });

  const finish = (status, details = {}) => serialize(async () => {
    if (finished) fail("run is already finished");
    if (!TERMINAL_STATUSES.has(status)) {
      fail("run status must be completed, failed, or cancelled");
    }
    if (eventSequence >= MAX_EVENTS) fail(`events exceed ${MAX_EVENTS} entries`);
    plainObject(details, "finish details");
    const storedDetails = cloneJson(details, "finish details");
    const finishedAt = timestamp(now);
    const event = {
      ...storedDetails,
      status,
      version: 1,
      sequence: eventSequence + 1,
      timestamp: finishedAt,
      runId,
      type: "run.finished",
    };
    const terminal = {
      ...run,
      ...storedDetails,
      version: run.version,
      runId,
      assignment: run.assignment,
      status,
      phase: typeof storedDetails.phase === "string" ? storedDetails.phase : "finished",
      currentAttempt: run.currentAttempt,
      startedAt: run.startedAt,
      finishedAt,
    };
    const terminalRecord = serializeRecord(terminal, "run record", { pretty: true });
    const eventRecord = serializeRecord(event, "event");
    await appendFile(eventsPath, eventRecord.content, { mode: 0o600 });
    eventSequence = event.sequence;
    await atomicWrite(runPath, terminalRecord.content);
    Object.assign(run, terminal);
    finished = true;
    return structuredClone(terminal);
  });

  return Object.freeze({
    runDir,
    appendEvent,
    writeAttemptPlan,
    writeWorkResult,
    writeGateReceipt,
    enqueueInbox,
    readInbox,
    finish,
  });
}

export async function openPodRunStore({ stateRoot, runId, now = () => new Date() }) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0 || stateRoot.includes("\0")) {
    fail("stateRoot must be a non-empty path");
  }
  if (!RUN_ID.test(runId)) fail("invalid run ID");
  if (typeof now !== "function") fail("now must be a function");

  const root = path.resolve(stateRoot);
  const runDir = path.join(root, runId);
  const runPath = path.join(runDir, "run.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  await privateEntry(root, "stateRoot", "isDirectory", 0o700);
  await privateEntry(runDir, "run directory", "isDirectory", 0o700);
  const runStat = await privateEntry(runPath, "run record", "isFile", 0o600);
  const eventsStat = await privateEntry(eventsPath, "event record", "isFile", 0o600);
  if (runStat.size < 2 || runStat.size > MAX_RECORD_BYTES) fail("run record has an invalid size");
  if (eventsStat.size > MAX_EVENTS * MAX_RECORD_BYTES) fail("event record has an invalid size");

  const runContent = await readFile(runPath, "utf8");
  if (Buffer.byteLength(runContent) !== runStat.size) fail("run record changed while opening");
  const run = parseStoredObject(runContent, "run record");
  if (run.version !== 1 || run.runId !== runId || !TERMINAL_STATUSES.has(run.status) && run.status !== "running"
      || typeof run.phase !== "string" || !Number.isSafeInteger(run.currentAttempt)
      || run.currentAttempt < 0 || run.currentAttempt > MAX_ATTEMPTS
      || !validStoredTimestamp(run.startedAt)
      || !(run.finishedAt === null || validStoredTimestamp(run.finishedAt))) {
    fail("run record is invalid");
  }
  plainObject(run.assignment, "run assignment");

  const eventsContent = await readFile(eventsPath, "utf8");
  if (Buffer.byteLength(eventsContent) !== eventsStat.size) fail("event record changed while opening");
  if (eventsContent !== "" && !eventsContent.endsWith("\n")) fail("event record is incomplete");
  const events = eventsContent === "" ? [] : eventsContent
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      if (Buffer.byteLength(line) + 1 > MAX_RECORD_BYTES) fail("event exceeds the record limit");
      const event = parseStoredObject(line, "event");
      if (event.version !== 1 || event.runId !== runId || event.sequence !== index + 1
          || !validStoredTimestamp(event.timestamp) || !EVENT_TYPE.test(event.type)) {
        fail("event record is invalid");
      }
      return event;
    });
  if (events.length > MAX_EVENTS) fail("event record exceeds the entry limit");
  const terminal = run.status !== "running";
  if (terminal) {
    const finalEvent = events.at(-1);
    if (run.finishedAt === null || finalEvent?.type !== "run.finished" || finalEvent.status !== run.status) {
      fail("terminal run record is inconsistent");
    }
  } else if (run.finishedAt !== null || events.some(event => event.type === "run.finished")) {
    fail("active run record is inconsistent");
  }

  let eventSequence = events.length;
  let finished = terminal;
  let pending = Promise.resolve();
  const serialize = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };

  const appendEvent = (type, details = {}) => serialize(async () => {
    if (finished) fail("run is already finished");
    if (eventSequence >= MAX_EVENTS - 1) {
      fail(`events exceed ${MAX_EVENTS - 1} entries before the terminal event`);
    }
    if (typeof type !== "string" || !EVENT_TYPE.test(type)) fail("invalid event type");
    plainObject(details, "event details");
    const event = {
      ...cloneJson(details, "event details"),
      version: 1,
      sequence: eventSequence + 1,
      timestamp: timestamp(now),
      runId,
      type,
    };
    const record = serializeRecord(event, "event");
    await appendFile(eventsPath, record.content, { mode: 0o600 });
    eventSequence = event.sequence;
    return structuredClone(event);
  });

  const finish = (status, details = {}) => serialize(async () => {
    if (finished) fail("run is already finished");
    if (!TERMINAL_STATUSES.has(status)) {
      fail("run status must be completed, failed, or cancelled");
    }
    if (eventSequence >= MAX_EVENTS) fail(`events exceed ${MAX_EVENTS} entries`);
    plainObject(details, "finish details");
    const storedDetails = cloneJson(details, "finish details");
    const finishedAt = timestamp(now);
    const event = {
      ...storedDetails,
      status,
      version: 1,
      sequence: eventSequence + 1,
      timestamp: finishedAt,
      runId,
      type: "run.finished",
    };
    const completedRun = {
      ...run,
      ...storedDetails,
      version: run.version,
      runId,
      assignment: run.assignment,
      status,
      phase: typeof storedDetails.phase === "string" ? storedDetails.phase : "finished",
      currentAttempt: run.currentAttempt,
      startedAt: run.startedAt,
      finishedAt,
    };
    const runRecord = serializeRecord(completedRun, "run record", { pretty: true });
    const eventRecord = serializeRecord(event, "event");
    await appendFile(eventsPath, eventRecord.content, { mode: 0o600 });
    eventSequence = event.sequence;
    await atomicWrite(runPath, runRecord.content);
    Object.assign(run, completedRun);
    finished = true;
    return structuredClone(completedRun);
  });

  return Object.freeze({
    runDir,
    run: Object.freeze(structuredClone(run)),
    events: Object.freeze(structuredClone(events)),
    appendEvent,
    finish,
  });
}
