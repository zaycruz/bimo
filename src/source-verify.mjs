import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const PROFILE = "monolith-repo-v1";
const MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 100_000;
const MAX_SOURCE_DEPTH = 64;
const GATES = Object.freeze([
  Object.freeze({ command: "npm", args: Object.freeze(["test"]) }),
  Object.freeze({ command: "npm", args: Object.freeze(["run", "regression", "--if-present"]) }),
  Object.freeze({ command: "npm", args: Object.freeze(["run", "smoke", "--if-present"]) }),
]);

function fail(message) {
  throw new Error(message);
}

function safeEnvironment() {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
}

function terminateGroup(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch {}
}

function executeFixed({ command, args, cwd, signal, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: safeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let exceeded = false;
    let killTimer;

    const terminate = () => {
      terminateGroup(child, "SIGTERM");
      killTimer ??= setTimeout(() => terminateGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const onAbort = () => terminate();
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) target.push(chunk);
      else {
        exceeded = true;
        terminate();
      }
    };

    if (signal.aborted) terminate();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", error => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      resolve({
        code: exceeded ? 125 : code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        outputExceeded: exceeded,
      });
    });
  });
}

function validateCommandResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isInteger(value.code) || value.code < 0 || value.code > 255
      || typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    fail("source gate returned an invalid command result");
  }
  if (Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > MAX_OUTPUT_BYTES
      || value.outputExceeded === true) {
    fail("source gate output exceeded 2097152 bytes");
  }
  return value;
}

function outputDigest({ stdout, stderr }) {
  const hash = createHash("sha256");
  const out = Buffer.from(stdout);
  const error = Buffer.from(stderr);
  hash.update(`stdout\0${out.length}\0`);
  hash.update(out);
  hash.update(`stderr\0${error.length}\0`);
  hash.update(error);
  return hash.digest("hex");
}

function validSnapshotReceipt(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(",") === "bytes,files,sha256"
    && Number.isInteger(value.files) && value.files >= 1 && value.files <= MAX_SOURCE_FILES
    && Number.isInteger(value.bytes) && value.bytes >= 1 && value.bytes <= MAX_SOURCE_BYTES
    && /^[a-f0-9]{64}$/.test(value.sha256);
}

function sameSnapshot(left, right) {
  return left.files === right.files && left.bytes === right.bytes && left.sha256 === right.sha256;
}

export async function scanSourceSnapshot(workspaceRoot) {
  const root = await checkedWorkspace(workspaceRoot);
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  let entriesSeen = 0;

  const visit = async (directory, prefix = "", depth = 0) => {
    if (depth > MAX_SOURCE_DEPTH) fail("source snapshot depth limit exceeded");
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_SOURCE_ENTRIES) fail("source snapshot entry limit exceeded");
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative.split("/").some(segment => segment.toLowerCase() === ".git")) {
        fail("source snapshot contains Git metadata");
      }
      if (relative.includes("\\") || /[\u0000-\u001f\u007f]/.test(relative)) {
        fail("source snapshot contains an unsafe path");
      }
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (entry.isFile() && stat.nlink > 1)) {
        fail("source snapshot contains unsafe filesystem metadata");
      }
      if (entry.isDirectory()) {
        hash.update(`D\0${relative}\0${stat.mode & 0o777}\0`);
        await visit(absolute, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) fail("source snapshot contains a non-regular entry");
      files += 1;
      bytes += stat.size;
      if (files > MAX_SOURCE_FILES || bytes > MAX_SOURCE_BYTES) {
        fail("source snapshot exceeds the verification limit");
      }
      const content = await readFile(absolute);
      if (content.length !== stat.size) fail("source snapshot changed during verification");
      hash.update(`F\0${relative}\0${stat.mode & 0o777}\0${content.length}\0`);
      hash.update(content);
    }
  };

  await visit(root);
  if (files < 1 || bytes < 1) fail("source snapshot is empty");
  return Object.freeze({ files, bytes, sha256: hash.digest("hex") });
}

async function sourceFilesForSyntax(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".js"))) files.push(relative);
    }
  };
  await visit(path.join(root, "src"), "src");
  const bin = await lstat(path.join(root, "bin", "monolith")).catch(() => null);
  if (bin?.isFile()) files.push("bin/monolith");
  if (!files.length || files.length > 500) fail("verification profile found an invalid source-file count");
  return files;
}

async function baselineTests(root) {
  const entries = await readdir(path.join(root, "test"), { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map(entry => `test/${entry.name}`)
    .sort();
  if (!files.length || files.length > 500) fail("verification profile found an invalid baseline-test count");
  return files;
}

async function checkedWorkspace(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    fail("workspace root must be an absolute directory");
  }
  const resolved = path.resolve(workspaceRoot);
  const stat = await lstat(resolved).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail("workspace root must be an absolute directory");
  }
  await realpath(resolved);
  return resolved;
}

export async function verifySourceCandidate({
  workspaceRoot,
  expectedSha,
  expectedSnapshot,
  profile,
  suite,
  timeoutSeconds,
  runCommand = executeFixed,
}) {
  if (!SHA.test(expectedSha ?? "")) fail("expected SHA is invalid");
  if (profile !== PROFILE) fail("source verification profile is invalid");
  if (suite !== "candidate" && suite !== "baseline") fail("source verification suite is invalid");
  if (suite === "candidate" && !validSnapshotReceipt(expectedSnapshot)) {
    fail("expected source snapshot is invalid");
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
    fail("source verification timeout is invalid");
  }
  if (typeof runCommand !== "function") fail("source command runner is invalid");
  const cwd = await checkedWorkspace(workspaceRoot);
  const deadlineAt = Date.now() + timeoutSeconds * 1_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);

  const run = async ({ command, args }) => {
    if (controller.signal.aborted || Date.now() >= deadlineAt) fail("source verification timed out");
    try {
      const result = validateCommandResult(await runCommand({
        command,
        args: [...args],
        cwd,
        signal: controller.signal,
        deadlineAt,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      }));
      if (controller.signal.aborted || Date.now() >= deadlineAt) fail("source verification timed out");
      return result;
    } catch (error) {
      if (controller.signal.aborted || Date.now() >= deadlineAt) fail("source verification timed out");
      throw error;
    }
  };

  try {
    let snapshot;
    if (suite === "candidate") {
      snapshot = await scanSourceSnapshot(cwd);
      if (!sameSnapshot(snapshot, expectedSnapshot)) fail("source snapshot does not match its trusted receipt");
    }

    const evidence = [];
    if (suite === "baseline") {
      const files = await baselineTests(cwd);
      const result = await run({ command: "node", args: ["--test", ...files] });
      if (result.code !== 0) fail(`source gate baseline regression exited ${result.code}`);
      evidence.push({
        authority: "trusted",
        command: `node --test ${files.length} baseline files`,
        outputSha256: outputDigest(result),
      });
    } else {
      const sourceFiles = await sourceFilesForSyntax(cwd);
      const syntaxHash = createHash("sha256");
      for (const sourceFile of sourceFiles) {
        const result = await run({ command: "node", args: ["--check", sourceFile] });
        if (result.code !== 0) fail(`source gate node --check exited ${result.code}`);
        syntaxHash.update(`${sourceFile}\0${outputDigest(result)}\0`);
      }
      evidence.push({
        authority: "trusted",
        command: `node --check ${sourceFiles.length} source files`,
        outputSha256: syntaxHash.digest("hex"),
      });
      for (const gate of GATES) {
        const result = await run(gate);
        const label = `${gate.command} ${gate.args.join(" ")}`;
        if (result.code !== 0) fail(`source gate ${label} exited ${result.code}`);
        evidence.push({
          authority: "advisory",
          command: label,
          outputSha256: outputDigest(result),
        });
      }
    }
    return {
      status: "passed",
      candidateSha: expectedSha,
      profile,
      suite,
      ...(snapshot ? { snapshot } : {}),
      evidence,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseOptions(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) fail("invalid source verifier options");
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      fail("invalid source verifier options");
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) fail(`duplicate source verifier option: ${flag}`);
    options[key] = value;
  }
  const allowed = new Set([
    "workspace", "expected-sha", "expected-files", "expected-bytes",
    "expected-snapshot-sha", "profile", "suite", "timeout-seconds",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`unknown source verifier option: --${key}`);
  }
  const timeoutSeconds = Number(options["timeout-seconds"]);
  const expectedFiles = Number(options["expected-files"]);
  const expectedBytes = Number(options["expected-bytes"]);
  const expectedSnapshot = options.suite === "candidate"
    ? {
        files: expectedFiles,
        bytes: expectedBytes,
        sha256: options["expected-snapshot-sha"],
      }
    : undefined;
  if (options.suite === "baseline" && [
    options["expected-files"], options["expected-bytes"], options["expected-snapshot-sha"],
  ].some(value => value !== undefined)) {
    fail("baseline source verifier does not accept a snapshot receipt");
  }
  return {
    workspaceRoot: options.workspace,
    expectedSha: options["expected-sha"],
    expectedSnapshot,
    profile: options.profile,
    suite: options.suite,
    timeoutSeconds,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const receipt = await verifySourceCandidate(parseOptions(argv));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
