import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { DockerRuntime } from "./docker-runtime.mjs";
import {
  builtInTargetCatalog,
  commandForTarget,
  deploymentRootForTarget,
  deploymentsRootForTarget,
  isDeploymentHostRoot,
  resolveDeploymentTarget,
} from "./deployment-target.mjs";
import { GitRuntime } from "./git-runtime.mjs";
import {
  validateOrganizerInput,
  validateOrganizerReceipt,
  validateOrganizerPrompt,
  validateTemplateCatalog,
} from "./organize.mjs";
import { runOrganizerController } from "./organizer-controller.mjs";
import { loadPodTemplate } from "./pod-contract.mjs";
import { runEngineeringPod } from "./pod-controller.mjs";
import { createPodRunStore, openPodRunStore, prunePodRuns } from "./pod-store.mjs";
import { publishRun } from "./publish-run.mjs";
import { loadWorkflow, runWorkflow } from "./workflow.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const templateRoot = path.join(packageRoot, "templates");
const organizerInstructionsPath = path.join(packageRoot, "etc", "organizer", "organizer.md");
const DEFAULT_IMAGE = "bimo-workflow:0.5.0";
const DEFAULT_MODEL = "openrouter/deepseek/deepseek-v4-flash";
const POD_REPOSITORY = "https://github.com/zaycruz/bimo.git";
const POD_TARGET_BRANCH = "main";
const PUBLISH_TIMEOUT_MS = 5 * 60 * 1_000;
const IMAGE_TRANSFER_TIMEOUT_MS = 10 * 60 * 1_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EXECUTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;
const SECRET_REF = /^op:\/\/[^/\u0000-\u001f\u007f]{1,255}\/[^/\u0000-\u001f\u007f]{1,255}\/[^/\u0000-\u001f\u007f]{1,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TEMPLATE_DIGEST = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const GITHUB_TOKEN = /^(?:github_pat_[A-Za-z0-9_]{20,}|gh[psoru]_[A-Za-z0-9]{20,})$/;
const IMAGE_CONFIG_FIELDS = [
  "Entrypoint", "Cmd", "Env", "User", "WorkingDir", "ExposedPorts",
  "Volumes", "Labels", "Healthcheck", "StopSignal", "Shell",
];
const WORKFLOW_DEPLOY_OPTIONS = [
  "--deployment", "--target", "--host", "--proxmox", "--vmid", "--task-file", "--task-stdin",
  "--secret-ref", "--public-url", "--port",
];
const POD_DEPLOY_OPTIONS = [
  "--deployment", "--target", "--host", "--proxmox", "--vmid", "--task-file", "--task-stdin",
  "--secret-ref", "--github-secret-ref", "--repository", "--base-sha", "--target-branch",
];
const DEPLOYMENT_LAYOUTS = {
  workflow: ["runs", "workspace"],
  organizer: ["runs", "worktrees"],
  pod: ["runs", "source", "worktrees", "snapshots"],
};
const RUN_LIST_LIMIT = 50;
const RUN_SCAN_LIMIT = 1_000;
const FOLLOW_POLL_MS = 2_000;
const PROGRESS_HEARTBEAT_MS = 30_000;
const PROGRESS_LINE_MAX = 320;
const TAIL_CHUNK_BYTES = 64 * 1024 + 1;
const DOCTOR_MIN_FREE_BLOCKS = 1_048_576;
const RUN_STATES = new Set(["running", "completed", "failed", "cancelled"]);

function fail(message) {
  throw new Error(message);
}

function parseOptions(argv, { booleans = [] } = {}) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (Object.hasOwn(options, key)) fail(`duplicate option: --${key}`);
    if (booleans.includes(key)) options[key] = true;
    else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) fail(`--${key} requires a value`);
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function parseOrganizerOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const option = value === "-p" ? "--prompt" : value === "-n" ? "--agents" : value;
    if (!option.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = option.slice(2);
    if (Object.hasOwn(options, key)) fail(`duplicate option: --${key}`);
    if (key === "json") options[key] = true;
    else {
      const next = argv[index + 1];
      if (next === undefined) fail(`--${key} requires a value`);
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function exactOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) fail(`unknown option: --${key}`);
  }
}

function execute(command, args, {
  input,
  timeoutMs = 20 * 60 * 1_000,
  maxOutputBytes = 5 * 1024 * 1024,
  env,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: env ?? { ...process.env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    let stdinFailed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) target.push(chunk);
      else child.kill("SIGTERM");
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (aborted) reject(new Error(`${command} aborted`));
      else if (timedOut) reject(new Error(`${command} timed out`));
      else if (stdinFailed) reject(new Error(`${command} closed before consuming its bounded input`));
      else if (bytes > maxOutputBytes) reject(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${result.stderr.trim().slice(0, 1_000)}`));
      else resolve(result);
    });
    if (input !== undefined) {
      child.stdin.on("error", () => { stdinFailed = true; });
      child.stdin.end(input);
    }
  });
}

function runPublisherGit({ command, args, env, signal, deadlineAt, maxOutputBytes }) {
  if (command !== "git" || !Array.isArray(args) || args.some(value => typeof value !== "string")) {
    fail("publisher requested an invalid Git command");
  }
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) {
    fail("publisher Git deadline is invalid");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) {
    fail("publisher Git output limit is invalid");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let terminalError;
    let killTimer;
    let settled = false;

    const signalGroup = name => {
      if (!Number.isInteger(child.pid)) return;
      try { process.kill(-child.pid, name); } catch {}
    };
    const stop = error => {
      terminalError ??= error;
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 250);
    };
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) target.push(chunk);
      else stop(new Error(`publisher Git output exceeded ${maxOutputBytes} bytes`));
    };
    const abort = () => stop(new Error("publisher Git command aborted"));
    const deadlineTimer = setTimeout(
      () => stop(new Error("publisher Git command exceeded its deadline")),
      Math.max(1, deadlineAt - Date.now()),
    );

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", error => stop(error));
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (terminalError) reject(terminalError);
      else resolve({
        code: Number.isInteger(code) && code >= 0 ? code : 128,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function readStdin(maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maximumBytes) fail(`stdin exceeds ${maximumBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadTemplate(name) {
  const podManifest = path.join(templateRoot, name, "pod.json");
  const podStat = await lstat(podManifest).catch(() => null);
  if (podStat) {
    if (!podStat.isFile() || podStat.isSymbolicLink()) fail(`template ${name} has an invalid pod.json`);
    const loaded = await loadPodTemplate(name, { templateRoot });
    return {
      kind: "engineering-pod",
      name: loaded.template.name,
      digest: loaded.digest,
      templateDigest: loaded.templateDigest,
      template: loaded.template,
      prompts: loaded.prompts,
    };
  }
  const loaded = await loadWorkflow(name, { templateRoot });
  return {
    kind: "workflow",
    name: loaded.workflow.name,
    digest: loaded.digest,
    templateDigest: loaded.templateDigest,
    workflow: loaded.workflow,
    prompts: loaded.prompts,
  };
}

async function listTemplates() {
  const entries = await readdir(templateRoot, { withFileTypes: true });
  const templates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const loaded = await loadTemplate(entry.name);
      if (loaded.kind === "workflow") {
        templates.push({
          kind: loaded.kind,
          name: loaded.name,
          roles: Object.keys(loaded.workflow.roles),
          maxSteps: loaded.workflow.maxSteps,
        });
      } else {
        templates.push({
          kind: loaded.kind,
          name: loaded.name,
          roles: ["planner", "engineering-a", "engineering-b", "qa-tests", "checker", "qa", "testing"],
          maxAttempts: loaded.template.maxAttempts,
        });
      }
    } catch {}
  }
  return templates;
}

async function listDeploymentTargets() {
  const catalog = builtInTargetCatalog();
  const local = await inspectLocalDocker();
  return catalog.map(target => target.kind === "local"
    ? { ...target, ...local }
    : { ...target, availability: "on-demand" });
}

async function inspectLocalDocker() {
  try {
    if (process.env.DOCKER_HOST?.trim()) {
      return { availability: "unavailable", reason: "DOCKER_HOST overrides are not accepted for local targets" };
    }
    const endpoint = (await execute("docker", [
      "context", "inspect", "--format", "{{(index .Endpoints \"docker\").Host}}",
    ], { timeoutMs: 10_000, maxOutputBytes: 4 * 1024 })).stdout.trim();
    if (!/^unix:\/\/\/[^\u0000\r\n]+$/u.test(endpoint)) {
      return { availability: "unavailable", reason: "Docker endpoint is not a local Unix socket" };
    }
    const result = await execute("docker", [
      "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}",
    ], { timeoutMs: 10_000, maxOutputBytes: 4 * 1024 });
    const platform = result.stdout.trim();
    if (!/^linux\/(?:amd64|arm64)$/u.test(platform)) {
      return { availability: "unavailable", reason: "Docker platform must be linux/amd64 or linux/arm64" };
    }
    return { availability: "ready", platform };
  } catch {
    return { availability: "unavailable", reason: "Docker is unavailable" };
  }
}

async function requireLocalDocker() {
  const status = await inspectLocalDocker();
  if (status.availability !== "ready") fail(`local target unavailable: ${status.reason}`);
  return status;
}

async function loadOrganizerCatalog() {
  const entries = await readdir(templateRoot, { withFileTypes: true });
  const catalog = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const loaded = await loadTemplate(entry.name);
    if (loaded.kind === "workflow") {
      catalog.push({
        template: loaded.name,
        templateDigest: loaded.templateDigest,
        kind: loaded.kind,
        roles: Object.keys(loaded.workflow.roles),
        maxSteps: loaded.workflow.maxSteps,
        acceptedOptions: WORKFLOW_DEPLOY_OPTIONS,
      });
    } else {
      catalog.push({
        template: loaded.name,
        templateDigest: loaded.templateDigest,
        kind: loaded.kind,
        roles: ["planner", ...Object.keys(loaded.template.writers), "checker", "qa", "testing"],
        maxAttempts: loaded.template.maxAttempts,
        acceptedOptions: POD_DEPLOY_OPTIONS,
      });
    }
  }
  return validateTemplateCatalog(catalog);
}

async function targetExecute(target, command, options) {
  const invocation = commandForTarget(target, command);
  return execute(invocation.command, invocation.args, options);
}

async function targetPlatform(target) {
  if (target.kind === "local") return (await requireLocalDocker()).platform;
  const result = await targetExecute(target, [
    "docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}",
  ], { timeoutMs: 10_000, maxOutputBytes: 4 * 1024 });
  const platform = result.stdout.trim();
  if (!/^linux\/(?:amd64|arm64)$/u.test(platform)) {
    fail("target Docker platform must be linux/amd64 or linux/arm64");
  }
  return platform;
}

function deploymentDirectories(layout) {
  const directories = DEPLOYMENT_LAYOUTS[layout];
  if (!directories) fail("layout must be workflow, organizer, or pod");
  return directories;
}

function controllerLocalRootArgs(target) {
  return target.kind === "local" ? ["--local-home", target.home] : [];
}

function controllerHostRootIsValid(hostRoot, deployment, localHome) {
  return isDeploymentHostRoot(hostRoot, deployment, { localHome });
}

function transferImage(target, image, { timeoutMs = IMAGE_TRANSFER_TIMEOUT_MS } = {}) {
  const loadInvocation = commandForTarget(target, ["docker", "load"]);
  if (target.kind === "local" || loadInvocation.command !== "ssh") {
    fail("image transfer requires a remote deployment target");
  }
  return new Promise((resolve, reject) => {
    const save = spawn("docker", ["save", image], { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
    const load = spawn(loadInvocation.command, loadInvocation.args, { stdio: ["pipe", "pipe", "pipe"] });
    save.stdout.pipe(load.stdin);
    const output = [];
    let outputBytes = 0;
    let terminalError;
    let saveClosed = false;
    let loadClosed = false;
    let saveCode;
    let loadCode;
    let settled = false;
    let hardStopTimer;

    const terminate = child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    };

    const stop = error => {
      terminalError ??= error;
      save.stdout.unpipe(load.stdin);
      load.stdin.destroy();
      terminate(save);
      terminate(load);
      hardStopTimer ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(terminalError);
      }, 2_500);
    };

    const collect = chunk => {
      outputBytes += chunk.length;
      if (outputBytes <= 256 * 1024) output.push(chunk);
      else stop(new Error("image transfer output exceeded 262144 bytes"));
    };

    const timer = setTimeout(() => {
      stop(new Error(`image transfer timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = () => {
      if (settled || !saveClosed || !loadClosed) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStopTimer);
      if (terminalError) reject(terminalError);
      else if (saveCode === 0 && loadCode === 0) resolve();
      else reject(new Error(`image transfer failed (save=${saveCode}, load=${loadCode}): ${Buffer.concat(output).toString("utf8").trim().slice(0, 1_000)}`));
    };

    save.stderr.on("data", collect);
    load.stdout.on("data", collect);
    load.stderr.on("data", collect);
    save.on("error", error => stop(error));
    load.on("error", error => stop(error));
    load.stdin.on("error", error => stop(error));
    save.on("close", code => {
      saveClosed = true;
      saveCode = code;
      if (code !== 0 && !terminalError) stop(new Error(`docker save exited ${code}`));
      finish();
    });
    load.on("close", code => {
      loadClosed = true;
      loadCode = code;
      if (code !== 0 && !terminalError) stop(new Error(`ssh image load exited ${code}: ${Buffer.concat(output).toString("utf8").trim().slice(0, 1_000)}`));
      finish();
    });
  });
}

function imageTransferTag(imageId) {
  if (!SHA256.test(imageId)) fail("Docker returned an invalid local image ID");
  return `bimo-transfer:${imageId.slice(7, 19)}-${randomUUID().replaceAll("-", "")}`;
}

async function prepareImage(target, image, { retag = true } = {}) {
  const platform = await targetPlatform(target);
  const buildArgs = target.kind === "local"
    ? ["build", "--tag", image, packageRoot]
    : ["build", "--platform", platform, "--tag", image, packageRoot];
  await execute("docker", buildArgs);
  const imageResult = await execute("docker", ["image", "inspect", image]);
  const localImage = parseImageInspect(imageResult.stdout, "local");
  if (localImage.platform !== platform) {
    fail(`built image platform ${localImage.platform} does not match target ${platform}`);
  }
  if (target.kind === "local") {
    return { remoteImage: localImage, transferTag: null };
  }
  const transferTag = imageTransferTag(localImage.imageId);
  let remoteTransferStarted = false;
  try {
    await execute("docker", ["image", "tag", localImage.imageId, transferTag], { timeoutMs: 30_000 });
    const taggedImageResult = await execute("docker", ["image", "inspect", transferTag]);
    const taggedImage = parseImageInspect(taggedImageResult.stdout, "tagged local");
    if (taggedImage.imageId !== localImage.imageId
        || taggedImage.contentFingerprint !== localImage.contentFingerprint) {
      fail("local transfer tag does not match the inspected image");
    }

    remoteTransferStarted = true;
    await transferImage(target, transferTag);
    const remoteImageResult = await targetExecute(target, ["docker", "image", "inspect", transferTag]);
    const remoteImage = parseImageInspect(remoteImageResult.stdout, "remote");
    if (remoteImage.contentFingerprint !== localImage.contentFingerprint) {
      fail("transferred image content does not match the inspected local image");
    }
    if (retag) {
      await targetExecute(target, ["docker", "image", "tag", transferTag, image], { timeoutMs: 30_000 });
    }
    return { remoteImage, transferTag };
  } catch (error) {
    if (remoteTransferStarted) {
      await targetExecute(target, ["docker", "image", "rm", "-f", transferTag], { timeoutMs: 30_000 }).catch(() => {});
    }
    await execute("docker", ["image", "rm", "-f", transferTag], { timeoutMs: 30_000 }).catch(() => {});
    throw error;
  }
}

async function cleanupTransferredImage(target, transferTag) {
  if (!transferTag) return;
  await targetExecute(target, ["docker", "image", "rm", "-f", transferTag], { timeoutMs: 30_000 }).catch(() => {});
  await execute("docker", ["image", "rm", "-f", transferTag], { timeoutMs: 30_000 }).catch(() => {});
}

async function validateLocalStateChain(home, hostRoot, { allowMissing }) {
  const relative = path.relative(home, hostRoot);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("local deployment state root is invalid");
  }
  let current = home;
  for (const component of ["", ...relative.split(path.sep)]) {
    if (component) current = path.join(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return;
      fail("local deployment state path is invalid");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("local deployment state path must contain only real directories");
    }
  }
}

async function ensureLocalStateRoot(target, hostRoot) {
  await validateLocalStateChain(target.home, hostRoot, { allowMissing: true });
  await mkdir(hostRoot, { recursive: true, mode: 0o700 });
  await validateLocalStateChain(target.home, hostRoot, { allowMissing: false });
}

async function prepareLocalState(target, image, hostRoot, layout) {
  if (target.kind !== "local") fail("local state preparation requires the local target");
  deploymentDirectories(layout);
  await ensureLocalStateRoot(target, hostRoot);
  await targetExecute(target, [
    "docker", "run", "--rm",
    "--user", "0:0",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN",
    "--cap-add", "DAC_OVERRIDE",
    "--cap-add", "FOWNER",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "32",
    "--memory", "64m",
    "--cpus", "0.25",
    "--volume", `${hostRoot}:/deployment:rw`,
    image,
    "internal-prepare",
    "--layout", layout,
  ], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
}

async function prepareDeploymentState(target, image, hostRoot, layout) {
  const directories = deploymentDirectories(layout);
  if (target.kind === "local") {
    await prepareLocalState(target, image, hostRoot, layout);
    return;
  }
  const paths = directories.map(directory => `${hostRoot}/${directory}`);
  await targetExecute(target, ["mkdir", "-p", ...paths]);
  await targetExecute(target, ["chmod", "700", hostRoot, ...paths]);
  if (layout === "workflow") {
    await targetExecute(target, ["chown", "1000:0", `${hostRoot}/workspace`]);
    await targetExecute(target, ["chmod", "770", `${hostRoot}/workspace`]);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalJson(value, depth = 0) {
  if (depth > 32) fail("Docker image inspect content is too deeply nested");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`
    )).join(",")}}`;
  }
  fail("Docker image inspect content contains an unsupported value");
}

function parseImageInspect(raw, label) {
  let values;
  try { values = JSON.parse(raw); } catch { fail(`${label} Docker image inspect returned invalid JSON`); }
  if (!Array.isArray(values) || values.length !== 1 || !isPlainObject(values[0])) {
    fail(`${label} Docker image inspect returned an invalid shape`);
  }
  const value = values[0];
  if (!SHA256.test(value.Id ?? "")) fail(`${label} Docker image inspect returned an invalid image ID`);
  for (const field of ["Architecture", "Os"]) {
    if (typeof value[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value[field])) {
      fail(`${label} Docker image inspect returned an invalid ${field}`);
    }
  }
  if (!isPlainObject(value.Config)) fail(`${label} Docker image inspect returned an invalid Config`);
  if (!isPlainObject(value.RootFS) || typeof value.RootFS.Type !== "string"
      || !Array.isArray(value.RootFS.Layers) || value.RootFS.Layers.some(layer => !SHA256.test(layer))) {
    fail(`${label} Docker image inspect returned an invalid RootFS`);
  }
  const normalizedConfig = Object.fromEntries(IMAGE_CONFIG_FIELDS.map(field => [
    field,
    Object.hasOwn(value.Config, field) ? value.Config[field] : null,
  ]));
  const content = {
    Architecture: value.Architecture,
    Os: value.Os,
    Config: normalizedConfig,
    RootFS: value.RootFS,
  };
  return {
    imageId: value.Id,
    platform: `${value.Os}/${value.Architecture}`,
    contentFingerprint: createHash("sha256").update(canonicalJson(content)).digest("hex"),
  };
}

async function resolveSecret(reference, account) {
  if (!SECRET_REF.test(reference)) fail("--secret-ref must be a 1Password op:// reference");
  const args = ["read", reference];
  if (account) args.push("--account", account);
  const result = await execute("op", args, { maxOutputBytes: 4 * 1024 });
  const secret = result.stdout.trim();
  if (!/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(secret)) fail("1Password reference did not resolve to an OpenRouter key");
  return secret;
}

function exactObject(value, fields, label) {
  if (!isPlainObject(value)
      || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    fail(`${label} has an invalid shape`);
  }
  return value;
}

function parseLastJson(stdout, label) {
  const line = stdout.trim().split("\n").at(-1);
  try {
    return JSON.parse(line);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function validateOrganizerPlan(value, expected) {
  exactObject(value, [
    "version", "status", "promptSha256", "template", "templateDigest",
    "agents", "votes", "handoff", "runId",
  ], "organizer controller");
  const promptSha256 = createHash("sha256").update(expected.prompt, "utf8").digest("hex");
  if (value.version !== 1 || value.status !== "planned" || value.runId !== expected.runId
      || value.promptSha256 !== promptSha256 || value.agents !== expected.agents
      || !Array.isArray(value.votes) || value.votes.length !== expected.agents) {
    fail("organizer controller returned an invalid plan");
  }
  const votes = value.votes.map((vote, index) => {
    exactObject(vote, ["template", "templateDigest", "reason"], `organizer vote ${index + 1}`);
    return validateOrganizerReceipt({ version: 1, ...vote }, expected.catalog);
  });
  const selected = expected.catalog.find(entry => entry.template === value.template);
  if (!selected || selected.templateDigest !== value.templateDigest) {
    fail("organizer controller selected an unknown template or digest");
  }
  const selectedVotes = votes.filter(vote => (
    vote.template === selected.template && vote.templateDigest === selected.templateDigest
  )).length;
  const quorum = expected.agents === 2 ? 2 : Math.ceil(expected.agents / 2);
  if (selectedVotes < quorum) fail("organizer controller plan lacks the required quorum");

  exactObject(value.handoff, ["template", "templateDigest", "acceptedOptions"], "organizer handoff");
  if (value.handoff.template !== selected.template
      || value.handoff.templateDigest !== selected.templateDigest
      || !Array.isArray(value.handoff.acceptedOptions)
      || value.handoff.acceptedOptions.length !== selected.acceptedOptions.length
      || value.handoff.acceptedOptions.some((option, index) => option !== selected.acceptedOptions[index])) {
    fail("organizer controller returned an invalid handoff");
  }
  return value;
}

function validatePodReady(value, expected) {
  exactObject(value, ["status", "runId", "baseSha", "candidateSha", "branch"], "pod controller");
  if (value.status !== "ready" || value.runId !== expected.runId
      || value.baseSha !== expected.baseSha || !GIT_SHA.test(value.candidateSha ?? "")
      || value.branch !== `bimo/${expected.runId}`) {
    fail("pod controller returned an invalid ready receipt");
  }
  return value;
}

function validatePublishedPod(value, expected) {
  exactObject(value, [
    "status", "runId", "repository", "targetBranch", "baseSha", "candidateSha",
    "headBranch", "publication",
  ], "pod publisher");
  if (value.status !== "completed" || value.runId !== expected.runId
      || value.repository !== POD_REPOSITORY || value.targetBranch !== POD_TARGET_BRANCH
      || value.baseSha !== expected.baseSha || value.candidateSha !== expected.candidateSha
      || value.headBranch !== expected.branch) {
    fail("pod publisher returned an invalid completion receipt");
  }
  const publication = value.publication;
  if (!isPlainObject(publication)
      || Object.keys(publication).some(key => ![
        "baseSha", "created", "draft", "headBranch", "headSha", "number", "reconciled",
        "targetBranch", "url",
      ].includes(key))
      || !Number.isSafeInteger(publication.number) || publication.number < 1
      || publication.draft !== true || typeof publication.created !== "boolean"
      || publication.baseSha !== expected.baseSha || publication.headSha !== expected.candidateSha
      || publication.headBranch !== expected.branch || publication.targetBranch !== POD_TARGET_BRANCH
      || !new RegExp(`^https://github\\.com/zaycruz/bimo/pull/${publication.number}$`).test(publication.url ?? "")) {
    fail("pod publisher returned an invalid draft pull request receipt");
  }
  return value;
}

async function resolveGitHubSecret(reference, account) {
  if (!SECRET_REF.test(reference ?? "")) {
    fail("--github-secret-ref must be a 1Password op:// reference");
  }
  const args = ["read", reference];
  if (account) args.push("--account", account);
  const result = await execute("op", args, { maxOutputBytes: 4 * 1024 });
  const secret = result.stdout.trim();
  if (!GITHUB_TOKEN.test(secret)) fail("1Password reference did not resolve to a GitHub token");
  return secret;
}

async function deploy(template, options) {
  const loaded = await loadTemplate(template);
  const pod = loaded.kind === "engineering-pod";
  exactOptions(options, pod ? [
    "deployment", "target", "proxmox", "host", "vmid", "task-file", "task-stdin",
    "secret-ref", "github-secret-ref", "account", "repository", "base-sha",
    "target-branch", "model", "image", "json",
  ] : [
    "deployment", "target", "proxmox", "host", "vmid", "task-file", "task-stdin",
    "secret-ref", "account", "public-url", "port", "model", "image", "json",
  ]);
  if (!options.deployment) fail("--deployment is required");
  if (!NAME.test(options.deployment)) fail("--deployment must use lowercase letters, numbers, and dashes");
  const deploymentTarget = resolveDeploymentTarget(options);
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const model = options.model ?? DEFAULT_MODEL;
  if (!/^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/.test(model)) fail("--model is invalid");
  let port;
  let publicUrl;
  if (pod) {
    if (options.repository !== POD_REPOSITORY) fail(`--repository must be ${POD_REPOSITORY}`);
    if (!GIT_SHA.test(options["base-sha"] ?? "")) fail("--base-sha must be an exact 40-character Git SHA");
    if (options["target-branch"] !== POD_TARGET_BRANCH) fail(`--target-branch must be ${POD_TARGET_BRANCH}`);
    if (!options["github-secret-ref"]) fail("--github-secret-ref is required");
  } else {
    port = Number(options.port ?? 8080);
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) fail("--port must be from 1024 to 65535");
    if (!options["public-url"]) fail("--public-url is required");
    publicUrl = new URL(options["public-url"]);
    if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) fail("--public-url is invalid");
  }
  if (Boolean(options["task-file"]) === Boolean(options["task-stdin"])) fail("use exactly one of --task-file or --task-stdin");
  const task = options["task-file"]
    ? await readFile(path.resolve(options["task-file"]), "utf8")
    : await readStdin(64 * 1024);
  if (!task.trim() || Buffer.byteLength(task) > 64 * 1024) fail("task must contain 1 to 65536 bytes");
  if (!options["secret-ref"]) fail("--secret-ref is required");

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const progress = options.json ? null : new AbortController();
  if (progress) process.stderr.write(`run: ${runId}\n`);
  const heartbeat = progress ? startRunHeartbeat({ runId }) : null;
  let follower = null;
  let transferTag = null;
  try {
    heartbeat?.setPhase("preparing image");
    const prepared = await prepareImage(deploymentTarget, image);
    const remoteImage = prepared.remoteImage;
    transferTag = prepared.transferTag;
    const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
    if (progress) {
      heartbeat.setPhase("running controller");
      const readChunk = async ({ runId: current, after, signal }) => {
        const update = await targetExecute(deploymentTarget, stateReadArgs(hostRoot, remoteImage.imageId, [
          "internal-tail", "--run", current, "--after", String(after),
        ]), { timeoutMs: 30_000, maxOutputBytes: 256 * 1024, signal });
        return parseTailUpdate(update.stdout);
      };
      follower = streamRunProgress({
        readChunk,
        runId,
        signal: progress.signal,
        onEvent: event => {
          if (typeof event?.type === "string") heartbeat.setPhase(event.type);
        },
      }).catch(() => {});
    }
    if (pod) {
      await prepareDeploymentState(deploymentTarget, remoteImage.imageId, hostRoot, "pod");
      let openRouterKey = await resolveSecret(options["secret-ref"], options.account);
      const computeEnvelope = JSON.stringify({
        version: 1,
        template: loaded.template.name,
        templateDigest: loaded.templateDigest,
        deployment: options.deployment,
        task,
        key: openRouterKey,
        model,
        image: remoteImage.imageId,
        repository: POD_REPOSITORY,
        baseSha: options["base-sha"],
        targetBranch: POD_TARGET_BRANCH,
        runId,
      });
      openRouterKey = "";
      const controllerName = `bimo-${options.deployment}-controller`;
      const compute = await targetExecute(deploymentTarget, [
        "docker", "run", "--rm", "-i",
        "--name", controllerName,
        "--user", "0:0",
        "--read-only",
        "--cap-drop", "ALL",
        "--cap-add", "CHOWN",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "384",
        "--memory", "2g",
        "--cpus", "2",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--volume", "/var/run/docker.sock:/var/run/docker.sock:rw",
        "--volume", `${hostRoot}/runs:/state:rw`,
        "--volume", `${hostRoot}/source:/source:rw`,
        "--volume", `${hostRoot}/worktrees:/worktrees:rw`,
        "--volume", `${hostRoot}/snapshots:/snapshots:rw`,
        remoteImage.imageId,
        "internal-pod-run",
        "--host-root", hostRoot,
        ...controllerLocalRootArgs(deploymentTarget),
      ], {
        input: computeEnvelope,
        timeoutMs: (loaded.template.timeouts.workflowSeconds + 600) * 1_000,
        maxOutputBytes: 512 * 1024,
      });
      const ready = validatePodReady(parseLastJson(compute.stdout, "pod controller"), {
        runId,
        baseSha: options["base-sha"],
      });

      let githubToken = await resolveGitHubSecret(options["github-secret-ref"], options.account);
      const publishEnvelope = JSON.stringify({
        version: 1,
        runId,
        repository: POD_REPOSITORY,
        targetBranch: POD_TARGET_BRANCH,
        baseSha: ready.baseSha,
        candidateSha: ready.candidateSha,
        headBranch: ready.branch,
        token: githubToken,
      });
      githubToken = "";
      heartbeat?.setPhase("publishing");
      const publisher = await targetExecute(deploymentTarget, [
        "docker", "run", "--rm", "-i",
        "--name", `bimo-${options.deployment}-publisher`,
        "--user", "0:0",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "128",
        "--memory", "512m",
        "--cpus", "0.5",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
        "--tmpfs", "/run/bimo-publish:rw,nosuid,nodev,noexec,size=16m,mode=0700",
        "--volume", `${hostRoot}/runs:/state:rw`,
        "--volume", `${hostRoot}/source:/source:rw`,
        remoteImage.imageId,
        "internal-publish",
      ], {
        input: publishEnvelope,
        timeoutMs: PUBLISH_TIMEOUT_MS + 60_000,
        maxOutputBytes: 512 * 1024,
      });
      const response = validatePublishedPod(parseLastJson(publisher.stdout, "pod publisher"), ready);
      if (options.json) process.stdout.write(`${JSON.stringify(response)}\n`);
      else process.stdout.write(
        `deployed ${loaded.template.name} as ${options.deployment}\nrun: ${response.runId}\nPR: ${response.publication.url} (draft)\n`,
      );
    } else {
      await prepareDeploymentState(deploymentTarget, remoteImage.imageId, hostRoot, "workflow");

      const secret = await resolveSecret(options["secret-ref"], options.account);
      const envelope = JSON.stringify({
        version: 1,
        template: loaded.workflow.name,
        templateDigest: loaded.templateDigest,
        deployment: options.deployment,
        task,
        key: secret,
        model,
        image: remoteImage.imageId,
        port,
        publicUrl: publicUrl.toString().replace(/\/$/, ""),
        runId,
      });
      const controllerName = `bimo-${options.deployment}-controller`;
      const result = await targetExecute(deploymentTarget, [
        "docker", "run", "--rm", "-i",
        "--name", controllerName,
        "--user", "0:0",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "256",
        "--memory", "1g",
        "--cpus", "1",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--volume", "/var/run/docker.sock:/var/run/docker.sock:rw",
        "--volume", `${hostRoot}/runs:/state:rw`,
        "--volume", `${hostRoot}/workspace:/workspace:rw`,
        remoteImage.imageId,
        "internal-run",
        "--host-root", hostRoot,
        ...controllerLocalRootArgs(deploymentTarget),
      ], {
        input: envelope,
        timeoutMs: (loaded.workflow.timeouts.workflowSeconds + 600) * 1_000,
        maxOutputBytes: 512 * 1024,
      });
      const response = parseLastJson(result.stdout, "workflow controller");
      if (options.json) process.stdout.write(`${JSON.stringify(response)}\n`);
      else process.stdout.write(`deployed ${response.template} as ${response.deployment}\nrun: ${response.runId}\nurl: ${response.url}\n`);
    }
  } finally {
    progress?.abort();
    if (follower) await follower;
    heartbeat?.stop();
    await cleanupTransferredImage(deploymentTarget, transferTag);
  }
}

async function organizeRemote(options) {
  exactOptions(options, [
    "prompt", "agents", "deployment", "target", "proxmox", "host", "vmid",
    "secret-ref", "account", "model", "image", "json",
  ]);
  if (!options.deployment) fail("--deployment is required");
  if (!NAME.test(options.deployment)) {
    fail("--deployment must use lowercase letters, numbers, and dashes");
  }
  const deploymentTarget = resolveDeploymentTarget(options);
  const prompt = validateOrganizerPrompt(options.prompt);
  const agentsText = options.agents ?? "1";
  if (!/^[1-3]$/u.test(agentsText)) fail("--agents must be an integer from 1 to 3");
  const agents = Number(agentsText);
  if (!options["secret-ref"]) fail("--secret-ref is required");
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const model = options.model ?? DEFAULT_MODEL;
  if (!/^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/.test(model)) fail("--model is invalid");
  const catalog = await loadOrganizerCatalog();
  validateOrganizerInput({ prompt, agents, catalog });

  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const progress = options.json ? null : new AbortController();
  if (progress) process.stderr.write(`run: ${runId}\n`);
  const heartbeat = progress ? startRunHeartbeat({ runId }) : null;
  let follower = null;
  let transferTag = null;
  try {
    heartbeat?.setPhase("preparing image");
    const prepared = await prepareImage(deploymentTarget, image, { retag: false });
    const remoteImage = prepared.remoteImage;
    transferTag = prepared.transferTag;
    const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
    if (progress) {
      heartbeat.setPhase("running controller");
      const readChunk = async ({ runId: current, after, signal }) => {
        const update = await targetExecute(deploymentTarget, stateReadArgs(hostRoot, remoteImage.imageId, [
          "internal-tail", "--run", current, "--after", String(after),
        ]), { timeoutMs: 30_000, maxOutputBytes: 256 * 1024, signal });
        return parseTailUpdate(update.stdout);
      };
      follower = streamRunProgress({
        readChunk,
        runId,
        signal: progress.signal,
        onEvent: event => {
          if (typeof event?.type === "string") heartbeat.setPhase(event.type);
        },
      }).catch(() => {});
    }
    await prepareDeploymentState(deploymentTarget, remoteImage.imageId, hostRoot, "organizer");
    let openRouterKey = await resolveSecret(options["secret-ref"], options.account);
    const envelope = JSON.stringify({
      version: 1,
      deployment: options.deployment,
      runId,
      prompt,
      agents,
      key: openRouterKey,
      model,
      image: remoteImage.imageId,
    });
    openRouterKey = "";
    const result = await targetExecute(deploymentTarget, [
      "docker", "run", "--rm", "-i",
      "--name", `bimo-${options.deployment}-controller`,
      "--user", "0:0",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "128",
      "--memory", "512m",
      "--cpus", "0.5",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m",
      "--volume", "/var/run/docker.sock:/var/run/docker.sock:rw",
      "--volume", `${hostRoot}/runs:/state:rw`,
      "--volume", `${hostRoot}/worktrees:/worktrees:rw`,
      remoteImage.imageId,
      "internal-organize",
      "--host-root", hostRoot,
      ...controllerLocalRootArgs(deploymentTarget),
    ], {
      input: envelope,
      timeoutMs: 12 * 60 * 1_000,
      maxOutputBytes: 256 * 1024,
    });
    const response = validateOrganizerPlan(parseLastJson(result.stdout, "organizer controller"), {
      prompt,
      agents,
      catalog,
      runId,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(response)}\n`);
    else process.stdout.write([
      `planned ${response.template} with ${response.agents} organizer${response.agents === 1 ? "" : "s"}`,
      `run: ${response.runId}`,
      `prompt: ${response.promptSha256}`,
      `template digest: ${response.templateDigest}`,
      `accepted deploy options: ${response.handoff.acceptedOptions.join(", ")}`,
      "",
    ].join("\n"));
  } finally {
    progress?.abort();
    if (follower) await follower;
    heartbeat?.stop();
    await cleanupTransferredImage(deploymentTarget, transferTag);
  }
}

export async function runController({
  loaded,
  envelope,
  runtime,
  stateRoot = "/state",
  workspace = "/workspace",
  runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
  clockSource = () => Date.now(),
  signalEmitter = process,
}) {
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void runtime.cancel();
  };
  signalEmitter.once("SIGINT", stop);
  signalEmitter.once("SIGTERM", stop);
  try {
    const clock = () => {
      if (interrupted) fail("controller interrupted");
      return clockSource();
    };
    const deadlineAt = clock() + (loaded.workflow.timeouts.workflowSeconds * 1_000);
    const imageDigest = await runtime.imageDigest({ deadlineAt });
    await runtime.start({ deadlineAt });
    if (interrupted) fail("controller interrupted");
    return await runWorkflow({
      ...loaded,
      task: envelope.task,
      stateRoot,
      workspace,
      runId,
      model: envelope.model,
      imageDigest,
      deadlineAt,
      clock,
      runRole: input => runtime.runRole(input),
      verify: input => runtime.verify(input),
      publish: input => runtime.publish(input),
    });
  } finally {
    signalEmitter.off("SIGINT", stop);
    signalEmitter.off("SIGTERM", stop);
    await runtime.close();
  }
}

function sourceSnapshotHandle(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !EXECUTION_ID.test(value.id ?? "")
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.sha ?? "")) {
    fail(`${label} snapshot is invalid`);
  }
  const receipt = value.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || !Number.isInteger(receipt.files) || !Number.isInteger(receipt.bytes)
      || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")) {
    fail(`${label} snapshot receipt is invalid`);
  }
  return {
    id: value.id,
    sha: value.sha,
    receipt: { files: receipt.files, bytes: receipt.bytes, sha256: receipt.sha256 },
  };
}

export async function runPodController({
  loaded,
  envelope,
  runtime,
  source,
  store,
  stateRoot = "/state",
  runId = envelope?.runId,
  clockSource = () => Date.now(),
  signalEmitter = process,
  runPod = runEngineeringPod,
}) {
  if (!loaded || loaded.kind !== "engineering-pod" || !loaded.template || !loaded.prompts) {
    fail("loaded engineering pod is invalid");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("pod envelope is invalid");
  if (!RUN_ID.test(runId ?? "")) fail("pod run ID is invalid");
  if (typeof runPod !== "function") fail("pod controller runner is invalid");
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    void runtime.cancel();
    void source.cancel?.();
  };
  signalEmitter.once("SIGINT", stop);
  signalEmitter.once("SIGTERM", stop);
  try {
    const clock = () => {
      if (interrupted) fail("controller interrupted");
      return clockSource();
    };
    const deadlineAt = clock() + (loaded.template.timeouts.workflowSeconds * 1_000);
    await runtime.imageDigest({ deadlineAt });
    await runtime.start({ deadlineAt, bootstrap: false });
    if (interrupted) fail("controller interrupted");
    return await runPod({
      template: loaded.template,
      prompts: loaded.prompts,
      templateDigest: loaded.templateDigest,
      assignment: { task: envelope.task },
      repository: envelope.repository,
      baseRevision: envelope.baseSha,
      targetBranch: envelope.targetBranch,
      runId,
      stateRoot,
      agents: runtime,
      source,
      store,
      clock,
      deadlineAt,
      verifyCandidate: input => runtime.verifySource({
        runId,
        expectedSha: input.expectedSha,
        candidateSnapshot: sourceSnapshotHandle(input.candidateSnapshot, "candidate"),
        baseSnapshot: sourceSnapshotHandle(input.baseSnapshot, "base"),
        profile: input.profile,
        timeoutSeconds: input.timeoutSeconds,
      }),
    });
  } finally {
    signalEmitter.off("SIGINT", stop);
    signalEmitter.off("SIGTERM", stop);
    await runtime.close();
  }
}

async function internalRun(options) {
  exactOptions(options, ["host-root", "local-home"]);
  const raw = await readStdin(128 * 1024);
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail("invalid controller envelope"); }
  const expected = ["version", "template", "templateDigest", "deployment", "task", "key", "model", "image", "port", "publicUrl", "runId"].sort();
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).sort().some((key, index) => key !== expected[index])
      || Object.keys(envelope).length !== expected.length) {
    fail("controller envelope has unexpected fields");
  }
  if (envelope.version !== 1 || !NAME.test(envelope.deployment ?? "") || !NAME.test(envelope.template ?? "")
      || !controllerHostRootIsValid(options["host-root"], envelope.deployment, options["local-home"])
      || !TEMPLATE_DIGEST.test(envelope.templateDigest ?? "") || !SHA256.test(envelope.image ?? "")
      || !RUN_ID.test(envelope.runId ?? "")) {
    fail("controller envelope is invalid");
  }
  const loaded = await loadWorkflow(envelope.template, { templateRoot });
  if (loaded.templateDigest !== envelope.templateDigest) fail("controller template digest does not match the locally validated template");
  const runtime = new DockerRuntime({
    image: envelope.image,
    deployment: envelope.deployment,
    hostRoot: options["host-root"],
    localHome: options["local-home"],
    key: envelope.key,
    model: envelope.model,
    port: envelope.port,
    publicUrl: envelope.publicUrl,
  });
  envelope.key = null;
  const result = await runController({ loaded, envelope, runtime, runId: envelope.runId });
  process.stdout.write(`${JSON.stringify({ ...result, template: envelope.template, deployment: envelope.deployment })}\n`);
}

async function readJsonEnvelope(maximumBytes, fields, label) {
  const raw = await readStdin(maximumBytes);
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail(`invalid ${label} envelope`); }
  return exactObject(envelope, fields, `${label} envelope`);
}

async function openDeploymentDirectory(targetPath, label, { create = false } = {}) {
  if (create) {
    try {
      await mkdir(targetPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") fail(`deployment state ${label} is invalid`);
    }
  }
  try {
    return await open(targetPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    fail(`deployment state ${label} is invalid`);
  }
}

async function internalPrepare(options) {
  exactOptions(options, ["layout"]);
  const directories = deploymentDirectories(options.layout);
  const root = "/deployment";
  const rootHandle = await openDeploymentDirectory(root, "mount");
  try {
    await rootHandle.chmod(0o700);
  } finally {
    await rootHandle.close();
  }
  for (const directory of directories) {
    const targetPath = path.join(root, directory);
    const handle = await openDeploymentDirectory(targetPath, directory, { create: true });
    try {
      await handle.chmod(directory === "workspace" ? 0o770 : 0o700);
      if (directory === "workspace") await handle.chown(1_000, 0);
    } finally {
      await handle.close();
    }
  }
}

async function internalOrganize(options) {
  exactOptions(options, ["host-root", "local-home"]);
  const envelope = await readJsonEnvelope(128 * 1024, [
    "version", "deployment", "runId", "prompt", "agents", "key", "model", "image",
  ], "organizer controller");
  if (envelope.version !== 1 || !NAME.test(envelope.deployment ?? "")
      || !controllerHostRootIsValid(options["host-root"], envelope.deployment, options["local-home"])
      || !RUN_ID.test(envelope.runId ?? "")
      || !Number.isInteger(envelope.agents) || envelope.agents < 1 || envelope.agents > 3
      || !/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(envelope.key ?? "")
      || !/^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/.test(envelope.model ?? "")
      || !SHA256.test(envelope.image ?? "")) {
    fail("organizer controller envelope is invalid");
  }
  const catalog = await loadOrganizerCatalog();
  validateOrganizerInput({ prompt: envelope.prompt, agents: envelope.agents, catalog });
  const instructionsStat = await lstat(organizerInstructionsPath).catch(() => null);
  if (!instructionsStat?.isFile() || instructionsStat.isSymbolicLink()
      || instructionsStat.size < 1 || instructionsStat.size > 16 * 1024) {
    fail("packaged organizer instructions are invalid");
  }
  const baseInstructions = await readFile(organizerInstructionsPath, "utf8");
  const runtime = new DockerRuntime({
    image: envelope.image,
    deployment: envelope.deployment,
    hostRoot: options["host-root"],
    localHome: options["local-home"],
    key: envelope.key,
    model: envelope.model,
    modelConcurrency: envelope.agents,
    modelRequestLimit: 100,
  });
  envelope.key = null;
  const result = await runOrganizerController({
    prompt: envelope.prompt,
    agents: envelope.agents,
    catalog,
    baseInstructions,
    model: envelope.model,
    runtime,
    runId: envelope.runId,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function internalPodRun(options) {
  exactOptions(options, ["host-root", "local-home"]);
  const envelope = await readJsonEnvelope(128 * 1024, [
    "version", "template", "templateDigest", "deployment", "task", "key", "model", "image",
    "repository", "baseSha", "targetBranch", "runId",
  ], "pod controller");
  if (envelope.version !== 1 || !NAME.test(envelope.deployment ?? "")
      || !controllerHostRootIsValid(options["host-root"], envelope.deployment, options["local-home"])
      || envelope.template !== "parallel-engineering-pod"
      || !TEMPLATE_DIGEST.test(envelope.templateDigest ?? "")
      || typeof envelope.task !== "string" || !envelope.task.trim()
      || Buffer.byteLength(envelope.task) > 64 * 1024
      || !/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(envelope.key ?? "")
      || !/^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/.test(envelope.model ?? "")
      || !SHA256.test(envelope.image ?? "") || envelope.repository !== POD_REPOSITORY
      || !GIT_SHA.test(envelope.baseSha ?? "") || envelope.targetBranch !== POD_TARGET_BRANCH
      || !RUN_ID.test(envelope.runId ?? "")) {
    fail("pod controller envelope is invalid");
  }
  const loaded = await loadTemplate(envelope.template);
  if (loaded.kind !== "engineering-pod" || loaded.templateDigest !== envelope.templateDigest) {
    fail("controller template digest does not match the locally validated template");
  }
  const allowedWriteRoots = Object.fromEntries(Object.entries(loaded.template.writers).map(
    ([slot, writer]) => [slot, [...writer.allowedWriteRoots]],
  ));
  const source = new GitRuntime({
    allowedRepositories: [POD_REPOSITORY],
    allowedWriteRoots,
    gitRoot: "/source",
    worktreesRoot: "/worktrees",
    snapshotsRoot: "/snapshots",
    runId: envelope.runId,
  });
  await prunePodRuns({ stateRoot: "/state", keepTerminalRuns: 20 });
  const store = await createPodRunStore({
    stateRoot: "/state",
    runId: envelope.runId,
    assignment: {
      task: envelope.task,
      repository: envelope.repository,
      baseSha: envelope.baseSha,
      targetBranch: envelope.targetBranch,
    },
  });
  const runtime = new DockerRuntime({
    image: envelope.image,
    deployment: envelope.deployment,
    hostRoot: options["host-root"],
    localHome: options["local-home"],
    key: envelope.key,
    model: envelope.model,
    modelConcurrency: Object.keys(loaded.template.writers).length,
    modelRequestLimit: 300,
  });
  envelope.key = null;
  try {
    const result = await runPodController({
      loaded,
      envelope,
      runtime,
      source,
      store,
      runId: envelope.runId,
    });
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      runId: result.runId,
      baseSha: result.baseSha,
      candidateSha: result.candidateSha,
      branch: result.branch,
    })}\n`);
  } catch (error) {
    await source.close({ retainForPublication: false }).catch(() => {});
    await store.finish("failed", {
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    }).catch(() => {});
    throw error;
  }
}

async function internalPublish(options) {
  exactOptions(options, []);
  const envelope = await readJsonEnvelope(16 * 1024, [
    "version", "runId", "repository", "targetBranch", "baseSha", "candidateSha",
    "headBranch", "token",
  ], "publisher");
  if (envelope.version !== 1 || !RUN_ID.test(envelope.runId ?? "")
      || envelope.repository !== POD_REPOSITORY || envelope.targetBranch !== POD_TARGET_BRANCH
      || !GIT_SHA.test(envelope.baseSha ?? "") || !GIT_SHA.test(envelope.candidateSha ?? "")
      || envelope.headBranch !== `bimo/${envelope.runId}`
      || !GITHUB_TOKEN.test(envelope.token ?? "")) {
    fail("publisher envelope is invalid");
  }
  const token = envelope.token;
  envelope.token = null;
  const result = await publishRun({
    runId: envelope.runId,
    stateRoot: "/state",
    sourceGitDir: "/source/repository.git",
    repository: envelope.repository,
    targetBranch: envelope.targetBranch,
    baseSha: envelope.baseSha,
    candidateSha: envelope.candidateSha,
    headBranch: envelope.headBranch,
    token,
    deadlineAt: Date.now() + PUBLISH_TIMEOUT_MS,
  }, { gitRunner: runPublisherGit });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function internalPublishResume(options) {
  exactOptions(options, ["state-root"]);
  const stateRoot = internalStateRoot(options);
  const envelope = await readJsonEnvelope(16 * 1024, ["version", "runId", "token"], "publisher resume");
  if (envelope.version !== 1 || !RUN_ID.test(envelope.runId ?? "") || !GITHUB_TOKEN.test(envelope.token ?? "")) {
    fail("publisher resume envelope is invalid");
  }
  let runId = envelope.runId;
  if (runId === "latest") {
    runId = (await readFile(path.join(stateRoot, "latest"), "utf8").catch(() => "")).trim();
    if (!RUN_ID.test(runId)) fail("no latest run is recorded");
  }
  const store = await openPodRunStore({ stateRoot, runId });
  const ready = store.events.filter(event => event.type === "publication.ready");
  if (ready.length !== 1) fail("run has no unique publication.ready record");
  const { repository, targetBranch, baseSha, candidateSha, headBranch } = ready[0];
  if (repository !== POD_REPOSITORY || targetBranch !== POD_TARGET_BRANCH
      || !GIT_SHA.test(baseSha ?? "") || !GIT_SHA.test(candidateSha ?? "")
      || headBranch !== `bimo/${runId}`) {
    fail("publication.ready record is invalid");
  }
  const token = envelope.token;
  envelope.token = null;
  const result = await publishRun({
    runId,
    stateRoot,
    sourceGitDir: "/source/repository.git",
    repository,
    targetBranch,
    baseSha,
    candidateSha,
    headBranch,
    token,
    deadlineAt: Date.now() + PUBLISH_TIMEOUT_MS,
  }, { gitRunner: runPublisherGit });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function interruptibleSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function startRunHeartbeat({
  runId,
  intervalMs = PROGRESS_HEARTBEAT_MS,
  now = () => Date.now(),
  write = line => process.stderr.write(line),
} = {}) {
  if (!RUN_ID.test(runId ?? "")) fail("run ID is invalid");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) fail("heartbeat interval is invalid");
  const startedAt = now();
  let phase = "starting";
  const timer = setInterval(() => {
    const elapsed = Math.max(0, Math.round((now() - startedAt) / 1_000));
    write(`run ${runId}: still working (${phase}, ${elapsed}s elapsed)\n`);
  }, intervalMs);
  timer.unref?.();
  return Object.freeze({
    setPhase(next) {
      if (typeof next === "string" && next.length >= 1 && next.length <= 64
          && !/[\u0000-\u001f\u007f]/u.test(next)) {
        phase = next;
      }
    },
    stop() {
      clearInterval(timer);
    },
  });
}

export async function streamRunProgress({
  readChunk,
  runId,
  signal,
  pollMs = FOLLOW_POLL_MS,
  write = line => process.stderr.write(line),
  onEvent,
} = {}) {
  if (typeof readChunk !== "function") fail("progress reader is invalid");
  if (!RUN_ID.test(runId ?? "")) fail("run ID is invalid");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) fail("progress poll interval is invalid");
  let offset = 0;
  let resolved = runId;
  while (!signal?.aborted) {
    try {
      const update = await readChunk({ runId: resolved, after: offset, signal });
      if (!isPlainObject(update) || !RUN_ID.test(update.runId ?? "")
          || !Number.isSafeInteger(update.offset) || typeof update.chunk !== "string") {
        fail("progress update is invalid");
      }
      resolved = update.runId;
      offset = update.offset;
      if (update.chunk) {
        for (const line of update.chunk.trimEnd().split("\n")) {
          write(`${`run ${runId}: ${formatFollowEvent(line)}`.slice(0, PROGRESS_LINE_MAX)}\n`);
          if (onEvent) {
            try {
              onEvent(JSON.parse(line));
            } catch {
              // Progress rendering must not fail the run.
            }
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) break;
      if (error instanceof Error && error.message === "progress update is invalid") throw error;
      // The run directory may not exist yet; keep polling.
    }
    await interruptibleSleep(pollMs, signal);
  }
}

async function remoteLogs(options) {
  exactOptions(options, ["deployment", "target", "proxmox", "host", "vmid", "run", "image", "json", "follow"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const runId = options.run ?? "latest";
  if (runId !== "latest" && !RUN_ID.test(runId)) fail("--run is invalid");
  const deploymentTarget = resolveDeploymentTarget(options);
  if (deploymentTarget.kind === "local") await requireLocalDocker();
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
  if (options.follow) {
    await followLogs(deploymentTarget, { hostRoot, image, runId, json: Boolean(options.json) });
    return;
  }
  const result = await targetExecute(deploymentTarget, [
    "docker", "run", "--rm", "--read-only", "--network", "none",
    "--user", "0:0",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "128m",
    "--cpus", "0.25",
    "--volume", `${hostRoot}/runs:/state:ro`,
    image,
    "internal-logs",
    "--run", runId,
    ...(options.json ? ["--json"] : []),
  ], { maxOutputBytes: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
}

async function internalLogs(argv) {
  const { positional, options } = parseOptions(argv, { booleans: ["json"] });
  if (positional.length) fail("internal-logs accepts no positional arguments");
  exactOptions(options, ["run", "json"]);
  let runId = options.run ?? "latest";
  if (runId === "latest") runId = (await readFile("/state/latest", "utf8")).trim();
  if (!RUN_ID.test(runId)) fail("invalid run ID");
  const runDir = path.join("/state", runId);
  const stat = await lstat(runDir).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`unknown run: ${runId}`);
  const targetPath = path.join(runDir, options.json ? "events.jsonl" : "CHANGELOG.md");
  const fileStat = await lstat(targetPath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.size > 2 * 1024 * 1024) fail("run log is invalid");
  process.stdout.write(await readFile(targetPath, "utf8"));
}

function internalStateRoot(options) {
  const root = options["state-root"] ?? "/state";
  if (typeof root !== "string" || root.length > 4_096 || !path.isAbsolute(root)
      || path.normalize(root) !== root || /[\u0000\r\n]/u.test(root)) {
    fail("--state-root is invalid");
  }
  return root;
}

function storedTimestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function parseEventLines(raw) {
  let events;
  try {
    events = raw.split("\n").map(line => JSON.parse(line));
  } catch {
    fail("run event record is invalid");
  }
  if (events.some(event => !isPlainObject(event))) fail("run event record is invalid");
  return events;
}

async function readRunEvents(runDir, { wholeFile }) {
  const eventsPath = path.join(runDir, "events.jsonl");
  const stat = await lstat(eventsPath).catch(() => null);
  if (!stat) return [];
  if (!stat.isFile() || stat.isSymbolicLink()) fail("run event record is invalid");
  if (wholeFile) {
    if (stat.size > 2 * 1024 * 1024) fail("run event record is invalid");
    const raw = await readFile(eventsPath, "utf8");
    return raw.trim() ? parseEventLines(raw.trimEnd()) : [];
  }
  const window = Math.min(stat.size, 128 * 1024);
  if (!window) return [];
  const handle = await open(eventsPath, "r");
  try {
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, stat.size - window);
    const text = buffer.toString("utf8").trimEnd();
    const line = text ? text.split("\n").at(-1) : "";
    return line ? parseEventLines(line) : [];
  } finally {
    await handle.close();
  }
}

function summarizeEvent(event) {
  if (!event) return null;
  const summary = {};
  if (Number.isSafeInteger(event.sequence)) summary.sequence = event.sequence;
  const timestamp = storedTimestamp(event.timestamp);
  if (timestamp) summary.timestamp = timestamp;
  if (typeof event.type === "string" && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/.test(event.type)) {
    summary.type = event.type;
  }
  for (const field of ["status", "reason", "role", "outcome", "template", "url", "phase"]) {
    if (typeof event[field] === "string") {
      summary[field] = event[field].replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 200);
    }
  }
  return summary;
}

async function summarizeRun(stateRoot, runId, { withLastEvent = false } = {}) {
  const runDir = path.join(stateRoot, runId);
  const dirStat = await lstat(runDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail("run directory is invalid");

  let record = null;
  const recordPath = path.join(runDir, "run.json");
  const recordStat = await lstat(recordPath).catch(() => null);
  if (recordStat) {
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.size > 64 * 1024) {
      fail("run record is invalid");
    }
    try {
      record = JSON.parse(await readFile(recordPath, "utf8"));
    } catch {
      fail("run record is invalid");
    }
    if (!isPlainObject(record)) fail("run record is invalid");
  }

  let state = typeof record?.status === "string" && RUN_STATES.has(record.status) ? record.status : null;
  let startedAt = storedTimestamp(record?.startedAt);
  let finishedAt = storedTimestamp(record?.finishedAt);
  let attempts = null;
  if (Number.isSafeInteger(record?.currentAttempt) && record.currentAttempt >= 0) {
    attempts = record.currentAttempt;
  }
  const phase = typeof record?.phase === "string" && record.phase.length <= 64 ? record.phase : null;

  let events = [];
  if (!state) events = await readRunEvents(runDir, { wholeFile: true });
  else if (withLastEvent) events = await readRunEvents(runDir, { wholeFile: false });

  if (!state) {
    const terminal = events.at(-1);
    if (terminal?.type === "run.finished" && RUN_STATES.has(terminal.status) && terminal.status !== "running") {
      state = terminal.status;
    } else if (terminal?.type === "run.failed") state = "failed";
    else if (terminal?.type === "run.completed") state = "completed";
    else state = "running";
    startedAt ??= storedTimestamp(events[0]?.timestamp);
    if (state !== "running") finishedAt ??= storedTimestamp(terminal?.timestamp);
    attempts ??= events.reduce(
      (maximum, event) => (Number.isSafeInteger(event.attempt) ? Math.max(maximum, event.attempt) : maximum),
      0,
    );
  }
  if (attempts === null) attempts = events.length ? 1 : 0;

  return {
    id: runId,
    state,
    phase,
    startedAt,
    finishedAt,
    attempts,
    ...(withLastEvent ? { lastEvent: summarizeEvent(events.at(-1) ?? null) } : {}),
  };
}

async function internalRuns(argv) {
  const { positional, options } = parseOptions(argv, { booleans: ["json"] });
  if (positional.length) fail("internal-runs accepts no positional arguments");
  exactOptions(options, ["deployment", "state-root", "json"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const stateRoot = internalStateRoot(options);
  const entries = await readdir(stateRoot, { withFileTypes: true });
  const runIds = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID.test(entry.name))
    .map(entry => entry.name);
  if (runIds.length > RUN_SCAN_LIMIT) fail("run state exceeds the scan limit");
  runIds.sort((left, right) => right.localeCompare(left));
  const runs = [];
  for (const runId of runIds.slice(0, RUN_LIST_LIMIT)) {
    try {
      runs.push(await summarizeRun(stateRoot, runId));
    } catch {
      runs.push({ id: runId, state: "unknown", phase: null, startedAt: null, finishedAt: null, attempts: 0 });
    }
  }
  runs.sort((left, right) => (
    (right.startedAt ?? "").localeCompare(left.startedAt ?? "") || right.id.localeCompare(left.id)
  ));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ deployment: options.deployment, runs })}\n`);
    return;
  }
  for (const run of runs) {
    process.stdout.write([
      run.id,
      run.state,
      run.startedAt ?? "-",
      run.finishedAt ?? "-",
      String(run.attempts),
    ].join("\t") + "\n");
  }
}

async function internalStatus(argv) {
  const { positional, options } = parseOptions(argv, { booleans: ["json"] });
  if (positional.length) fail("internal-status accepts no positional arguments");
  exactOptions(options, ["deployment", "run", "state-root", "json"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const stateRoot = internalStateRoot(options);
  let runId = options.run ?? "latest";
  if (runId === "latest") runId = (await readFile(path.join(stateRoot, "latest"), "utf8").catch(() => "")).trim();
  let status;
  if (!runId) {
    status = {
      runId: null, state: "none", phase: null, startedAt: null, finishedAt: null, attempts: 0, lastEvent: null,
    };
  } else {
    if (!RUN_ID.test(runId)) fail("invalid run ID");
    const dirStat = await lstat(path.join(stateRoot, runId)).catch(() => null);
    if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) fail(`unknown run: ${runId}`);
    let summary;
    try {
      summary = await summarizeRun(stateRoot, runId, { withLastEvent: true });
    } catch {
      summary = {
        id: runId, state: "unknown", phase: null, startedAt: null, finishedAt: null, attempts: 0, lastEvent: null,
      };
    }
    const { id, ...rest } = summary;
    status = { runId: id, ...rest };
  }
  const payload = { deployment: options.deployment, ...status };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const lines = [
    `deployment: ${payload.deployment}`,
    `run: ${payload.runId ?? "-"}`,
    `state: ${payload.state}`,
  ];
  if (payload.phase) lines.push(`phase: ${payload.phase}`);
  lines.push(`started: ${payload.startedAt ?? "-"}`);
  lines.push(`finished: ${payload.finishedAt ?? "-"}`);
  lines.push(`attempts: ${payload.attempts}`);
  if (payload.lastEvent) {
    lines.push(`last event: ${payload.lastEvent.type ?? "event"} at ${payload.lastEvent.timestamp ?? "-"}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function internalTail(argv) {
  const { positional, options } = parseOptions(argv);
  if (positional.length) fail("internal-tail accepts no positional arguments");
  exactOptions(options, ["run", "after", "state-root"]);
  const stateRoot = internalStateRoot(options);
  let runId = options.run ?? "latest";
  if (runId === "latest") runId = (await readFile(path.join(stateRoot, "latest"), "utf8")).trim();
  if (!RUN_ID.test(runId)) fail("invalid run ID");
  if (!/^\d{1,15}$/.test(options.after ?? "0")) fail("--after is invalid");
  let offset = Number(options.after ?? "0");
  const eventsPath = path.join(stateRoot, runId, "events.jsonl");
  const stat = await lstat(eventsPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`unknown run: ${runId}`);
  const size = stat.size;
  if (offset > size) offset = 0;
  const window = Math.min(TAIL_CHUNK_BYTES, size - offset);
  let chunk = "";
  let next = offset;
  if (window > 0) {
    const handle = await open(eventsPath, "r");
    try {
      const buffer = Buffer.alloc(window);
      await handle.read(buffer, 0, window, offset);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline >= 0) {
        chunk = buffer.subarray(0, newline + 1).toString("utf8");
        next = offset + newline + 1;
      }
    } finally {
      await handle.close();
    }
  }
  process.stdout.write(`${JSON.stringify({ runId, offset: next, size, chunk })}\n`);
}

function stateReadArgs(hostRoot, image, internalArgs) {
  return [
    "docker", "run", "--rm", "--read-only", "--network", "none",
    "--user", "0:0",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "128m",
    "--cpus", "0.25",
    "--volume", `${hostRoot}/runs:/state:ro`,
    image,
    ...internalArgs,
  ];
}

async function remoteRuns(options) {
  exactOptions(options, ["deployment", "target", "proxmox", "host", "vmid", "image", "json"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const deploymentTarget = resolveDeploymentTarget(options);
  if (deploymentTarget.kind === "local") await requireLocalDocker();
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
  const result = await targetExecute(deploymentTarget, stateReadArgs(hostRoot, image, [
    "internal-runs",
    "--deployment", options.deployment,
    ...(options.json ? ["--json"] : []),
  ]), { maxOutputBytes: 2 * 1024 * 1024 });
  process.stdout.write(result.stdout);
}

async function remoteStatus(options) {
  exactOptions(options, ["deployment", "target", "proxmox", "host", "vmid", "run", "image", "json"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const runId = options.run ?? "latest";
  if (runId !== "latest" && !RUN_ID.test(runId)) fail("--run is invalid");
  const deploymentTarget = resolveDeploymentTarget(options);
  if (deploymentTarget.kind === "local") await requireLocalDocker();
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
  const result = await targetExecute(deploymentTarget, stateReadArgs(hostRoot, image, [
    "internal-status",
    "--deployment", options.deployment,
    "--run", runId,
    ...(options.json ? ["--json"] : []),
  ]), { maxOutputBytes: 64 * 1024 });
  process.stdout.write(result.stdout);
}

async function remoteCancel(options) {
  exactOptions(options, ["deployment", "target", "proxmox", "host", "vmid", "run", "image", "json"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const runId = options.run ?? null;
  if (runId !== null && !RUN_ID.test(runId)) fail("--run is invalid");
  const deploymentTarget = resolveDeploymentTarget(options);
  if (deploymentTarget.kind === "local") await requireLocalDocker();
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
  if (runId !== null) {
    const statusResult = await targetExecute(deploymentTarget, stateReadArgs(hostRoot, image, [
      "internal-status",
      "--deployment", options.deployment,
      "--run", runId,
      "--json",
    ]), { maxOutputBytes: 64 * 1024 });
    const status = parseLastJson(statusResult.stdout, "run status");
    if (!isPlainObject(status) || typeof status.state !== "string") fail("run status is invalid");
    if (status.state !== "running") fail(`run ${runId} is ${status.state}; nothing to cancel`);
  }
  const signalled = [];
  for (const name of [
    `bimo-${options.deployment}-controller`,
    `bimo-${options.deployment}-publisher`,
  ]) {
    const sent = await targetExecute(deploymentTarget, [
      "docker", "kill", "--signal", "SIGTERM", name,
    ], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 }).then(() => true, () => false);
    if (sent) signalled.push(name);
  }
  if (signalled.length === 0) {
    fail(`no running controller or publisher for deployment ${options.deployment}`);
  }
  const receipt = { deployment: options.deployment, run: runId, signalled };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  for (const name of signalled) {
    process.stdout.write(`sent SIGTERM to ${name}; the run will finish as failed or cancelled\n`);
  }
}

function validateResumedPublication(value) {
  exactObject(value, [
    "status", "runId", "repository", "targetBranch", "baseSha", "candidateSha",
    "headBranch", "publication",
  ], "pod publisher");
  if (value.status !== "completed" || !RUN_ID.test(value.runId ?? "")
      || value.repository !== POD_REPOSITORY || value.targetBranch !== POD_TARGET_BRANCH
      || !GIT_SHA.test(value.baseSha ?? "") || !GIT_SHA.test(value.candidateSha ?? "")
      || value.headBranch !== `bimo/${value.runId}`) {
    fail("pod publisher returned an invalid completion receipt");
  }
  const publication = value.publication;
  if (!isPlainObject(publication)
      || Object.keys(publication).some(key => ![
        "baseSha", "created", "draft", "headBranch", "headSha", "number", "reconciled",
        "targetBranch", "url",
      ].includes(key))
      || !Number.isSafeInteger(publication.number) || publication.number < 1
      || publication.draft !== true || typeof publication.created !== "boolean"
      || publication.baseSha !== value.baseSha || publication.headSha !== value.candidateSha
      || publication.headBranch !== value.headBranch || publication.targetBranch !== POD_TARGET_BRANCH
      || !new RegExp(`^https://github\\.com/zaycruz/bimo/pull/${publication.number}$`).test(publication.url ?? "")) {
    fail("pod publisher returned an invalid draft pull request receipt");
  }
  return value;
}

async function remotePublish(options) {
  exactOptions(options, [
    "deployment", "target", "proxmox", "host", "vmid", "run",
    "github-secret-ref", "account", "image", "json",
  ]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const runId = options.run ?? "latest";
  if (runId !== "latest" && !RUN_ID.test(runId)) fail("--run is invalid");
  if (!options["github-secret-ref"]) fail("--github-secret-ref is required");
  const deploymentTarget = resolveDeploymentTarget(options);
  if (deploymentTarget.kind === "local") await requireLocalDocker();
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const hostRoot = deploymentRootForTarget(deploymentTarget, options.deployment);
  let githubToken = await resolveGitHubSecret(options["github-secret-ref"], options.account);
  const envelope = JSON.stringify({ version: 1, runId, token: githubToken });
  githubToken = "";
  const publisher = await targetExecute(deploymentTarget, [
    "docker", "run", "--rm", "-i",
    "--name", `bimo-${options.deployment}-publisher`,
    "--user", "0:0",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "128",
    "--memory", "512m",
    "--cpus", "0.5",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    "--tmpfs", "/run/bimo-publish:rw,nosuid,nodev,noexec,size=16m,mode=0700",
    "--volume", `${hostRoot}/runs:/state:rw`,
    "--volume", `${hostRoot}/source:/source:rw`,
    image,
    "internal-publish-resume",
  ], {
    input: envelope,
    timeoutMs: PUBLISH_TIMEOUT_MS + 60_000,
    maxOutputBytes: 512 * 1024,
  });
  const response = validateResumedPublication(parseLastJson(publisher.stdout, "pod publisher"));
  if (options.json) process.stdout.write(`${JSON.stringify(response)}\n`);
  else process.stdout.write(`published ${response.runId}\nPR: ${response.publication.url} (draft)\n`);
}

function formatFollowEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isPlainObject(event)) return line;
  const detail = event.status ?? event.reason
    ?? (typeof event.role === "string"
      ? [event.role, event.outcome].filter(value => typeof value === "string").join(" ")
      : null)
    ?? event.template ?? event.url ?? "";
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : "-";
  const type = typeof event.type === "string" ? event.type : "event";
  return `${timestamp} ${type}${detail ? ` ${String(detail).slice(0, 200)}` : ""}`;
}

function parseTailUpdate(stdout) {
  let value;
  try {
    value = JSON.parse(stdout.trim().split("\n").at(-1));
  } catch {
    fail("follow update is invalid");
  }
  if (!isPlainObject(value) || !RUN_ID.test(value.runId ?? "")
      || !Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.size)
      || value.offset < 0 || value.offset > value.size
      || typeof value.chunk !== "string" || Buffer.byteLength(value.chunk) > TAIL_CHUNK_BYTES) {
    fail("follow update is invalid");
  }
  return value;
}

async function followLogs(deploymentTarget, { hostRoot, image, runId, json }) {
  const abort = new AbortController();
  let wake = null;
  const stop = () => {
    abort.abort();
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let offset = 0;
  let currentRunId = null;
  try {
    while (!abort.signal.aborted) {
      let update;
      try {
        const result = await targetExecute(deploymentTarget, stateReadArgs(hostRoot, image, [
          "internal-tail",
          "--run", currentRunId ?? runId,
          "--after", String(offset),
        ]), {
          timeoutMs: 30_000,
          maxOutputBytes: 256 * 1024,
          signal: abort.signal,
        });
        update = parseTailUpdate(result.stdout);
      } catch (error) {
        if (abort.signal.aborted) break;
        throw error;
      }
      currentRunId = update.runId;
      offset = update.offset;
      if (update.chunk) {
        if (json) process.stdout.write(update.chunk);
        else {
          for (const line of update.chunk.trimEnd().split("\n")) {
            process.stdout.write(`${formatFollowEvent(line)}\n`);
          }
        }
      }
      if (update.size > update.offset) continue;
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, FOLLOW_POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function doctorReason(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 200) || "check failed";
}

async function nearestExistingDirectory(targetPath) {
  let current = targetPath;
  for (let depth = 0; depth < 64; depth += 1) {
    const stat = await lstat(current).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail("no existing directory on the state path");
}

function parseDfAvailable(stdout) {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const match = line.match(/(\d+)\s+\d+%\s+/);
  if (!match) fail("df output is unparseable");
  return Number(match[1]);
}

function doctorDiskReason(available) {
  const mib = Math.floor(available / 1024);
  if (available < DOCTOR_MIN_FREE_BLOCKS) fail(`only ${mib} MiB free`);
  return `${mib} MiB free`;
}

async function doctorRemoteProbe(target, probe) {
  return targetExecute(target, probe, { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 })
    .then(() => true, () => false);
}

async function doctorRemoteStateRoot(target, root) {
  if (await doctorRemoteProbe(target, ["test", "-d", root])) {
    if (!(await doctorRemoteProbe(target, ["test", "-w", root]))) fail("state root is not writable");
    return `writable (${root})`;
  }
  const parent = path.posix.dirname(root);
  if (await doctorRemoteProbe(target, ["test", "-d", parent, "-a", "-w", parent])) {
    return `missing; parent is writable (${parent})`;
  }
  fail("state root is missing and its parent is not writable");
}

async function doctorRemoteDisk(target, root) {
  let candidate = root;
  for (let depth = 0; depth < 4; depth += 1) {
    if (await doctorRemoteProbe(target, ["test", "-d", candidate])) {
      const result = await targetExecute(target, ["df", "-Pk", candidate], {
        timeoutMs: 15_000,
        maxOutputBytes: 16 * 1024,
      });
      return doctorDiskReason(parseDfAvailable(result.stdout));
    }
    const parent = path.posix.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  fail("no existing directory on the remote state path");
}

async function doctor(options) {
  exactOptions(options, [
    "deployment", "target", "proxmox", "host", "vmid", "secret-ref", "account", "json",
  ]);
  if (options.deployment !== undefined && !NAME.test(options.deployment)) fail("--deployment is invalid");
  if (options["secret-ref"] !== undefined && !SECRET_REF.test(options["secret-ref"])) {
    fail("--secret-ref must be a 1Password op:// reference");
  }
  const target = resolveDeploymentTarget(options);
  const checks = [];
  const check = async (name, run) => {
    try {
      checks.push(Object.freeze({ name, status: "pass", reason: await run() }));
    } catch (error) {
      checks.push(Object.freeze({ name, status: "fail", reason: doctorReason(error) }));
    }
  };

  if (target.kind === "local") {
    await check("docker", async () => {
      const status = await inspectLocalDocker();
      if (status.availability !== "ready") fail(status.reason);
      return `ready (${status.platform})`;
    });
    const root = options.deployment
      ? deploymentRootForTarget(target, options.deployment)
      : deploymentsRootForTarget(target);
    await check("state-root", async () => {
      const existing = await nearestExistingDirectory(root);
      await access(existing, fsConstants.W_OK);
      return `writable (${existing})`;
    });
    await check("disk", async () => {
      const existing = await nearestExistingDirectory(root);
      const result = await execute("df", ["-Pk", existing], {
        timeoutMs: 15_000,
        maxOutputBytes: 16 * 1024,
      });
      return doctorDiskReason(parseDfAvailable(result.stdout));
    });
  } else {
    const sshTarget = target.kind === "ssh"
      ? target
      : Object.freeze({ kind: "ssh", runtime: "docker", sshTarget: target.sshTarget });
    await check("ssh", async () => {
      await targetExecute(sshTarget, ["true"], { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 });
      return "reachable (batch mode)";
    });
    if (target.kind === "proxmox-lxc") {
      await check("pct", async () => {
        const result = await targetExecute(sshTarget, ["pct", "status", target.vmid], {
          timeoutMs: 15_000,
          maxOutputBytes: 4 * 1024,
        });
        const status = result.stdout.trim();
        if (!/^status: running$/u.test(status)) fail(`guest ${target.vmid} is not running`);
        return `guest ${target.vmid} is running`;
      });
    }
    await check("docker", async () => {
      const result = await targetExecute(target, [
        "docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}",
      ], { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 });
      const platform = result.stdout.trim();
      if (!/^linux\/(?:amd64|arm64)$/u.test(platform)) {
        fail("remote Docker platform must be linux/amd64 or linux/arm64");
      }
      return `ready (${platform})`;
    });
    const root = options.deployment
      ? deploymentRootForTarget(target, options.deployment)
      : deploymentsRootForTarget(target);
    await check("state-root", () => doctorRemoteStateRoot(target, root));
    await check("disk", () => doctorRemoteDisk(target, root));
  }

  if (options["secret-ref"]) {
    let opAvailable = false;
    await check("op-cli", async () => {
      const result = await execute("op", ["--version"], {
        timeoutMs: 15_000,
        maxOutputBytes: 4 * 1024,
      });
      const version = result.stdout.trim();
      if (!/^\d+\.\d+[\d.]*$/u.test(version)) fail("op CLI returned an unexpected version");
      opAvailable = true;
      return `op ${version}`;
    });
    if (opAvailable) {
      await check("secret-ref", async () => {
        const args = ["read", options["secret-ref"]];
        if (options.account) args.push("--account", options.account);
        const result = await execute("op", args, {
          timeoutMs: 15_000,
          maxOutputBytes: 4 * 1024,
        }).catch(() => fail("reference is not readable"));
        if (!result.stdout.trim()) fail("reference resolved to an empty value");
        return "reference is readable";
      });
    } else {
      checks.push(Object.freeze({ name: "secret-ref", status: "skip", reason: "op CLI is unavailable" }));
    }
  } else {
    checks.push(Object.freeze({ name: "secret-ref", status: "skip", reason: "no --secret-ref supplied" }));
  }

  const ok = checks.every(entry => entry.status !== "fail");
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, target: target.kind, checks })}\n`);
  } else {
    for (const entry of checks) {
      process.stdout.write(`${entry.status.toUpperCase()} ${entry.name}: ${entry.reason}\n`);
    }
  }
  if (!ok) process.exitCode = 1;
}

const COMMAND_HELP = {
  list: "bimo list [--json]\n  List the installed workflow and pod templates.",
  targets: "bimo targets [--json]\n  Probe the local Docker daemon and list the built-in deployment targets.",
  validate: "bimo validate TEMPLATE [--json]\n  Validate one installed template and print its digest.",
  organize: "bimo organize -p PROMPT [-n 1|2|3] --deployment NAME [target flags] --secret-ref op://VAULT/ITEM/FIELD [--json]\n  Plan a deployment with bounded organizer agents without deploying.",
  deploy: "bimo deploy TEMPLATE --deployment NAME [target flags] --task-file FILE --secret-ref op://VAULT/ITEM/FIELD [--json]\n  Deploy a template as a bounded Docker fleet.",
  runs: "bimo runs --deployment NAME [target flags] [--json]\n  List recorded runs for a deployment from its durable state root.",
  status: "bimo status --deployment NAME [target flags] [--run ID] [--json]\n  Print the latest run state and last event for a deployment.",
  logs: "bimo logs --deployment NAME [target flags] [--run ID] [--json] [--follow]\n  Print a run log; --follow streams new events until interrupted.",
  doctor: "bimo doctor [--deployment NAME] [target flags] [--secret-ref op://VAULT/ITEM/FIELD] [--json]\n  Run deployment preflight checks and report pass, fail, or skip per check.",
  cancel: "bimo cancel --deployment NAME [target flags] [--run ID] [--json]\n  Send SIGTERM to the deployment's running controller or publisher container on the target; the in-container controller cancels active work and finishes the run durably.",
  publish: "bimo publish --deployment NAME --github-secret-ref op://VAULT/ITEM/FIELD [target flags] [--run ID] [--json]\n  Resume an interrupted pod publication from the durable publication.ready record; an already completed publication replays its receipt with zero new side effects.",
};

function usage() {
  return `usage:
  bimo list [--json]
  bimo targets [--json]
  bimo validate TEMPLATE [--json]
  bimo organize -p PROMPT [-n 1|2|3] --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] --secret-ref op://VAULT/ITEM/FIELD [--json]
  bimo -p PROMPT [-n 1|2|3] --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] --secret-ref op://VAULT/ITEM/FIELD [--json]
  bimo deploy TEMPLATE --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] --task-file FILE --secret-ref op://VAULT/ITEM/FIELD --public-url URL [--json]
  bimo deploy parallel-engineering-pod --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] --task-file FILE --secret-ref op://VAULT/ITEM/FIELD --github-secret-ref op://VAULT/ITEM/FIELD --repository ${POD_REPOSITORY} --base-sha SHA --target-branch main [--json]
  bimo logs --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] [--run ID] [--json] [--follow]
  bimo runs --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] [--json]
  bimo status --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] [--run ID] [--json]
  bimo doctor [--deployment NAME] [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] [--secret-ref op://VAULT/ITEM/FIELD] [--json]
  bimo cancel --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] [--run ID] [--json]
  bimo publish --deployment NAME [--target local | --target ssh --host HOST | --target proxmox-lxc --proxmox HOST --vmid ID] --github-secret-ref op://VAULT/ITEM/FIELD [--run ID] [--json]
  bimo help [COMMAND]
`;
}

async function runCommand(argv) {
  let [command, ...rest] = argv;
  if (command === "-p" || command === "--prompt") {
    command = "organize";
    rest = argv;
  }
  if (!command) {
    process.stdout.write(usage());
    process.exitCode = 1;
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = command === "help" ? rest[0] : undefined;
    if (topic !== undefined) {
      if (rest.length !== 1 || !Object.hasOwn(COMMAND_HELP, topic)) fail(`unknown command: ${topic}`);
      process.stdout.write(`${COMMAND_HELP[topic]}\n`);
      return;
    }
    process.stdout.write(usage());
    return;
  }
  if (command === "--version") {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  if (rest.includes("--help") && Object.hasOwn(COMMAND_HELP, command)) {
    process.stdout.write(`${COMMAND_HELP[command]}\n`);
    return;
  }
  if (command === "list") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("list accepts no positional arguments");
    exactOptions(options, ["json"]);
    const templates = await listTemplates();
    if (options.json) process.stdout.write(`${JSON.stringify({ templates })}\n`);
    else templates.forEach(template => process.stdout.write(`${template.name}\t${template.roles.join(" -> ")}\n`));
    return;
  }
  if (command === "targets") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("targets accepts no positional arguments");
    exactOptions(options, ["json"]);
    const targets = await listDeploymentTargets();
    if (options.json) process.stdout.write(`${JSON.stringify({ targets })}\n`);
    else targets.forEach(target => process.stdout.write([
      target.kind,
      target.availability,
      target.runtime,
      target.platform ?? "-",
      target.configuration,
    ].join("\t") + "\n"));
    return;
  }
  if (command === "validate") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    exactOptions(options, ["json"]);
    if (positional.length !== 1) fail("validate requires one template name");
    const loaded = await loadTemplate(positional[0]);
    const result = { valid: true, kind: loaded.kind, template: loaded.name, digest: loaded.digest };
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `valid template ${result.template} (${result.digest})\n`);
    return;
  }
  if (command === "organize") {
    const { positional, options } = parseOrganizerOptions(rest);
    if (positional.length) fail("organize accepts no positional arguments");
    await organizeRemote(options);
    return;
  }
  if (command === "deploy") {
    const { positional, options } = parseOptions(rest, { booleans: ["task-stdin", "json"] });
    if (positional.length !== 1) fail("deploy requires one template name");
    await deploy(positional[0], options);
    return;
  }
  if (command === "logs") {
    const { positional, options } = parseOptions(rest, { booleans: ["json", "follow"] });
    if (positional.length) fail("logs accepts no positional arguments");
    await remoteLogs(options);
    return;
  }
  if (command === "runs") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("runs accepts no positional arguments");
    await remoteRuns(options);
    return;
  }
  if (command === "status") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("status accepts no positional arguments");
    await remoteStatus(options);
    return;
  }
  if (command === "doctor") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("doctor accepts no positional arguments");
    await doctor(options);
    return;
  }
  if (command === "cancel") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("cancel accepts no positional arguments");
    await remoteCancel(options);
    return;
  }
  if (command === "publish") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("publish accepts no positional arguments");
    await remotePublish(options);
    return;
  }
  if (command === "internal-run") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-run accepts no positional arguments");
    await internalRun(options);
    return;
  }
  if (command === "internal-prepare") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-prepare accepts no positional arguments");
    await internalPrepare(options);
    return;
  }
  if (command === "internal-organize") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-organize accepts no positional arguments");
    await internalOrganize(options);
    return;
  }
  if (command === "internal-pod-run") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-pod-run accepts no positional arguments");
    await internalPodRun(options);
    return;
  }
  if (command === "internal-publish") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-publish accepts no positional arguments");
    await internalPublish(options);
    return;
  }
  if (command === "internal-publish-resume") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-publish-resume accepts no positional arguments");
    await internalPublishResume(options);
    return;
  }
  if (command === "internal-logs") {
    await internalLogs(rest);
    return;
  }
  if (command === "internal-runs") {
    await internalRuns(rest);
    return;
  }
  if (command === "internal-status") {
    await internalStatus(rest);
    return;
  }
  if (command === "internal-tail") {
    await internalTail(rest);
    return;
  }
  fail(`unknown command: ${command}`);
}

function errorReceiptMessage(error) {
  return (error instanceof Error && typeof error.message === "string" ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 500) || "command failed";
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await runCommand(argv);
  } catch (error) {
    if (argv.includes("--json")) {
      const command = argv[0] === "-p" || argv[0] === "--prompt" ? "organize" : argv[0] ?? null;
      process.stdout.write(`${JSON.stringify({
        ok: false,
        error: { command, message: errorReceiptMessage(error) },
      })}\n`);
    }
    throw error;
  }
}
