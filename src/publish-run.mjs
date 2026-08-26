import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  createGitHubPublisher as defaultCreateGitHubPublisher,
  parseGitHubRepository,
} from "./github-publisher.mjs";
import { openPodRunStore } from "./pod-store.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const INPUT_FIELDS = Object.freeze([
  "baseSha",
  "candidateSha",
  "deadlineAt",
  "headBranch",
  "repository",
  "runId",
  "sourceGitDir",
  "stateRoot",
  "targetBranch",
  "token",
]);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SOURCE_CLEANUP_TIMEOUT_MS = 5_000;
const ASKPASS_PROGRAM = path.resolve(import.meta.dirname, "..", "bin", "bimo-git-askpass");

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function safePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
      || value.includes("\0") || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`${label} must be an absolute canonical path`);
  }
  return value;
}

function safeBranch(value, label) {
  if (typeof value !== "string" || !SAFE_BRANCH.test(value) || value === "HEAD"
      || value.startsWith("refs/") || value.includes("..") || value.includes("//")
      || value.includes("@{") || value.endsWith("/") || value.endsWith(".")
      || value.split("/").some(component => (
        component.length === 0 || component.startsWith(".") || component.endsWith(".lock")
      ))) {
    fail(`invalid ${label}`);
  }
  return value;
}

function containsPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function strictInput(input) {
  plainObject(input, "publish input");
  if (Object.keys(input).sort().join(",") !== INPUT_FIELDS.join(",")) {
    fail(`publish input must contain exactly ${INPUT_FIELDS.join(", ")}`);
  }
  if (!RUN_ID.test(input.runId)) fail("invalid run ID");
  const stateRoot = safePath(input.stateRoot, "stateRoot");
  const sourceGitDir = safePath(input.sourceGitDir, "sourceGitDir");
  if (containsPath(stateRoot, sourceGitDir) || containsPath(sourceGitDir, stateRoot)) {
    fail("sourceGitDir must not overlap stateRoot");
  }
  parseGitHubRepository(input.repository);
  const targetBranch = safeBranch(input.targetBranch, "targetBranch");
  const headBranch = safeBranch(input.headBranch, "headBranch");
  if (targetBranch === headBranch) fail("headBranch must differ from targetBranch");
  if (!SHA1.test(input.baseSha)) fail("invalid baseSha");
  if (!SHA1.test(input.candidateSha)) fail("invalid candidateSha");
  if (typeof input.token !== "string" || input.token.length === 0
      || Buffer.byteLength(input.token) > 4_096 || !/^[\u0021-\u007e]+$/u.test(input.token)) {
    fail("invalid token");
  }
  if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now()) {
    fail("deadlineAt must be a future safe integer");
  }
  return {
    ...input,
    stateRoot,
    sourceGitDir,
    targetBranch,
    headBranch,
  };
}

function readyMatches(ready, input) {
  return ready.repository === input.repository
    && ready.targetBranch === input.targetBranch
    && ready.baseSha === input.baseSha
    && ready.candidateSha === input.candidateSha
    && ready.headBranch === input.headBranch;
}

function fixedGitArgs(sourceGitDir, args) {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "credential.useHttpPath=true",
    "-c", "protocol.file.allow=never",
    `--git-dir=${sourceGitDir}`,
    ...args,
  ];
}

function baseGitEnvironment(home = os.tmpdir()) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function commandResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !Number.isInteger(value.code) || value.code < 0 || value.code > 255
      || typeof value.stdout !== "string" || typeof value.stderr !== "string"
      || Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > MAX_GIT_OUTPUT_BYTES) {
    fail("Git runner returned an invalid result");
  }
  return value;
}

async function runGit(gitRunner, args, env, deadlineAt) {
  if (Date.now() >= deadlineAt) fail("publication deadline exceeded");
  const controller = new AbortController();
  let expired = false;
  let timer;
  const schedule = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      expired = true;
      controller.abort();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();
  try {
    const result = await gitRunner({
      command: "git",
      args,
      env,
      signal: controller.signal,
      deadlineAt,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    });
    if (expired || Date.now() >= deadlineAt) fail("publication deadline exceeded");
    return commandResult(result);
  } catch (error) {
    if (expired || Date.now() >= deadlineAt) fail("publication deadline exceeded");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensurePrivateDirectory(target, label) {
  const stat = await lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail(`${label} must be a private regular directory`);
  }
  return stat;
}

async function cleanupPrivateSourceGitDir(target, expected, removeSourceGitDir) {
  let timer;
  const cleanup = (async () => {
    try {
      const current = await lstat(target).catch(() => null);
      if (!current?.isDirectory() || current.isSymbolicLink()
          || (current.mode & 0o777) !== 0o700
          || (expected !== null && (current.dev !== expected.dev || current.ino !== expected.ino))) {
        return;
      }
      await removeSourceGitDir(target, { recursive: true, force: true });
    } catch {
      // Durable completion is authoritative; retention cleanup is best-effort.
    }
  })();
  const bounded = new Promise(resolve => {
    timer = setTimeout(resolve, SOURCE_CLEANUP_TIMEOUT_MS);
  });
  try {
    await Promise.race([cleanup, bounded]);
  } finally {
    clearTimeout(timer);
  }
}

async function createAskpass(askpassRoot, token) {
  const program = await lstat(ASKPASS_PROGRAM).catch(() => null);
  if (!program?.isFile() || program.isSymbolicLink()
      || (program.mode & 0o100) === 0 || (program.mode & 0o022) !== 0) {
    fail("baked askpass program is invalid");
  }
  const priorRoot = await lstat(askpassRoot).catch(() => null);
  if (priorRoot === null) await mkdir(askpassRoot, { mode: 0o700 });
  await ensurePrivateDirectory(askpassRoot, "askpassRoot");
  const directory = await mkdtemp(path.join(askpassRoot, "credential-"));
  await chmod(directory, 0o700);
  const home = path.join(directory, "home");
  const tokenFile = path.join(directory, "token");
  await mkdir(home, { mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { flag: "wx", mode: 0o600 });
  await chmod(tokenFile, 0o600);
  let cleaned = false;
  return {
    env: {
      ...baseGitEnvironment(home),
      GIT_ASKPASS: ASKPASS_PROGRAM,
      GIT_ASKPASS_REQUIRE: "force",
      BIMO_GIT_TOKEN_FILE: tokenFile,
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      const tokenBytes = Buffer.byteLength(`${token}\n`);
      try {
        if (await lstat(tokenFile).catch(() => null)) {
          await writeFile(tokenFile, Buffer.alloc(tokenBytes), { mode: 0o600 });
        }
      } finally {
        await rm(tokenFile, { force: true });
        await rm(home, { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
        if (priorRoot === null) await rmdir(askpassRoot).catch(() => {});
      }
    },
  };
}

function parseRemoteRefs(stdout, targetBranch, headBranch) {
  const refs = new Map();
  const lines = stdout === "" ? [] : stdout.trimEnd().split("\n");
  for (const line of lines) {
    const match = /^([a-f0-9]{40})\t(refs\/heads\/.+)$/u.exec(line);
    if (match === null || refs.has(match[2])) fail("remote ref inspection returned invalid output");
    if (match[2] !== `refs/heads/${targetBranch}` && match[2] !== `refs/heads/${headBranch}`) {
      fail("remote ref inspection returned an unexpected ref");
    }
    refs.set(match[2], match[1]);
  }
  return refs;
}

function publicationReceipt(value, input) {
  plainObject(value, "publication receipt");
  const allowed = [
    "baseSha",
    "created",
    "draft",
    "headBranch",
    "headSha",
    "number",
    "reconciled",
    "targetBranch",
    "url",
  ];
  if (Object.keys(value).some(key => !allowed.includes(key))
      || !Number.isSafeInteger(value.number) || value.number < 1
      || value.headBranch !== input.headBranch || value.headSha !== input.candidateSha
      || value.targetBranch !== input.targetBranch || value.baseSha !== input.baseSha
      || value.draft !== true || typeof value.created !== "boolean"
      || (value.reconciled !== undefined && value.reconciled !== true)) {
    fail("GitHub publisher returned an invalid draft pull request receipt");
  }
  const { owner, repo } = parseGitHubRepository(input.repository);
  let url;
  try {
    url = new URL(value.url);
  } catch {
    fail("GitHub publisher returned an invalid draft pull request receipt");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== ""
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
      || url.pathname.toLowerCase() !== `/${owner}/${repo}/pull/${value.number}`.toLowerCase()
      || JSON.stringify(value).includes(input.token)) {
    fail("GitHub publisher returned an invalid draft pull request receipt");
  }
  return structuredClone(value);
}

function completedResult(record, input) {
  plainObject(record, "completed publication record");
  if (record.repository !== input.repository || record.targetBranch !== input.targetBranch
      || record.baseSha !== input.baseSha || record.candidateSha !== input.candidateSha
      || record.headBranch !== input.headBranch) {
    fail("completed publication does not match publication input");
  }
  return Object.freeze({
    status: "completed",
    runId: input.runId,
    repository: input.repository,
    targetBranch: input.targetBranch,
    baseSha: input.baseSha,
    candidateSha: input.candidateSha,
    headBranch: input.headBranch,
    publication: publicationReceipt(record.publication, input),
  });
}

async function publishRunInternal(input, {
  gitRunner = async () => fail("Git runner is unavailable"),
  createGitHubPublisher = defaultCreateGitHubPublisher,
  openRunStore = openPodRunStore,
  fetchImpl = globalThis.fetch,
  askpassRoot = "/run/bimo-publish",
  removeSourceGitDir = rm,
} = {}) {
  const validated = strictInput(input);
  if (typeof gitRunner !== "function") fail("gitRunner must be a function");
  if (typeof createGitHubPublisher !== "function") fail("createGitHubPublisher must be a function");
  if (typeof openRunStore !== "function") fail("openRunStore must be a function");
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  if (typeof removeSourceGitDir !== "function") fail("removeSourceGitDir must be a function");
  safePath(askpassRoot, "askpassRoot");

  const store = await openRunStore({
    stateRoot: validated.stateRoot,
    runId: validated.runId,
  });
  plainObject(store, "opened run store");
  if (!Array.isArray(store.events) || store.run === null || typeof store.run !== "object"
      || typeof store.appendEvent !== "function"
      || typeof store.finish !== "function") {
    fail("opened run store is invalid");
  }
  const readyRecords = store.events.filter(event => event?.type === "publication.ready");
  if (readyRecords.length !== 1 || !readyMatches(readyRecords[0], validated)) {
    fail("publication.ready does not match publication input");
  }
  if (store.run.status === "completed") {
    if (store.run.phase !== "published") fail("completed publication has an invalid phase");
    const finishedRecords = store.events.filter(event => event?.type === "publication.finished");
    if (finishedRecords.length !== 1) fail("completed publication has invalid durable evidence");
    const fromRun = completedResult(store.run, validated);
    const fromEvent = completedResult(finishedRecords[0], validated);
    if (JSON.stringify(fromRun) !== JSON.stringify(fromEvent)) {
      fail("completed publication has conflicting durable evidence");
    }
    const remainingSource = await lstat(validated.sourceGitDir).catch(() => null);
    if (remainingSource?.isDirectory() && !remainingSource.isSymbolicLink()
        && (remainingSource.mode & 0o777) === 0o700) {
      await cleanupPrivateSourceGitDir(
        validated.sourceGitDir,
        remainingSource,
        removeSourceGitDir,
      );
    }
    return fromRun;
  }
  if (store.run.status !== "running") fail("run is not publication-ready");
  const interruptedPublications = store.events.filter(event => event?.type === "publication.finished");
  if (interruptedPublications.length > 1) fail("active run has conflicting publication evidence");
  if (interruptedPublications.length === 1) {
    const interrupted = interruptedPublications[0];
    if (store.events.at(-1) !== interrupted) fail("active run has events after publication evidence");
    const result = completedResult(interrupted, validated);
    await store.finish("completed", {
      phase: "published",
      repository: result.repository,
      targetBranch: result.targetBranch,
      baseSha: result.baseSha,
      candidateSha: result.candidateSha,
      headBranch: result.headBranch,
      publication: result.publication,
    });
    await cleanupPrivateSourceGitDir(validated.sourceGitDir, null, removeSourceGitDir);
    return result;
  }

  const sourceGitDirectory = await ensurePrivateDirectory(validated.sourceGitDir, "sourceGitDir");
  const local = await runGit(
    gitRunner,
    fixedGitArgs(validated.sourceGitDir, [
      "rev-parse", "--verify", "--end-of-options", `${validated.candidateSha}^{commit}`,
    ]),
    baseGitEnvironment(),
    validated.deadlineAt,
  );
  if (local.code !== 0 || !/^[a-f0-9]{40}\n?$/u.test(local.stdout)
      || local.stdout.trimEnd() !== validated.candidateSha) {
    fail("local candidate does not match candidateSha");
  }

  const askpass = await createAskpass(askpassRoot, validated.token);
  try {
    const remote = await runGit(
      gitRunner,
      fixedGitArgs(validated.sourceGitDir, [
        "ls-remote",
        "--heads",
        validated.repository,
        `refs/heads/${validated.targetBranch}`,
        `refs/heads/${validated.headBranch}`,
      ]),
      askpass.env,
      validated.deadlineAt,
    );
    if (remote.code !== 0) fail("remote ref inspection failed");
    const refs = parseRemoteRefs(remote.stdout, validated.targetBranch, validated.headBranch);
    if (refs.get(`refs/heads/${validated.targetBranch}`) !== validated.baseSha) {
      fail("remote target branch does not match baseSha");
    }
    const remoteHead = refs.get(`refs/heads/${validated.headBranch}`);
    if (remoteHead !== undefined && remoteHead !== validated.candidateSha) {
      fail("remote head branch already exists at another SHA");
    }
    if (remoteHead === undefined) {
      const pushed = await runGit(
        gitRunner,
        fixedGitArgs(validated.sourceGitDir, [
          "push",
          "--porcelain",
          "--no-verify",
          validated.repository,
          `${validated.candidateSha}:refs/heads/${validated.headBranch}`,
        ]),
        askpass.env,
        validated.deadlineAt,
      );
      if (pushed.code !== 0) fail("exact candidate push failed");
    }
  } finally {
    await askpass.cleanup();
  }

  const publisher = createGitHubPublisher({
    repository: validated.repository,
    targetBranch: validated.targetBranch,
    token: validated.token,
    fetchImpl,
  });
  if (publisher === null || typeof publisher !== "object" || typeof publisher.publish !== "function") {
    fail("GitHub publisher port is invalid");
  }
  const publication = publicationReceipt(await publisher.publish({
    headBranch: validated.headBranch,
    headSha: validated.candidateSha,
    baseSha: validated.baseSha,
    title: `Bimo run ${validated.runId}`,
    body: `Automated draft pull request for Bimo run ${validated.runId}.`,
    deadlineAt: validated.deadlineAt,
    draft: true,
  }), validated);
  const binding = {
    repository: validated.repository,
    targetBranch: validated.targetBranch,
    baseSha: validated.baseSha,
    candidateSha: validated.candidateSha,
    headBranch: validated.headBranch,
    publication,
  };
  await store.appendEvent("publication.finished", binding);
  await store.finish("completed", { phase: "published", ...binding });
  await cleanupPrivateSourceGitDir(
    validated.sourceGitDir,
    sourceGitDirectory,
    removeSourceGitDir,
  );
  return Object.freeze({
    status: "completed",
    runId: validated.runId,
    ...binding,
  });
}

export async function publishRun(input, dependencies) {
  const token = input !== null && typeof input === "object" && typeof input.token === "string"
    ? input.token
    : "";
  try {
    return await publishRunInternal(input, dependencies);
  } catch (error) {
    let message = error instanceof Error && typeof error.message === "string"
      ? error.message
      : "publication finalization failed";
    if (token.length > 0) message = message.split(token).join("[REDACTED]");
    if (message.length === 0 || Buffer.byteLength(message) > 4_096
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message)) {
      message = "publication finalization failed";
    }
    throw new Error(message);
  }
}
