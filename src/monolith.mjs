import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { DockerRuntime } from "./docker-runtime.mjs";
import { loadWorkflow, runWorkflow } from "./workflow.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const templateRoot = path.join(packageRoot, "templates");
const DEFAULT_IMAGE = "monolith-workflow:0.2.0";
const DEFAULT_MODEL = "openrouter/deepseek/deepseek-v4-flash";
const IMAGE_TRANSFER_TIMEOUT_MS = 10 * 60 * 1_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SSH_TARGET = /^(?:[a-z_][a-z0-9_-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;
const SECRET_REF = /^op:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TEMPLATE_DIGEST = /^[a-f0-9]{64}$/;
const IMAGE_CONFIG_FIELDS = [
  "Entrypoint", "Cmd", "Env", "User", "WorkingDir", "ExposedPorts",
  "Volumes", "Labels", "Healthcheck", "StopSignal", "Shell",
];

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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) target.push(chunk);
      else child.kill("SIGTERM");
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) reject(new Error(`${command} timed out`));
      else if (bytes > maxOutputBytes) reject(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${result.stderr.trim().slice(0, 1_000)}`));
      else resolve(result);
    });
    if (input !== undefined) child.stdin.end(input);
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

async function listTemplates() {
  const entries = await readdir(templateRoot, { withFileTypes: true });
  const templates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const loaded = await loadWorkflow(entry.name, { templateRoot });
      templates.push({ name: loaded.workflow.name, roles: Object.keys(loaded.workflow.roles), maxSteps: loaded.workflow.maxSteps });
    } catch {}
  }
  return templates;
}

function target(options) {
  const proxmox = options.proxmox;
  const host = options.host;
  if (Boolean(proxmox) === Boolean(host)) fail("use exactly one of --host or --proxmox");
  const sshTarget = proxmox ?? host;
  if (!SSH_TARGET.test(sshTarget)) fail("SSH target contains unsupported characters");
  if (proxmox) {
    if (!/^\d{1,9}$/.test(options.vmid ?? "")) fail("--vmid must be numeric with --proxmox");
    return { sshTarget, prefix: ["pct", "exec", options.vmid, "--"] };
  }
  if (options.vmid) fail("--vmid is only valid with --proxmox");
  return { sshTarget, prefix: [] };
}

function sshArgs(remote, command) {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    remote.sshTarget,
    ...remote.prefix,
    ...command,
  ];
}

async function remoteExecute(remote, command, options) {
  return execute("ssh", sshArgs(remote, command), options);
}

function transferImage(remote, image, { timeoutMs = IMAGE_TRANSFER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const save = spawn("docker", ["save", image], { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
    const load = spawn("ssh", sshArgs(remote, ["docker", "load"]), { stdio: ["pipe", "pipe", "pipe"] });
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
  return `monolith-transfer:${imageId.slice(7, 19)}-${randomUUID().replaceAll("-", "")}`;
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

async function deploy(template, options) {
  exactOptions(options, [
    "deployment", "proxmox", "host", "vmid", "task-file", "task-stdin",
    "secret-ref", "account", "public-url", "port", "model", "image", "json",
  ]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment must use lowercase letters, numbers, and dashes");
  const remote = target(options);
  const loaded = await loadWorkflow(template, { templateRoot });
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const model = options.model ?? DEFAULT_MODEL;
  if (!/^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/.test(model)) fail("--model is invalid");
  const port = Number(options.port ?? 8080);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) fail("--port must be from 1024 to 65535");
  if (!options["public-url"]) fail("--public-url is required");
  const publicUrl = new URL(options["public-url"]);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) fail("--public-url is invalid");
  if (Boolean(options["task-file"]) === Boolean(options["task-stdin"])) fail("use exactly one of --task-file or --task-stdin");
  const task = options["task-file"]
    ? await readFile(path.resolve(options["task-file"]), "utf8")
    : await readStdin(64 * 1024);
  if (!task.trim() || Buffer.byteLength(task) > 64 * 1024) fail("task must contain 1 to 65536 bytes");
  if (!options["secret-ref"]) fail("--secret-ref is required");

  await execute("docker", ["build", "--platform", "linux/amd64", "--tag", image, packageRoot]);
  const imageResult = await execute("docker", ["image", "inspect", image]);
  const localImage = parseImageInspect(imageResult.stdout, "local");
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
    await transferImage(remote, transferTag);
    const remoteImageResult = await remoteExecute(remote, ["docker", "image", "inspect", transferTag]);
    const remoteImage = parseImageInspect(remoteImageResult.stdout, "remote");
    if (remoteImage.contentFingerprint !== localImage.contentFingerprint) {
      fail("transferred image content does not match the inspected local image");
    }
    await remoteExecute(remote, ["docker", "image", "tag", transferTag, image], { timeoutMs: 30_000 });

    const hostRoot = `/var/lib/monolith/deployments/${options.deployment}`;
    await remoteExecute(remote, ["mkdir", "-p", `${hostRoot}/runs`, `${hostRoot}/workspace`]);
    await remoteExecute(remote, ["chmod", "700", hostRoot, `${hostRoot}/runs`]);
    await remoteExecute(remote, ["chown", "1000:0", `${hostRoot}/workspace`]);
    await remoteExecute(remote, ["chmod", "770", `${hostRoot}/workspace`]);

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
    });
    const controllerName = `monolith-${options.deployment}-controller`;
    const result = await remoteExecute(remote, [
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
    ], { input: envelope, timeoutMs: (loaded.workflow.timeouts.workflowSeconds + 600) * 1_000, maxOutputBytes: 512 * 1024 });
    const response = JSON.parse(result.stdout.trim().split("\n").at(-1));
    if (options.json) process.stdout.write(`${JSON.stringify(response)}\n`);
    else process.stdout.write(`deployed ${response.template} as ${response.deployment}\nrun: ${response.runId}\nurl: ${response.url}\n`);
  } finally {
    if (remoteTransferStarted) {
      await remoteExecute(remote, ["docker", "image", "rm", "-f", transferTag], { timeoutMs: 30_000 }).catch(() => {});
    }
    await execute("docker", ["image", "rm", "-f", transferTag], { timeoutMs: 30_000 }).catch(() => {});
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

async function internalRun(options) {
  exactOptions(options, ["host-root"]);
  if (!/^\/var\/lib\/monolith\/deployments\/[a-z][a-z0-9-]{0,31}$/.test(options["host-root"] ?? "")) fail("--host-root is invalid");
  const raw = await readStdin(128 * 1024);
  let envelope;
  try { envelope = JSON.parse(raw); } catch { fail("invalid controller envelope"); }
  const expected = ["version", "template", "templateDigest", "deployment", "task", "key", "model", "image", "port", "publicUrl"].sort();
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).sort().some((key, index) => key !== expected[index])
      || Object.keys(envelope).length !== expected.length) {
    fail("controller envelope has unexpected fields");
  }
  if (envelope.version !== 1 || !NAME.test(envelope.deployment ?? "") || !NAME.test(envelope.template ?? "")
      || !TEMPLATE_DIGEST.test(envelope.templateDigest ?? "") || !SHA256.test(envelope.image ?? "")) {
    fail("controller envelope is invalid");
  }
  const loaded = await loadWorkflow(envelope.template, { templateRoot });
  if (loaded.templateDigest !== envelope.templateDigest) fail("controller template digest does not match the locally validated template");
  const runtime = new DockerRuntime({
    image: envelope.image,
    deployment: envelope.deployment,
    hostRoot: options["host-root"],
    key: envelope.key,
    model: envelope.model,
    port: envelope.port,
    publicUrl: envelope.publicUrl,
  });
  envelope.key = null;
  const result = await runController({ loaded, envelope, runtime });
  process.stdout.write(`${JSON.stringify({ ...result, template: envelope.template, deployment: envelope.deployment })}\n`);
}

async function remoteLogs(options) {
  exactOptions(options, ["deployment", "proxmox", "host", "vmid", "run", "image", "json"]);
  if (!NAME.test(options.deployment ?? "")) fail("--deployment is invalid");
  const runId = options.run ?? "latest";
  if (runId !== "latest" && !RUN_ID.test(runId)) fail("--run is invalid");
  const remote = target(options);
  const image = options.image ?? DEFAULT_IMAGE;
  if (!IMAGE.test(image)) fail("--image is invalid");
  const hostRoot = `/var/lib/monolith/deployments/${options.deployment}`;
  const result = await remoteExecute(remote, [
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

function usage() {
  return `usage:
  monolith list [--json]
  monolith validate TEMPLATE [--json]
  monolith deploy TEMPLATE --deployment NAME (--host HOST | --proxmox HOST --vmid ID) --task-file FILE --secret-ref op://VAULT/ITEM/FIELD --public-url URL [--json]
  monolith logs --deployment NAME (--host HOST | --proxmox HOST --vmid ID) [--run ID] [--json]
`;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(usage());
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
  if (command === "validate") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    exactOptions(options, ["json"]);
    if (positional.length !== 1) fail("validate requires one template name");
    const loaded = await loadWorkflow(positional[0], { templateRoot });
    const result = { valid: true, template: loaded.workflow.name, digest: loaded.digest };
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `valid template ${result.template} (${result.digest})\n`);
    return;
  }
  if (command === "deploy") {
    const { positional, options } = parseOptions(rest, { booleans: ["task-stdin", "json"] });
    if (positional.length !== 1) fail("deploy requires one template name");
    await deploy(positional[0], options);
    return;
  }
  if (command === "logs") {
    const { positional, options } = parseOptions(rest, { booleans: ["json"] });
    if (positional.length) fail("logs accepts no positional arguments");
    await remoteLogs(options);
    return;
  }
  if (command === "internal-run") {
    const { positional, options } = parseOptions(rest);
    if (positional.length) fail("internal-run accepts no positional arguments");
    await internalRun(options);
    return;
  }
  if (command === "internal-logs") {
    await internalLogs(rest);
    return;
  }
  fail(`unknown command: ${command}`);
}
