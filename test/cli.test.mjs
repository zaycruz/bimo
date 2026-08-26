import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

import { runController, runPodController } from "../src/bimo.mjs";
import { loadPodTemplate } from "../src/pod-contract.mjs";
import { loadWorkflow } from "../src/workflow.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "bin", "bimo");

async function run(...args) {
  const result = await execute(process.execPath, [cli, ...args], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

function invoke(args, { input = "", env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

const LOCAL_IMAGE_ID = `sha256:${"a".repeat(64)}`;
const REMOTE_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const POD_BASE_SHA = "1".repeat(40);
const POD_CANDIDATE_SHA = "2".repeat(40);
const BASE_CONFIG = {
  Entrypoint: ["/app/bin/bimo"],
  Env: ["NODE_ENV=production"],
  WorkingDir: "/app",
  Labels: { "dev.ascii.bimo": "workflow" },
};
const REORDERED_CONFIG = {
  Labels: { "dev.ascii.bimo": "workflow" },
  WorkingDir: "/app",
  Env: ["NODE_ENV=production"],
  Entrypoint: ["/app/bin/bimo"],
  Cmd: null,
  Volumes: null,
  AttachStderr: false,
  AttachStdin: false,
  AttachStdout: false,
  Domainname: "",
  Hostname: "",
  Image: "",
  OnBuild: null,
  OpenStdin: false,
  StdinOnce: false,
  Tty: false,
};
const BASE_LAYERS = [`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`];

function imageInspect(imageId, {
  architecture = "amd64",
  config = BASE_CONFIG,
  layers = BASE_LAYERS,
} = {}) {
  return JSON.stringify([{
    Id: imageId,
    Architecture: architecture,
    Os: "linux",
    Config: config,
    RootFS: { Type: "layers", Layers: layers },
  }]);
}

async function fakeDeployTools(t, {
  remoteImageId = REMOTE_IMAGE_ID,
  remoteConfig = REORDERED_CONFIG,
  remoteLayers = BASE_LAYERS,
  remotePlatform = "linux/amd64",
  localArchitecture = "amd64",
  controller = "conflict",
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "bimo-cli-test-"));
  const logFile = path.join(directory, "commands.jsonl");
  const taskFile = path.join(directory, "task.txt");
  await writeFile(logFile, "");
  await writeFile(taskFile, "Build the test application.\n");

const docker = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BIMO_TEST_LOG, JSON.stringify({ tool: "docker", args }) + "\\n");
const log = value => fs.appendFileSync(process.env.BIMO_TEST_LOG, JSON.stringify(value) + "\\n");
if (args[0] === "context" && args[1] === "inspect") process.stdout.write(process.env.BIMO_TEST_DOCKER_ENDPOINT + "\\n");
else if (args[0] === "version") process.stdout.write("linux/arm64\\n");
else if (args[0] === "image" && args[1] === "inspect") process.stdout.write(process.env.BIMO_TEST_LOCAL_INSPECT + "\\n");
else if (args[0] === "save") process.stdout.write("fake-image-archive");
else if (args[0] === "run") {
  const internalCommand = args.find(value => value === "internal-prepare" || value === "internal-run");
  if (internalCommand === "internal-prepare") process.stdout.write("prepared\\n");
  else {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      const envelope = JSON.parse(raw);
      log({
        tool: "local-controller-envelope",
        fields: Object.keys(envelope).sort(),
        templateDigest: envelope.templateDigest,
        image: envelope.image,
      });
      process.stdout.write(JSON.stringify({
        template: envelope.template,
        deployment: envelope.deployment,
        runId: "local-test-run",
        url: envelope.publicUrl,
      }) + "\\n");
    });
  }
}
`;
  const ssh = `#!/usr/bin/env node
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2);
const command = args.slice(5);
const dockerIndex = command.indexOf("docker");
const runtimeCommand = dockerIndex === -1 ? command : command.slice(dockerIndex);
const log = value => fs.appendFileSync(process.env.BIMO_TEST_LOG, JSON.stringify(value) + "\\n");
log({ tool: "ssh", args, command });
if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "version") {
  process.stdout.write(process.env.BIMO_TEST_REMOTE_PLATFORM + "\\n");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "load") {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write("Loaded image\\n"));
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "image" && runtimeCommand[2] === "inspect") {
  process.stdout.write(process.env.BIMO_TEST_REMOTE_INSPECT + "\\n");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "run"
    && runtimeCommand.includes("internal-logs")) {
  process.stdout.write("");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "run") {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { raw += chunk; });
  process.stdin.on("end", () => {
    const envelope = JSON.parse(raw);
    log({
      tool: "controller-envelope",
      fields: Object.keys(envelope).sort(),
      templateDigest: envelope.templateDigest,
      image: envelope.image,
    });
    const internalCommand = command.find(value => value === "internal-pod-run"
      || value === "internal-publish" || value === "internal-organize");
    if (process.env.BIMO_TEST_CONTROLLER === "conflict") {
      process.stderr.write("Conflict: controller name is already in use\\n");
      process.exitCode = 125;
    } else if (process.env.BIMO_TEST_CONTROLLER === "pod-success" && internalCommand === "internal-pod-run") {
      log({
        tool: "pod-compute-envelope",
        fields: Object.keys(envelope).sort(),
        runId: envelope.runId,
        repository: envelope.repository,
        baseSha: envelope.baseSha,
        targetBranch: envelope.targetBranch,
      });
      process.stdout.write(JSON.stringify({
        status: "ready",
        runId: envelope.runId,
        baseSha: envelope.baseSha,
        candidateSha: process.env.BIMO_TEST_POD_CANDIDATE,
        branch: "bimo/" + envelope.runId,
      }) + "\\n");
    } else if (process.env.BIMO_TEST_CONTROLLER === "pod-success" && internalCommand === "internal-publish") {
      log({
        tool: "pod-publish-envelope",
        fields: Object.keys(envelope).sort(),
        runId: envelope.runId,
        repository: envelope.repository,
        baseSha: envelope.baseSha,
        candidateSha: envelope.candidateSha,
        targetBranch: envelope.targetBranch,
        headBranch: envelope.headBranch,
      });
      process.stdout.write(JSON.stringify({
        status: "completed",
        runId: envelope.runId,
        repository: envelope.repository,
        targetBranch: envelope.targetBranch,
        baseSha: envelope.baseSha,
        candidateSha: envelope.candidateSha,
        headBranch: envelope.headBranch,
        publication: {
          number: 42,
          url: "https://github.com/zaycruz/bimo/pull/42",
          draft: true,
          created: true,
          headBranch: envelope.headBranch,
          headSha: envelope.candidateSha,
          targetBranch: envelope.targetBranch,
          baseSha: envelope.baseSha,
        },
      }) + "\\n");
    } else if (process.env.BIMO_TEST_CONTROLLER === "organize-success"
      && internalCommand === "internal-organize") {
      const template = process.env.BIMO_TEST_ORGANIZER_TEMPLATE;
      const templateDigest = process.env.BIMO_TEST_ORGANIZER_DIGEST;
      const acceptedOptions = JSON.parse(process.env.BIMO_TEST_ORGANIZER_OPTIONS);
      log({
        tool: "organizer-envelope",
        fields: Object.keys(envelope).sort(),
        version: envelope.version,
        deployment: envelope.deployment,
        runId: envelope.runId,
        prompt: envelope.prompt,
        agents: envelope.agents,
        model: envelope.model,
        image: envelope.image,
      });
      const vote = { template, templateDigest, reason: "The installed workflow matches the assignment." };
      process.stdout.write(JSON.stringify({
        version: 1,
        status: "planned",
        promptSha256: createHash("sha256").update(envelope.prompt, "utf8").digest("hex"),
        template,
        templateDigest,
        agents: envelope.agents,
        votes: Array.from({ length: envelope.agents }, () => vote),
        handoff: { template, templateDigest, acceptedOptions },
        runId: envelope.runId,
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        template: envelope.template,
        deployment: envelope.deployment,
        runId: "test-run",
        url: envelope.publicUrl,
      }) + "\\n");
    }
  });
}
`;
  const op = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BIMO_TEST_LOG, JSON.stringify({ tool: "op", reference: args[1] }) + "\\n");
if (args[1].endsWith("/github")) process.stdout.write("github_pat_${"g".repeat(64)}\\n");
else process.stdout.write("sk-or-v1-${"k".repeat(32)}\\n");
`;
  await Promise.all([
    writeFile(path.join(directory, "docker"), docker, { mode: 0o755 }),
    writeFile(path.join(directory, "ssh"), ssh, { mode: 0o755 }),
    writeFile(path.join(directory, "op"), op, { mode: 0o755 }),
  ]);
  t.after(() => rm(directory, { recursive: true, force: true }));

  return {
    taskFile,
    logFile,
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      DOCKER_HOST: "",
      BIMO_TEST_LOG: logFile,
      BIMO_TEST_DOCKER_ENDPOINT: "unix:///tmp/bimo-test-docker.sock",
      BIMO_TEST_LOCAL_INSPECT: imageInspect(LOCAL_IMAGE_ID, { architecture: localArchitecture }),
      BIMO_TEST_REMOTE_INSPECT: imageInspect(remoteImageId, {
        architecture: remotePlatform.split("/")[1],
        config: remoteConfig,
        layers: remoteLayers,
      }),
      BIMO_TEST_REMOTE_PLATFORM: remotePlatform,
      BIMO_TEST_CONTROLLER: controller,
      BIMO_TEST_POD_CANDIDATE: POD_CANDIDATE_SHA,
      BIMO_TEST_ORGANIZER_TEMPLATE: "react-app",
      BIMO_TEST_ORGANIZER_DIGEST: (await loadWorkflow("react-app", {
        templateRoot: path.join(root, "templates"),
      })).templateDigest,
      BIMO_TEST_ORGANIZER_OPTIONS: JSON.stringify([
        "--deployment", "--target", "--host", "--proxmox", "--vmid", "--task-file", "--task-stdin",
        "--secret-ref", "--public-url", "--port",
      ]),
    },
  };
}

async function readCommandLog(logFile) {
  return (await readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function deployArgs(taskFile) {
  return [
    "deploy", "react-app",
    "--deployment", "fleet-demo",
    "--host", "example.invalid",
    "--task-file", taskFile,
    "--secret-ref", "op://Test/Bimo/key",
    "--public-url", "http://example.invalid:8080",
    "--image", "bimo-workflow:test",
    "--json",
  ];
}

function podDeployArgs(taskFile) {
  return [
    "deploy", "parallel-engineering-pod",
    "--deployment", "pod-demo",
    "--host", "example.invalid",
    "--task-file", taskFile,
    "--secret-ref", "op://Test/Bimo/openrouter",
    "--github-secret-ref", "op://Test/Bimo publisher/github",
    "--repository", "https://github.com/zaycruz/bimo.git",
    "--base-sha", POD_BASE_SHA,
    "--target-branch", "main",
    "--image", "bimo-workflow:test",
    "--json",
  ];
}

function organizeArgs(prompt, agents) {
  return [
    "organize",
    "--prompt", prompt,
    ...(agents === undefined ? [] : ["--agents", String(agents)]),
    "--deployment", "organizer-demo",
    "--host", "example.invalid",
    "--secret-ref", "op://Test/Bimo/openrouter",
    "--image", "bimo-workflow:test",
    "--json",
  ];
}

test("the installed CLI lists the packaged workflows and fixed engineering pod", async () => {
  const result = await run("list", "--json");
  assert.deepEqual(result.templates.map(template => template.name), [
    "parallel-engineering-pod",
    "react-app",
    "react-solo",
  ]);
  assert.ok(result.templates.some(template => (
    template.name === "parallel-engineering-pod"
      && template.kind === "engineering-pod"
      && template.maxAttempts === 3
      && template.roles.join(",") === "planner,engineering-a,engineering-b,qa-tests,checker,qa,testing"
  )));
  assert.ok(result.templates.some(template => (
    template.name === "react-app"
      && template.maxSteps === 15
      && template.roles.join(",") === "engineering,qa,testing"
  )));
  assert.ok(result.templates.some(template => (
    template.name === "react-solo"
      && template.maxSteps === 1
      && template.roles.join(",") === "engineering"
  )));
});

test("targets reports the working local Docker adapter and the two on-demand access adapters", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke(["targets", "--json"], { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    targets: [
      {
        kind: "local",
        runtime: "docker",
        configuration: "automatic",
        availability: "ready",
        platform: "linux/arm64",
      },
      {
        kind: "ssh",
        runtime: "docker",
        configuration: "--host HOST",
        availability: "on-demand",
      },
      {
        kind: "proxmox-lxc",
        runtime: "docker",
        configuration: "--proxmox HOST --vmid ID",
        availability: "on-demand",
      },
    ],
  });
  const commands = await readCommandLog(tools.logFile);
  assert.deepEqual(commands, [
    {
      tool: "docker",
      args: ["context", "inspect", "--format", "{{(index .Endpoints \"docker\").Host}}"],
    },
    {
      tool: "docker",
      args: ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
    },
  ]);
});

test("targets fails closed for non-local Docker endpoints and DOCKER_HOST overrides", async t => {
  const tools = await fakeDeployTools(t);
  const remoteEndpoint = await invoke(["targets", "--json"], {
    env: { ...tools.env, BIMO_TEST_DOCKER_ENDPOINT: "tcp://docker.example:2376" },
  });
  assert.equal(remoteEndpoint.code, 0, remoteEndpoint.stderr);
  assert.deepEqual(JSON.parse(remoteEndpoint.stdout).targets[0], {
    kind: "local",
    runtime: "docker",
    configuration: "automatic",
    availability: "unavailable",
    reason: "Docker endpoint is not a local Unix socket",
  });

  const overridden = await invoke(["targets", "--json"], {
    env: { ...tools.env, DOCKER_HOST: "unix:///tmp/untrusted-docker.sock" },
  });
  assert.equal(overridden.code, 0, overridden.stderr);
  assert.equal(JSON.parse(overridden.stdout).targets[0].reason,
    "DOCKER_HOST overrides are not accepted for local targets");
});

test("deploy defaults to local Docker without SSH or image transfer", async t => {
  const tools = await fakeDeployTools(t, {
    controller: "workflow-success",
    localArchitecture: "arm64",
  });
  const args = deployArgs(tools.taskFile).filter((value, index, all) => (
    value !== "--host" && all[index - 1] !== "--host"
  ));
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    template: "react-app",
    deployment: "fleet-demo",
    runId: "local-test-run",
    url: "http://example.invalid:8080",
  });

  const entries = await readCommandLog(tools.logFile);
  assert.equal(entries.some(entry => entry.tool === "ssh"), false);
  const docker = entries.filter(entry => entry.tool === "docker").map(entry => entry.args);
  assert.ok(docker.some(command => command[0] === "build"
    && command.includes("--tag") && !command.includes("--platform")));
  assert.equal(docker.some(command => command[0] === "save"), false);
  assert.equal(docker.some(command => command[0] === "image" && command[1] === "tag"), false);

  const hostRoot = path.join(os.homedir(), ".local", "share", "bimo", "deployments", "fleet-demo");
  const prepare = docker.find(command => command.includes("internal-prepare"));
  const controller = docker.find(command => command.includes("internal-run"));
  assert.ok(prepare);
  assert.ok(controller);
  assert.ok(prepare.includes(`${hostRoot}:/deployment:rw`));
  assert.ok(controller.includes(`${hostRoot}/runs:/state:rw`));
  assert.ok(controller.includes(`${hostRoot}/workspace:/workspace:rw`));
  assert.equal(controller[controller.indexOf("--local-home") + 1], os.homedir());
  assert.equal(controller[controller.indexOf("internal-run") - 1], LOCAL_IMAGE_ID);
  const envelope = entries.find(entry => entry.tool === "local-controller-envelope");
  assert.equal(envelope.image, LOCAL_IMAGE_ID);
});

test("explicit SSH target builds for the target daemon architecture", async t => {
  const tools = await fakeDeployTools(t, {
    controller: "workflow-success",
    remotePlatform: "linux/arm64",
    localArchitecture: "arm64",
  });
  const args = deployArgs(tools.taskFile);
  args.splice(args.indexOf("--host"), 0, "--target", "ssh");
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  const entries = await readCommandLog(tools.logFile);
  const build = entries.find(entry => entry.tool === "docker" && entry.args[0] === "build");
  assert.ok(build);
  assert.equal(build.args[build.args.indexOf("--platform") + 1], "linux/arm64");
  assert.ok(entries.some(entry => entry.tool === "ssh"
    && entry.command.join(" ").includes("docker version --format")));
});

test("explicit Proxmox LXC target wraps Docker with pct exec", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke([
    "logs",
    "--deployment", "fleet-demo",
    "--target", "proxmox-lxc",
    "--proxmox", "root@pve-05",
    "--vmid", "212",
    "--image", "bimo-workflow:test",
  ], { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  const entries = await readCommandLog(tools.logFile);
  const invocation = entries.find(entry => entry.tool === "ssh");
  assert.deepEqual(invocation.command.slice(0, 5), ["pct", "exec", "212", "--", "docker"]);
  assert.ok(invocation.command.includes("internal-logs"));
});

test("the installed CLI validates the packaged React workflow", async () => {
  const result = await run("validate", "react-app", "--json");
  assert.equal(result.valid, true);
  assert.equal(result.template, "react-app");
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test("the installed CLI validates the packaged one-role workflow", async () => {
  const result = await run("validate", "react-solo", "--json");
  assert.equal(result.valid, true);
  assert.equal(result.template, "react-solo");
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test("the installed CLI validates the packaged fixed engineering pod", async () => {
  const result = await run("validate", "parallel-engineering-pod", "--json");
  assert.equal(result.valid, true);
  assert.equal(result.kind, "engineering-pod");
  assert.equal(result.template, "parallel-engineering-pod");
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test("the package ships its runnable how-to and example prompts", async () => {
  const packed = await execute("npm", ["pack", "--json", "--dry-run"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const [manifest] = JSON.parse(packed.stdout);
  const files = new Set(manifest.files.map(file => file.path));
  for (const expected of [
    "README.md",
    "docs/organize.md",
    "docs/targets.md",
    "examples/fleet-demo.md",
    "examples/solo-demo.md",
    "examples/prompts/small-app.md",
    "examples/prompts/parallel-engineering-pod.md",
    "examples/pod-assignment.md",
  ]) {
    assert.ok(files.has(expected), `package is missing ${expected}`);
  }
});

test("organize transfers content-verified image without retagging and runs one exact sandboxed controller", async t => {
  const prompt = "Build a small status page with a readable health indicator.";
  const tools = await fakeDeployTools(t, { controller: "organize-success" });
  const result = await invoke(organizeArgs(prompt, 2), { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");

  const response = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(response).sort(), [
    "agents", "handoff", "promptSha256", "runId", "status", "template", "templateDigest", "version", "votes",
  ]);
  assert.equal(response.version, 1);
  assert.equal(response.status, "planned");
  assert.equal(response.template, "react-app");
  assert.equal(response.templateDigest, tools.env.BIMO_TEST_ORGANIZER_DIGEST);
  assert.equal(response.agents, 2);
  assert.equal(response.promptSha256, createHash("sha256").update(prompt, "utf8").digest("hex"));
  assert.equal(response.votes.length, 2);
  assert.ok(response.votes.every(vote => (
    Object.keys(vote).sort().join(",") === "reason,template,templateDigest"
      && vote.template === response.template
      && vote.templateDigest === response.templateDigest
  )));
  assert.deepEqual(response.handoff, {
    template: "react-app",
    templateDigest: response.templateDigest,
    acceptedOptions: [
      "--deployment", "--target", "--host", "--proxmox", "--vmid", "--task-file", "--task-stdin",
      "--secret-ref", "--public-url", "--port",
    ],
  });

  const entries = await readCommandLog(tools.logFile);
  const localCommands = entries.filter(entry => entry.tool === "docker").map(entry => entry.args);
  const remoteEntries = entries.filter(entry => entry.tool === "ssh");
  const remoteCommands = remoteEntries.map(entry => entry.command);
  const localTag = localCommands.find(command => command[0] === "image" && command[1] === "tag");
  assert.ok(localTag);
  assert.equal(localTag[2], LOCAL_IMAGE_ID);
  assert.match(localTag[3], /^bimo-transfer:[a-f0-9]{12}-[a-f0-9]{32}$/);
  const transferTag = localTag[3];
  const remoteInspect = remoteCommands.find(command => (
    command[0] === "docker" && command[1] === "image" && command[2] === "inspect"
  ));
  assert.deepEqual(remoteInspect, ["docker", "image", "inspect", transferTag]);
  const remoteRun = remoteCommands.find(command => command[0] === "docker" && command[1] === "run");
  const hostRoot = "/var/lib/bimo/deployments/organizer-demo";
  assert.deepEqual(remoteRun, [
    "docker", "run", "--rm", "-i",
    "--name", "bimo-organizer-demo-controller",
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
    REMOTE_IMAGE_ID,
    "internal-organize", "--host-root", hostRoot,
  ]);
  assert.equal(remoteCommands.some(command => (
    command[0] === "docker" && command[1] === "image" && command[2] === "tag"
  )), false);
  assert.ok(remoteCommands.some(command => command[0] === "mkdir"
    && command.includes(`${hostRoot}/runs`) && command.includes(`${hostRoot}/worktrees`)));
  assert.ok(remoteCommands.some(command => command[0] === "chmod"
    && command.includes(hostRoot) && command.includes(`${hostRoot}/runs`)
    && command.includes(`${hostRoot}/worktrees`)));
  for (const mount of [
    "/var/run/docker.sock:/var/run/docker.sock:rw",
    `${hostRoot}/runs:/state:rw`,
    `${hostRoot}/worktrees:/worktrees:rw`,
  ]) assert.ok(remoteRun.includes(mount), `organizer controller missing ${mount}`);
  assert.equal(remoteRun.includes("bootstrap"), false);
  assert.equal(remoteCommands.some(command => command.some(value => (
    value === "internal-run" || value === "internal-pod-run" || value === "internal-publish"
      || value === "github" || value === "app"
  ))), false);

  const organizerEnvelope = entries.find(entry => entry.tool === "organizer-envelope");
  assert.deepEqual(organizerEnvelope.fields, [
    "agents", "deployment", "image", "key", "model", "prompt", "runId", "version",
  ]);
  assert.equal(organizerEnvelope.deployment, "organizer-demo");
  assert.equal(organizerEnvelope.agents, 2);
  assert.equal(organizerEnvelope.prompt, prompt);
  assert.equal(organizerEnvelope.image, REMOTE_IMAGE_ID);
  assert.equal(organizerEnvelope.runId, response.runId);
  const serializedLog = JSON.stringify(entries);
  assert.equal(serializedLog.includes(`sk-or-v1-${"k".repeat(32)}`), false);

  const remoteCleanup = remoteCommands.filter(command => command.join(" ") === `docker image rm -f ${transferTag}`);
  const localCleanup = localCommands.filter(command => command.join(" ") === `image rm -f ${transferTag}`);
  assert.equal(remoteCleanup.length, 1);
  assert.equal(localCleanup.length, 1);
  assert.ok(remoteCommands.indexOf(remoteCleanup[0]) > remoteCommands.indexOf(remoteRun));
  assert.ok(localCommands.indexOf(localCleanup[0]) > localCommands.findIndex(command => command[0] === "save"));
});

test("organize explicit and root prompt aliases preserve short/long option parity", async t => {
  const prompt = "Build a small status page with a readable health indicator.";
  const tools = await fakeDeployTools(t, { controller: "organize-success" });
  const variants = [
    organizeArgs(prompt, 2),
    ["organize", "-p", prompt, "-n", "2", "--deployment", "organizer-demo", "--host", "example.invalid",
      "--secret-ref", "op://Test/Bimo/openrouter", "--image", "bimo-workflow:test", "--json"],
    ["-p", prompt, "--agents", "2", "--deployment", "organizer-demo", "--host", "example.invalid",
      "--secret-ref", "op://Test/Bimo/openrouter", "--image", "bimo-workflow:test", "--json"],
  ];
  const responses = [];
  for (const args of variants) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    responses.push(JSON.parse(result.stdout));
  }
  const comparable = ({ runId, ...response }) => response;
  assert.deepEqual(comparable(responses[1]), comparable(responses[0]));
  assert.deepEqual(comparable(responses[2]), comparable(responses[0]));

  const literalOptionPrompt = await invoke([
    "organize", "--prompt", "-n", "--agents", "1",
    "--deployment", "organizer-demo", "--host", "example.invalid",
    "--secret-ref", "op://Test/Bimo/openrouter",
    "--image", "bimo-workflow:test", "--json",
  ], { env: tools.env });
  assert.equal(literalOptionPrompt.code, 0, literalOptionPrompt.stderr);
  assert.equal(
    JSON.parse(literalOptionPrompt.stdout).promptSha256,
    createHash("sha256").update("-n", "utf8").digest("hex"),
  );
});

test("organize defaults to one agent and accepts the 1-to-3 agent bounds", async t => {
  const prompt = "Build a small status page with a readable health indicator.";
  const tools = await fakeDeployTools(t, { controller: "organize-success" });
  for (const [args, expected] of [[organizeArgs(prompt), 1], [organizeArgs(prompt, 1), 1], [organizeArgs(prompt, 3), 3]]) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).agents, expected);
  }
});

test("organize rejects missing, empty, and unsafe prompts before Docker", async t => {
  const tools = await fakeDeployTools(t);
  const common = [
    "organize", "--deployment", "organizer-demo", "--host", "example.invalid",
    "--secret-ref", "op://Test/Bimo/openrouter", "--image", "bimo-workflow:test", "--json",
  ];
  for (const [promptArgs, pattern] of [
    [[], /prompt must be a non-empty string/],
    [["--prompt", ""], /prompt must be a non-empty string/],
    [["--prompt", " \t\n"], /prompt must be a non-empty string/],
    [["--prompt", "unsafe\u0007prompt"], /prompt contains unsafe control characters/],
  ]) {
    const result = await invoke([...common.slice(0, 1), ...promptArgs, ...common.slice(1)], { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("organize rejects out-of-bounds, duplicate, and unknown options before Docker", async t => {
  const tools = await fakeDeployTools(t);
  const valid = organizeArgs("Build a small status page.");
  for (const [args, pattern] of [
    [organizeArgs("Build a small status page.", 0), /--agents must be an integer from 1 to 3/],
    [organizeArgs("Build a small status page.", 4), /--agents must be an integer from 1 to 3/],
    [organizeArgs("Build a small status page.", 1.5), /--agents must be an integer from 1 to 3/],
    [[...valid.slice(0, 3), "--prompt", "another", ...valid.slice(3)], /duplicate option: --prompt/],
    [[...valid, "--json"], /duplicate option: --json/],
    [[...valid, "--unknown", "value"], /unknown option: --unknown/],
  ]) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("internal-organize rejects exact envelope violations before Docker", async t => {
  const tools = await fakeDeployTools(t);
  const base = {
    version: 1,
    deployment: "organizer-demo",
    runId: "organizer-run-1",
    prompt: "Build a small status page.",
    agents: 1,
    key: `sk-or-v1-${"k".repeat(32)}`,
    model: "openrouter/deepseek/deepseek-v4-flash",
    image: LOCAL_IMAGE_ID,
  };
  for (const [envelope, pattern] of [
    [{ ...base, extra: true }, /invalid shape|exactly/],
    [{ ...base, image: undefined }, /invalid shape|exactly/],
    [{ ...base, agents: 0 }, /controller envelope is invalid/],
  ]) {
    if (envelope.image === undefined) delete envelope.image;
    const result = await invoke([
      "internal-organize", "--host-root", "/var/lib/bimo/deployments/organizer-demo",
    ], { input: JSON.stringify(envelope), env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("logs rejects remote-shell syntax before SSH", async () => {
  for (const runId of ["latest; id", "$(id)", "latest value", "latest\nid"]) {
    await assert.rejects(
      execute(process.execPath, [
        cli,
        "logs",
        "--deployment", "fleet-demo",
        "--host", "example.invalid",
        "--run", runId,
        "--json",
      ], {
        cwd: root,
        maxBuffer: 1024 * 1024,
        timeout: 2_000,
      }),
      error => {
        assert.match(error.stderr, /--run is invalid/);
        return true;
      },
    );
  }
});

test("internal-run rejects an invalid or mismatched template digest before Docker", async () => {
  const envelope = {
    version: 1,
    template: "react-app",
    templateDigest: "0".repeat(64),
    deployment: "fleet-demo",
    task: "Build the application.",
    key: `sk-or-v1-${"k".repeat(32)}`,
    model: "openrouter/deepseek/deepseek-v4-flash",
    image: LOCAL_IMAGE_ID,
    port: 8080,
    publicUrl: "http://example.invalid:8080",
  };
  const mismatch = await invoke([
    "internal-run",
    "--host-root", "/var/lib/bimo/deployments/fleet-demo",
  ], { input: JSON.stringify(envelope) });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /template digest does not match/);

  envelope.templateDigest = "$(id)";
  const injection = await invoke([
    "internal-run",
    "--host-root", "/var/lib/bimo/deployments/fleet-demo",
  ], { input: JSON.stringify(envelope) });
  assert.equal(injection.code, 1);
  assert.match(injection.stderr, /controller envelope is invalid/);
});

test("internal-pod-run rejects a mismatched packaged template before Git or Docker", async () => {
  const envelope = {
    version: 1,
    template: "parallel-engineering-pod",
    templateDigest: "0".repeat(64),
    deployment: "pod-demo",
    task: "Implement the fixed pod.",
    key: `sk-or-v1-${"k".repeat(32)}`,
    model: "openrouter/deepseek/deepseek-v4-flash",
    image: LOCAL_IMAGE_ID,
    repository: "https://github.com/zaycruz/bimo.git",
    baseSha: POD_BASE_SHA,
    targetBranch: "main",
    runId: "pod-run-1",
  };
  const result = await invoke([
    "internal-pod-run",
    "--host-root", "/var/lib/bimo/deployments/pod-demo",
  ], { input: JSON.stringify(envelope) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /template digest does not match/);
});

test("internal-publish rejects publication bindings outside the fixed repository", async () => {
  const result = await invoke(["internal-publish"], {
    input: JSON.stringify({
      version: 1,
      runId: "pod-run-1",
      repository: "https://github.com/attacker/repository.git",
      targetBranch: "main",
      baseSha: POD_BASE_SHA,
      candidateSha: POD_CANDIDATE_SHA,
      headBranch: "bimo/pod-run-1",
      token: `github_pat_${"g".repeat(64)}`,
    }),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /publisher envelope is invalid/);
});

test("deploy rejects image shell syntax before local execution", async () => {
  for (const image of ["bimo:latest;id", "$(id)", "bimo:latest\nid"]) {
    await assert.rejects(
      execute(process.execPath, [
        cli,
        "deploy", "react-app",
        "--deployment", "fleet-demo",
        "--host", "example.invalid",
        "--image", image,
      ], {
        cwd: root,
        maxBuffer: 1024 * 1024,
        timeout: 2_000,
      }),
      error => {
        assert.match(error.stderr, /--image is invalid/);
        return true;
      },
    );
  }
});

test("deploy rejects changed transferred image content before remote retag or secret resolution", async t => {
  const cases = [
    ["RootFS", { remoteLayers: [`sha256:${"e".repeat(64)}`] }],
    ["Config", { remoteConfig: { ...BASE_CONFIG, Cmd: ["changed-command"] } }],
  ];
  for (const [field, overrides] of cases) {
    await t.test(field, async child => {
      const tools = await fakeDeployTools(child, overrides);
      const result = await invoke(deployArgs(tools.taskFile), { env: tools.env });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /transferred image content does not match/);

      const commands = await readCommandLog(tools.logFile);
      const localCommands = commands.filter(entry => entry.tool === "docker").map(entry => entry.args);
      const remoteCommands = commands.filter(entry => entry.tool === "ssh").map(entry => entry.command);
      const transferTag = localCommands.find(command => command[0] === "image" && command[1] === "tag")?.[3];
      assert.match(transferTag, /^bimo-transfer:[a-f0-9]{12}-[a-f0-9]{32}$/);
      assert.ok(remoteCommands.some(command => command[0] === "docker" && command[1] === "load"));
      assert.ok(remoteCommands.some(command => command[0] === "docker" && command[1] === "image" && command[2] === "inspect"));
      assert.equal(remoteCommands.some(command => command[0] === "docker" && command[1] === "image" && command[2] === "tag"), false);
      assert.equal(remoteCommands.some(command => command[0] === "docker" && command[1] === "run"), false);
      assert.equal(commands.some(entry => entry.tool === "op"), false);
      assert.ok(remoteCommands.some(command => command.join(" ") === `docker image rm -f ${transferTag}`));
      assert.ok(localCommands.some(command => command.join(" ") === `image rm -f ${transferTag}`));
    });
  }
});

test("deploy accepts daemon-normalized Config, anchors transfer, and fails closed on an active controller", async t => {
  const tools = await fakeDeployTools(t);
  const validated = await run("validate", "react-app", "--json");
  const result = await invoke(deployArgs(tools.taskFile), { env: tools.env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /controller name is already in use/);

  const commands = await readCommandLog(tools.logFile);
  const localCommands = commands.filter(entry => entry.tool === "docker").map(entry => entry.args);
  const remoteEntries = commands.filter(entry => entry.tool === "ssh");
  const remoteCommands = remoteEntries.map(entry => entry.command);
  const localTag = localCommands.find(command => command[0] === "image" && command[1] === "tag");
  assert.ok(localTag);
  assert.equal(localTag[2], LOCAL_IMAGE_ID);
  assert.match(localTag[3], /^bimo-transfer:[a-f0-9]{12}-[a-f0-9]{32}$/);
  const transferTag = localTag[3];
  assert.ok(localCommands.some(command => command[0] === "save" && command[1] === transferTag));

  const remoteInspectIndex = remoteCommands.findIndex(command => (
    command[0] === "docker" && command[1] === "image" && command[2] === "inspect" && command.at(-1) === transferTag
  ));
  const remoteTagIndex = remoteCommands.findIndex(command => (
    command[0] === "docker" && command[1] === "image" && command[2] === "tag" && command[3] === transferTag
  ));
  assert.ok(remoteInspectIndex >= 0);
  assert.ok(remoteTagIndex > remoteInspectIndex);

  const controllerRun = remoteCommands.find(command => command[0] === "docker" && command[1] === "run");
  assert.ok(controllerRun);
  assert.notEqual(LOCAL_IMAGE_ID, REMOTE_IMAGE_ID);
  assert.equal(controllerRun[controllerRun.indexOf("internal-run") - 1], REMOTE_IMAGE_ID);
  assert.equal(remoteCommands.some(command => (
    command[0] === "docker" && command[1] === "rm" && command.includes("bimo-fleet-demo-controller")
  )), false);
  assert.ok(remoteEntries.every(entry => (
    entry.args[0] === "-o"
      && entry.args[1] === "BatchMode=yes"
      && entry.args[2] === "-o"
      && entry.args[3] === "StrictHostKeyChecking=yes"
  )));

  const controllerEnvelope = commands.find(entry => entry.tool === "controller-envelope");
  assert.equal(controllerEnvelope.templateDigest, validated.digest);
  assert.equal(controllerEnvelope.image, REMOTE_IMAGE_ID);
  assert.ok(controllerEnvelope.fields.includes("templateDigest"));
});

test("pod deploy computes without GitHub authority then publishes one exact draft PR in isolation", async t => {
  const tools = await fakeDeployTools(t, { controller: "pod-success" });
  const result = await invoke(podDeployArgs(tools.taskFile), { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "completed");
  assert.equal(response.baseSha, POD_BASE_SHA);
  assert.equal(response.candidateSha, POD_CANDIDATE_SHA);
  assert.equal(response.publication.draft, true);
  assert.equal(response.publication.url, "https://github.com/zaycruz/bimo/pull/42");

  const entries = await readCommandLog(tools.logFile);
  const remoteCommands = entries.filter(entry => entry.tool === "ssh").map(entry => entry.command);
  const compute = remoteCommands.find(command => command.includes("internal-pod-run"));
  const publisher = remoteCommands.find(command => command.includes("internal-publish"));
  assert.ok(compute, "compute controller was not launched");
  assert.ok(publisher, "isolated publisher was not launched");
  assert.equal(compute[compute.indexOf("--name") + 1], "bimo-pod-demo-controller");
  assert.equal(compute[compute.indexOf("--cap-add") + 1], "CHOWN");
  assert.equal(publisher[publisher.indexOf("--name") + 1], "bimo-pod-demo-publisher");
  assert.equal(remoteCommands.some(command => (
    command[0] === "docker" && command[1] === "rm" && command.includes("bimo-pod-demo-publisher")
  )), false);

  const hostRoot = "/var/lib/bimo/deployments/pod-demo";
  assert.ok(remoteCommands.some(command => command[0] === "mkdir"
    && ["runs", "source", "worktrees", "snapshots"].every(directory => (
      command.includes(`${hostRoot}/${directory}`)
    ))));
  for (const mount of [
    "/var/run/docker.sock:/var/run/docker.sock:rw",
    `${hostRoot}/runs:/state:rw`,
    `${hostRoot}/source:/source:rw`,
    `${hostRoot}/worktrees:/worktrees:rw`,
    `${hostRoot}/snapshots:/snapshots:rw`,
  ]) {
    assert.ok(compute.includes(mount), `compute missing ${mount}`);
  }
  assert.ok(publisher.includes(`${hostRoot}/runs:/state:rw`));
  assert.ok(publisher.includes(`${hostRoot}/source:/source:rw`));
  assert.equal(publisher.some(value => value.includes("docker.sock")), false);
  assert.equal(publisher.some(value => value.includes("worktrees") || value.includes("snapshots")), false);
  assert.ok(publisher.includes("/run/bimo-publish:rw,nosuid,nodev,noexec,size=16m,mode=0700"));

  const computeEnvelope = entries.find(entry => entry.tool === "pod-compute-envelope");
  const publishEnvelope = entries.find(entry => entry.tool === "pod-publish-envelope");
  assert.deepEqual(computeEnvelope.fields, [
    "baseSha", "deployment", "image", "key", "model", "repository", "runId", "targetBranch",
    "task", "template", "templateDigest", "version",
  ]);
  assert.deepEqual(publishEnvelope.fields, [
    "baseSha", "candidateSha", "headBranch", "repository", "runId", "targetBranch", "token", "version",
  ]);
  assert.equal(computeEnvelope.runId, publishEnvelope.runId);
  assert.equal(computeEnvelope.repository, "https://github.com/zaycruz/bimo.git");
  assert.equal(publishEnvelope.candidateSha, POD_CANDIDATE_SHA);

  const openRouterIndex = entries.findIndex(entry => entry.tool === "op" && entry.reference.endsWith("/openrouter"));
  const computeIndex = entries.indexOf(computeEnvelope);
  const githubIndex = entries.findIndex(entry => entry.tool === "op" && entry.reference.endsWith("/github"));
  const publishIndex = entries.indexOf(publishEnvelope);
  assert.ok(openRouterIndex >= 0 && openRouterIndex < computeIndex);
  assert.ok(computeIndex < githubIndex && githubIndex < publishIndex);
  const serializedLog = JSON.stringify(entries);
  assert.equal(serializedLog.includes(`sk-or-v1-${"k".repeat(32)}`), false);
  assert.equal(serializedLog.includes(`github_pat_${"g".repeat(64)}`), false);
});

test("controller signal cancellation aborts runtime and prevents verify or publish", async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "bimo-controller-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const loaded = await loadWorkflow("react-solo", { templateRoot: path.join(root, "templates") });
  const signalEmitter = new EventEmitter();
  const deadlines = [];
  let cancelCalls = 0;
  let closeCalls = 0;
  let verifyCalls = 0;
  let publishCalls = 0;
  const runtime = {
    imageDigest: async ({ deadlineAt }) => {
      deadlines.push(deadlineAt);
      return REMOTE_IMAGE_ID;
    },
    start: async ({ deadlineAt }) => {
      deadlines.push(deadlineAt);
    },
    runRole: async () => {
      signalEmitter.emit("SIGTERM");
      return {
        receipt: {
          outcome: "completed",
          what: "Engineering completed the task",
          why: "The implementation is complete",
          evidence: ["focused test passed"],
          files: ["src/App.jsx"],
        },
        runtime: { exitCode: 0 },
      };
    },
    verify: async () => {
      verifyCalls += 1;
      return { status: "passed", evidence: ["verified"] };
    },
    publish: async () => {
      publishCalls += 1;
      return { url: "http://127.0.0.1:8080" };
    },
    cancel: async () => {
      cancelCalls += 1;
    },
    close: async () => {
      closeCalls += 1;
    },
  };

  await assert.rejects(runController({
    loaded,
    envelope: {
      task: "stop the controller safely",
      model: "openrouter/deepseek/deepseek-v4-flash",
    },
    runtime,
    stateRoot: path.join(temporary, "runs"),
    workspace: path.join(temporary, "workspace"),
    runId: "signal-cancelled",
    clockSource: () => 0,
    signalEmitter,
  }), /controller interrupted/);

  assert.equal(cancelCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(verifyCalls, 0);
  assert.equal(publishCalls, 0);
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines[0], deadlines[1]);
  assert.equal(signalEmitter.listenerCount("SIGINT"), 0);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
});

test("pod controller composition starts without app bootstrap and verifies only opaque snapshots", async () => {
  const pod = await loadPodTemplate("parallel-engineering-pod", {
    templateRoot: path.join(root, "templates"),
  });
  const loaded = { kind: "engineering-pod", ...pod };
  const calls = [];
  const runtime = {
    imageDigest: async input => { calls.push(["image", input]); return REMOTE_IMAGE_ID; },
    start: async input => { calls.push(["start", input]); },
    verifySource: async input => {
      calls.push(["verify", input]);
      return { status: "passed", candidateSha: input.expectedSha, evidence: [] };
    },
    cancel: async () => { calls.push(["cancel"]); },
    close: async () => { calls.push(["close"]); },
  };
  const source = {};
  const store = {};
  let podInput;
  const result = await runPodController({
    loaded,
    envelope: {
      task: "Implement the fixed pod.",
      repository: "https://github.com/zaycruz/bimo.git",
      baseSha: "a".repeat(40),
      targetBranch: "main",
      runId: "pod-run-1",
    },
    runtime,
    source,
    store,
    runId: "pod-run-1",
    clockSource: () => 1_000,
    signalEmitter: new EventEmitter(),
    runPod: async input => {
      podInput = input;
      await input.verifyCandidate({
        expectedSha: "b".repeat(40),
        profile: "bimo-repo-v1",
        timeoutSeconds: 60,
        candidateSnapshot: {
          id: "candidate-1",
          sha: "b".repeat(40),
          root: "/snapshots/pod-run-1/candidate-1",
          receipt: { files: 3, bytes: 100, sha256: "c".repeat(64) },
        },
        baseSnapshot: {
          id: "run-base",
          sha: "a".repeat(40),
          root: "/snapshots/pod-run-1/run-base",
          receipt: { files: 2, bytes: 80, sha256: "d".repeat(64) },
        },
      });
      return { status: "ready", runId: "pod-run-1", candidateSha: "b".repeat(40) };
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(podInput.prompts.planner, pod.prompts.planner);
  assert.equal(podInput.agents, runtime);
  assert.equal(podInput.source, source);
  assert.equal(podInput.store, store);
  assert.deepEqual(calls.find(([name]) => name === "start")[1], {
    deadlineAt: 7_201_000,
    bootstrap: false,
  });
  const verification = calls.find(([name]) => name === "verify")[1];
  assert.deepEqual(Object.keys(verification.candidateSnapshot).sort(), ["id", "receipt", "sha"]);
  assert.deepEqual(Object.keys(verification.baseSnapshot).sort(), ["id", "receipt", "sha"]);
  assert.equal(calls.at(-1)[0], "close");
});
