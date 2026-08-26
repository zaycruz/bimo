import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SHA1 = /^[a-f0-9]{40}$/u;
const SLOT = /^(?:engineering-a|engineering-b|qa-tests)$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const FIXED_INTEGRATION_ORDER = Object.freeze([
  "engineering-a",
  "engineering-b",
  "qa-tests",
]);
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ZERO_SHA1 = "0".repeat(40);
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_DEPTH = 64;
const MAX_SNAPSHOT_FILES = 10_000;
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_INSPECT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_REACHABLE_COMMITS = 100;
const MAX_REACHABLE_TREE_ENTRIES = 200_000;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  return value;
}

function requireSha(value, label = "Git SHA") {
  if (typeof value !== "string" || !SHA1.test(value)) {
    fail(`${label} must be an exact lowercase 40-character SHA-1`);
  }
  return value;
}

function requireDeadline(deadlineAt) {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) {
    fail("deadlineAt must be a future safe integer");
  }
  return deadlineAt;
}

function requireId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`invalid ${label}`);
  return value;
}

function requireBranch(value, label = "branch") {
  if (
    typeof value !== "string"
    || !SAFE_BRANCH.test(value)
    || value === "HEAD"
    || value.startsWith("refs/")
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || value.endsWith("/")
    || value.endsWith(".")
    || value.split("/").some(component => (
      component.length === 0
      || component.startsWith(".")
      || component.endsWith(".lock")
    ))
  ) {
    fail(`invalid ${label}`);
  }
  return value;
}

function canonicalRepository(repository) {
  if (
    typeof repository !== "string"
    || repository.length === 0
    || repository.length > 512
    || repository !== repository.trim()
  ) {
    fail("invalid GitHub repository");
  }
  let parsed;
  try {
    parsed = new URL(repository);
  } catch {
    fail("invalid GitHub repository");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.includes("%")
  ) {
    fail("invalid GitHub repository");
  }
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/u.exec(parsed.pathname);
  if (match === null) {
    fail("invalid GitHub repository");
  }
  const name = match[2].endsWith(".git") ? match[2].slice(0, -4) : match[2];
  if (name.length === 0 || name === "." || name === "..") fail("invalid GitHub repository");
  return `https://github.com/${match[1].toLowerCase()}/${name.toLowerCase()}.git`;
}

function validateRelativePath(value, label = "repository path") {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value) > 1_024
    || value !== value.normalize("NFC")
    || value.includes("\\")
    || CONTROL.test(value)
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
  ) {
    fail(`${label} must be a canonical relative path`);
  }
  const components = value.split("/");
  if (components.some(component => component.length === 0 || component === "." || component === "..")) {
    fail(`${label} must be a canonical relative path`);
  }
  if (components.some(component => {
    const folded = component.toLowerCase();
    return folded === ".git" || folded === ".github";
  })) {
    fail(`${label} names a forbidden repository control path`);
  }
  return value;
}

function validateSnapshotPath(value, label = "snapshot path") {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value) > 1_024
    || value !== value.normalize("NFC")
    || value.includes("\\")
    || CONTROL.test(value)
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
  ) {
    fail(`${label} must be a canonical relative path`);
  }
  const components = value.split("/");
  if (components.some(component => component.length === 0 || component === "." || component === "..")) {
    fail(`${label} must be a canonical relative path`);
  }
  if (components.some(component => component.toLowerCase() === ".git")) {
    fail(`${label} names forbidden Git administration data`);
  }
  return value;
}

function pathWithin(directory, candidate) {
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

function filesystemDescendant(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sortPaths(values) {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function ensureNoPathCollisions(paths, label = "repository paths") {
  const folded = new Map();
  for (const repositoryPath of paths) {
    const key = repositoryPath.normalize("NFC").toLowerCase();
    const existing = folded.get(key);
    if (existing !== undefined && existing !== repositoryPath) {
      fail(`${label} contain a case or Unicode normalization collision`);
    }
    folded.set(key, repositoryPath);
  }
}

function requireLimits(value) {
  requirePlainObject(value, "change limits");
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "maxBytes" || keys[1] !== "maxFiles") {
    fail("change limits must contain exactly maxFiles and maxBytes");
  }
  const { maxFiles, maxBytes } = value;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || maxFiles > 100_000) {
    fail("invalid changed-file limit");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 2 ** 40) {
    fail("invalid changed-byte limit");
  }
  return { maxFiles, maxBytes };
}

function splitNull(buffer, label) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer ?? "");
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) fail(`${label} was not NUL terminated`);
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const bytes = buffer.subarray(start, index);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value).equals(bytes)) fail(`${label} contains a non-UTF-8 path`);
    values.push(value);
    start = index + 1;
  }
  return values;
}

function outputBuffer(result, field = "stdout") {
  if (Buffer.isBuffer(result)) return result;
  if (typeof result === "string") return Buffer.from(result);
  if (result !== null && typeof result === "object") {
    const value = result[field] ?? "";
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === "string") return Buffer.from(value);
  }
  fail("Git command runner returned an invalid result");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultEnvironment(home) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Monolith Controller",
    GIT_AUTHOR_EMAIL: "controller@thisismonolith.invalid",
    GIT_COMMITTER_NAME: "Monolith Controller",
    GIT_COMMITTER_EMAIL: "controller@thisismonolith.invalid",
  };
}

function commandError(stderr, exitCode) {
  const detail = outputBuffer({ stderr }, "stderr").toString("utf8").trim().slice(0, 2_000);
  const error = new Error(detail ? `Git command failed: ${detail}` : "Git command failed");
  error.exitCode = exitCode;
  return error;
}

async function execute(command, args, {
  cwd,
  env,
  input,
  signal,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killTimer;
    let forcedError;
    let terminating = false;
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const kill = signalName => {
      try {
        if (process.platform !== "win32" && Number.isInteger(child.pid)) {
          process.kill(-child.pid, signalName);
        } else {
          child.kill(signalName);
        }
      } catch {
        child.kill(signalName);
      }
    };
    const abort = () => {
      if (terminating || settled) return;
      terminating = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
      killTimer.unref?.();
    };
    const append = (current, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        forcedError ??= new Error("Git command output exceeded the configured bound");
        abort();
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.stdin.on("error", () => {});
    child.once("error", error => finish(error));
    child.once("close", exitCode => {
      if (forcedError) finish(forcedError);
      else if (exitCode === 0) finish(null, { stdout, stderr, exitCode });
      else finish(commandError(stderr, exitCode));
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

async function settleWithinDeadline(runner, command, args, options) {
  const { deadlineAt } = options;
  requireDeadline(deadlineAt);
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineAt - Date.now());
  try {
    const result = await runner(command, args, { ...options, signal: controller.signal });
    if (expired || Date.now() >= deadlineAt) fail("Git operation deadline exceeded");
    const stdout = outputBuffer(result);
    const stderr = outputBuffer(result, "stderr");
    if (stdout.length + stderr.length > options.maxOutputBytes) {
      fail("Git command output exceeded the configured bound");
    }
    return result;
  } catch (error) {
    if (expired || Date.now() >= deadlineAt) fail("Git operation deadline exceeded");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function checkDeadline(deadlineAt) {
  if (Date.now() >= deadlineAt) fail("Git operation deadline exceeded");
}

async function checked(deadlineAt, operation) {
  checkDeadline(deadlineAt);
  const value = await operation();
  checkDeadline(deadlineAt);
  return value;
}

async function collectTree(root, deadlineAt, relative = "", state = { entries: 0 }) {
  const depth = relative === "" ? 0 : relative.split("/").length;
  if (depth > MAX_TREE_DEPTH) fail("repository tree depth limit exceeded");
  const entries = await checked(deadlineAt, () => readdir(path.join(root, relative), { withFileTypes: true }));
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  const collected = [];
  for (const entry of entries) {
    state.entries += 1;
    if (state.entries > MAX_TREE_ENTRIES) fail("repository tree entry limit exceeded");
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(root, childRelative);
    const metadata = await checked(deadlineAt, () => lstat(full));
    collected.push({ relative: childRelative, full, metadata });
    if (metadata.isDirectory()) {
      collected.push(...await collectTree(root, deadlineAt, childRelative, state));
    }
  }
  return collected;
}

export class GitRuntime {
  #allowLocalRepository;
  #allowedRepositories;
  #allowedWriteRoots;
  #bareRoot;
  #branchHeads = new Map();
  #cloneSource;
  #closed = false;
  #command;
  #environment;
  #gitRoot;
  #gitRootOwned = false;
  #home;
  #markerPath;
  #markerValue;
  #prepared;
  #resultRecords = new Map();
  #runId;
  #runner;
  #snapshots = new Map();
  #snapshotsRunOwned = false;
  #snapshotsRoot;
  #workspaceCounter = 0;
  #workspaces = new Map();
  #worktreesRunOwned = false;
  #worktreesRoot;
  #writerGid;
  #writerUid;

  constructor({
    allowedRepositories,
    allowedWriteRoots,
    cloneSource,
    allowLocalRepository = false,
    gitRoot,
    snapshotsRoot,
    worktreesRoot,
    runId,
    runner = execute,
    command = "git",
    writerUid,
    writerGid,
  }) {
    if (!Array.isArray(allowedRepositories) || allowedRepositories.length === 0) {
      fail("allowedRepositories must be a non-empty array");
    }
    this.#allowedRepositories = new Set(allowedRepositories.map(canonicalRepository));
    this.#allowLocalRepository = allowLocalRepository;
    requirePlainObject(allowedWriteRoots, "allowedWriteRoots");
    this.#allowedWriteRoots = new Map();
    for (const slot of FIXED_INTEGRATION_ORDER) {
      const roots = allowedWriteRoots[slot];
      if (!Array.isArray(roots) || roots.length === 0) fail(`allowedWriteRoots.${slot} is required`);
      const canonical = roots.map(root => validateRelativePath(root, `allowedWriteRoots.${slot}`));
      ensureNoPathCollisions(canonical, `allowedWriteRoots.${slot}`);
      this.#allowedWriteRoots.set(slot, Object.freeze(sortPaths(new Set(canonical))));
    }
    const ownedRoots = FIXED_INTEGRATION_ORDER.flatMap(slot => (
      this.#allowedWriteRoots.get(slot).map(root => ({ slot, root, folded: root.toLowerCase() }))
    ));
    for (let left = 0; left < ownedRoots.length; left += 1) {
      for (let right = left + 1; right < ownedRoots.length; right += 1) {
        const first = ownedRoots[left];
        const second = ownedRoots[right];
        if (
          first.slot !== second.slot
          && (
            first.folded === second.folded
            || first.folded.startsWith(`${second.folded}/`)
            || second.folded.startsWith(`${first.folded}/`)
          )
        ) {
          fail(`allowed write roots overlap between ${first.slot} and ${second.slot}`);
        }
      }
    }
    if (Object.keys(allowedWriteRoots).some(slot => !SLOT.test(slot))) {
      fail("allowedWriteRoots contains an unknown slot");
    }
    if (typeof gitRoot !== "string" || !path.isAbsolute(gitRoot)) fail("gitRoot must be absolute");
    if (typeof worktreesRoot !== "string" || !path.isAbsolute(worktreesRoot)) fail("worktreesRoot must be absolute");
    if (typeof snapshotsRoot !== "string" || !path.isAbsolute(snapshotsRoot)) fail("snapshotsRoot must be absolute");
    this.#runId = requireId(runId, "runId");
    this.#gitRoot = path.resolve(gitRoot);
    this.#worktreesRoot = path.resolve(worktreesRoot);
    this.#snapshotsRoot = path.resolve(snapshotsRoot);
    this.#bareRoot = path.join(this.#gitRoot, "repository.git");
    this.#home = path.join(this.#gitRoot, ".home");
    this.#markerPath = path.join(this.#gitRoot, ".monolith-git-runtime");
    this.#markerValue = `monolith-git-runtime-v1:${this.#runId}:${randomBytes(32).toString("hex")}\n`;
    const roots = [this.#gitRoot, this.#worktreesRoot, this.#snapshotsRoot];
    for (let left = 0; left < roots.length; left += 1) {
      for (let right = left + 1; right < roots.length; right += 1) {
        if (filesystemDescendant(roots[left], roots[right]) || filesystemDescendant(roots[right], roots[left])) {
          fail("Git, worktree, and snapshot roots must be disjoint");
        }
      }
    }
    if (typeof runner !== "function") fail("runner must be a function");
    if (typeof command !== "string" || command.length === 0 || CONTROL.test(command)) fail("invalid Git command");
    this.#runner = runner;
    this.#command = command;
    this.#environment = defaultEnvironment(this.#home);

    if (cloneSource !== undefined) {
      if (!allowLocalRepository) fail("cloneSource is test-only and requires allowLocalRepository");
      let parsed;
      try {
        parsed = new URL(cloneSource);
      } catch {
        fail("invalid local cloneSource");
      }
      if (parsed.protocol !== "file:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
        fail("invalid local cloneSource");
      }
      this.#cloneSource = cloneSource;
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
    const currentGid = typeof process.getgid === "function" ? process.getgid() : 0;
    this.#writerUid = writerUid ?? (allowLocalRepository ? currentUid : 1_000);
    this.#writerGid = writerGid ?? (allowLocalRepository ? currentGid : 1_000);
    if (!Number.isInteger(this.#writerUid) || this.#writerUid < 0) fail("invalid writerUid");
    if (!Number.isInteger(this.#writerGid) || this.#writerGid < 0) fail("invalid writerGid");
  }

  async #run(args, {
    deadlineAt,
    cwd,
    input,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    allowedExitCodes = [0],
    environment = {},
  } = {}) {
    if (this.#closed) fail("Git runtime is closed");
    if (!Array.isArray(args) || args.some(argument => typeof argument !== "string")) {
      fail("Git arguments must be an array of strings");
    }
    let result;
    try {
      result = await settleWithinDeadline(this.#runner, this.#command, args, {
        cwd,
        env: { ...this.#environment, ...environment },
        input,
        deadlineAt,
        maxOutputBytes,
      });
    } catch (error) {
      if (allowedExitCodes.includes(error?.exitCode)) {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: error.exitCode };
      }
      throw error;
    }
    const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 0;
    if (!allowedExitCodes.includes(exitCode)) throw commandError(outputBuffer(result, "stderr"), exitCode);
    return result;
  }

  #controllerArgs(args, gitDir = this.#bareRoot, workTree) {
    const prefix = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false",
      "-c", "diff.external=",
      "-c", "protocol.file.allow=never",
      `--git-dir=${gitDir}`,
    ];
    if (workTree !== undefined) prefix.push(`--work-tree=${workTree}`);
    return [...prefix, ...args];
  }

  async #git(args, options = {}) {
    const result = await this.#run(this.#controllerArgs(args, options.gitDir, options.workTree), options);
    return outputBuffer(result);
  }

  async #claimGitRoot(deadlineAt) {
    await checked(deadlineAt, () => mkdir(this.#gitRoot, { recursive: true, mode: 0o700 }));
    const rootMetadata = await checked(deadlineAt, () => lstat(this.#gitRoot));
    const currentUid = typeof process.getuid === "function" ? process.getuid() : rootMetadata.uid;
    const currentGid = typeof process.getgid === "function" ? process.getgid() : rootMetadata.gid;
    if (
      !rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || (rootMetadata.mode & 0o777) !== 0o700
      || rootMetadata.uid !== currentUid
      || rootMetadata.gid !== currentGid
    ) {
      fail("controller Git root failed its ownership boundary check");
    }
    const existing = await checked(deadlineAt, () => readdir(this.#gitRoot));
    if (existing.length !== 0) fail("controller Git root must be empty before use");
    let handle;
    try {
      handle = await checked(deadlineAt, () => open(this.#markerPath, "wx", 0o600));
      await checked(deadlineAt, () => handle.writeFile(this.#markerValue, "utf8"));
      await checked(deadlineAt, () => handle.sync());
      await checked(deadlineAt, () => handle.close());
      handle = undefined;
      const claimedEntries = await checked(deadlineAt, () => readdir(this.#gitRoot));
      if (claimedEntries.length !== 1 || claimedEntries[0] !== path.basename(this.#markerPath)) {
        fail("controller Git root changed while it was being claimed");
      }
      await checked(deadlineAt, () => mkdir(this.#home, { mode: 0o700 }));
      this.#gitRootOwned = true;
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(this.#markerPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #verifyGitRootOwnership(deadlineAt) {
    if (!this.#gitRootOwned) return false;
    const rootMetadata = await checked(deadlineAt, () => lstat(this.#gitRoot));
    const markerMetadata = await checked(deadlineAt, () => lstat(this.#markerPath));
    const marker = await checked(deadlineAt, () => readFile(this.#markerPath, "utf8"));
    const currentUid = typeof process.getuid === "function" ? process.getuid() : rootMetadata.uid;
    const currentGid = typeof process.getgid === "function" ? process.getgid() : rootMetadata.gid;
    if (
      !rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || (rootMetadata.mode & 0o777) !== 0o700
      || rootMetadata.uid !== currentUid
      || rootMetadata.gid !== currentGid
      || !markerMetadata.isFile()
      || markerMetadata.isSymbolicLink()
      || (markerMetadata.mode & 0o777) !== 0o600
      || markerMetadata.uid !== currentUid
      || markerMetadata.gid !== currentGid
      || marker !== this.#markerValue
    ) {
      fail("controller Git root ownership marker changed");
    }
    try {
      const bareMetadata = await checked(deadlineAt, () => lstat(this.#bareRoot));
      const rootRealpath = await checked(deadlineAt, () => realpath(this.#gitRoot));
      const bareRealpath = await checked(deadlineAt, () => realpath(this.#bareRoot));
      if (
        !bareMetadata.isDirectory()
        || bareMetadata.isSymbolicLink()
        || bareMetadata.uid !== currentUid
        || bareMetadata.gid !== currentGid
        || !filesystemDescendant(rootRealpath, bareRealpath)
        || bareRealpath === rootRealpath
      ) {
        fail("controller bare repository ownership changed");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return true;
  }

  async #claimRunDirectory(root, label, deadlineAt) {
    await checked(deadlineAt, () => mkdir(root, { recursive: true, mode: 0o700 }));
    const parentMetadata = await checked(deadlineAt, () => lstat(root));
    const currentUid = typeof process.getuid === "function" ? process.getuid() : parentMetadata.uid;
    const currentGid = typeof process.getgid === "function" ? process.getgid() : parentMetadata.gid;
    if (
      !parentMetadata.isDirectory()
      || parentMetadata.isSymbolicLink()
      || parentMetadata.uid !== currentUid
      || parentMetadata.gid !== currentGid
    ) {
      fail(`${label} root failed its ownership boundary check`);
    }
    const runRoot = path.join(root, this.#runId);
    try {
      await checked(deadlineAt, () => mkdir(runRoot, { mode: 0o700 }));
    } catch (error) {
      if (error?.code === "EEXIST") fail(`${label} run root already exists`);
      throw error;
    }
    const runMetadata = await checked(deadlineAt, () => lstat(runRoot));
    if (
      !runMetadata.isDirectory()
      || runMetadata.isSymbolicLink()
      || (runMetadata.mode & 0o777) !== 0o700
      || runMetadata.uid !== currentUid
      || runMetadata.gid !== currentGid
    ) {
      fail(`${label} run root failed its ownership boundary check`);
    }
    return runRoot;
  }

  async prepareAssignment({ repository, baseRevision, targetBranch, deadlineAt }) {
    requireDeadline(deadlineAt);
    if (this.#prepared !== undefined) fail("assignment is already prepared");
    const canonical = canonicalRepository(repository);
    if (!this.#allowedRepositories.has(canonical)) fail("repository is not allowlisted");
    const baseSha = requireSha(baseRevision, "baseRevision");
    requireBranch(targetBranch, "targetBranch");
    await this.#claimGitRoot(deadlineAt);
    await this.#claimRunDirectory(this.#worktreesRoot, "worktree", deadlineAt);
    this.#worktreesRunOwned = true;
    await this.#claimRunDirectory(this.#snapshotsRoot, "snapshot", deadlineAt);
    this.#snapshotsRunOwned = true;
    const source = this.#cloneSource ?? canonical;
    await this.#run([
      "-c", "http.followRedirects=false",
      "-c", `protocol.file.allow=${this.#allowLocalRepository ? "always" : "never"}`,
      "clone", "--bare", "--no-tags", "--", source, this.#bareRoot,
    ], { deadlineAt, cwd: this.#gitRoot });
    await checked(deadlineAt, () => chmod(this.#bareRoot, 0o700));
    const bareMetadata = await checked(deadlineAt, () => lstat(this.#bareRoot));
    const resolvedGitRoot = await checked(deadlineAt, () => realpath(this.#gitRoot));
    const resolvedBareRoot = await checked(deadlineAt, () => realpath(this.#bareRoot));
    if (
      !bareMetadata.isDirectory()
      || bareMetadata.isSymbolicLink()
      || (bareMetadata.mode & 0o777) !== 0o700
      || bareMetadata.uid !== (typeof process.getuid === "function" ? process.getuid() : bareMetadata.uid)
      || bareMetadata.gid !== (typeof process.getgid === "function" ? process.getgid() : bareMetadata.gid)
      || !filesystemDescendant(resolvedGitRoot, resolvedBareRoot)
      || resolvedBareRoot === resolvedGitRoot
    ) {
      fail("controller bare repository failed its ownership boundary check");
    }
    const objectFormat = (await this.#git(["rev-parse", "--show-object-format"], { deadlineAt })).toString("utf8").trim();
    if (objectFormat !== "sha1") fail("repository object format must be sha1");
    const resolved = (await this.#git(["rev-parse", "--verify", `${baseSha}^{commit}`], { deadlineAt })).toString("ascii").trim();
    if (resolved !== baseSha) fail("baseRevision did not resolve to the exact requested commit");
    const targetHead = (await this.#git([
      "rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`,
    ], { deadlineAt })).toString("ascii").trim();
    if (targetHead !== baseSha) fail("baseRevision must equal the freshly cloned target branch head");
    const directories = await this.#listTreeDirectories(baseSha, deadlineAt);
    this.#prepared = Object.freeze({
      repository: canonical,
      baseSha,
      targetBranch,
      objectFormat,
      existingDirectories: Object.freeze(directories),
    });
    return Object.freeze({
      baseSha,
      objectFormat,
      existingDirectories: Object.freeze([...directories]),
    });
  }

  async #listTreeDirectories(sha, deadlineAt) {
    const tree = await this.#git(["ls-tree", "-d", "-r", "-z", sha], { deadlineAt });
    const directories = [];
    for (const record of splitNull(tree, "Git tree")) {
      const separator = record.indexOf("\t");
      if (separator < 0) fail("unexpected Git tree record");
      const repositoryPath = record.slice(separator + 1);
      try {
        directories.push(validateRelativePath(repositoryPath));
      } catch (error) {
        if (/forbidden repository control path/u.test(error.message)) continue;
        throw error;
      }
    }
    ensureNoPathCollisions(directories);
    return sortPaths(directories);
  }

  #requirePrepared() {
    if (this.#prepared === undefined) fail("assignment is not prepared");
    return this.#prepared;
  }

  #worktreePath(id) {
    const root = path.resolve(this.#worktreesRoot, this.#runId, id);
    const runRoot = path.resolve(this.#worktreesRoot, this.#runId);
    if (!filesystemDescendant(runRoot, root) || root === runRoot) fail("invalid workspace path");
    return root;
  }

  async #addWorktree({ id, sha, attempt, slot, writeDirectories, deadlineAt, kind = "writer" }) {
    requireId(id, "workspace ID");
    requireSha(sha);
    if (this.#workspaces.has(id)) fail("workspace ID already exists");
    const root = this.#worktreePath(id);
    await this.#git(["worktree", "add", "--detach", "--", root, sha], { deadlineAt });
    let record;
    try {
      const pointer = (await checked(deadlineAt, () => readFile(path.join(root, ".git"), "utf8"))).trim();
      const match = /^gitdir: (.+)$/u.exec(pointer);
      if (match === null || !path.isAbsolute(match[1])) fail("invalid linked-worktree Git pointer");
      const gitDir = await checked(deadlineAt, () => realpath(match[1]));
      const worktreeAdminRoot = await checked(deadlineAt, () => realpath(path.join(this.#bareRoot, "worktrees")));
      if (!filesystemDescendant(worktreeAdminRoot, gitDir) || gitDir === worktreeAdminRoot) {
        fail("linked-worktree Git directory escaped the controller repository");
      }
      const exactSha = (await this.#git(["rev-parse", "--verify", "HEAD"], {
        deadlineAt,
        gitDir,
        workTree: root,
      })).toString("ascii").trim();
      if (exactSha !== sha) fail("worktree did not start at the exact requested SHA");
      record = {
        id,
        root,
        gitDir,
        attempt,
        slot,
        kind,
        runBaseSha: this.#prepared.baseSha,
        initialSha: sha,
        writeDirectories: Object.freeze([...(writeDirectories ?? [])]),
      };
      await this.#secureWorktree(record, deadlineAt);
      this.#workspaces.set(id, record);
    } catch (error) {
      await this.#unlockForRemoval(root, deadlineAt).catch(() => {});
      await this.#git(["worktree", "remove", "--force", "--", root], {
        deadlineAt,
        allowedExitCodes: [0, 128],
      }).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return record;
  }

  async #assertSafeDirectory(root, repositoryDirectory, deadlineAt) {
    const resolvedRoot = await checked(deadlineAt, () => realpath(root));
    let current = root;
    for (const component of repositoryDirectory.split("/")) {
      current = path.join(current, component);
      const metadata = await checked(deadlineAt, () => lstat(current));
      if (metadata.isSymbolicLink()) fail(`${repositoryDirectory} contains a symbolic link`);
      if (!metadata.isDirectory()) fail(`${repositoryDirectory} must be an existing directory`);
      const resolved = await checked(deadlineAt, () => realpath(current));
      if (!filesystemDescendant(resolvedRoot, resolved) || resolved === resolvedRoot) {
        fail(`${repositoryDirectory} escaped the worktree`);
      }
    }
    return current;
  }

  async #secureWorktree(record, deadlineAt) {
    const writeDirectories = record.writeDirectories;
    for (const directory of writeDirectories) {
      await this.#assertSafeDirectory(record.root, directory, deadlineAt);
    }
    const entries = await collectTree(record.root, deadlineAt);
    for (const { relative, metadata } of entries) {
      if (metadata.isSymbolicLink()) fail(`${relative} is a symbolic link in the worktree`);
      if (!metadata.isDirectory() && !metadata.isFile()) fail(`${relative} is a special file in the worktree`);
      const writable = writeDirectories.some(directory => pathWithin(directory, relative));
      if (writable && metadata.isFile() && metadata.nlink > 1) {
        fail(`${relative} is a hard-linked file inside a writable directory`);
      }
    }
    for (const { relative, full, metadata } of entries) {
      if (relative === ".git") {
        await checked(deadlineAt, () => chmod(full, 0o400));
        continue;
      }
      const writable = writeDirectories.some(directory => pathWithin(directory, relative));
      if (writable) {
        await checked(deadlineAt, () => chmod(full, metadata.isDirectory() ? 0o755 : ((metadata.mode & 0o111) ? 0o755 : 0o644)));
        await checked(deadlineAt, () => chown(full, this.#writerUid, this.#writerGid));
      } else {
        await checked(deadlineAt, () => chmod(full, metadata.isDirectory() ? 0o555 : ((metadata.mode & 0o111) ? 0o555 : 0o444)));
      }
    }
    await checked(deadlineAt, () => chmod(record.root, 0o555));
  }

  #validateWorkItem(workItem, { expectedSlot } = {}) {
    requirePlainObject(workItem, "workItem");
    const slot = workItem.ownerSlot;
    if (typeof slot !== "string" || !SLOT.test(slot) || (expectedSlot !== undefined && slot !== expectedSlot)) {
      fail("invalid writer slot");
    }
    if (typeof workItem.id !== "string" || workItem.id.length === 0 || Buffer.byteLength(workItem.id) > 256 || CONTROL.test(workItem.id)) {
      fail("invalid work-item ID");
    }
    if (!Array.isArray(workItem.writePaths) || workItem.writePaths.length === 0) {
      fail("workItem.writePaths must contain existing directories");
    }
    const writePaths = sortPaths(new Set(workItem.writePaths.map(value => validateRelativePath(value, "write path"))));
    if (writePaths.length !== workItem.writePaths.length) fail("write paths must be unique");
    ensureNoPathCollisions(writePaths, "write paths");
    const allowedRoots = this.#allowedWriteRoots.get(slot);
    for (const writePath of writePaths) {
      if (!allowedRoots.some(root => pathWithin(root, writePath))) {
        fail(`${writePath} is outside the allowed write roots for ${slot}`);
      }
    }
    return { id: workItem.id, slot, writePaths };
  }

  async createWorktree({ attempt, workItem, baseSha, deadlineAt }) {
    requireDeadline(deadlineAt);
    const prepared = this.#requirePrepared();
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 10_000) fail("invalid attempt");
    if (requireSha(baseSha, "baseSha") !== prepared.baseSha) {
      fail("every writer attempt must start from the immutable run base");
    }
    const validated = this.#validateWorkItem(workItem);
    const id = `attempt-${attempt}-${validated.slot}`;
    for (const directory of validated.writePaths) {
      if (!prepared.existingDirectories.includes(directory)) {
        fail(`${directory} must be an existing directory in the immutable base`);
      }
    }
    const record = await this.#addWorktree({
      id,
      sha: prepared.baseSha,
      attempt,
      slot: validated.slot,
      writeDirectories: validated.writePaths,
      deadlineAt,
    });
    for (const directory of validated.writePaths) {
      await this.#assertSafeDirectory(record.root, directory, deadlineAt);
    }
    record.workItemId = validated.id;
    return Object.freeze({
      id: record.id,
      root: record.root,
      writeDirectories: Object.freeze([...record.writeDirectories]),
    });
  }

  async createReadView({ id, sha, deadlineAt }) {
    requireDeadline(deadlineAt);
    this.#requirePrepared();
    const record = await this.#addWorktree({
      id: requireId(id, "read-view ID"),
      sha: requireSha(sha),
      writeDirectories: [],
      deadlineAt,
      kind: "read",
    });
    return Object.freeze({ id: record.id, root: record.root });
  }

  #workspaceRecord(workspace) {
    requirePlainObject(workspace, "workspace");
    const id = requireId(workspace.id, "workspace ID");
    const record = this.#workspaces.get(id);
    if (record === undefined || workspace.root !== record.root) fail("unknown workspace");
    return record;
  }

  async #head(record, deadlineAt) {
    return (await this.#git(["rev-parse", "--verify", "HEAD"], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
    })).toString("ascii").trim();
  }

  async #fileSizeAtHead(record, repositoryPath, deadlineAt) {
    const output = await this.#git(["ls-tree", "-z", "-l", "HEAD", "--", repositoryPath], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
    });
    const records = splitNull(output, "Git ls-tree output");
    if (records.length !== 1) fail(`could not resolve deleted file ${repositoryPath}`);
    const match = /^(\d+) blob [a-f0-9]{40}\s+(\d+)\t([\s\S]+)$/u.exec(records[0]);
    if (match === null || match[3] !== repositoryPath) fail("unexpected Git ls-tree output");
    if (match[1] === "120000" || match[1] === "160000") fail(`${repositoryPath} has a forbidden Git mode`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) fail("invalid Git blob size");
    return size;
  }

  async inspect({ workspace, limits, deadlineAt }) {
    requireDeadline(deadlineAt);
    const record = this.#workspaceRecord(workspace);
    if (record.kind !== "writer" && record.kind !== "combined") fail("workspace is not writable");
    const bounded = requireLimits(limits);
    for (const directory of record.writeDirectories) {
      await this.#assertSafeDirectory(record.root, directory, deadlineAt);
    }
    const common = { deadlineAt, gitDir: record.gitDir, workTree: record.root };
    const unmerged = await this.#git(["ls-files", "--unmerged", "-z"], common);
    if (unmerged.length > 0) fail("workspace contains an unmerged path");
    const tracked = splitNull(await this.#git([
      "diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--",
    ], common), "Git tracked diff");
    if (tracked.length % 2 !== 0) fail("unexpected Git tracked diff");
    const changes = new Map();
    for (let index = 0; index < tracked.length; index += 2) {
      const statusCode = tracked[index];
      const repositoryPath = tracked[index + 1];
      if (!/^[AMD]$/u.test(statusCode)) fail(`unsupported Git change type ${statusCode}`);
      changes.set(repositoryPath, statusCode);
    }
    const untracked = splitNull(await this.#git(["ls-files", "--others", "-z"], common), "Git untracked files");
    for (const repositoryPath of untracked) {
      if (changes.has(repositoryPath)) fail("Git reported a path as both tracked and untracked");
      changes.set(repositoryPath, "A");
    }
    const paths = sortPaths(changes.keys());
    ensureNoPathCollisions(paths, "changed paths");
    const details = [];
    let changedBytes = 0;
    for (const repositoryPath of paths) {
      validateRelativePath(repositoryPath, "changed path");
      if (!record.writeDirectories.some(directory => pathWithin(directory, repositoryPath))) {
        fail(`${repositoryPath} is outside the writer scope`);
      }
      const statusCode = changes.get(repositoryPath);
      let bytes;
      if (statusCode === "D") {
        bytes = await this.#fileSizeAtHead(record, repositoryPath, deadlineAt);
      } else {
        const full = path.join(record.root, ...repositoryPath.split("/"));
        const metadata = await checked(deadlineAt, () => lstat(full));
        if (metadata.isSymbolicLink()) fail(`${repositoryPath} is a symbolic link`);
        if (!metadata.isFile()) fail(`${repositoryPath} is not a regular file`);
        if (metadata.nlink > 1) fail(`${repositoryPath} is a hard-linked file`);
        const resolvedRoot = await checked(deadlineAt, () => realpath(record.root));
        const resolvedFile = await checked(deadlineAt, () => realpath(full));
        if (!filesystemDescendant(resolvedRoot, resolvedFile) || resolvedFile === resolvedRoot) {
          fail(`${repositoryPath} escaped the worktree`);
        }
        bytes = metadata.size;
        if (bytes > MAX_INSPECT_FILE_BYTES) fail(`${repositoryPath} exceeds the inspect file-size limit`);
        const content = await checked(deadlineAt, () => readFile(full));
        const after = await checked(deadlineAt, () => lstat(full));
        if (
          content.length !== bytes
          || !after.isFile()
          || after.isSymbolicLink()
          || after.size !== metadata.size
          || after.ino !== metadata.ino
          || after.mtimeMs !== metadata.mtimeMs
        ) {
          fail(`${repositoryPath} changed during inspection`);
        }
        details.push(Object.freeze({
          path: repositoryPath,
          status: statusCode,
          bytes,
          contentSha256: sha256(content),
        }));
      }
      changedBytes += bytes;
      if (!Number.isSafeInteger(changedBytes)) fail("changed-byte count exceeded the safe integer range");
      if (statusCode === "D") details.push(Object.freeze({ path: repositoryPath, status: statusCode, bytes }));
    }
    if (details.length > bounded.maxFiles) fail("changed-file limit exceeded");
    if (changedBytes > bounded.maxBytes) fail("changed-byte limit exceeded");
    return Object.freeze({
      changes: Object.freeze(details),
      changedFiles: details.length,
      changedBytes,
    });
  }

  async #freezeWorktree(record, deadlineAt) {
    const entries = await collectTree(record.root, deadlineAt);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    for (const { relative, metadata } of entries) {
      if (metadata.isSymbolicLink()) fail(`${relative} is a symbolic link in the worktree`);
      if (!metadata.isDirectory() && !metadata.isFile()) fail(`${relative} is a special file in the worktree`);
      if (metadata.isFile() && metadata.nlink > 1) fail(`${relative} is a hard-linked file in the worktree`);
    }
    for (const { relative, full, metadata } of entries) {
      if (record.writeDirectories.some(directory => pathWithin(directory, relative))) {
        await checked(deadlineAt, () => chown(full, uid, gid));
      }
      await checked(deadlineAt, () => chmod(
        full,
        relative === ".git" ? 0o400 : metadata.isDirectory() ? 0o555 : ((metadata.mode & 0o111) ? 0o555 : 0o444),
      ));
    }
    await checked(deadlineAt, () => chmod(record.root, 0o555));
  }

  async #inspectIndex(record, limits, deadlineAt) {
    const bounded = requireLimits(limits);
    const common = { deadlineAt, gitDir: record.gitDir, workTree: record.root };
    const tokens = splitNull(await this.#git([
      "diff", "--cached", "--name-status", "-z", "--no-renames", "HEAD", "--",
    ], common), "Git staged diff");
    if (tokens.length % 2 !== 0) fail("unexpected Git staged diff");
    const details = [];
    let changedBytes = 0;
    for (let index = 0; index < tokens.length; index += 2) {
      const statusCode = tokens[index];
      const repositoryPath = validateRelativePath(tokens[index + 1], "staged path");
      if (!/^[AMD]$/u.test(statusCode)) fail(`unsupported staged Git change type ${statusCode}`);
      if (!record.writeDirectories.some(directory => pathWithin(directory, repositoryPath))) {
        fail(`${repositoryPath} is outside the writer scope`);
      }
      let bytes;
      let contentSha256;
      if (statusCode === "D") {
        bytes = await this.#fileSizeAtHead(record, repositoryPath, deadlineAt);
      } else {
        const entries = splitNull(await this.#git([
          "ls-files", "--stage", "-z", "--", repositoryPath,
        ], common), "Git staged entry");
        if (entries.length !== 1) fail(`staged path ${repositoryPath} has an invalid index entry`);
        const match = /^(\d{6}) ([a-f0-9]{40}) 0\t([\s\S]+)$/u.exec(entries[0]);
        if (match === null || match[3] !== repositoryPath) fail("unexpected Git staged entry");
        if (match[1] !== "100644" && match[1] !== "100755") {
          fail(`${repositoryPath} has a forbidden staged Git mode`);
        }
        const sizeText = (await this.#git(["cat-file", "-s", match[2]], {
          deadlineAt,
          maxOutputBytes: 4_096,
        })).toString("ascii").trim();
        bytes = Number(sizeText);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_INSPECT_FILE_BYTES) {
          fail(`${repositoryPath} exceeds the staged file-size limit`);
        }
        const content = await this.#git(["cat-file", "blob", match[2]], {
          deadlineAt,
          maxOutputBytes: bytes + 1,
        });
        if (content.length !== bytes) fail(`${repositoryPath} staged blob size changed`);
        contentSha256 = sha256(content);
      }
      changedBytes += bytes;
      if (!Number.isSafeInteger(changedBytes)) fail("staged byte count exceeded the safe integer range");
      details.push(Object.freeze({
        path: repositoryPath,
        status: statusCode,
        bytes,
        ...(contentSha256 === undefined ? {} : { contentSha256 }),
      }));
    }
    details.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    ensureNoPathCollisions(details.map(change => change.path), "staged paths");
    if (details.length > bounded.maxFiles) fail("changed-file limit exceeded");
    if (changedBytes > bounded.maxBytes) fail("changed-byte limit exceeded");
    return Object.freeze({ changes: Object.freeze(details), changedFiles: details.length, changedBytes });
  }

  async #diffBetween({ baseSha, resultSha, directories = [], deadlineAt }) {
    requireSha(baseSha, "baseSha");
    requireSha(resultSha, "resultSha");
    const pathspec = directories.length > 0 ? ["--", ...directories] : [];
    const bytes = await this.#git([
      "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
      baseSha, resultSha, ...pathspec,
    ], { deadlineAt, maxOutputBytes: 32 * 1024 * 1024 });
    const names = splitNull(await this.#git([
      "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      baseSha, resultSha, ...pathspec,
    ], { deadlineAt }), "Git commit diff");
    for (const repositoryPath of names) validateRelativePath(repositoryPath, "changed path");
    ensureNoPathCollisions(names, "changed paths");
    const changedPaths = sortPaths(names);
    return {
      bytes,
      diff: bytes.toString("utf8"),
      diffSha256: sha256(bytes),
      changedPaths,
    };
  }

  async #commitStaged(record, message, deadlineAt) {
    if (
      typeof message !== "string"
      || message.length === 0
      || Buffer.byteLength(message) > 512
      || CONTROL.test(message)
    ) {
      fail("invalid controller commit message");
    }
    await this.#git([
      "commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-m", message,
    ], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
      environment: {
        GIT_AUTHOR_NAME: "Monolith Controller",
        GIT_AUTHOR_EMAIL: "controller@thisismonolith.invalid",
        GIT_COMMITTER_NAME: "Monolith Controller",
        GIT_COMMITTER_EMAIL: "controller@thisismonolith.invalid",
      },
    });
    return this.#head(record, deadlineAt);
  }

  async validateAndCommit({ workspace, workItem, limits, deadlineAt }) {
    requireDeadline(deadlineAt);
    const record = this.#workspaceRecord(workspace);
    if (record.kind !== "writer" && record.kind !== "combined") fail("workspace is not writable");
    const validated = this.#validateWorkItem(workItem, { expectedSlot: record.slot });
    if (
      validated.id !== record.workItemId
      || validated.writePaths.length !== record.writeDirectories.length
      || validated.writePaths.some((value, index) => value !== record.writeDirectories[index])
    ) {
      fail("workItem does not match the controller-captured writer scope");
    }
    await this.#freezeWorktree(record, deadlineAt);
    const inspected = await this.inspect({ workspace, limits, deadlineAt });
    if (inspected.changedFiles === 0) fail("writer produced no changes");
    const baseSha = await this.#head(record, deadlineAt);
    await this.#git(["add", "-f", "-A", "--", ...record.writeDirectories], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
    });
    const staged = await this.#inspectIndex(record, limits, deadlineAt);
    if (
      staged.changes.length !== inspected.changes.length
      || staged.changes.some((change, index) => {
        const before = inspected.changes[index];
        return change.path !== before.path
          || change.status !== before.status
          || change.bytes !== before.bytes
          || change.contentSha256 !== before.contentSha256;
      })
    ) {
      fail("writer content changed between inspection and staging");
    }
    const resultSha = await this.#commitStaged(
      record,
      `monolith(${record.slot}): ${record.workItemId}`,
      deadlineAt,
    );
    const parents = (await this.#git(["show", "-s", "--format=%P", resultSha], {
      deadlineAt,
    })).toString("ascii").trim().split(/\s+/u).filter(Boolean);
    if (parents.length !== 1 || parents[0] !== baseSha) fail("controller commit has an unexpected parent");
    const reread = await this.#diffBetween({ baseSha, resultSha, deadlineAt });
    if (
      reread.changedPaths.length !== staged.changes.length
      || reread.changedPaths.some((value, index) => value !== staged.changes[index].path)
    ) {
      fail("committed diff does not match the inspected writer delta");
    }
    const remaining = await this.inspect({
      workspace,
      limits: { maxFiles: 0, maxBytes: 0 },
      deadlineAt,
    });
    if (remaining.changedFiles !== 0) fail("workspace remained dirty after controller commit");
    const treeSha = (await this.#git(["show", "-s", "--format=%T", resultSha], {
      deadlineAt,
    })).toString("ascii").trim();
    const resultRecord = Object.freeze({
      attempt: record.attempt,
      slot: record.slot,
      workItemId: record.workItemId,
      directBaseSha: baseSha,
      runBaseSha: record.runBaseSha,
      resultSha,
      treeSha,
      writeDirectories: record.writeDirectories,
    });
    await this.#secureWorktree(record, deadlineAt);
    this.#resultRecords.set(resultSha, resultRecord);
    return Object.freeze({
      baseSha,
      resultSha,
      treeSha,
      changedPaths: Object.freeze(reread.changedPaths),
      changedFiles: staged.changedFiles,
      changedBytes: staged.changedBytes,
      diffSha256: reread.diffSha256,
      diff: reread.diff,
    });
  }

  async checkpoint(input) {
    return this.validateAndCommit(input);
  }

  async readCommit({ baseSha, resultSha, deadlineAt }) {
    requireDeadline(deadlineAt);
    this.#requirePrepared();
    const reread = await this.#diffBetween({ baseSha, resultSha, deadlineAt });
    return Object.freeze({
      baseSha,
      resultSha,
      changedPaths: Object.freeze(reread.changedPaths),
      diffSha256: reread.diffSha256,
      diff: reread.diff,
    });
  }

  async #unlockControllerPaths(record, directories, deadlineAt) {
    for (const directory of directories) {
      const full = await this.#assertSafeDirectory(record.root, directory, deadlineAt);
      const entries = await collectTree(full, deadlineAt);
      await checked(deadlineAt, () => chmod(full, 0o755));
      for (const entry of entries) {
        if (entry.metadata.isSymbolicLink()) fail(`${entry.relative} is a symbolic link`);
        if (!entry.metadata.isDirectory() && !entry.metadata.isFile()) fail(`${entry.relative} is a special file`);
        await checked(deadlineAt, () => chmod(
          entry.full,
          entry.metadata.isDirectory() ? 0o755 : ((entry.metadata.mode & 0o111) ? 0o755 : 0o644),
        ));
      }
    }
  }

  async #cumulativePatch(resultRecord, deadlineAt) {
    return this.#diffBetween({
      baseSha: resultRecord.runBaseSha,
      resultSha: resultRecord.resultSha,
      directories: resultRecord.writeDirectories,
      deadlineAt,
    });
  }

  async #applyResult(record, resultRecord, message, deadlineAt) {
    const patch = await this.#cumulativePatch(resultRecord, deadlineAt);
    if (patch.changedPaths.length === 0) fail("accepted result has an empty cumulative patch");
    for (const repositoryPath of patch.changedPaths) {
      if (!resultRecord.writeDirectories.some(directory => pathWithin(directory, repositoryPath))) {
        fail("accepted result escaped its captured writer scope");
      }
    }
    await this.#unlockControllerPaths(record, resultRecord.writeDirectories, deadlineAt);
    await this.#git(["update-index", "--refresh"], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
    });
    await this.#git([
      "apply", "--cached", "--binary", "--whitespace=nowarn", "-",
    ], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
      input: patch.bytes,
    });
    const resultSha = await this.#commitStaged(record, message, deadlineAt);
    await this.#git(["reset", "--hard", resultSha], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
    });
    return resultSha;
  }

  async #applyResultToIndex(record, resultRecord, deadlineAt) {
    const patch = await this.#cumulativePatch(resultRecord, deadlineAt);
    if (patch.changedPaths.length === 0) fail("accepted result has an empty cumulative patch");
    for (const repositoryPath of patch.changedPaths) {
      if (!resultRecord.writeDirectories.some(directory => pathWithin(directory, repositoryPath))) {
        fail("accepted result escaped its captured writer scope");
      }
    }
    await this.#git(["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], {
      deadlineAt,
      gitDir: record.gitDir,
      workTree: record.root,
      input: patch.bytes,
    });
    return patch;
  }

  async combineBase({ attempt, requesterCheckpointSha, dependencyResultSha, deadlineAt }) {
    requireDeadline(deadlineAt);
    const prepared = this.#requirePrepared();
    if (!Number.isSafeInteger(attempt) || attempt < 1) fail("invalid attempt");
    const requester = this.#resultRecords.get(requireSha(requesterCheckpointSha, "requesterCheckpointSha"));
    const dependency = this.#resultRecords.get(requireSha(dependencyResultSha, "dependencyResultSha"));
    if (requester === undefined || dependency === undefined) fail("dependency results are not controller-authored commits");
    if (requester.attempt !== attempt || dependency.attempt !== attempt) {
      fail("dependency results must come from the same attempt");
    }
    if (requester.slot !== "engineering-a" || dependency.slot !== "engineering-b") {
      fail("dependency combination requires engineering-a and engineering-b results");
    }
    const id = `attempt-${attempt}-engineering-a-resume-${++this.#workspaceCounter}`;
    const record = await this.#addWorktree({
      id,
      sha: prepared.baseSha,
      attempt,
      slot: "engineering-a",
      writeDirectories: requester.writeDirectories,
      deadlineAt,
      kind: "combined",
    });
    record.workItemId = requester.workItemId;
    try {
      await this.#applyResult(
        record,
        dependency,
        `monolith(dependency): ${dependency.workItemId}`,
        deadlineAt,
      );
      const baseSha = await this.#applyResult(
        record,
        requester,
        `monolith(requester): ${requester.workItemId}`,
        deadlineAt,
      );
      await this.#secureWorktree(record, deadlineAt);
      return Object.freeze({
        baseSha,
        workspace: Object.freeze({
          id: record.id,
          root: record.root,
          writeDirectories: Object.freeze([...record.writeDirectories]),
        }),
      });
    } catch (error) {
      fail(`dependency combination failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #readBranch(branch, deadlineAt) {
    const ref = `refs/heads/${branch}`;
    const result = await this.#run(this.#controllerArgs(["rev-parse", "--verify", ref]), {
      deadlineAt,
      allowedExitCodes: [0, 128],
      maxOutputBytes: 4_096,
    });
    if (result.exitCode === 128) return undefined;
    const value = outputBuffer(result).toString("ascii").trim();
    return requireSha(value, "branch head");
  }

  async integrate({ attempt, baseSha, commits, integrationOrder, branch, deadlineAt }) {
    requireDeadline(deadlineAt);
    const prepared = this.#requirePrepared();
    if (!Number.isSafeInteger(attempt) || attempt < 1) fail("invalid attempt");
    if (requireSha(baseSha, "baseSha") !== prepared.baseSha) fail("integration base must be the immutable run base");
    if (
      !Array.isArray(integrationOrder)
      || integrationOrder.length !== FIXED_INTEGRATION_ORDER.length
      || integrationOrder.some((slot, index) => slot !== FIXED_INTEGRATION_ORDER[index])
    ) {
      fail("integration must use the fixed integration order");
    }
    if (!Array.isArray(commits) || commits.length !== FIXED_INTEGRATION_ORDER.length) {
      fail("integration requires exactly three accepted commits");
    }
    const bySlot = new Map();
    for (const value of commits) {
      requirePlainObject(value, "accepted commit");
      const resultSha = requireSha(value.resultSha, "accepted resultSha");
      const record = this.#resultRecords.get(resultSha);
      if (record === undefined) fail("integration received a commit not authored by this controller");
      if (record.attempt !== attempt) fail("integration commits must belong to the active attempt");
      if (value.ownerSlot !== undefined && value.ownerSlot !== record.slot) fail("accepted commit slot does not match its controller record");
      if (bySlot.has(record.slot)) fail("integration received duplicate writer slots");
      bySlot.set(record.slot, record);
    }
    if (FIXED_INTEGRATION_ORDER.some(slot => !bySlot.has(slot))) {
      fail("integration requires the fixed engineering and QA slots");
    }
    const claimedPaths = new Map();
    const patches = new Map();
    for (const slot of FIXED_INTEGRATION_ORDER) {
      const patch = await this.#cumulativePatch(bySlot.get(slot), deadlineAt);
      patches.set(slot, patch);
      for (const repositoryPath of patch.changedPaths) {
        const folded = repositoryPath.toLowerCase();
        for (const [otherPath, otherSlot] of claimedPaths) {
          if (
            folded === otherPath
            || folded.startsWith(`${otherPath}/`)
            || otherPath.startsWith(`${folded}/`)
          ) {
            fail(`integration path conflict between ${otherSlot} and ${slot}`);
          }
        }
        claimedPaths.set(folded, slot);
      }
    }
    const branchName = requireBranch(branch);
    const id = `attempt-${attempt}-integration-${++this.#workspaceCounter}`;
    const record = await this.#addWorktree({
      id,
      sha: prepared.baseSha,
      attempt,
      writeDirectories: [],
      deadlineAt,
      kind: "integration",
    });
    const integratedResultShas = [];
    let candidateSha;
    try {
      for (const slot of FIXED_INTEGRATION_ORDER) {
        const result = bySlot.get(slot);
        await this.#applyResultToIndex(record, result, deadlineAt);
        integratedResultShas.push(result.resultSha);
      }
      const treeSha = (await this.#git(["write-tree"], {
        deadlineAt,
        gitDir: record.gitDir,
        workTree: record.root,
      })).toString("ascii").trim();
      requireSha(treeSha, "integrated tree SHA");
      const acceptedTimes = [];
      for (const resultSha of integratedResultShas) {
        const seconds = Number((await this.#git(["show", "-s", "--format=%ct", resultSha], {
          deadlineAt,
        })).toString("ascii").trim());
        if (!Number.isSafeInteger(seconds) || seconds < 0) fail("accepted commit has an invalid timestamp");
        acceptedTimes.push(seconds);
      }
      const integrationDate = `${Math.max(...acceptedTimes) + 1} +0000`;
      candidateSha = (await this.#git([
        "commit-tree", treeSha,
        ...integratedResultShas.flatMap(resultSha => ["-p", resultSha]),
        "-m", `monolith integration: attempt ${attempt}`,
      ], {
        deadlineAt,
        environment: {
          GIT_AUTHOR_DATE: integrationDate,
          GIT_COMMITTER_DATE: integrationDate,
        },
      })).toString("ascii").trim();
      requireSha(candidateSha, "candidateSha");
      const candidateParents = (await this.#git(["show", "-s", "--format=%P", candidateSha], {
        deadlineAt,
      })).toString("ascii").trim().split(/\s+/u).filter(Boolean);
      if (
        candidateParents.length !== integratedResultShas.length
        || candidateParents.some((value, index) => value !== integratedResultShas[index])
      ) {
        fail("candidate does not preserve the exact accepted commit parents");
      }
      for (const slot of FIXED_INTEGRATION_ORDER) {
        const result = bySlot.get(slot);
        const ancestry = await this.#run(this.#controllerArgs([
          "merge-base", "--is-ancestor", result.resultSha, candidateSha,
        ]), { deadlineAt, allowedExitCodes: [0, 1], maxOutputBytes: 4_096 });
        if ((ancestry.exitCode ?? 0) !== 0) fail("candidate omitted an accepted commit from its ancestry");
        const candidatePatch = await this.#diffBetween({
          baseSha: prepared.baseSha,
          resultSha: candidateSha,
          directories: result.writeDirectories,
          deadlineAt,
        });
        const acceptedPatch = patches.get(slot);
        if (
          candidatePatch.diffSha256 !== acceptedPatch.diffSha256
          || candidatePatch.changedPaths.length !== acceptedPatch.changedPaths.length
          || candidatePatch.changedPaths.some((value, index) => value !== acceptedPatch.changedPaths[index])
        ) {
          fail(`candidate tree does not exactly preserve the accepted ${slot} result`);
        }
      }
      await this.#unlockControllerPaths(
        record,
        FIXED_INTEGRATION_ORDER.flatMap(slot => bySlot.get(slot).writeDirectories),
        deadlineAt,
      );
      await this.#git(["reset", "--hard", candidateSha], {
        deadlineAt,
        gitDir: record.gitDir,
        workTree: record.root,
      });
      await this.#secureWorktree(record, deadlineAt);
    } catch (error) {
      fail(`integration conflict; refusing candidate: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (await this.#head(record, deadlineAt) !== candidateSha) fail("integration worktree is not at the exact candidate SHA");
    const existing = await this.#readBranch(branchName, deadlineAt);
    const expected = this.#branchHeads.get(branchName);
    if (expected === undefined && existing !== undefined) fail("integration branch already exists outside this runtime");
    if (expected !== undefined && existing !== expected) fail("integration branch changed concurrently");
    await this.#git([
      "update-ref", `refs/heads/${branchName}`, candidateSha, expected ?? ZERO_SHA1,
    ], { deadlineAt });
    this.#branchHeads.set(branchName, candidateSha);
    record.candidateSha = candidateSha;
    return Object.freeze({
      branch: branchName,
      candidateSha,
      workspaceId: record.id,
      workspaceRoot: record.root,
      integratedResultShas: Object.freeze(integratedResultShas),
    });
  }

  async scan({ baseSha, candidateSha, deadlineAt }) {
    requireDeadline(deadlineAt);
    const prepared = this.#requirePrepared();
    if (requireSha(baseSha, "baseSha") !== prepared.baseSha) fail("scan base must be the immutable run base");
    requireSha(candidateSha, "candidateSha");
    if (![...this.#branchHeads.values()].includes(candidateSha)) fail("scan candidate is not an integrated controller candidate");
    const ancestry = await this.#run(this.#controllerArgs([
      "merge-base", "--is-ancestor", baseSha, candidateSha,
    ]), { deadlineAt, allowedExitCodes: [0, 1], maxOutputBytes: 4_096 });
    if ((ancestry.exitCode ?? 0) !== 0) fail("candidate is not descended from the immutable run base");
    const history = await this.#scanReachableHistory(baseSha, candidateSha, deadlineAt);
    const raw = splitNull(await this.#git([
      "diff", "--raw", "-z", "--abbrev=40", "--no-renames", "--no-ext-diff", baseSha, candidateSha, "--",
    ], { deadlineAt }), "candidate raw diff");
    if (raw.length % 2 !== 0) fail("candidate raw diff is malformed");
    const changedPaths = [];
    let scannedBytes = 0;
    for (let index = 0; index < raw.length; index += 2) {
      const metadata = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/u.exec(raw[index]);
      if (metadata === null) fail("candidate contains an unsupported change type");
      const [, oldMode, newMode, , candidateObject, statusCode] = metadata;
      const repositoryPath = validateRelativePath(raw[index + 1], "candidate changed path");
      changedPaths.push(repositoryPath);
      for (const mode of [oldMode, newMode]) {
        if (mode === "000000") continue;
        if (mode === "120000") fail(`${repositoryPath} is a symbolic link in the candidate diff`);
        if (mode === "160000") fail(`${repositoryPath} is a Git link in the candidate diff`);
        if (mode !== "100644" && mode !== "100755") fail(`${repositoryPath} has an unsupported Git mode`);
      }
      if (oldMode !== "000000" && newMode !== "000000" && oldMode !== newMode) {
        fail(`${repositoryPath} changes executable policy`);
      }
      if (oldMode === "000000" && newMode === "100755") {
        fail(`${repositoryPath} adds an unexpected executable`);
      }
      if (statusCode === "D") continue;
      const sizeText = (await this.#git(["cat-file", "-s", candidateObject], {
        deadlineAt,
        maxOutputBytes: 4_096,
      })).toString("ascii").trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SCAN_BLOB_BYTES) {
        fail(`${repositoryPath} exceeds the candidate scan blob limit`);
      }
      scannedBytes += size;
      if (!Number.isSafeInteger(scannedBytes) || scannedBytes > MAX_SNAPSHOT_BYTES) {
        fail("candidate changed blobs exceed the scan byte limit");
      }
      const content = await this.#git(["cat-file", "blob", candidateObject], {
        deadlineAt,
        maxOutputBytes: size + 1,
      });
      if (content.length !== size) fail("candidate blob changed during scan");
      const text = content.toString("latin1");
      if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
        fail(`${repositoryPath} contains a likely live secret or private key`);
      }
    }
    ensureNoPathCollisions(changedPaths, "candidate changed paths");
    const exactDiff = await this.#diffBetween({ baseSha, resultSha: candidateSha, deadlineAt });
    if (
      exactDiff.changedPaths.length !== changedPaths.length
      || exactDiff.changedPaths.some((value, index) => value !== sortPaths(changedPaths)[index])
    ) {
      fail("candidate diff path scan disagrees with the exact diff");
    }
    return Object.freeze({
      status: "passed",
      candidateSha,
      evidence: Object.freeze([
        `base:${baseSha}`,
        `candidate:${candidateSha}`,
        `changed-files:${changedPaths.length}`,
        `changed-bytes:${scannedBytes}`,
        `diff-sha256:${exactDiff.diffSha256}`,
        `reachable-commits:${history.commits}`,
        `reachable-new-blobs:${history.blobs}`,
        `reachable-sha256:${history.sha256}`,
      ]),
    });
  }

  async #treeEntries(sha, deadlineAt) {
    const tokens = splitNull(await this.#git([
      "ls-tree", "-r", "-z", "--full-tree", sha,
    ], { deadlineAt, maxOutputBytes: 16 * 1024 * 1024 }), "reachable Git tree");
    const entries = [];
    for (const token of tokens) {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(token);
      if (match === null) fail("reachable history contains an invalid tree entry");
      const repositoryPath = validateSnapshotPath(match[4], "reachable history path");
      entries.push(Object.freeze({
        mode: match[1],
        type: match[2],
        objectId: match[3],
        path: repositoryPath,
      }));
    }
    ensureNoPathCollisions(entries.map(entry => entry.path), "reachable history paths");
    return entries;
  }

  async #scanReachableHistory(baseSha, candidateSha, deadlineAt) {
    const baseEntries = new Map((await this.#treeEntries(baseSha, deadlineAt)).map(entry => [entry.path, entry]));
    const baseObjects = new Set([...baseEntries.values()].map(entry => entry.objectId));
    const baseControlPaths = [...baseEntries.keys()].filter(repositoryPath => (
      repositoryPath.split("/").some(component => component.toLowerCase() === ".github")
    ));
    const revisionBytes = await this.#git([
      "rev-list", "--topo-order", candidateSha, `^${baseSha}`,
    ], { deadlineAt, maxOutputBytes: 16 * 1024 });
    const revisions = revisionBytes.toString("ascii").trim().split("\n").filter(Boolean);
    if (revisions.length < 1 || revisions.length > MAX_REACHABLE_COMMITS) {
      fail("candidate reachable-commit limit exceeded");
    }
    for (const revision of revisions) requireSha(revision, "reachable commit");
    const scannedObjects = new Set();
    const digest = createHash("sha256");
    let treeEntries = 0;
    let scannedBytes = 0;
    for (const revision of revisions) {
      digest.update(`C\0${revision}\0`);
      const message = await this.#git(["show", "-s", "--format=%B", revision], {
        deadlineAt,
        maxOutputBytes: 64 * 1024,
      });
      if (SECRET_PATTERNS.some(pattern => pattern.test(message.toString("latin1")))) {
        fail("reachable commit metadata contains a likely live secret or private key");
      }
      const entries = await this.#treeEntries(revision, deadlineAt);
      treeEntries += entries.length;
      if (treeEntries > MAX_REACHABLE_TREE_ENTRIES) fail("candidate reachable-tree entry limit exceeded");
      const seen = new Set();
      for (const entry of entries) {
        seen.add(entry.path);
        if (entry.type !== "blob" || entry.mode === "120000") {
          fail(`${entry.path} is a symbolic link or Git link in reachable history`);
        }
        if (entry.mode !== "100644" && entry.mode !== "100755") {
          fail(`${entry.path} has an unsupported reachable Git mode`);
        }
        const baseEntry = baseEntries.get(entry.path);
        const controlPath = entry.path.split("/").some(component => component.toLowerCase() === ".github");
        if (controlPath && (baseEntry === undefined || baseEntry.objectId !== entry.objectId || baseEntry.mode !== entry.mode)) {
          fail(`${entry.path} changes forbidden repository control history`);
        }
        if (entry.mode === "100755" && baseEntry?.mode !== "100755") {
          fail(`${entry.path} adds an unexpected executable in reachable history`);
        }
        if (baseEntry !== undefined && entry.mode !== baseEntry.mode) {
          fail(`${entry.path} changes executable policy in reachable history`);
        }
        if (baseObjects.has(entry.objectId) || scannedObjects.has(entry.objectId)) continue;
        const sizeText = (await this.#git(["cat-file", "-s", entry.objectId], {
          deadlineAt,
          maxOutputBytes: 4_096,
        })).toString("ascii").trim();
        const size = Number(sizeText);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SCAN_BLOB_BYTES) {
          fail(`${entry.path} exceeds the reachable-history blob limit`);
        }
        scannedBytes += size;
        if (!Number.isSafeInteger(scannedBytes) || scannedBytes > MAX_SNAPSHOT_BYTES) {
          fail("reachable history exceeds the scan byte limit");
        }
        const content = await this.#git(["cat-file", "blob", entry.objectId], {
          deadlineAt,
          maxOutputBytes: size + 1,
        });
        if (content.length !== size) fail("reachable blob changed during scan");
        if (SECRET_PATTERNS.some(pattern => pattern.test(content.toString("latin1")))) {
          fail(`${entry.path} contains a likely live secret or private key in reachable history`);
        }
        scannedObjects.add(entry.objectId);
        digest.update(`B\0${entry.objectId}\0${size}\0`);
        digest.update(content);
      }
      for (const controlPath of baseControlPaths) {
        if (!seen.has(controlPath)) fail(`${controlPath} is deleted in reachable control history`);
      }
    }
    return Object.freeze({
      commits: revisions.length,
      blobs: scannedObjects.size,
      bytes: scannedBytes,
      sha256: digest.digest("hex"),
    });
  }

  async #snapshotReceipt(root, deadlineAt) {
    const entries = await collectTree(root, deadlineAt);
    const digest = createHash("sha256");
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      validateSnapshotPath(entry.relative);
      if (entry.metadata.isSymbolicLink()) fail(`${entry.relative} is a symbolic link in the snapshot`);
      if (entry.metadata.isDirectory()) {
        digest.update(`D\0${entry.relative}\0${entry.metadata.mode & 0o777}\0`);
        continue;
      }
      if (!entry.metadata.isFile()) fail(`${entry.relative} is a special file in the snapshot`);
      if (entry.metadata.nlink > 1) fail(`${entry.relative} is hard-linked in the snapshot`);
      if (entry.metadata.size > MAX_SNAPSHOT_FILE_BYTES) fail("snapshot file-size limit exceeded");
      files += 1;
      bytes += entry.metadata.size;
      if (files > MAX_SNAPSHOT_FILES) fail("snapshot file-count limit exceeded");
      if (!Number.isSafeInteger(bytes) || bytes > MAX_SNAPSHOT_BYTES) fail("snapshot byte limit exceeded");
      const content = await checked(deadlineAt, () => readFile(entry.full));
      if (content.length !== entry.metadata.size) fail("snapshot file changed during receipt calculation");
      const after = await checked(deadlineAt, () => lstat(entry.full));
      if (
        !after.isFile()
        || after.isSymbolicLink()
        || after.size !== entry.metadata.size
        || after.mtimeMs !== entry.metadata.mtimeMs
        || after.ino !== entry.metadata.ino
      ) {
        fail("snapshot file changed during receipt calculation");
      }
      digest.update(`F\0${entry.relative}\0${entry.metadata.mode & 0o777}\0${entry.metadata.size}\0`);
      digest.update(content);
    }
    if (files < 1 || bytes < 1) fail("snapshot is empty");
    return Object.freeze({ files, bytes, sha256: digest.digest("hex") });
  }

  async #lockSnapshot(root, deadlineAt) {
    const entries = await collectTree(root, deadlineAt);
    const uid = this.#allowLocalRepository && typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = this.#allowLocalRepository && typeof process.getgid === "function" ? process.getgid() : 0;
    for (const entry of entries) {
      if (entry.metadata.isSymbolicLink()) fail(`${entry.relative} is a symbolic link in the snapshot`);
      await checked(deadlineAt, () => chown(entry.full, uid, gid));
      await checked(deadlineAt, () => chmod(
        entry.full,
        entry.metadata.isDirectory() ? 0o555 : ((entry.metadata.mode & 0o111) ? 0o555 : 0o444),
      ));
    }
    await checked(deadlineAt, () => chown(root, uid, gid));
    await checked(deadlineAt, () => chmod(root, 0o555));
  }

  async createSnapshot({ id, sha, deadlineAt }) {
    requireDeadline(deadlineAt);
    const prepared = this.#requirePrepared();
    const snapshotId = requireId(id, "snapshot ID");
    const exactSha = requireSha(sha, "snapshot SHA");
    if (exactSha !== prepared.baseSha && ![...this.#branchHeads.values()].includes(exactSha)) {
      fail("snapshot SHA must be the immutable base or an integrated candidate");
    }
    if (this.#snapshots.has(snapshotId)) fail("snapshot ID already exists");
    const runRoot = path.resolve(this.#snapshotsRoot, this.#runId);
    const destination = path.resolve(runRoot, snapshotId);
    if (!filesystemDescendant(runRoot, destination) || destination === runRoot) fail("invalid snapshot path");
    if (!this.#snapshotsRunOwned) fail("snapshot run root is not controller-owned");
    try {
      await checked(deadlineAt, () => lstat(destination));
      fail("snapshot destination already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const source = await this.#addWorktree({
      id: `snapshot-source-${snapshotId}-${++this.#workspaceCounter}`,
      sha: exactSha,
      writeDirectories: [],
      deadlineAt,
      kind: "snapshot-source",
    });
    const temporary = await checked(deadlineAt, () => mkdtemp(path.join(path.dirname(destination), `.${snapshotId}-`)));
    let installed = false;
    try {
      const sourceEntries = await collectTree(source.root, deadlineAt);
      for (const entry of sourceEntries) {
        if (entry.relative === ".git") continue;
        validateSnapshotPath(entry.relative);
        if (entry.metadata.isSymbolicLink()) fail(`${entry.relative} is a symbolic link in the source tree`);
        const target = path.join(temporary, ...entry.relative.split("/"));
        if (entry.metadata.isDirectory()) {
          await checked(deadlineAt, () => mkdir(target, { mode: 0o700 }));
        } else if (entry.metadata.isFile()) {
          if (entry.metadata.size > MAX_SNAPSHOT_FILE_BYTES) fail("snapshot file-size limit exceeded");
          await checked(deadlineAt, () => copyFile(entry.full, target));
        } else {
          fail(`${entry.relative} is a special file in the source tree`);
        }
      }
      await this.#lockSnapshot(temporary, deadlineAt);
      await checked(deadlineAt, () => rename(temporary, destination));
      installed = true;
      const lockedReceipt = await this.#snapshotReceipt(destination, deadlineAt);
      const record = Object.freeze({
        id: snapshotId,
        root: destination,
        sha: exactSha,
        receipt: Object.freeze({ ...lockedReceipt }),
      });
      this.#snapshots.set(snapshotId, record);
      return Object.freeze({ ...record });
    } catch (error) {
      const cleanupTarget = installed ? destination : temporary;
      await this.#unlockForRemoval(cleanupTarget, Date.now() + 5_000).catch(() => {});
      await rm(cleanupTarget, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #unlockForRemoval(root, deadlineAt) {
    const controllerUid = typeof process.getuid === "function" ? process.getuid() : 0;
    const controllerGid = typeof process.getgid === "function" ? process.getgid() : 0;
    let metadata;
    try {
      metadata = await checked(deadlineAt, () => lstat(root));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!metadata.isDirectory()) {
      await checked(deadlineAt, () => chown(root, controllerUid, controllerGid));
      await checked(deadlineAt, () => chmod(root, 0o600));
      return;
    }
    await checked(deadlineAt, () => chown(root, controllerUid, controllerGid));
    await checked(deadlineAt, () => chmod(root, 0o700));
    const entries = await collectTree(root, deadlineAt);
    for (const entry of entries) {
      if (entry.metadata.isSymbolicLink()) continue;
      await checked(deadlineAt, () => chown(entry.full, controllerUid, controllerGid));
      await checked(deadlineAt, () => chmod(entry.full, entry.metadata.isDirectory() ? 0o700 : 0o600));
    }
  }

  async close({ retainForPublication = false, deadlineAt } = {}) {
    if (this.#closed) return;
    if (typeof retainForPublication !== "boolean") fail("retainForPublication must be a boolean");
    const cleanupDeadline = Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now()
      ? deadlineAt
      : Date.now() + 10_000;
    for (const snapshot of [...this.#snapshots.values()].reverse()) {
      await this.#unlockForRemoval(snapshot.root, cleanupDeadline).catch(() => {});
      await rm(snapshot.root, { recursive: true, force: true }).catch(() => {});
    }
    for (const record of [...this.#workspaces.values()].reverse()) {
      await this.#unlockForRemoval(record.root, cleanupDeadline).catch(() => {});
      await this.#git(["worktree", "remove", "--force", "--", record.root], {
        deadlineAt: cleanupDeadline,
        allowedExitCodes: [0, 128],
      }).catch(() => {});
      await rm(record.root, { recursive: true, force: true }).catch(() => {});
    }
    if (retainForPublication && this.#gitRootOwned) {
      await this.#git(["worktree", "prune", "--expire=now"], { deadlineAt: cleanupDeadline });
      const adminRoot = path.join(this.#bareRoot, "worktrees");
      const stale = await readdir(adminRoot).catch(error => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      if (stale.length !== 0) fail("retained repository contains stale worktree administration");
    }
    for (const [owned, runRoot] of [
      [this.#worktreesRunOwned, path.join(this.#worktreesRoot, this.#runId)],
      [this.#snapshotsRunOwned, path.join(this.#snapshotsRoot, this.#runId)],
    ]) {
      if (!owned) continue;
      await rmdir(runRoot).catch(error => {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
      });
    }
    if (await this.#verifyGitRootOwnership(cleanupDeadline)) {
      await rm(this.#home, { recursive: true, force: true });
      if (!retainForPublication) await rm(this.#bareRoot, { recursive: true, force: true });
      await rm(this.#markerPath, { force: true });
    }
    this.#closed = true;
  }
}

export function createGitRuntime(options) {
  return new GitRuntime(options);
}
