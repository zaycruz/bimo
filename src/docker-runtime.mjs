import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/;
const HOST_ROOT = /^\/var\/lib\/monolith\/deployments\/[a-z][a-z0-9-]{0,31}$/;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EXECUTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NODE_UID = 1000;
const NODE_GID = 1000;
const PROXY_LIFETIME_SECONDS = 3_600;
const MAX_MODEL_CONCURRENCY = 3;
const MAX_MODEL_REQUESTS = 300;
const MAX_SNAPSHOT_ENTRIES = 10_000;
const MAX_SNAPSHOT_DEPTH = 64;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const COMMAND_KILL_GRACE_MS = 250;
const artifactReceipts = new WeakMap();
const DEPLOYMENT_LABEL = "sh.thisismonolith.deployment";
const TRANSIENT_LABEL = "sh.thisismonolith.transient";

function fail(message) {
  throw new Error(message);
}

function containerName(deployment, suffix) {
  return `monolith-${deployment}-${suffix}`;
}

function commonSandbox({ memory = "2g", cpus = "1.5", pids = "256" } = {}) {
  return [
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", pids,
    "--memory", memory,
    "--cpus", cpus,
    "--user", `${NODE_UID}:${NODE_GID}`,
  ];
}

function bind(source, target, readOnly = false) {
  if (source.includes(",") || source.includes("\n")) fail("unsafe bind mount source");
  return `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`;
}

function writableWorkspaceMounts(workspaceHost, access, writeMounts) {
  if (writeMounts === undefined) {
    return {
      rootReadOnly: access !== "write",
      maskGit: false,
      mounts: [],
    };
  }
  if (!Array.isArray(writeMounts) || writeMounts.length > 32) {
    fail("invalid writable workspace directories");
  }
  if ((access === "write") !== (writeMounts.length > 0)) {
    fail("writable workspace directories do not match access");
  }

  const relatives = [];
  const mounts = writeMounts.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).sort().join(",") !== "relative,source") {
      fail("invalid writable workspace directory");
    }
    const { relative, source } = value;
    if (typeof relative !== "string" || relative.length < 1 || relative.length > 240
        || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(relative)) {
      fail("invalid writable workspace directory");
    }
    const parts = relative.split("/");
    if (parts.some(part => part === "." || part === "..")
        || parts.some(part => part.toLowerCase() === ".git" || part.toLowerCase() === ".github")) {
      fail("invalid writable workspace directory");
    }
    const expectedSource = path.join(workspaceHost, ...parts);
    if (typeof source !== "string" || path.resolve(source) !== expectedSource) {
      fail("invalid writable workspace directory");
    }
    for (const existing of relatives) {
      if (relative === existing || relative.startsWith(`${existing}/`) || existing.startsWith(`${relative}/`)) {
        fail("overlapping writable workspace directories");
      }
    }
    relatives.push(relative);
    return {
      source: expectedSource,
      target: `/workspace/${relative}`,
    };
  });

  return { rootReadOnly: true, maskGit: true, mounts };
}

function transientLabels(deployment) {
  return [
    "--label", `${DEPLOYMENT_LABEL}=${deployment}`,
    "--label", `${TRANSIENT_LABEL}=true`,
  ];
}

function validateDeadline(deadlineAt, label = "deployment") {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) {
    fail(`invalid ${label} deadline`);
  }
  return deadlineAt;
}

function remaining(deadlineAt, label) {
  const milliseconds = deadlineAt - Date.now();
  if (milliseconds < 1) fail(`${label} deadline exceeded`);
  return milliseconds;
}

async function bounded(operation, deadlineAt, label) {
  const milliseconds = remaining(deadlineAt, label);
  let timer;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => finish(reject, new Error(`${label} deadline exceeded`)), milliseconds);
    Promise.resolve().then(operation).then(
      value => {
        if (Date.now() >= deadlineAt) finish(reject, new Error(`${label} deadline exceeded`));
        else finish(resolve, value);
      },
      error => finish(reject, error),
    );
  });
}

async function checkedFs(operation, deadlineAt, label) {
  return bounded(operation, deadlineAt, label);
}

async function abortableFs(operation, deadlineAt, label) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, remaining(deadlineAt, label));
  try {
    const result = await operation(controller.signal);
    if (expired) fail(`${label} deadline exceeded`);
    remaining(deadlineAt, label);
    return result;
  } catch (error) {
    if (expired) fail(`${label} deadline exceeded`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateArtifactReceipt(receipt, workflow) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.getPrototypeOf(receipt) !== Object.prototype
      || Object.keys(receipt).sort().join(",") !== "bytes,files,sha256"
      || !Number.isInteger(receipt.files) || receipt.files < 1 || receipt.files > workflow.output.maxFiles
      || !Number.isInteger(receipt.bytes) || receipt.bytes < 0 || receipt.bytes > workflow.output.maxBytes
      || !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
    fail("verification returned an invalid artifact receipt");
  }
  return { files: receipt.files, bytes: receipt.bytes, sha256: receipt.sha256 };
}

function validateSourceSnapshotHandle(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(",") !== "id,receipt,sha"
      || !EXECUTION_ID.test(value.id ?? "")
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sha ?? "")) {
    fail(`invalid ${label} source snapshot`);
  }
  const receipt = value.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.getPrototypeOf(receipt) !== Object.prototype
      || Object.keys(receipt).sort().join(",") !== "bytes,files,sha256"
      || !Number.isInteger(receipt.files) || receipt.files < 1 || receipt.files > 10_000
      || !Number.isInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > 100 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
    fail(`invalid ${label} source snapshot receipt`);
  }
  return Object.freeze({
    id: value.id,
    sha: value.sha,
    receipt: Object.freeze({ files: receipt.files, bytes: receipt.bytes, sha256: receipt.sha256 }),
  });
}

function validateSourceVerifierReceipt(value, { expectedSha, profile, suite, snapshot }) {
  const expectedFields = suite === "candidate"
    ? "candidateSha,evidence,profile,snapshot,status,suite"
    : "candidateSha,evidence,profile,status,suite";
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(",") !== expectedFields
      || value.status !== "passed" || value.candidateSha !== expectedSha
      || value.profile !== profile || value.suite !== suite
      || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 600) {
    fail(`source ${suite} verifier returned an invalid receipt`);
  }
  for (const evidence of value.evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
        || Object.getPrototypeOf(evidence) !== Object.prototype
        || Object.keys(evidence).sort().join(",") !== "authority,command,outputSha256"
        || !["trusted", "advisory"].includes(evidence.authority)
        || typeof evidence.command !== "string" || !evidence.command || Buffer.byteLength(evidence.command) > 512
        || !/^[a-f0-9]{64}$/.test(evidence.outputSha256)) {
      fail(`source ${suite} verifier returned invalid evidence`);
    }
  }
  if (suite === "candidate") {
    if (!value.snapshot || !sameArtifact(value.snapshot, snapshot)) {
      fail("source candidate verifier snapshot receipt did not match");
    }
  } else if (value.evidence.some(item => item.authority !== "trusted")) {
    fail("source baseline verifier returned advisory evidence");
  }
  return value;
}

function sameArtifact(left, right) {
  return left.files === right.files && left.bytes === right.bytes && left.sha256 === right.sha256;
}

export function agentCreateArgs({
  deployment,
  role,
  step,
  image,
  network,
  workspaceHost,
  handoffHost,
  promptHost,
  access,
  model,
  timeoutSeconds,
  nameSuffix = `${role}-${step}`,
  writeMounts,
}) {
  if (!EXECUTION_ID.test(nameSuffix)) fail("invalid agent execution name");
  const workspaceMounts = writableWorkspaceMounts(workspaceHost, access, writeMounts);
  const name = containerName(deployment, nameSuffix);
  return [
    "create",
    "--name", name,
    ...transientLabels(deployment),
    "--network", network,
    ...commonSandbox(),
    "--ulimit", "fsize=8388608:8388608",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--tmpfs", "/home/node:rw,nosuid,nodev,size=512m,uid=1000,gid=1000",
    "--tmpfs", "/instructions:rw,nosuid,nodev,noexec,size=64k,uid=1000,gid=1000",
    "--env", "MONOLITH_GATEWAY_URL=http://gateway:8787/api/v1",
    "--mount", bind(workspaceHost, "/workspace", workspaceMounts.rootReadOnly),
    ...(workspaceMounts.maskGit ? ["--mount", bind("/dev/null", "/workspace/.git", true)] : []),
    ...workspaceMounts.mounts.flatMap(({ source, target }) => ["--mount", bind(source, target, false)]),
    "--mount", bind(handoffHost, "/handoff", false),
    "--mount", bind(promptHost, "/instructions/instructions.md", true),
    image,
    "agent",
    "--role", role,
    "--model", model,
    "--timeout-seconds", String(timeoutSeconds),
  ];
}

export function bootstrapArgs({ deployment, image, workspaceHost }) {
  return [
    "run",
    "--rm",
    "--name", containerName(deployment, "bootstrap"),
    ...transientLabels(deployment),
    "--network", "none",
    ...commonSandbox({ memory: "512m", cpus: "1", pids: "128" }),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs", "/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000",
    "--mount", bind(workspaceHost, "/workspace", false),
    image,
    "bootstrap",
  ];
}

export function proxyCreateArgs({
  deployment,
  image,
  network,
  model,
  modelConcurrency = 1,
  modelRequestLimit = 100,
}) {
  if (!Number.isInteger(modelConcurrency)
      || modelConcurrency < 1
      || modelConcurrency > MAX_MODEL_CONCURRENCY) {
    fail("invalid model concurrency");
  }
  if (!Number.isInteger(modelRequestLimit)
      || modelRequestLimit < 1
      || modelRequestLimit > MAX_MODEL_REQUESTS) {
    fail("invalid model request limit");
  }
  return [
    "create",
    "--interactive",
    "--name", containerName(deployment, "gateway"),
    ...transientLabels(deployment),
    "--network", network,
    "--network-alias", "gateway",
    ...commonSandbox({ memory: "256m", cpus: "0.5", pids: "64" }),
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
    image,
    "proxy",
    "--listen-scope", "isolated-network",
    "--lifetime-seconds", String(PROXY_LIFETIME_SECONDS),
    "--port", "8787",
    "--model", model.replace(/^openrouter\//, ""),
    "--max-requests", String(modelRequestLimit),
    "--max-concurrency", String(modelConcurrency),
    "--max-body-bytes", "2097152",
    "--timeout-seconds", "300",
  ];
}

export function sourceVerifierCreateArgs({
  deployment,
  image,
  snapshotHost,
  baselineTestHost,
  expectedSha,
  expectedSnapshot,
  profile,
  suite,
  timeoutSeconds,
  nameSuffix,
}) {
  if (!NAME.test(deployment ?? "") || !EXECUTION_ID.test(nameSuffix ?? "")) {
    fail("invalid source verifier identity");
  }
  if (!SAFE_IMAGE.test(image ?? "")) fail("invalid source verifier image");
  const snapshotRoot = path.join("/var/lib/monolith/deployments", deployment, "snapshots");
  if (typeof snapshotHost !== "string" || !path.isAbsolute(snapshotHost)
      || !path.resolve(snapshotHost).startsWith(`${snapshotRoot}${path.sep}`)) {
    fail("invalid source snapshot host path");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedSha ?? "")) {
    fail("invalid source verifier SHA");
  }
  if (profile !== "monolith-repo-v1" || (suite !== "candidate" && suite !== "baseline")) {
    fail("invalid source verification profile");
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
    fail("invalid source verification timeout");
  }
  if (suite === "candidate") {
    if (!expectedSnapshot || typeof expectedSnapshot !== "object" || Array.isArray(expectedSnapshot)
        || Object.getPrototypeOf(expectedSnapshot) !== Object.prototype
        || Object.keys(expectedSnapshot).sort().join(",") !== "bytes,files,sha256"
        || !Number.isInteger(expectedSnapshot.files) || expectedSnapshot.files < 1 || expectedSnapshot.files > 10_000
        || !Number.isInteger(expectedSnapshot.bytes) || expectedSnapshot.bytes < 1 || expectedSnapshot.bytes > 100 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(expectedSnapshot.sha256)) {
      fail("invalid expected source snapshot");
    }
    if (baselineTestHost !== undefined) fail("candidate verification cannot mount baseline tests");
  } else {
    if (expectedSnapshot !== undefined) fail("baseline verification cannot accept a snapshot receipt");
    if (typeof baselineTestHost !== "string" || !path.isAbsolute(baselineTestHost)
        || !path.resolve(baselineTestHost).startsWith(`${snapshotRoot}${path.sep}`)
        || path.basename(baselineTestHost) !== "test") {
      fail("invalid baseline test snapshot path");
    }
  }

  return [
    "create",
    "--name", containerName(deployment, nameSuffix),
    ...transientLabels(deployment),
    "--network", "none",
    ...commonSandbox({ memory: "2g", cpus: "1.5", pids: "256" }),
    "--ulimit", "fsize=8388608:8388608",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000",
    "--tmpfs", "/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000",
    "--mount", bind(path.resolve(snapshotHost), "/workspace", true),
    ...(suite === "baseline"
      ? ["--mount", bind(path.resolve(baselineTestHost), "/workspace/test", true)]
      : []),
    image,
    "source-verify",
    "--workspace", "/workspace",
    "--expected-sha", expectedSha,
    "--profile", profile,
    "--suite", suite,
    "--timeout-seconds", String(timeoutSeconds),
    ...(suite === "candidate" ? [
      "--expected-files", String(expectedSnapshot.files),
      "--expected-bytes", String(expectedSnapshot.bytes),
      "--expected-snapshot-sha", expectedSnapshot.sha256,
    ] : []),
  ];
}

export function serverCreateArgs({
  deployment,
  image,
  outputHost,
  port,
  nameSuffix = "app",
  publish = true,
  restart = publish,
  transient = false,
}) {
  return [
    "create",
    "--name", containerName(deployment, nameSuffix),
    ...(transient ? transientLabels(deployment) : []),
    ...(restart ? ["--restart", "unless-stopped"] : []),
    ...commonSandbox({ memory: "128m", cpus: "0.5", pids: "64" }),
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    ...(publish ? ["--publish", `${port}:8080`] : []),
    "--mount", bind(outputHost, "/site", true),
    image,
    "serve",
    "--root", "/site",
    "--port", "8080",
  ];
}

const snapshotOperations = { chmod, chown, lstat, mkdir, open, readdir, rm };

function assertSnapshotBounds(state, relative, depth) {
  state.entries += 1;
  if (state.entries > state.maxEntries) fail(`verified output exceeds ${state.maxEntries} entries`);
  if (depth > state.maxDepth) fail(`verified output exceeds maximum depth at: ${relative}`);
}

async function readRegularFile(target, operations, deadlineAt, label) {
  const handle = await checkedFs(
    () => operations.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
    deadlineAt,
    label,
  );
  try {
    const before = await checkedFs(() => handle.stat(), deadlineAt, label);
    if (!before.isFile()) fail(`verified output contains an unsupported entry: ${target}`);
    const content = await abortableFs(signal => handle.readFile({ signal }), deadlineAt, label);
    const after = await checkedFs(() => handle.stat(), deadlineAt, label);
    if (content.length !== before.size || after.size !== before.size
        || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
      fail(`verified output changed while being copied: ${target}`);
    }
    return { content, stat: before };
  } finally {
    await bounded(
      () => handle.close(),
      Math.max(deadlineAt, Date.now() + 250),
      "snapshot handle cleanup",
    );
  }
}

async function writeExclusiveFile(target, content, operations, deadlineAt, label) {
  const handle = await checkedFs(
    () => operations.open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    ),
    deadlineAt,
    label,
  );
  try {
    await abortableFs(signal => handle.writeFile(content, { signal }), deadlineAt, label);
  } finally {
    await bounded(
      () => handle.close(),
      Math.max(deadlineAt, Date.now() + 250),
      "snapshot handle cleanup",
    );
  }
}

async function copySnapshotEntries(source, destination, operations, deadlineAt, state, depth = 1) {
  const entries = await checkedFs(() => operations.readdir(source, { withFileTypes: true }), deadlineAt, "snapshot");
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    const relative = path.relative(state.source, sourcePath);
    assertSnapshotBounds(state, relative, depth);
    const stat = await checkedFs(() => operations.lstat(sourcePath), deadlineAt, "snapshot");
    if (stat.isSymbolicLink()) fail(`verified output contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      await checkedFs(() => operations.mkdir(destinationPath, { mode: 0o700 }), deadlineAt, "snapshot");
      await copySnapshotEntries(sourcePath, destinationPath, operations, deadlineAt, state, depth + 1);
    } else if (stat.isFile()) {
      state.files += 1;
      state.bytes += stat.size;
      if (state.files > state.maxFiles) fail(`verified output exceeds ${state.maxFiles} files`);
      if (state.bytes > state.maxBytes) fail(`verified output exceeds ${state.maxBytes} bytes`);
      const { content } = await readRegularFile(sourcePath, operations, deadlineAt, "snapshot");
      await writeExclusiveFile(destinationPath, content, operations, deadlineAt, "snapshot");
    } else {
      fail(`verified output contains an unsupported entry: ${relative}`);
    }
  }
}

async function lockSnapshotEntries(target, owner, operations, deadlineAt) {
  const entries = await checkedFs(() => operations.readdir(target, { withFileTypes: true }), deadlineAt, "snapshot");
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const stat = await checkedFs(() => operations.lstat(child), deadlineAt, "snapshot");
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await lockSnapshotEntries(child, owner, operations, deadlineAt);
      await checkedFs(() => operations.chown(child, owner.uid, owner.gid), deadlineAt, "snapshot");
      await checkedFs(() => operations.chmod(child, 0o555), deadlineAt, "snapshot");
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      await checkedFs(() => operations.chown(child, owner.uid, owner.gid), deadlineAt, "snapshot");
      await checkedFs(() => operations.chmod(child, 0o444), deadlineAt, "snapshot");
    } else {
      fail(`artifact snapshot contains an unsupported entry: ${entry.name}`);
    }
  }
}

async function unlockSnapshot(target, operations) {
  const stat = await operations.lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await operations.chmod(target, 0o700).catch(() => {});
    const entries = await operations.readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) await unlockSnapshot(path.join(target, entry.name), operations);
  } else {
    await operations.chmod(target, 0o600).catch(() => {});
  }
}

async function removeSnapshot(target) {
  await unlockSnapshot(target, snapshotOperations);
  await snapshotOperations.rm(target, { recursive: true, force: true });
}

async function scanSnapshot(root, expected, owner, operations, deadlineAt) {
  const hash = createHash("sha256");
  const state = {
    entries: 0,
    files: 0,
    bytes: 0,
    maxFiles: expected.files,
    maxBytes: expected.bytes,
    maxEntries: MAX_SNAPSHOT_ENTRIES,
    maxDepth: MAX_SNAPSHOT_DEPTH,
  };

  async function visit(directory, depth = 1) {
    const directoryStat = await checkedFs(() => operations.lstat(directory), deadlineAt, "snapshot scan");
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o222) !== 0
        || directoryStat.uid !== owner.uid || directoryStat.gid !== owner.gid) {
      fail("artifact snapshot is not locked");
    }
    const entries = await checkedFs(() => operations.readdir(directory, { withFileTypes: true }), deadlineAt, "snapshot scan");
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      assertSnapshotBounds(state, relative, depth);
      const stat = await checkedFs(() => operations.lstat(target), deadlineAt, "snapshot scan");
      if (stat.isSymbolicLink()) fail(`artifact snapshot contains a symlink: ${relative}`);
      if (stat.isDirectory()) {
        await visit(target, depth + 1);
      } else if (stat.isFile()) {
        if ((stat.mode & 0o222) !== 0 || stat.uid !== owner.uid || stat.gid !== owner.gid) {
          fail(`artifact snapshot is not locked: ${relative}`);
        }
        state.files += 1;
        state.bytes += stat.size;
        if (state.files > state.maxFiles) fail("artifact snapshot file count does not match verification");
        if (state.bytes > state.maxBytes) fail("artifact snapshot byte count does not match verification");
        const { content } = await readRegularFile(target, operations, deadlineAt, "snapshot scan");
        hash.update(`${relative}\0${stat.size}\0`);
        hash.update(content);
      } else {
        fail(`artifact snapshot contains an unsupported entry: ${relative}`);
      }
    }
  }

  await visit(root);
  return { files: state.files, bytes: state.bytes, sha256: hash.digest("hex") };
}

export async function snapshotDirectory(source, destination, owner = { uid: 0, gid: 0 }, options = {}) {
  if (!Number.isInteger(owner.uid) || owner.uid < 0 || !Number.isInteger(owner.gid) || owner.gid < 0) {
    fail("invalid snapshot owner");
  }
  const operations = { ...snapshotOperations, ...(options.operations ?? {}) };
  const deadlineAt = options.deadlineAt ?? (Date.now() + DEFAULT_OPERATION_TIMEOUT_MS);
  validateDeadline(deadlineAt, "snapshot");
  const expected = options.expectedArtifact ?? {
    files: options.maxFiles ?? 5_000,
    bytes: options.maxBytes ?? 104_857_600,
    sha256: "0".repeat(64),
  };
  const sourceStat = await checkedFs(() => operations.lstat(source).catch(() => null), deadlineAt, "snapshot");
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    fail("verified output is not a directory");
  }
  let destinationCreated = false;
  try {
    try {
      // Root creation is intentionally awaited with trusted I/O so it cannot mutate after timeout cleanup.
      await snapshotOperations.mkdir(destination, { mode: 0o700 });
      destinationCreated = true;
      remaining(deadlineAt, "snapshot");
    } catch (error) {
      if (error?.code === "EEXIST") fail("artifact snapshot already exists");
      throw error;
    }
    await copySnapshotEntries(source, destination, operations, deadlineAt, {
      source,
      entries: 0,
      files: 0,
      bytes: 0,
      maxFiles: options.maxFiles ?? expected.files,
      maxBytes: options.maxBytes ?? expected.bytes,
      maxEntries: options.maxEntries ?? MAX_SNAPSHOT_ENTRIES,
      maxDepth: options.maxDepth ?? MAX_SNAPSHOT_DEPTH,
    });
    await lockSnapshotEntries(destination, owner, operations, deadlineAt);
    await checkedFs(() => operations.chown(destination, owner.uid, owner.gid), deadlineAt, "snapshot");
    await checkedFs(() => operations.chmod(destination, 0o555), deadlineAt, "snapshot");
    const receipt = await scanSnapshot(destination, expected, owner, operations, deadlineAt);
    if (options.expectedArtifact && !sameArtifact(receipt, expected)) {
      fail("artifact snapshot does not match verification receipt");
    }
    return receipt;
  } catch (error) {
    if (destinationCreated) await removeSnapshot(destination);
    throw error;
  }
}

function execute(command, args, {
  input,
  timeoutMs = 120_000,
  maxOutputBytes = 256 * 1024,
  allowFailure = false,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${command} cancelled`));
      return;
    }
    const child = spawn(command, args, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;
    let settled = false;
    let killTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const terminate = () => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
        killTimer.unref();
      }
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) target.push(chunk);
      else {
        outputExceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => {
      finish(reject, error);
    });
    child.on("close", code => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (cancelled) finish(reject, new Error(`${command} cancelled`));
      else if (timedOut) finish(reject, new Error(`${command} timed out`));
      else if (outputExceeded) finish(reject, new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
      else if (code !== 0 && !allowFailure) finish(reject, new Error(`${command} exited ${code}: ${result.stderr.trim().slice(0, 500)}`));
      else finish(resolve, result);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

function startAttached(command, containerId, input) {
  const child = spawn(command, ["start", "-ai", containerId], {
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let bytes = 0;
  const consume = chunk => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) child.kill("SIGTERM");
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.on("error", () => {});
  child.stdin.end(input);
  return child;
}

async function wait(milliseconds) {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseLastJson(text, label) {
  const lines = text.trim().split("\n").filter(Boolean);
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    fail(`${label} did not return JSON`);
  }
}

export class DockerRuntime {
  constructor({
    docker = "docker",
    image,
    deployment,
    hostRoot,
    stateRoot = "/state",
    key,
    model,
    modelConcurrency = 1,
    modelRequestLimit = 100,
    port,
    publicUrl,
  }) {
    if (!NAME.test(deployment)) fail("invalid deployment name");
    if (!HOST_ROOT.test(hostRoot)) fail("invalid Monolith host root");
    if (hostRoot !== `/var/lib/monolith/deployments/${deployment}`) {
      fail("Monolith host root must match deployment");
    }
    if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) fail("invalid Monolith state root");
    if (path.resolve(stateRoot) !== stateRoot) fail("Monolith state root must be canonical");
    if (!SAFE_IMAGE.test(image)) fail("invalid image reference");
    if (!MODEL.test(model)) fail("invalid model reference");
    if (!Number.isInteger(modelConcurrency)
        || modelConcurrency < 1
        || modelConcurrency > MAX_MODEL_CONCURRENCY) {
      fail("invalid model concurrency");
    }
    if (!Number.isInteger(modelRequestLimit)
        || modelRequestLimit < 1
        || modelRequestLimit > MAX_MODEL_REQUESTS) {
      fail("invalid model request limit");
    }
    if (typeof key !== "string" || !/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(key)) fail("invalid OpenRouter key");
    const publicationConfigured = port !== undefined || publicUrl !== undefined;
    if (publicationConfigured && (!Number.isInteger(port) || port < 1_024 || port > 65_535)) {
      fail("invalid publication port");
    }
    let parsedUrl;
    if (publicationConfigured) {
      if (port === undefined || publicUrl === undefined) fail("publication configuration is incomplete");
      parsedUrl = new URL(publicUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) fail("invalid public URL");
    }
    this.docker = docker;
    this.image = image;
    this.deployment = deployment;
    this.hostRoot = hostRoot;
    this.stateRoot = path.resolve(stateRoot);
    this.key = key;
    this.model = model;
    this.modelConcurrency = modelConcurrency;
    this.modelRequestLimit = modelRequestLimit;
    this.port = port ?? null;
    this.publicUrl = parsedUrl?.toString().replace(/\/$/, "") ?? null;
    this.controllerUid = typeof process.getuid === "function" ? process.getuid() : 0;
    this.controllerGid = typeof process.getgid === "function" ? process.getgid() : 0;
    this.agentNetwork = containerName(deployment, "agents");
    this.egressNetwork = containerName(deployment, "egress");
    this.agentNetworkCreated = false;
    this.egressNetworkCreated = false;
    this.proxyId = null;
    this.proxyCreateAttempted = false;
    this.proxyProcess = null;
    this.snapshotOwner = { uid: 0, gid: 0 };
    this.healthAttempts = 20;
    this.cleanupTimeoutMs = 15_000;
    this.cleanupCommandTimeoutMs = 5_000;
    this.deploymentDeadlineAt = null;
    artifactReceipts.set(this, new Map());
    this.retiredContainers = new Set();
    this.activeContainers = new Set();
    this.cancelled = false;
    this.cancelListeners = new Set();
    this.activeOperations = new Set();
    this.cancelPromise = null;
    this.closePromise = null;
    this.wait = wait;
    this.startProxy = (containerId, input) => startAttached(this.docker, containerId, input);
  }

  async command(args, options) {
    return execute(this.docker, args, options);
  }

  deploymentDeadline(deadlineAt) {
    validateDeadline(deadlineAt, "deployment");
    if (this.deploymentDeadlineAt !== null && this.deploymentDeadlineAt !== deadlineAt) {
      fail("deployment deadline changed");
    }
    this.deploymentDeadlineAt = deadlineAt;
    return deadlineAt;
  }

  phaseDeadline(timeoutSeconds, label, maximumSeconds = Number.MAX_SAFE_INTEGER) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) fail(`invalid ${label} timeout`);
    const requested = Date.now() + Math.min(timeoutSeconds, maximumSeconds) * 1_000;
    return this.deploymentDeadlineAt === null ? requested : Math.min(requested, this.deploymentDeadlineAt);
  }

  throwIfCancelled() {
    if (this.cancelled) fail("deployment cancelled");
  }

  async commandWithin(args, options = {}, deadlineAt, label, { cleanup = false } = {}) {
    if (!cleanup) this.throwIfCancelled();
    const available = remaining(deadlineAt, label);
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? available, available));
    const commandDeadline = Math.min(deadlineAt, Date.now() + timeoutMs);
    const controller = new AbortController();
    let deadlineExpired = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, remaining(commandDeadline, label));
    const rawOperation = Promise.resolve().then(() => this.command(args, {
      ...options,
      timeoutMs,
      signal: controller.signal,
    }));
    const cancel = () => controller.abort();
    if (!cleanup) {
      this.cancelListeners.add(cancel);
      this.activeOperations.add(rawOperation);
    }
    try {
      try {
        const result = await rawOperation;
        if (!cleanup) this.throwIfCancelled();
        if (deadlineExpired || Date.now() >= commandDeadline) fail(`${label} deadline exceeded`);
        return result;
      } catch (error) {
        if (!cleanup && this.cancelled) fail("deployment cancelled");
        if (deadlineExpired || Date.now() >= commandDeadline) fail(`${label} deadline exceeded`);
        throw error;
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (!cleanup) {
        this.cancelListeners.delete(cancel);
        this.activeOperations.delete(rawOperation);
      }
    }
  }

  async waitWithin(milliseconds, deadlineAt, label) {
    const duration = Math.min(milliseconds, remaining(deadlineAt, label));
    await bounded(() => this.wait(duration), Math.min(deadlineAt, Date.now() + duration + 1), label);
  }

  cleanupDeadline() {
    return Date.now() + this.cleanupTimeoutMs;
  }

  async cleanupCommand(args, deadlineAt, options = {}) {
    try {
      await this.commandWithin(args, {
        ...options,
        allowFailure: true,
        timeoutMs: Math.min(options.timeoutMs ?? this.cleanupCommandTimeoutMs, this.cleanupCommandTimeoutMs),
      }, deadlineAt, "cleanup", { cleanup: true });
    } catch {}
  }

  async reconcileTransientResources(deadlineAt) {
    const filters = [
      "--filter", `label=${DEPLOYMENT_LABEL}=${this.deployment}`,
      "--filter", `label=${TRANSIENT_LABEL}=true`,
    ];
    const containers = await this.commandWithin(
      ["ps", "-aq", ...filters],
      {},
      deadlineAt,
      "deployment",
    );
    const containerIds = containers.stdout.trim().split(/\s+/u).filter(Boolean);
    if (containerIds.some(id => !/^[a-f0-9]{12,64}$/.test(id))) fail("Docker returned an invalid transient container ID");
    if (containerIds.length) {
      await this.commandWithin(["rm", "-f", ...containerIds], {}, deadlineAt, "deployment");
    }
    const networks = await this.commandWithin(
      ["network", "ls", "-q", ...filters],
      {},
      deadlineAt,
      "deployment",
    );
    const networkIds = networks.stdout.trim().split(/\s+/u).filter(Boolean);
    if (networkIds.some(id => !/^[a-f0-9]{12,64}$/.test(id))) fail("Docker returned an invalid transient network ID");
    if (networkIds.length) {
      await this.commandWithin(["network", "rm", ...networkIds], {}, deadlineAt, "deployment");
    }
  }

  async imageDigest({ deadlineAt } = {}) {
    const deploymentDeadline = deadlineAt === undefined
      ? this.deploymentDeadlineAt
      : this.deploymentDeadline(deadlineAt);
    if (deploymentDeadline === null) fail("deployment deadline is required");
    const result = await this.commandWithin(
      ["image", "inspect", "--format", "{{.Id}}", this.image],
      {},
      deploymentDeadline,
      "deployment",
    );
    return result.stdout.trim();
  }

  async start({ deadlineAt, bootstrap = true } = {}) {
    if (typeof bootstrap !== "boolean") fail("bootstrap must be boolean");
    const deploymentDeadline = this.deploymentDeadline(deadlineAt);
    const bootstrapName = containerName(this.deployment, "bootstrap");
    try {
      await this.reconcileTransientResources(deploymentDeadline);
      if (bootstrap) {
        this.activeContainers.add(bootstrapName);
        await this.commandWithin(bootstrapArgs({
          deployment: this.deployment,
          image: this.image,
          workspaceHost: path.join(this.hostRoot, "workspace"),
        }), { timeoutMs: 10 * 60 * 1_000 }, deploymentDeadline, "deployment");
        this.activeContainers.delete(bootstrapName);
      }
      this.agentNetworkCreated = true;
      await this.commandWithin([
        "network", "create", ...transientLabels(this.deployment), "--internal", this.agentNetwork,
      ], {}, deploymentDeadline, "deployment");
      this.egressNetworkCreated = true;
      await this.commandWithin([
        "network", "create", ...transientLabels(this.deployment), this.egressNetwork,
      ], {}, deploymentDeadline, "deployment");
      this.proxyCreateAttempted = true;
      const created = await this.commandWithin(proxyCreateArgs({
        deployment: this.deployment,
        image: this.image,
        network: this.agentNetwork,
        model: this.model,
        modelConcurrency: this.modelConcurrency,
        modelRequestLimit: this.modelRequestLimit,
      }), {}, deploymentDeadline, "deployment");
      this.proxyId = created.stdout.trim();
      await this.commandWithin(["network", "connect", this.egressNetwork, this.proxyId], {}, deploymentDeadline, "deployment");
      this.proxyProcess = this.startProxy(this.proxyId, `${this.key}\n`);
      this.key = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const probe = await this.commandWithin([
          "run", "--rm", "--network", this.agentNetwork,
          ...transientLabels(this.deployment),
          ...commonSandbox({ memory: "64m", cpus: "0.25", pids: "32" }),
          "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16m",
          this.image,
          "probe",
          "--url", "http://gateway:8787/healthz",
          "--status", "200",
          "--contains", "ok",
        ], { allowFailure: true, timeoutMs: 15_000 }, deploymentDeadline, "deployment");
        if (probe.code === 0) return;
        await this.waitWithin(250, deploymentDeadline, "deployment");
      }
      fail("credential gateway did not become healthy");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async runRole({ role, step, attempt, access, prompt, timeoutSeconds, runDir, workspace }) {
    void workspace;
    return this.#runAgentExecution({
      executionId: `${String(step).padStart(2, "0")}-${role}`,
      containerSuffix: `${role}-${step}`,
      attemptName: `${String(step).padStart(2, "0")}-${role}-${attempt}`,
      role,
      access,
      prompt,
      timeoutSeconds,
      runDir,
      workspaceHost: path.join(this.hostRoot, "workspace"),
    });
  }

  async runAgentExecution({
    executionId,
    role,
    attempt = 1,
    access,
    prompt,
    timeoutSeconds,
    runId,
    workspaceId,
    writeDirectories,
  }) {
    if (!EXECUTION_ID.test(executionId ?? "")) fail("invalid agent execution ID");
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 999) fail("invalid agent execution attempt");
    if (!RUN_ID.test(runId ?? "")) fail("invalid agent run ID");
    if (!EXECUTION_ID.test(workspaceId ?? "")) fail("invalid agent workspace ID");
    if (!Array.isArray(writeDirectories)) fail("invalid writable workspace directories");
    const workspaceHost = path.join(this.hostRoot, "worktrees", runId, workspaceId);
    const writeMounts = writeDirectories.map(relative => ({
      relative,
      source: typeof relative === "string" ? path.join(workspaceHost, ...relative.split("/")) : "",
    }));
    return this.#runAgentExecution({
      executionId,
      containerSuffix: executionId,
      attemptName: `${executionId}-${attempt}`,
      role,
      access,
      prompt,
      timeoutSeconds,
      runDir: path.join(this.stateRoot, runId),
      workspaceHost,
      writeMounts,
    });
  }

  async #runAgentExecution({
    executionId,
    containerSuffix,
    attemptName,
    role,
    access,
    prompt,
    timeoutSeconds,
    runDir,
    workspaceHost,
    writeMounts,
  }) {
    this.throwIfCancelled();
    if (!NAME.test(role ?? "")) fail("invalid agent role");
    if (access !== "read" && access !== "write") fail("invalid agent workspace access");
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) {
      fail("invalid agent prompt");
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1_800) {
      fail("invalid agent timeout");
    }
    const runName = path.basename(runDir);
    if (!RUN_ID.test(runName)) fail("invalid agent run directory");
    if (path.resolve(runDir) !== path.join(this.stateRoot, runName)) {
      fail("agent run directory must match state root");
    }
    const [stateMetadata, runMetadata] = await Promise.all([
      lstat(this.stateRoot).catch(() => null),
      lstat(runDir).catch(() => null),
    ]);
    if (!stateMetadata?.isDirectory() || stateMetadata.isSymbolicLink()
        || (stateMetadata.mode & 0o777) !== 0o700
        || stateMetadata.uid !== this.controllerUid || stateMetadata.gid !== this.controllerGid) {
      fail("Monolith state root must be a private regular directory");
    }
    if (!runMetadata?.isDirectory() || runMetadata.isSymbolicLink()
        || (runMetadata.mode & 0o777) !== 0o700
        || runMetadata.uid !== this.controllerUid || runMetadata.gid !== this.controllerGid) {
      fail("agent run directory must be a private regular directory");
    }
    const deadlineAt = this.phaseDeadline(timeoutSeconds, "role");
    const internalAttempt = path.join(runDir, "attempts", attemptName);
    const internalHandoff = path.join(internalAttempt, "handoff");
    const hostAttempt = path.join(this.hostRoot, "runs", path.basename(runDir), "attempts", attemptName);
    const hostHandoff = path.join(hostAttempt, "handoff");
    const hostPrompt = path.join(hostAttempt, "instructions.md");
    await mkdir(internalHandoff, { recursive: true, mode: 0o733 });
    await chmod(internalHandoff, 0o733);
    const internalPrompt = path.join(internalAttempt, "instructions.md");
    await writeFile(internalPrompt, prompt, { mode: 0o400 });
    await chmod(internalPrompt, 0o444);

    const args = agentCreateArgs({
      deployment: this.deployment,
      role,
      step: 1,
      image: this.image,
      network: this.agentNetwork,
      workspaceHost,
      handoffHost: hostHandoff,
      promptHost: hostPrompt,
      access,
      model: this.model,
      timeoutSeconds,
      nameSuffix: containerSuffix,
      writeMounts,
    });
    let containerId;
    let createAttempted = false;
    const activeName = containerName(this.deployment, containerSuffix);
    const startedAt = Date.now();
    try {
      createAttempted = true;
      this.activeContainers.add(activeName);
      const created = await this.commandWithin(args, {}, deadlineAt, "role");
      containerId = created.stdout.trim();
      const execution = await this.commandWithin(["start", "-ai", containerId], {
        timeoutMs: timeoutSeconds * 1_000,
        maxOutputBytes: 128 * 1024,
      }, deadlineAt, "role");
      const agentResult = parseLastJson(execution.stdout, `role ${role}`);
      if (agentResult.status !== "completed" || !/^[a-f0-9]{64}$/.test(agentResult.outputSha256 ?? "")) {
        fail(`role ${role} returned an invalid runtime receipt`);
      }
      const resultPath = path.join(internalHandoff, "result.json");
      const resultStat = await lstat(resultPath).catch(() => null);
      if (!resultStat?.isFile() || resultStat.isSymbolicLink() || resultStat.size < 2 || resultStat.size > 65_536) {
        fail(`role ${role} returned an invalid handoff file`);
      }
      const receipt = JSON.parse(await readFile(resultPath, "utf8"));
      return {
        receipt,
        runtime: {
          containerId,
          imageDigest: (await this.commandWithin(
            ["image", "inspect", "--format", "{{.Id}}", this.image],
            {},
            deadlineAt,
            "role",
          )).stdout.trim(),
          outputSha256: agentResult.outputSha256,
          exitCode: 0,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) {
        error.runtime = {
          ...(containerId ? { containerId } : {}),
          durationMs: Date.now() - startedAt,
        };
      }
      throw error;
    } finally {
      if (createAttempted) {
        await this.cleanupCommand(
          ["rm", "-f", containerId ?? containerName(this.deployment, containerSuffix)],
          this.cleanupDeadline(),
        );
      }
      this.activeContainers.delete(activeName);
      await rm(internalAttempt, { recursive: true, force: true });
    }
  }

  async verifySource({
    runId,
    expectedSha,
    candidateSnapshot,
    baseSnapshot,
    profile,
    timeoutSeconds = 900,
  }) {
    this.throwIfCancelled();
    if (!RUN_ID.test(runId ?? "")) fail("invalid source verification run ID");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedSha ?? "")) {
      fail("invalid source verification SHA");
    }
    if (profile !== "monolith-repo-v1") fail("invalid source verification profile");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 900) {
      fail("invalid source verification timeout");
    }
    const candidate = validateSourceSnapshotHandle(candidateSnapshot, "candidate");
    const base = validateSourceSnapshotHandle(baseSnapshot, "base");
    if (candidate.sha !== expectedSha) fail("candidate snapshot does not match the expected SHA");
    let boundedSeconds = timeoutSeconds;
    if (this.deploymentDeadlineAt !== null) {
      boundedSeconds = Math.min(
        boundedSeconds,
        Math.floor(remaining(this.deploymentDeadlineAt, "source verification") / 1_000),
      );
    }
    if (boundedSeconds < 2) fail("source verification deadline exceeded");
    const deadlineAt = Math.min(
      Date.now() + boundedSeconds * 1_000,
      this.deploymentDeadlineAt ?? Number.MAX_SAFE_INTEGER,
    );
    const candidateHost = path.join(this.hostRoot, "snapshots", runId, candidate.id);
    const baselineTestsHost = path.join(this.hostRoot, "snapshots", runId, base.id, "test");

    const runSuite = async suite => {
      const nameSuffix = suite === "candidate" ? "source-candidate" : "source-baseline";
      const name = containerName(this.deployment, nameSuffix);
      const availableSeconds = Math.floor(remaining(deadlineAt, "source verification") / 1_000);
      if (availableSeconds < 1) fail("source verification deadline exceeded");
      const suiteSeconds = suite === "candidate"
        ? Math.max(1, Math.min(Math.floor(boundedSeconds / 2), availableSeconds))
        : availableSeconds;
      let containerId;
      this.activeContainers.add(name);
      try {
        const created = await this.commandWithin(sourceVerifierCreateArgs({
          deployment: this.deployment,
          image: this.image,
          snapshotHost: candidateHost,
          ...(suite === "baseline" ? { baselineTestHost: baselineTestsHost } : {}),
          expectedSha,
          ...(suite === "candidate" ? { expectedSnapshot: candidate.receipt } : {}),
          profile,
          suite,
          timeoutSeconds: suiteSeconds,
          nameSuffix,
        }), {}, deadlineAt, "source verification");
        containerId = created.stdout.trim();
        const execution = await this.commandWithin(["start", "-ai", containerId], {
          timeoutMs: suiteSeconds * 1_000,
          maxOutputBytes: 256 * 1024,
        }, deadlineAt, "source verification");
        return validateSourceVerifierReceipt(
          parseLastJson(execution.stdout, `source ${suite} verifier`),
          { expectedSha, profile, suite, snapshot: candidate.receipt },
        );
      } finally {
        await this.cleanupCommand(["rm", "-f", containerId ?? name], this.cleanupDeadline());
        this.activeContainers.delete(name);
      }
    };

    const candidateResult = await runSuite("candidate");
    const baselineResult = await runSuite("baseline");
    return Object.freeze({
      status: "passed",
      candidateSha: expectedSha,
      profile,
      snapshot: candidate.receipt,
      evidence: Object.freeze([
        ...candidateResult.evidence.map(item => Object.freeze({ ...item })),
        ...baselineResult.evidence.map(item => Object.freeze({ ...item })),
      ]),
    });
  }

  async verify({ workflow, workspace, runDir, timeoutSeconds = 900 }) {
    this.throwIfCancelled();
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) fail("invalid verification timeout");
    let boundedTimeoutSeconds = Math.min(timeoutSeconds, 900);
    if (this.deploymentDeadlineAt !== null) {
      const deploymentSeconds = Math.floor(remaining(this.deploymentDeadlineAt, "verification") / 1_000);
      if (deploymentSeconds < 1) fail("verification deadline exceeded");
      boundedTimeoutSeconds = Math.min(boundedTimeoutSeconds, deploymentSeconds);
    }
    const deadlineAt = Math.min(
      Date.now() + boundedTimeoutSeconds * 1_000,
      this.deploymentDeadlineAt ?? Number.MAX_SAFE_INTEGER,
    );
    const name = containerName(this.deployment, "verify");
    const runId = path.basename(runDir);
    if (!RUN_ID.test(runId)) fail("invalid verification run ID");
    let containerId;
    let createAttempted = false;
    try {
      createAttempted = true;
      this.activeContainers.add(name);
      const created = await this.commandWithin([
        "create",
        "--name", name,
        ...transientLabels(this.deployment),
        "--network", "none",
        ...commonSandbox(),
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,uid=1000,gid=1000",
        "--mount", bind(path.join(this.hostRoot, "workspace"), "/workspace", false),
        this.image,
        "verify",
        "--output", workflow.output.directory,
        "--max-files", String(workflow.output.maxFiles),
        "--max-bytes", String(workflow.output.maxBytes),
        "--contains", workflow.output.smoke.contains,
        "--path", workflow.output.smoke.path,
        "--status", String(workflow.output.smoke.status),
        "--timeout-seconds", String(boundedTimeoutSeconds),
      ], {}, deadlineAt, "verification");
      containerId = created.stdout.trim();
      const execution = await this.commandWithin(["start", "-ai", containerId], {
        timeoutMs: boundedTimeoutSeconds * 1_000,
        maxOutputBytes: 128 * 1024,
      }, deadlineAt, "verification");
      const result = parseLastJson(execution.stdout, "verification");
      if (!result || typeof result !== "object" || Array.isArray(result)
          || Object.getPrototypeOf(result) !== Object.prototype
          || Object.keys(result).sort().join(",") !== "artifact,evidence,status"
          || result.status !== "passed" || !Array.isArray(result.evidence)
          || result.evidence.length < 1 || result.evidence.length > 50
          || result.evidence.some(item => typeof item !== "string" || !item || Buffer.byteLength(item) > 2_000)) {
        fail("verification returned an invalid receipt");
      }
      const expectedArtifact = validateArtifactReceipt(result.artifact, workflow);

      await this.commandWithin(["rm", "-f", containerId], {}, deadlineAt, "verification");
      createAttempted = false;
      containerId = null;
      const artifact = await snapshotDirectory(
        path.join(workspace, workflow.output.directory),
        path.join(runDir, "artifact"),
        this.snapshotOwner,
        {
          deadlineAt,
          expectedArtifact,
          maxFiles: workflow.output.maxFiles,
          maxBytes: workflow.output.maxBytes,
        },
      );
      this.throwIfCancelled();
      remaining(deadlineAt, "verification");
      artifactReceipts.get(this).set(runId, Object.freeze({ ...artifact }));
      return { status: "passed", evidence: result.evidence, artifact: { ...artifact } };
    } finally {
      if (createAttempted && containerId) {
        await this.cleanupCommand(["rm", "-f", containerId], this.cleanupDeadline());
      } else if (createAttempted) {
        await this.cleanupCommand(["rm", "-f", name], this.cleanupDeadline());
      }
      this.activeContainers.delete(name);
    }
  }

  async appState(name, deadlineAt) {
    const inspected = await this.commandWithin([
      "container", "inspect", "--format", "{{.Id}} {{.State.Running}}", name,
    ], { allowFailure: true }, deadlineAt, "publication");
    if (inspected.code !== 0) {
      if (/no such (?:object|container)/iu.test(inspected.stderr)) return { exists: false, running: false };
      fail("could not inspect the existing published app");
    }
    const match = /^([a-f0-9]{64}) (true|false)$/.exec(inspected.stdout.trim());
    if (!match) fail("Docker returned an invalid app state");
    return { exists: true, id: match[1], running: match[2] === "true" };
  }

  async probeApp(name, workflow, deadlineAt) {
    let lastError;
    for (let attempt = 0; attempt < this.healthAttempts; attempt += 1) {
      try {
        await this.commandWithin([
          "exec", name,
          "node", "/app/src/probe.mjs",
          "--url", `http://127.0.0.1:8080${workflow.output.smoke.path}`,
          "--status", String(workflow.output.smoke.status),
          "--contains", workflow.output.smoke.contains,
        ], { timeoutMs: 15_000 }, deadlineAt, "publication");
        return;
      } catch (error) {
        lastError = error;
        await this.waitWithin(250, deadlineAt, "publication");
      }
    }
    throw lastError ?? new Error("published app did not become healthy");
  }

  async publish({ workflow, runDir, timeoutSeconds }) {
    this.throwIfCancelled();
    if (this.port === null || this.publicUrl === null) fail("runtime publication is not configured");
    const deadlineAt = this.phaseDeadline(timeoutSeconds, "publication", 900);
    const runId = path.basename(runDir);
    if (!RUN_ID.test(runId)) fail("invalid publication run ID");
    const appName = containerName(this.deployment, "app");
    const candidateSuffix = `app-candidate-${runId}`;
    const candidateName = containerName(this.deployment, candidateSuffix);
    const backupName = containerName(this.deployment, `app-backup-${runId}`);
    const internalSnapshot = path.join(runDir, "artifact");
    const snapshotStat = await lstat(internalSnapshot).catch(() => null);
    if (!snapshotStat?.isDirectory() || snapshotStat.isSymbolicLink()) {
      fail("verified artifact snapshot is missing");
    }
    const expectedArtifact = artifactReceipts.get(this).get(runId);
    if (!expectedArtifact) fail("verified artifact receipt is missing");
    const assertArtifact = async () => {
      this.throwIfCancelled();
      const receipt = await scanSnapshot(
        internalSnapshot,
        expectedArtifact,
        this.snapshotOwner,
        snapshotOperations,
        deadlineAt,
      );
      if (!sameArtifact(receipt, expectedArtifact)) fail("artifact snapshot no longer matches verification receipt");
      this.throwIfCancelled();
    };
    await assertArtifact();
    const outputHost = path.join(this.hostRoot, "runs", runId, "artifact");

    const candidateArgs = serverCreateArgs({
      deployment: this.deployment,
      image: this.image,
      outputHost,
      port: this.port,
      nameSuffix: candidateSuffix,
      publish: false,
      restart: false,
      transient: true,
    });
    try {
      this.activeContainers.add(candidateName);
      await this.commandWithin(candidateArgs, {}, deadlineAt, "publication");
      await this.commandWithin(["start", candidateName], {}, deadlineAt, "publication");
      await this.probeApp(candidateName, workflow, deadlineAt);
      await assertArtifact();
    } finally {
      await this.cleanupCommand(["rm", "-f", candidateName], this.cleanupDeadline());
      this.activeContainers.delete(candidateName);
    }

    const previous = await this.appState(appName, deadlineAt);
    let renameAttempted = false;
    let replacementAttempted = false;
    try {
      if (previous.exists) {
        renameAttempted = true;
        await this.commandWithin(["rename", appName, backupName], {}, deadlineAt, "publication");
        if (previous.running) {
          await this.commandWithin(["stop", "--time", "10", backupName], {}, deadlineAt, "publication");
        }
      }

      replacementAttempted = true;
      await this.commandWithin(serverCreateArgs({
        deployment: this.deployment,
        image: this.image,
        outputHost,
        port: this.port,
      }), {}, deadlineAt, "publication");
      await this.commandWithin(["start", appName], {}, deadlineAt, "publication");
      await this.probeApp(appName, workflow, deadlineAt);
      await assertArtifact();
      this.throwIfCancelled();
      if (remaining(deadlineAt, "publication") < 1_000) fail("publication deadline exceeded");
    } catch (replacementError) {
      const cleanupDeadline = this.cleanupDeadline();
      if (replacementAttempted) await this.cleanupCommand(["rm", "-f", appName], cleanupDeadline);
      if (renameAttempted) {
        try {
          await this.commandWithin(
            ["rename", backupName, appName],
            { allowFailure: true, timeoutMs: this.cleanupCommandTimeoutMs },
            cleanupDeadline,
            "cleanup",
            { cleanup: true },
          );
          if (previous.running) {
            await this.commandWithin(
              ["start", appName],
              { allowFailure: true, timeoutMs: this.cleanupCommandTimeoutMs },
              cleanupDeadline,
              "cleanup",
              { cleanup: true },
            );
          }
          const restored = await this.commandWithin(
            ["container", "inspect", "--format", "{{.Id}} {{.State.Running}}", appName],
            { allowFailure: true, timeoutMs: this.cleanupCommandTimeoutMs },
            cleanupDeadline,
            "cleanup",
            { cleanup: true },
          );
          const restoredMatch = /^([a-f0-9]{64}) (true|false)$/.exec(restored.stdout.trim());
          const backup = await this.commandWithin(
            ["container", "inspect", "--format", "{{.Id}}", backupName],
            { allowFailure: true, timeoutMs: this.cleanupCommandTimeoutMs },
            cleanupDeadline,
            "cleanup",
            { cleanup: true },
          );
          const backupGone = backup.code !== 0 && /no such (?:object|container)/iu.test(backup.stderr);
          if (restored.code !== 0 || !restoredMatch
              || restoredMatch[1] !== previous.id
              || (restoredMatch[2] === "true") !== previous.running
              || !backupGone) {
            fail("the previous published app could not be restored");
          }
        } catch (restoreError) {
          throw new AggregateError(
            [replacementError, restoreError],
            "published app replacement failed and the previous app could not be restored",
          );
        }
      } else if (replacementAttempted) {
        try {
          const lingering = await this.commandWithin(
            ["container", "inspect", "--format", "{{.Id}}", appName],
            { allowFailure: true, timeoutMs: this.cleanupCommandTimeoutMs },
            cleanupDeadline,
            "cleanup",
            { cleanup: true },
          );
          if (lingering.code === 0 || !/no such (?:object|container)/iu.test(lingering.stderr)) {
            fail("the failed published app could not be removed");
          }
        } catch (reconcileError) {
          throw new AggregateError(
            [replacementError, reconcileError],
            "published app replacement failed and the failed app could not be removed",
          );
        }
      }
      throw replacementError;
    }
    if (renameAttempted) {
      this.retiredContainers.add(backupName);
    }
    return { url: `${this.publicUrl}${workflow.output.smoke.path}` };
  }

  cancel() {
    if (!this.cancelled) {
      this.cancelled = true;
      for (const listener of [...this.cancelListeners]) listener();
    }
    if (!this.cancelPromise) this.cancelPromise = this.close();
    return this.cancelPromise;
  }

  close() {
    if (!this.closePromise) {
      const activeAtClose = [...this.activeContainers];
      this.closePromise = (async () => {
        if (this.cancelled) await Promise.allSettled([...this.activeOperations]);
        for (const active of activeAtClose) this.activeContainers.add(active);
        await this.performClose();
      })().catch(() => {});
    }
    return this.closePromise;
  }

  async performClose() {
    const cleanupDeadline = this.cleanupDeadline();
    for (const active of this.activeContainers) {
      await this.cleanupCommand(["rm", "-f", active], cleanupDeadline, { timeoutMs: 250 });
      this.activeContainers.delete(active);
    }
    for (const retired of this.retiredContainers) {
      await this.cleanupCommand(["rm", "-f", retired], cleanupDeadline);
      this.retiredContainers.delete(retired);
    }
    if (this.proxyCreateAttempted || this.proxyId) {
      await this.cleanupCommand(
        ["rm", "-f", this.proxyId ?? containerName(this.deployment, "gateway")],
        cleanupDeadline,
      );
    }
    this.proxyId = null;
    this.proxyCreateAttempted = false;
    if (this.proxyProcess) {
      try { this.proxyProcess.kill("SIGTERM"); } catch {}
    }
    this.proxyProcess = null;
    this.key = null;
    if (this.agentNetworkCreated) {
      await this.cleanupCommand(["network", "rm", this.agentNetwork], cleanupDeadline);
      this.agentNetworkCreated = false;
    }
    if (this.egressNetworkCreated) {
      await this.cleanupCommand(["network", "rm", this.egressNetwork], cleanupDeadline);
      this.egressNetworkCreated = false;
    }
  }
}
