import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

import { runController, runPodController, startRunHeartbeat, streamRunProgress } from "../src/bimo.mjs";
import { loadPodTemplate } from "../src/pod-contract.mjs";
import { createPodRunStore } from "../src/pod-store.mjs";
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
  localConfig = BASE_CONFIG,
  controller = "conflict",
  missingOp = false,
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
else if (args[0] === "image" && args[1] === "inspect") {
  if (process.env.BIMO_TEST_IMAGE_MISSING) {
    process.stderr.write("Error response from daemon: No such image: " + args[args.length - 1] + "\\n");
    process.exitCode = 1;
  } else process.stdout.write(process.env.BIMO_TEST_LOCAL_INSPECT + "\\n");
}
else if (args[0] === "save") process.stdout.write("fake-image-archive");
else if (args[0] === "kill") {
  const name = args[args.length - 1];
  if ((process.env.BIMO_TEST_KILL ?? "").split(",").includes(name)) process.stdout.write(name + "\\n");
  else {
    process.stderr.write("Error: No such container: " + name + "\\n");
    process.exitCode = 1;
  }
}
else if (args[0] === "run") {
  if (process.env.BIMO_TEST_READ_FAIL && args.includes("internal-logs")) {
    process.stderr.write(process.env.BIMO_TEST_READ_FAIL + "\\n");
    process.exitCode = 1;
  } else {
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
        runId: envelope.runId,
      });
      process.stdout.write(JSON.stringify({
        template: envelope.template,
        deployment: envelope.deployment,
        runId: envelope.runId,
        url: envelope.publicUrl,
      }) + "\\n");
    });
  }
  }
}
`;
  const ssh = `#!/usr/bin/env node
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2);
const command = args.slice(5);
const separator = command.indexOf("--");
const runtimeCommand = separator === -1 ? command : command.slice(separator + 1);
const log = value => fs.appendFileSync(process.env.BIMO_TEST_LOG, JSON.stringify(value) + "\\n");
log({ tool: "ssh", args, command });
if (runtimeCommand[0] === "true") {
  process.exit(0);
} else if (runtimeCommand[0] === "test") {
  process.exit(process.env.BIMO_TEST_STATE_MISSING ? 1 : 0);
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "kill") {
  const name = runtimeCommand[runtimeCommand.length - 1];
  log({ tool: "docker-kill", name });
  if ((process.env.BIMO_TEST_KILL ?? "").split(",").includes(name)) {
    process.stdout.write(name + "\\n");
  } else {
    process.stderr.write("Error: No such container: " + name + "\\n");
    process.exitCode = 1;
  }
} else if (runtimeCommand[0] === "df") {
  process.stdout.write("Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk1 488245288 10000000 470000000 3% /\\n");
} else if (runtimeCommand[0] === "pct") {
  process.stdout.write(process.env.BIMO_TEST_PCT_STATUS ?? "status: running\\n");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "run"
    && (runtimeCommand.includes("internal-runs") || runtimeCommand.includes("internal-status")
      || runtimeCommand.includes("internal-tail"))) {
  const payload = runtimeCommand.includes("internal-runs") ? process.env.BIMO_TEST_RUNS_OUTPUT
    : runtimeCommand.includes("internal-status") ? process.env.BIMO_TEST_STATUS_OUTPUT
    : process.env.BIMO_TEST_TAIL_OUTPUT;
  process.stdout.write(payload ?? "");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "version") {
  process.stdout.write(process.env.BIMO_TEST_REMOTE_PLATFORM + "\\n");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "load") {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write("Loaded image\\n"));
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "image" && runtimeCommand[2] === "inspect") {
  if (process.env.BIMO_TEST_IMAGE_MISSING) {
    process.stderr.write("Error response from daemon: No such image: "
      + runtimeCommand[runtimeCommand.length - 1] + "\\n");
    process.exitCode = 1;
  } else process.stdout.write(process.env.BIMO_TEST_REMOTE_INSPECT + "\\n");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "run"
    && runtimeCommand.includes("internal-logs")) {
  process.stdout.write("");
} else if (runtimeCommand[0] === "docker" && runtimeCommand[1] === "run") {
  if (process.env.BIMO_TEST_CONTROLLER === "hang") {
    process.stdin.resume();
    setTimeout(() => process.exit(0), 30_000);
  } else {
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
      || value === "internal-publish" || value === "internal-publish-resume" || value === "internal-organize");
    if (process.env.BIMO_TEST_CONTROLLER === "conflict") {
      process.stderr.write("Conflict: controller name is already in use\\n");
      process.exitCode = 125;
    } else if (process.env.BIMO_TEST_CONTROLLER === "publish-resume-missing"
      && internalCommand === "internal-publish-resume") {
      process.stderr.write("bimo: no publication-ready record found for run " + envelope.runId + "\\n");
      process.exitCode = 1;
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
          url: envelope.repository.replace(/\.git$/, "") + "/pull/42",
          draft: true,
          created: true,
          headBranch: envelope.headBranch,
          headSha: envelope.candidateSha,
          targetBranch: envelope.targetBranch,
          baseSha: envelope.baseSha,
        },
      }) + "\\n");
    } else if (process.env.BIMO_TEST_CONTROLLER === "publish-resume-success"
      && internalCommand === "internal-publish-resume") {
      log({
        tool: "publish-resume-envelope",
        fields: Object.keys(envelope).sort(),
        runId: envelope.runId,
      });
      process.stdout.write(JSON.stringify({
        status: "completed",
        runId: envelope.runId,
        repository: "https://github.com/zaycruz/bimo.git",
        targetBranch: "main",
        baseSha: process.env.BIMO_TEST_POD_BASE,
        candidateSha: process.env.BIMO_TEST_POD_CANDIDATE,
        headBranch: "bimo/" + envelope.runId,
        publication: {
          number: 43,
          url: "https://github.com/zaycruz/bimo/pull/43",
          draft: true,
          created: false,
          headBranch: "bimo/" + envelope.runId,
          headSha: process.env.BIMO_TEST_POD_CANDIDATE,
          targetBranch: "main",
          baseSha: process.env.BIMO_TEST_POD_BASE,
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
        runId: envelope.runId ?? "test-run",
        url: envelope.publicUrl,
      }) + "\\n");
    }
  });
  }
}
`;
  const op = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("2.30.0\\n");
else {
  fs.appendFileSync(process.env.BIMO_TEST_LOG, JSON.stringify({ tool: "op", reference: args[1] }) + "\\n");
  if (process.env.BIMO_TEST_OP_FAIL) {
    process.stderr.write("[ERROR] 2026/01/01 00:00:00 You are not currently signed in; run \`op signin\` first\\n");
    process.exit(1);
  }
  if (args[1].endsWith("/github")) process.stdout.write("github_pat_${"g".repeat(64)}\\n");
  else process.stdout.write("sk-or-v1-${"k".repeat(32)}\\n");
}
`;
  await Promise.all([
    writeFile(path.join(directory, "docker"), docker, { mode: 0o755 }),
    writeFile(path.join(directory, "ssh"), ssh, { mode: 0o755 }),
    ...(missingOp ? [] : [writeFile(path.join(directory, "op"), op, { mode: 0o755 })]),
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
      BIMO_TEST_LOCAL_INSPECT: imageInspect(LOCAL_IMAGE_ID, {
        architecture: localArchitecture,
        config: localConfig,
      }),
      BIMO_TEST_REMOTE_INSPECT: imageInspect(remoteImageId, {
        architecture: remotePlatform.split("/")[1],
        config: remoteConfig,
        layers: remoteLayers,
      }),
      BIMO_TEST_REMOTE_PLATFORM: remotePlatform,
      BIMO_TEST_CONTROLLER: controller,
      BIMO_TEST_POD_BASE: POD_BASE_SHA,
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

test("bare bimo prints usage and exits 1, while the help aliases print usage and exit 0", async () => {
  const bare = await invoke([]);
  assert.equal(bare.code, 1);
  assert.match(bare.stdout, /^usage:/);
  assert.equal(bare.stderr, "");

  for (const flag of ["--help", "-h"]) {
    const result = await invoke([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, bare.stdout);
    assert.equal(result.stderr, "");
  }
});

test("--version prints the packaged version and exits 0", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const result = await invoke(["--version"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, "");
});

test("organize and deploy require --deployment before validating its format", async () => {
  const organizeBase = [
    "organize", "--prompt", "Build a small status page.",
    "--host", "example.invalid",
    "--secret-ref", "op://Test/Bimo/openrouter",
  ];
  for (const [args, pattern] of [
    [organizeBase, /--deployment is required/],
    [[...organizeBase, "--deployment", "Organizer_Demo"],
      /--deployment must use lowercase letters, numbers, and dashes/],
    [["deploy", "react-app"], /--deployment is required/],
    [["deploy", "react-app", "--deployment", "Fleet_Demo"],
      /--deployment must use lowercase letters, numbers, and dashes/],
  ]) {
    const result = await invoke(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
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
  const response = JSON.parse(result.stdout);
  assert.equal(response.template, "react-app");
  assert.equal(response.deployment, "fleet-demo");
  assert.match(response.runId, /^\d{14}-[0-9a-f]{8}$/);
  assert.equal(response.url, "http://example.invalid:8080");

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
  assert.equal(envelope.runId, response.runId);
});

test("deploy builds with the AGENT_RUNTIME build-arg and defaults the opencode image tag", async t => {
  const tools = await fakeDeployTools(t, {
    controller: "workflow-success",
    localArchitecture: "arm64",
  });
  const args = deployArgs(tools.taskFile).filter((value, index, all) => (
    value !== "--host" && all[index - 1] !== "--host"
      && value !== "--image" && all[index - 1] !== "--image"
  ));
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  const entries = await readCommandLog(tools.logFile);
  const docker = entries.filter(entry => entry.tool === "docker").map(entry => entry.args);
  const build = docker.find(command => command[0] === "build");
  assert.ok(build);
  assert.equal(build[build.indexOf("--tag") + 1], "bimo-workflow:0.6.0");
  assert.equal(build[build.indexOf("--build-arg") + 1], "AGENT_RUNTIME=opencode");
  const envelope = entries.find(entry => entry.tool === "local-controller-envelope");
  assert.ok(envelope.fields.includes("agentRuntime"));
});

test("deploy and organize reject an unknown --agent-runtime before any Docker work", async t => {
  const tools = await fakeDeployTools(t);
  for (const args of [
    [...deployArgs(tools.taskFile), "--agent-runtime", "bogus"],
    [...organizeArgs("Build a small status page.", 1), "--agent-runtime", "bogus"],
  ]) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--agent-runtime must name a built-in agent runtime/);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("deploy and organize accept --agent-runtime pi and derive the pi image tag", async t => {
  const piConfig = { ...BASE_CONFIG, Env: ["NODE_ENV=production", "BIMO_AGENT_RUNTIME=pi"] };

  const deployTools = await fakeDeployTools(t, {
    controller: "workflow-success",
    localArchitecture: "arm64",
    localConfig: piConfig,
  });
  const deploy = deployArgs(deployTools.taskFile).filter((value, index, all) => (
    value !== "--host" && all[index - 1] !== "--host"
      && value !== "--image" && all[index - 1] !== "--image"
  ));
  deploy.push("--agent-runtime", "pi");
  const deployResult = await invoke(deploy, { env: deployTools.env });
  assert.equal(deployResult.code, 0, deployResult.stderr);
  const deployEntries = await readCommandLog(deployTools.logFile);
  const deployDocker = deployEntries.filter(entry => entry.tool === "docker").map(entry => entry.args);
  const build = deployDocker.find(command => command[0] === "build");
  assert.ok(build);
  assert.equal(build[build.indexOf("--tag") + 1], "bimo-workflow:0.6.0-pi");
  assert.equal(build[build.indexOf("--build-arg") + 1], "AGENT_RUNTIME=pi");
  const deployEnvelope = deployEntries.find(entry => entry.tool === "local-controller-envelope");
  assert.ok(deployEnvelope.fields.includes("agentRuntime"));

  const organizeTools = await fakeDeployTools(t, {
    controller: "organize-success",
    localConfig: piConfig,
    remoteConfig: { ...REORDERED_CONFIG, Env: ["NODE_ENV=production", "BIMO_AGENT_RUNTIME=pi"] },
  });
  const organize = organizeArgs("Build a small status page.", 1).filter((value, index, all) => (
    value !== "--image" && all[index - 1] !== "--image"
  ));
  organize.push("--agent-runtime", "pi");
  const organizeResult = await invoke(organize, { env: organizeTools.env });
  assert.equal(organizeResult.code, 0, organizeResult.stderr);
  const organizeEntries = await readCommandLog(organizeTools.logFile);
  const organizeDocker = organizeEntries.filter(entry => entry.tool === "docker").map(entry => entry.args);
  const organizeBuild = organizeDocker.find(command => command[0] === "build");
  assert.ok(organizeBuild);
  assert.equal(organizeBuild[organizeBuild.indexOf("--tag") + 1], "bimo-workflow:0.6.0-pi");
});

test("an explicit --agent-runtime fails closed when the built image lacks the runtime env", async t => {
  const tools = await fakeDeployTools(t, {
    controller: "workflow-success",
    localArchitecture: "arm64",
  });
  const args = deployArgs(tools.taskFile).filter((value, index, all) => (
    value !== "--host" && all[index - 1] !== "--host"
      && value !== "--image" && all[index - 1] !== "--image"
  ));
  args.push("--agent-runtime", "opencode");
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /built image agent runtime unset does not match --agent-runtime opencode/);
  const entries = await readCommandLog(tools.logFile);
  assert.equal(entries.some(entry => entry.tool === "local-controller-envelope"), false);
});

test("an explicit --agent-runtime matching the built image env runs the controller", async t => {
  const tools = await fakeDeployTools(t, {
    controller: "workflow-success",
    localArchitecture: "arm64",
    localConfig: { ...BASE_CONFIG, Env: ["NODE_ENV=production", "BIMO_AGENT_RUNTIME=opencode"] },
  });
  const args = deployArgs(tools.taskFile).filter((value, index, all) => (
    value !== "--host" && all[index - 1] !== "--host"
      && value !== "--image" && all[index - 1] !== "--image"
  ));
  args.push("--agent-runtime", "opencode");
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.template, "react-app");
  const entries = await readCommandLog(tools.logFile);
  const envelope = entries.find(entry => entry.tool === "local-controller-envelope");
  assert.ok(envelope.fields.includes("agentRuntime"));
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
  const invocation = entries.find(entry => entry.tool === "ssh" && entry.command.includes("internal-logs"));
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
    "docker", "run", "--pull=never", "--rm", "-i",
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
    "agentRuntime", "agents", "deployment", "image", "key", "model", "prompt", "runId", "version",
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
  assert.equal(remoteCommands.some(command => command[0] === "rmdir"), false);
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
    agentRuntime: "opencode",
    image: LOCAL_IMAGE_ID,
  };
  for (const [envelope, pattern] of [
    [{ ...base, extra: true }, /invalid shape|exactly/],
    [{ ...base, image: undefined }, /invalid shape|exactly/],
    [{ ...base, agents: 0 }, /controller envelope is invalid/],
    [{ ...base, agentRuntime: "bogus" }, /controller envelope is invalid/],
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
    agentRuntime: "opencode",
    image: LOCAL_IMAGE_ID,
    port: 8080,
    publicUrl: "http://example.invalid:8080",
    runId: "workflow-run-1",
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
    agentRuntime: "opencode",
    image: LOCAL_IMAGE_ID,
    repository: "https://github.com/zaycruz/bimo.git",
    baseSha: POD_BASE_SHA,
    targetBranch: "main",
    cloneToken: null,
    runId: "pod-run-1",
  };
  const result = await invoke([
    "internal-pod-run",
    "--host-root", "/var/lib/bimo/deployments/pod-demo",
  ], { input: JSON.stringify(envelope) });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /template digest does not match/);
});

test("internal-pod-run validates the clone credential envelope field", async () => {
  const envelope = {
    version: 1,
    template: "parallel-engineering-pod",
    templateDigest: "0".repeat(64),
    deployment: "pod-demo",
    task: "Implement the fixed pod.",
    key: `sk-or-v1-${"k".repeat(32)}`,
    model: "openrouter/deepseek/deepseek-v4-flash",
    agentRuntime: "opencode",
    image: LOCAL_IMAGE_ID,
    repository: "https://github.com/zaycruz/bimo.git",
    baseSha: POD_BASE_SHA,
    targetBranch: "main",
    runId: "pod-run-1",
  };
  for (const [patch, pattern, label] of [
    [{}, /pod controller envelope has an invalid shape/, "missing cloneToken"],
    [{ cloneToken: "not-a-token" }, /pod controller envelope is invalid/, "malformed cloneToken"],
    [{ cloneToken: 42 }, /pod controller envelope is invalid/, "non-string cloneToken"],
  ]) {
    const candidate = { ...envelope, ...patch };
    const result = await invoke([
      "internal-pod-run",
      "--host-root", "/var/lib/bimo/deployments/pod-demo",
    ], { input: JSON.stringify(candidate) });
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, pattern, label);
  }
});

test("internal-publish validates the repository and branch shapes, not a fixed repository", async () => {
  const base = {
    version: 1,
    runId: "pod-run-1",
    repository: "https://github.com/zaycruz/pod-sandbox.git",
    targetBranch: "main",
    baseSha: POD_BASE_SHA,
    candidateSha: POD_CANDIDATE_SHA,
    headBranch: "bimo/pod-run-1",
    token: `github_pat_${"g".repeat(64)}`,
  };
  for (const [patch, label] of [
    [{ repository: "git@github.com:zaycruz/bimo.git" }, "ssh URL"],
    [{ repository: "https://gitlab.com/zaycruz/bimo.git" }, "non-github host"],
    [{ repository: "https://user:pass@github.com/zaycruz/bimo.git" }, "credentials in URL"],
    [{ repository: "https://github.com/zaycruz/../bimo.git" }, "traversal in path"],
    [{ targetBranch: "main..x" }, "double dot in branch"],
    [{ targetBranch: "my branch" }, "space in branch"],
    [{ targetBranch: "/main" }, "leading slash in branch"],
    [{ targetBranch: "main.lock" }, "lock suffix in branch"],
  ]) {
    const result = await invoke(["internal-publish"], {
      input: JSON.stringify({ ...base, ...patch }),
    });
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, /publisher envelope is invalid/, label);
  }
});

test("pod deploy accepts an operator-selected repository and target branch", async t => {
  const tools = await fakeDeployTools(t, { controller: "pod-success" });
  const args = podDeployArgs(tools.taskFile).flatMap((value, index, all) => (
    value === "--repository" || value === "--target-branch"
      ? []
      : all[index - 1] === "--repository" || all[index - 1] === "--target-branch"
        ? []
        : [value]
  ));
  args.push("--repository", "https://github.com/zaycruz/pod-sandbox.git",
    "--target-branch", "develop");
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.repository, "https://github.com/zaycruz/pod-sandbox.git");
  assert.equal(response.targetBranch, "develop");
  assert.equal(response.publication.url, "https://github.com/zaycruz/pod-sandbox/pull/42");

  const entries = await readCommandLog(tools.logFile);
  const computeEnvelope = entries.find(entry => entry.tool === "pod-compute-envelope");
  const publishEnvelope = entries.find(entry => entry.tool === "pod-publish-envelope");
  assert.equal(computeEnvelope.repository, "https://github.com/zaycruz/pod-sandbox.git");
  assert.equal(computeEnvelope.targetBranch, "develop");
  assert.equal(publishEnvelope.repository, "https://github.com/zaycruz/pod-sandbox.git");
  assert.equal(publishEnvelope.targetBranch, "develop");
});

test("pod deploy defaults the repository and target branch when the flags are omitted", async t => {
  const tools = await fakeDeployTools(t, { controller: "pod-success" });
  const args = podDeployArgs(tools.taskFile).flatMap((value, index, all) => (
    value === "--repository" || value === "--target-branch"
      ? []
      : all[index - 1] === "--repository" || all[index - 1] === "--target-branch"
        ? []
        : [value]
  ));
  const result = await invoke(args, { env: tools.env });

  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.repository, "https://github.com/zaycruz/bimo.git");
  assert.equal(response.targetBranch, "main");
});

test("pod deploy rejects invalid repository URLs and branch names before any Docker work", async () => {
  const base = [
    "deploy", "parallel-engineering-pod",
    "--deployment", "pod-demo",
    "--host", "example.invalid",
    "--task-stdin",
    "--secret-ref", "op://Test/Bimo/openrouter",
    "--github-secret-ref", "op://Test/Bimo publisher/github",
    "--base-sha", POD_BASE_SHA,
  ];
  for (const [extra, pattern] of [
    [["--repository", "git@github.com:zaycruz/bimo.git"], /must be an https github\.com repository URL/],
    [["--repository", "https://gitlab.com/zaycruz/bimo.git"], /must be an https github\.com repository URL/],
    [["--repository", "https://user:pass@github.com/zaycruz/bimo.git"], /must be an https github\.com repository URL/],
    [["--target-branch", "my branch"], /not a valid Git branch name/],
    [["--target-branch", "main..x"], /not a valid Git branch name/],
    [["--target-branch", "-bad"], /not a valid Git branch name/],
  ]) {
    const result = await invoke([...base, ...extra], { input: "Build the test application.\n" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
});

test("pod deploy brokers an optional read-scoped clone credential into the compute envelope", async t => {
  const tools = await fakeDeployTools(t, { controller: "pod-success" });
  const result = await invoke([
    ...podDeployArgs(tools.taskFile),
    "--clone-secret-ref", "op://Test/Bimo clone/github",
  ], { env: tools.env });
  assert.equal(result.code, 0, result.stderr);

  const entries = await readCommandLog(tools.logFile);
  const computeEnvelope = entries.find(entry => entry.tool === "pod-compute-envelope");
  assert.ok(computeEnvelope.fields.includes("cloneToken"));
  const cloneIndex = entries.findIndex(entry => entry.tool === "op"
    && entry.reference === "op://Test/Bimo clone/github");
  assert.ok(cloneIndex >= 0 && cloneIndex < entries.indexOf(computeEnvelope));
  const serializedLog = JSON.stringify(entries);
  assert.equal(serializedLog.includes(`github_pat_${"g".repeat(64)}`), false);
});

test("pod deploy rejects an invalid clone secret reference before any Docker work", async t => {
  const tools = await fakeDeployTools(t);
  for (const [reference, pattern] of [
    ["not-an-op-reference", /--clone-secret-ref must be a 1Password op:\/\/ reference/],
    ["op://Test/Bimo/openrouter", /did not resolve to a GitHub token/],
  ]) {
    const result = await invoke([
      ...podDeployArgs(tools.taskFile),
      "--clone-secret-ref", reference,
    ], { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  const entries = await readCommandLog(tools.logFile);
  assert.equal(entries.some(entry => entry.tool === "ssh"), false);
});

test("workflow deploys reject the pod-only clone secret flag", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke([
    ...deployArgs(tools.taskFile),
    "--clone-secret-ref", "op://Test/Bimo clone/github",
  ], { env: tools.env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown option: --clone-secret-ref/);
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

test("deploy rejects changed transferred image content before remote retag", async t => {
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
      const opIndex = commands.findIndex(entry => entry.tool === "op");
      const buildIndex = commands.findIndex(entry => entry.tool === "docker" && entry.args[0] === "build");
      assert.ok(opIndex >= 0 && buildIndex >= 0 && opIndex < buildIndex);
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
    "agentRuntime", "baseSha", "cloneToken", "deployment", "image", "key", "model", "repository", "runId",
    "targetBranch", "task", "template", "templateDigest", "version",
  ]);
  assert.deepEqual(publishEnvelope.fields, [
    "baseSha", "candidateSha", "headBranch", "repository", "runId", "targetBranch", "token", "version",
  ]);
  assert.equal(computeEnvelope.runId, publishEnvelope.runId);
  assert.equal(computeEnvelope.repository, "https://github.com/zaycruz/bimo.git");
  assert.equal(publishEnvelope.candidateSha, POD_CANDIDATE_SHA);

  const openRouterIndex = entries.findIndex(entry => entry.tool === "op" && entry.reference.endsWith("/openrouter"));
  const githubIndex = entries.findIndex(entry => entry.tool === "op" && entry.reference.endsWith("/github"));
  const buildIndex = entries.findIndex(entry => entry.tool === "docker" && entry.args[0] === "build");
  const computeIndex = entries.indexOf(computeEnvelope);
  const publishIndex = entries.indexOf(publishEnvelope);
  assert.ok(openRouterIndex >= 0 && githubIndex >= 0 && buildIndex >= 0);
  assert.ok(openRouterIndex < buildIndex && githubIndex < buildIndex);
  assert.ok(buildIndex < computeIndex && computeIndex < publishIndex);
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

async function fakeStateRoot(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "bimo-state-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workflowRun = "20240101000000-aaaa1111";
  const podRun = "20240202000000-bbbb2222";
  await mkdir(path.join(directory, workflowRun));
  await mkdir(path.join(directory, podRun));
  await writeFile(path.join(directory, workflowRun, "events.jsonl"), [
    JSON.stringify({
      version: 1, sequence: 1, timestamp: "2024-01-01T00:00:00.000Z", runId: workflowRun, type: "run.started",
    }),
    JSON.stringify({
      version: 1, sequence: 2, timestamp: "2024-01-01T00:01:00.000Z", runId: workflowRun,
      type: "role.started", role: "engineering", step: 1, attempt: 1,
    }),
    JSON.stringify({
      version: 1, sequence: 3, timestamp: "2024-01-01T00:02:00.000Z", runId: workflowRun,
      type: "run.finished", status: "completed", steps: 1,
    }),
  ].join("\n") + "\n");
  await writeFile(path.join(directory, podRun, "run.json"), `${JSON.stringify({
    version: 1,
    runId: podRun,
    assignment: {},
    status: "running",
    phase: "planned",
    currentAttempt: 2,
    startedAt: "2024-02-02T00:00:00.000Z",
    finishedAt: null,
  }, null, 2)}\n`);
  await writeFile(path.join(directory, podRun, "events.jsonl"), "");
  await writeFile(path.join(directory, "latest"), `${workflowRun}\n`);
  return { directory, workflowRun, podRun };
}

test("internal-runs summarizes recorded runs newest first in JSON and text", async t => {
  const { directory, workflowRun, podRun } = await fakeStateRoot(t);
  const result = await invoke(["internal-runs", "--state-root", directory, "--deployment", "demo", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    deployment: "demo",
    runs: [
      {
        id: podRun,
        state: "running",
        phase: "planned",
        startedAt: "2024-02-02T00:00:00.000Z",
        finishedAt: null,
        attempts: 2,
      },
      {
        id: workflowRun,
        state: "completed",
        phase: null,
        startedAt: "2024-01-01T00:00:00.000Z",
        finishedAt: "2024-01-01T00:02:00.000Z",
        attempts: 1,
      },
    ],
  });

  const text = await invoke(["internal-runs", "--state-root", directory, "--deployment", "demo"]);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout, [
    `${podRun}\trunning\t2024-02-02T00:00:00.000Z\t-\t2`,
    `${workflowRun}\tcompleted\t2024-01-01T00:00:00.000Z\t2024-01-01T00:02:00.000Z\t1`,
    "",
  ].join("\n"));
});

test("internal-runs isolates corrupt runs instead of hiding healthy ones", async t => {
  const { directory, workflowRun } = await fakeStateRoot(t);
  const corrupt = "20240303000000-cccc3333";
  await mkdir(path.join(directory, corrupt));
  await writeFile(path.join(directory, corrupt, "events.jsonl"), "not json\n");
  const result = await invoke(["internal-runs", "--state-root", directory, "--deployment", "demo", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.runs.length, 3);
  const corrupted = payload.runs.find(run => run.id === corrupt);
  assert.equal(corrupted.state, "unknown");
  assert.ok(payload.runs.some(run => run.id === workflowRun && run.state === "completed"));
});

test("internal-status reports the latest run state and last event", async t => {
  const { directory, workflowRun } = await fakeStateRoot(t);
  const result = await invoke(["internal-status", "--state-root", directory, "--deployment", "demo", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    deployment: "demo",
    runId: workflowRun,
    state: "completed",
    phase: null,
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:02:00.000Z",
    attempts: 1,
    lastEvent: {
      sequence: 3,
      timestamp: "2024-01-01T00:02:00.000Z",
      type: "run.finished",
      status: "completed",
    },
  });

  const text = await invoke(["internal-status", "--state-root", directory, "--deployment", "demo"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /state: completed/);
  assert.match(text.stdout, /last event: run\.finished at 2024-01-01T00:02:00\.000Z/);

  const empty = await mkdtemp(path.join(tmpdir(), "bimo-state-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const none = await invoke(["internal-status", "--state-root", empty, "--deployment", "demo", "--json"]);
  assert.equal(none.code, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).state, "none");
});

test("internal-tail streams complete event lines from a byte offset", async t => {
  const { directory, workflowRun } = await fakeStateRoot(t);
  const first = await invoke(["internal-tail", "--state-root", directory, "--run", "latest", "--after", "0"]);
  assert.equal(first.code, 0, first.stderr);
  const update = JSON.parse(first.stdout);
  assert.equal(update.runId, workflowRun);
  assert.equal(update.offset, update.size);
  assert.equal(update.chunk.trimEnd().split("\n").length, 3);

  const eventsPath = path.join(directory, workflowRun, "events.jsonl");
  const extra = JSON.stringify({
    version: 1, sequence: 4, timestamp: "2024-01-01T00:03:00.000Z", runId: workflowRun,
    type: "role.failed", role: "engineering", reason: "boom",
  }) + "\n";
  await appendFile(eventsPath, extra);
  const second = await invoke([
    "internal-tail", "--state-root", directory, "--run", workflowRun, "--after", String(update.offset),
  ]);
  assert.equal(second.code, 0, second.stderr);
  const follow = JSON.parse(second.stdout);
  assert.equal(follow.chunk, extra);
  assert.equal(follow.offset, update.offset + Buffer.byteLength(extra));

  const clamped = await invoke([
    "internal-tail", "--state-root", directory, "--run", workflowRun, "--after", "999999999",
  ]);
  assert.equal(clamped.code, 0, clamped.stderr);
  const reset = JSON.parse(clamped.stdout);
  assert.equal(reset.offset, reset.size);
  assert.ok(reset.chunk.startsWith('{"version":1,"sequence":1'));

  const invalid = await invoke([
    "internal-tail", "--state-root", directory, "--run", workflowRun, "--after", "-1",
  ]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /--after is invalid/);
});

test("runs and status read the state root through the sandboxed read container", async t => {
  const tools = await fakeDeployTools(t);
  const runsPayload = `${JSON.stringify({ deployment: "fleet-demo", runs: [] })}\n`;
  const runs = await invoke([
    "runs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--json",
  ], { env: { ...tools.env, BIMO_TEST_RUNS_OUTPUT: runsPayload } });
  assert.equal(runs.code, 0, runs.stderr);
  assert.equal(runs.stdout, runsPayload);

  const statusPayload = `${JSON.stringify({
    deployment: "fleet-demo", runId: null, state: "none", phase: null,
    startedAt: null, finishedAt: null, attempts: 0, lastEvent: null,
  })}\n`;
  const status = await invoke([
    "status", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--json",
  ], { env: { ...tools.env, BIMO_TEST_STATUS_OUTPUT: statusPayload } });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stdout, statusPayload);

  const commands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  const runsCommand = commands.find(command => command.includes("internal-runs"));
  const statusCommand = commands.find(command => command.includes("internal-status"));
  assert.ok(runsCommand);
  assert.ok(statusCommand);
  for (const command of [runsCommand, statusCommand]) {
    assert.ok(command.includes("/var/lib/bimo/deployments/fleet-demo/runs:/state:ro"));
    assert.ok(command.includes("--network"));
    assert.ok(command.includes("--read-only"));
  }
  assert.deepEqual(runsCommand.slice(-3), ["--deployment", "fleet-demo", "--json"]);
  assert.deepEqual(statusCommand.slice(-5), ["--deployment", "fleet-demo", "--run", "latest", "--json"]);
});

test("logs --follow streams new events and exits cleanly on SIGINT", async t => {
  const tools = await fakeDeployTools(t);
  const chunk = `${JSON.stringify({
    version: 1, sequence: 1, timestamp: "2024-01-01T00:00:00.000Z", runId: "run-1", type: "run.started",
  })}\n${JSON.stringify({
    version: 1, sequence: 2, timestamp: "2024-01-01T00:01:00.000Z", runId: "run-1",
    type: "run.finished", status: "completed",
  })}\n`;
  const payload = `${JSON.stringify({
    runId: "run-1", offset: Buffer.byteLength(chunk), size: Buffer.byteLength(chunk), chunk,
  })}\n`;
  const child = spawn(process.execPath, [
    cli, "logs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--follow",
  ], {
    cwd: root,
    env: { ...tools.env, BIMO_TEST_TAIL_OUTPUT: payload },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let interrupted = false;
  const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stdout.on("data", data => {
    stdout.push(data);
    if (!interrupted) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", data => stderr.push(data));
  const code = await new Promise(resolve => child.on("close", resolve));
  clearTimeout(killer);
  assert.equal(code, 0);
  const output = Buffer.concat(stdout).toString("utf8");
  assert.ok(output.includes("2024-01-01T00:00:00.000Z run.started"));
  assert.ok(output.includes("2024-01-01T00:01:00.000Z run.finished completed"));
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");

  const entries = await readCommandLog(tools.logFile);
  const tail = entries.find(entry => entry.tool === "ssh" && entry.command.includes("internal-tail"));
  assert.ok(tail);
  assert.deepEqual(tail.command.slice(-4), ["--run", "latest", "--after", "0"]);
});

test("doctor runs local preflight checks and skips credentials without --secret-ref", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke(["doctor", "--json"], { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.target, "local");
  assert.deepEqual(report.checks.map(check => [check.name, check.status]), [
    ["docker", "pass"],
    ["state-root", "pass"],
    ["disk", "pass"],
    ["secret-ref", "skip"],
  ]);
  assert.match(report.checks[0].reason, /linux\/arm64/);
});

test("doctor exits 1 and reports the failing check when the daemon is unusable", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke(["doctor", "--json"], {
    env: { ...tools.env, BIMO_TEST_DOCKER_ENDPOINT: "tcp://docker.example:2376" },
  });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].name, "docker");
  assert.equal(report.checks[0].status, "fail");
  assert.match(report.checks[0].reason, /Unix socket/);
});

test("doctor checks ssh targets and credential readability without printing secrets", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke([
    "doctor", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--secret-ref", "op://Test/Bimo/openrouter", "--json",
  ], { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(check => [check.name, check.status]), [
    ["ssh", "pass"],
    ["docker", "pass"],
    ["state-root", "pass"],
    ["disk", "pass"],
    ["op-cli", "pass"],
    ["secret-ref", "pass"],
  ]);
  const secret = `sk-or-v1-${"k".repeat(32)}`;
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(JSON.stringify(await readCommandLog(tools.logFile)).includes(secret), false);
  assert.match(
    report.checks.find(check => check.name === "secret-ref").reason,
    /OpenRouter API key/,
  );
});

test("doctor checks proxmox reachability, guest status, and in-guest docker", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke([
    "doctor", "--target", "proxmox-lxc", "--proxmox", "root@pve-05", "--vmid", "212", "--json",
  ], { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(check => check.name), [
    "ssh", "pct", "docker", "state-root", "disk", "secret-ref",
  ]);
  const commands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  assert.ok(commands.some(command => command.join(" ") === "pct status 212"));
  assert.ok(commands.some(command => command.slice(0, 5).join(" ") === "pct exec 212 -- docker"));

  const stopped = await invoke([
    "doctor", "--target", "proxmox-lxc", "--proxmox", "root@pve-05", "--vmid", "212", "--json",
  ], { env: { ...tools.env, BIMO_TEST_PCT_STATUS: "status: stopped\n" } });
  assert.equal(stopped.code, 1);
  const stoppedReport = JSON.parse(stopped.stdout);
  assert.equal(stoppedReport.ok, false);
  assert.deepEqual(
    stoppedReport.checks.find(check => check.name === "pct").status,
    "fail",
  );
});

test("help prints per-command synopses while --help keeps the full usage", async () => {
  const full = await invoke(["--help"]);
  const bare = await invoke(["help"]);
  assert.equal(bare.code, 0);
  assert.equal(bare.stdout, full.stdout);

  const logsHelp = await invoke(["help", "logs"]);
  assert.equal(logsHelp.code, 0, logsHelp.stderr);
  assert.match(logsHelp.stdout, /^bimo logs --deployment NAME/);
  const flagHelp = await invoke(["logs", "--help"]);
  assert.equal(flagHelp.code, 0, flagHelp.stderr);
  assert.equal(flagHelp.stdout, logsHelp.stdout);
  for (const command of ["runs", "status", "doctor", "deploy", "organize", "list", "targets", "validate"]) {
    const result = await invoke(["help", command]);
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^bimo ${command} `));
  }

  const bogus = await invoke(["help", "bogus"]);
  assert.equal(bogus.code, 1);
  assert.match(bogus.stderr, /unknown command: bogus/);
});

test("runs, status, logs --follow, and doctor reject invalid options before Docker", async t => {
  const tools = await fakeDeployTools(t);
  for (const [args, pattern] of [
    [["runs"], /--deployment is invalid/],
    [["runs", "--deployment", "Fleet_Demo"], /--deployment is invalid/],
    [["status", "--deployment", "fleet-demo", "--run", "$(id)"], /--run is invalid/],
    [["logs", "--deployment", "fleet-demo", "--follow", "--run", "latest;id"], /--run is invalid/],
    [["doctor", "--secret-ref", "not-a-secret"], /--secret-ref must be a 1Password op:\/\/ reference/],
    [["runs", "--deployment", "fleet-demo", "--unknown", "value"], /unknown option: --unknown/],
  ]) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("failures print a structured JSON receipt on stdout when --json is requested", async () => {
  const failure = await invoke(["deploy", "react-app", "--deployment", "Fleet_Demo", "--json"]);
  assert.equal(failure.code, 1);
  const receipt = JSON.parse(failure.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.command, "deploy");
  assert.match(receipt.error.message, /--deployment must use lowercase letters/);
  assert.match(failure.stderr, /^bimo: --deployment must use lowercase letters/);

  const plain = await invoke(["deploy", "react-app", "--deployment", "Fleet_Demo"]);
  assert.equal(plain.code, 1);
  assert.equal(plain.stdout, "");
  assert.match(plain.stderr, /^bimo: --deployment must use lowercase letters/);
});

test("run heartbeat emits bounded phase lines until stopped", async () => {
  const lines = [];
  const heartbeat = startRunHeartbeat({
    runId: "run-1",
    intervalMs: 5,
    write: line => lines.push(line),
  });
  heartbeat.setPhase("preparing image");
  heartbeat.setPhase("unsafephase");
  await new Promise(resolve => setTimeout(resolve, 30));
  heartbeat.stop();
  const ticks = lines.length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(lines.length, ticks);
  assert.ok(ticks >= 1);
  for (const line of lines) {
    assert.match(line, /^run run-1: still working \(preparing image, \d+s elapsed\)\n$/);
  }
});

test("run progress streams bounded event lines and tolerates a missing run", async () => {
  const runId = "run-1";
  const eventA = JSON.stringify({
    version: 1, sequence: 1, timestamp: "2024-01-01T00:00:00.000Z", runId, type: "run.started",
  });
  const eventB = JSON.stringify({
    version: 1, sequence: 2, timestamp: "2024-01-01T00:01:00.000Z", runId,
    type: "gate.finished", status: "passed",
  });
  const chunk = `${eventA}\n${eventB}\n`;
  const offset = Buffer.byteLength(chunk);
  const reads = [];
  const phases = [];
  const lines = [];
  const abort = new AbortController();
  let calls = 0;
  const readChunk = async ({ runId: current, after }) => {
    calls += 1;
    reads.push(after);
    if (calls === 1) throw new Error("unknown run: run-1");
    if (calls >= 4) abort.abort();
    return { runId: current, offset, size: offset, chunk: calls === 2 ? chunk : "" };
  };
  await streamRunProgress({
    readChunk,
    runId,
    signal: abort.signal,
    pollMs: 1,
    write: line => lines.push(line),
    onEvent: event => phases.push(event.type),
  });
  assert.deepEqual(reads.slice(0, 3), [0, 0, offset]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "run run-1: 2024-01-01T00:00:00.000Z run.started\n");
  assert.equal(lines[1], "run run-1: 2024-01-01T00:01:00.000Z gate.finished passed\n");
  assert.ok(lines.every(line => line.length <= 321));
  assert.deepEqual(phases, ["run.started", "gate.finished"]);
});

test("organize prints the run ID on stderr once the run starts in human mode", async t => {
  const tools = await fakeDeployTools(t, { controller: "organize-success" });
  const args = organizeArgs("Build a small status page.", 1).filter(value => value !== "--json");
  const result = await invoke(args, { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  const stderrLines = result.stderr.trimEnd().split("\n");
  assert.match(stderrLines[0], /^run: \d{14}-[0-9a-f]{8}$/);
  assert.ok(stderrLines.every(line => line.length <= 320));
  assert.ok(result.stdout.includes(`run: ${stderrLines[0].slice(5)}`));
});

test("cancel and publish reject invalid options before Docker", async t => {
  const tools = await fakeDeployTools(t);
  for (const [args, pattern] of [
    [["cancel"], /--deployment is invalid/],
    [["cancel", "--deployment", "fleet-demo", "--run", "$(id)"], /--run is invalid/],
    [["cancel", "--deployment", "fleet-demo", "--unknown", "x"], /unknown option: --unknown/],
    [["publish", "--deployment", "Fleet_Demo", "--github-secret-ref", "op://a/b/c"], /--deployment is invalid/],
    [["publish", "--deployment", "fleet-demo", "--run", "bad;id", "--github-secret-ref", "op://a/b/c"], /--run is invalid/],
    [["publish", "--deployment", "fleet-demo"], /--github-secret-ref is required/],
  ]) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("cancel sends SIGTERM to the running controller or publisher on the target", async t => {
  const tools = await fakeDeployTools(t);
  const cancelArgs = [
    "cancel", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--json",
  ];
  const result = await invoke(cancelArgs, {
    env: { ...tools.env, BIMO_TEST_KILL: "bimo-fleet-demo-controller" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    deployment: "fleet-demo",
    run: null,
    signalled: ["bimo-fleet-demo-controller"],
  });
  const kills = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "docker-kill")
    .map(entry => entry.name);
  assert.deepEqual(kills, ["bimo-fleet-demo-controller", "bimo-fleet-demo-publisher"]);
  const commands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  const kill = commands.find(command => command[1] === "kill");
  assert.deepEqual(kill.slice(0, 4), ["docker", "kill", "--signal", "SIGTERM"]);

  const idle = await invoke(cancelArgs, { env: tools.env });
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /no running controller or publisher for deployment fleet-demo/);
  const receipt = JSON.parse(idle.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.command, "cancel");
});

test("cancel --run refuses a terminal run and signals a live one", async t => {
  const tools = await fakeDeployTools(t);
  const statusPayload = state => `${JSON.stringify({
    deployment: "fleet-demo", runId: "run-1", state, phase: null,
    startedAt: "2024-01-01T00:00:00.000Z", finishedAt: null, attempts: 1, lastEvent: null,
  })}\n`;
  const cancelArgs = [
    "cancel", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--run", "run-1", "--image", "bimo-workflow:test", "--json",
  ];
  const terminal = await invoke(cancelArgs, {
    env: { ...tools.env, BIMO_TEST_STATUS_OUTPUT: statusPayload("completed") },
  });
  assert.equal(terminal.code, 1);
  assert.match(terminal.stderr, /run run-1 is completed; nothing to cancel/);
  assert.equal((await readCommandLog(tools.logFile)).some(entry => entry.tool === "docker-kill"), false);

  const live = await invoke(cancelArgs, {
    env: {
      ...tools.env,
      BIMO_TEST_STATUS_OUTPUT: statusPayload("running"),
      BIMO_TEST_KILL: "bimo-fleet-demo-publisher",
    },
  });
  assert.equal(live.code, 0, live.stderr);
  assert.deepEqual(JSON.parse(live.stdout), {
    deployment: "fleet-demo",
    run: "run-1",
    signalled: ["bimo-fleet-demo-publisher"],
  });
});

test("publish resumes an idempotent publication through the isolated publisher container", async t => {
  const tools = await fakeDeployTools(t, { controller: "publish-resume-success" });
  const runId = "20240101000000-abcd1234";
  const result = await invoke([
    "publish", "--deployment", "pod-demo", "--run", runId,
    "--host", "example.invalid",
    "--github-secret-ref", "op://Test/Bimo publisher/github",
    "--image", "bimo-workflow:test",
    "--json",
  ], { env: tools.env });
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.status, "completed");
  assert.equal(response.runId, runId);
  assert.equal(response.headBranch, `bimo/${runId}`);
  assert.equal(response.publication.url, "https://github.com/zaycruz/bimo/pull/43");
  assert.equal(response.publication.draft, true);

  const entries = await readCommandLog(tools.logFile);
  const remoteCommands = entries.filter(entry => entry.tool === "ssh").map(entry => entry.command);
  const publisher = remoteCommands.find(command => command.includes("internal-publish-resume"));
  assert.ok(publisher, "resume publisher was not launched");
  assert.equal(publisher[publisher.indexOf("--name") + 1], "bimo-pod-demo-publisher");
  const hostRoot = "/var/lib/bimo/deployments/pod-demo";
  assert.ok(publisher.includes(`${hostRoot}/runs:/state:rw`));
  assert.ok(publisher.includes(`${hostRoot}/source:/source:rw`));
  assert.equal(publisher.some(value => value.includes("docker.sock")), false);
  assert.equal(publisher.some(value => value.includes("worktrees") || value.includes("snapshots")), false);

  const envelope = entries.find(entry => entry.tool === "publish-resume-envelope");
  assert.deepEqual(envelope.fields, ["runId", "token", "version"]);
  assert.equal(envelope.runId, runId);
  assert.equal(JSON.stringify(entries).includes(`github_pat_${"g".repeat(64)}`), false);
});

async function fakePublicationStore(t, { completed = false, interrupted = false, ready = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "bimo-resume-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "20240101000000-abcd1234";
  const publication = {
    number: 46,
    url: "https://github.com/zaycruz/bimo/pull/46",
    headBranch: `bimo/${runId}`,
    headSha: POD_CANDIDATE_SHA,
    targetBranch: "main",
    baseSha: POD_BASE_SHA,
    draft: true,
    created: true,
  };
  const binding = {
    repository: "https://github.com/zaycruz/bimo.git",
    targetBranch: "main",
    baseSha: POD_BASE_SHA,
    candidateSha: POD_CANDIDATE_SHA,
    headBranch: `bimo/${runId}`,
  };
  const store = await createPodRunStore({
    stateRoot: directory,
    runId,
    assignment: { task: "Build the bounded change." },
  });
  if (ready) await store.appendEvent("publication.ready", binding);
  if (completed || interrupted) {
    await store.appendEvent("publication.finished", { ...binding, publication });
  }
  if (completed) await store.finish("completed", { phase: "published", ...binding, publication });
  return { directory, runId, publication };
}

function resumeEnvelope(runId) {
  return JSON.stringify({ version: 1, runId, token: `github_pat_${"g".repeat(64)}` });
}

test("internal-publish-resume replays a completed publication with zero new side effects", async t => {
  const { directory, runId, publication } = await fakePublicationStore(t, { completed: true });
  const result = await invoke(["internal-publish-resume", "--state-root", directory], {
    input: resumeEnvelope(runId),
  });
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.publication.number, publication.number);
  assert.equal(receipt.publication.url, publication.url);
  const events = (await readFile(path.join(directory, runId, "events.jsonl"), "utf8"))
    .trim().split("\n");
  assert.equal(events.length, 3);
});

test("internal-publish-resume finishes an interrupted publication without Git or API work", async t => {
  const { directory, runId, publication } = await fakePublicationStore(t, { interrupted: true });
  const result = await invoke(["internal-publish-resume", "--state-root", directory], {
    input: resumeEnvelope(runId),
  });
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.publication.number, publication.number);
  const events = (await readFile(path.join(directory, runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), [
    "publication.ready", "publication.finished", "run.finished",
  ]);
  const record = JSON.parse(await readFile(path.join(directory, runId, "run.json"), "utf8"));
  assert.equal(record.status, "completed");
  assert.equal(record.phase, "published");
});

test("internal-publish-resume fails closed without durable publication evidence", async t => {
  const { directory, runId } = await fakePublicationStore(t, { ready: false });
  const result = await invoke(["internal-publish-resume", "--state-root", directory], {
    input: resumeEnvelope(runId),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(`no publication-ready record found for run ${runId}`));

  for (const [input, pattern] of [
    [{ version: 1, runId, token: "not-a-token" }, /publisher resume envelope is invalid/],
    [{ version: 1, runId, token: `github_pat_${"g".repeat(64)}`, extra: true }, /invalid shape/],
  ]) {
    const rejected = await invoke(["internal-publish-resume", "--state-root", directory], {
      input: JSON.stringify(input),
    });
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, pattern);
  }
});

test("help covers the cancel and publish commands", async () => {
  for (const command of ["cancel", "publish"]) {
    const result = await invoke(["help", command]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^bimo ${command} --deployment NAME`));
  }
  const usageText = await invoke(["help"]);
  assert.match(usageText.stdout, /^ {2}bimo cancel --deployment NAME/m);
  assert.match(usageText.stdout, /^ {2}bimo publish --deployment NAME/m);
});

test("read containers pass --pull=never and preflight image presence before running", async t => {
  const tools = await fakeDeployTools(t);
  const runsPayload = `${JSON.stringify({ deployment: "fleet-demo", runs: [] })}\n`;
  const result = await invoke([
    "runs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--json",
  ], { env: { ...tools.env, BIMO_TEST_RUNS_OUTPUT: runsPayload } });
  assert.equal(result.code, 0, result.stderr);

  const commands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  const inspect = commands.find(command => (
    command[0] === "docker" && command[1] === "image" && command[2] === "inspect"
  ));
  const read = commands.find(command => command.includes("internal-runs"));
  assert.ok(inspect, "image-presence preflight did not run");
  assert.ok(read.includes("--pull=never"));
  assert.ok(commands.indexOf(inspect) < commands.indexOf(read));
});

test("every docker run the CLI builds is pinned with --pull=never", async t => {
  const tools = await fakeDeployTools(t, { controller: "pod-success" });
  const result = await invoke(podDeployArgs(tools.taskFile), { env: tools.env });
  assert.equal(result.code, 0, result.stderr);

  const commands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  const runs = commands.filter(command => command[0] === "docker" && command[1] === "run");
  assert.ok(runs.length >= 2, "expected controller and publisher runs");
  for (const command of runs) {
    assert.ok(command.includes("--pull=never"), `missing --pull=never: ${command.join(" ")}`);
  }
});

test("logs reports a missing image without pulling or leaking the docker-login hint", async t => {
  const tools = await fakeDeployTools(t);
  const env = { ...tools.env, BIMO_TEST_IMAGE_MISSING: "1" };

  const remote = await invoke([
    "logs", "--deployment", "fleet-demo", "--host", "example.invalid", "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(remote.code, 1);
  assert.match(remote.stderr,
    /bimo image bimo-workflow:test is not built on the target yet; run bimo deploy first/);
  assert.doesNotMatch(remote.stderr, /docker login|pull access denied/i);

  const follow = await invoke([
    "logs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--follow",
  ], { env });
  assert.equal(follow.code, 1);
  assert.match(follow.stderr, /the run is still preparing its image/);
  assert.doesNotMatch(follow.stderr, /docker login|pull access denied/i);

  const local = await invoke([
    "logs", "--deployment", "fleet-demo", "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(local.code, 1);
  assert.match(local.stderr, /bimo image bimo-workflow:test is not built locally yet/);
  assert.doesNotMatch(local.stderr, /docker login|pull access denied/i);

  const commands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh" || entry.tool === "docker");
  assert.equal(commands.some(entry => {
    const command = entry.command ?? entry.args;
    return command.includes("internal-logs") || command.includes("internal-tail");
  }), false);
});

test("deploy and organize resolve --secret-ref before any image build", async t => {
  const deployTools = await fakeDeployTools(t);
  const deployResult = await invoke(deployArgs(deployTools.taskFile), { env: deployTools.env });
  assert.equal(deployResult.code, 1);
  const deployEntries = await readCommandLog(deployTools.logFile);
  const deployOp = deployEntries.findIndex(entry => entry.tool === "op");
  const deployBuild = deployEntries.findIndex(entry => (
    entry.tool === "docker" && entry.args[0] === "build"
  ));
  assert.ok(deployOp >= 0 && deployBuild >= 0 && deployOp < deployBuild);

  const organizeTools = await fakeDeployTools(t, { controller: "organize-success" });
  const organizeResult = await invoke(organizeArgs("Build a small status page."), {
    env: organizeTools.env,
  });
  assert.equal(organizeResult.code, 0, organizeResult.stderr);
  const organizeEntries = await readCommandLog(organizeTools.logFile);
  const organizeOp = organizeEntries.findIndex(entry => entry.tool === "op");
  const organizeBuild = organizeEntries.findIndex(entry => (
    entry.tool === "docker" && entry.args[0] === "build"
  ));
  assert.ok(organizeOp >= 0 && organizeBuild >= 0 && organizeOp < organizeBuild);
});

test("deploy, organize, and publish report a missing 1Password CLI before any Docker work", async t => {
  const tools = await fakeDeployTools(t, { missingOp: true });
  const env = {
    ...tools.env,
    PATH: `${path.dirname(tools.taskFile)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };

  const deployResult = await invoke(deployArgs(tools.taskFile), { env });
  assert.equal(deployResult.code, 1);
  assert.match(deployResult.stderr,
    /1Password CLI \(`op`\) not found; it is required to resolve --secret-ref/);
  assert.match(deployResult.stderr, /1password\.com/);
  assert.doesNotMatch(deployResult.stderr, /ENOENT/);

  const organizeResult = await invoke(organizeArgs("Build a small status page."), { env });
  assert.equal(organizeResult.code, 1);
  assert.match(organizeResult.stderr,
    /1Password CLI \(`op`\) not found; it is required to resolve --secret-ref/);

  const publishResult = await invoke([
    "publish", "--deployment", "pod-demo", "--host", "example.invalid",
    "--github-secret-ref", "op://Test/Bimo publisher/github", "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(publishResult.code, 1);
  assert.match(publishResult.stderr,
    /1Password CLI \(`op`\) not found; it is required to resolve --github-secret-ref/);

  const entries = await readCommandLog(tools.logFile);
  assert.equal(entries.some(entry => entry.tool === "docker" || entry.tool === "ssh"), false);
});

test("doctor reports a missing 1Password CLI as a bounded check failure", async t => {
  const tools = await fakeDeployTools(t, { missingOp: true });
  const env = {
    ...tools.env,
    PATH: `${path.dirname(tools.taskFile)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };
  const result = await invoke(["doctor", "--secret-ref", "op://Test/Bimo/key", "--json"], { env });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  const opCheck = report.checks.find(check => check.name === "op-cli");
  assert.equal(opCheck.status, "fail");
  assert.match(opCheck.reason, /1Password CLI \(`op`\) not found/);
  assert.doesNotMatch(opCheck.reason, /ENOENT/);
  assert.equal(report.checks.find(check => check.name === "secret-ref").status, "skip");
});

test("an unauthenticated 1Password CLI keeps its guidance under one bimo framing line", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke(deployArgs(tools.taskFile), {
    env: { ...tools.env, BIMO_TEST_OP_FAIL: "1" },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^bimo: failed to resolve --secret-ref via 1Password: /);
  assert.match(result.stderr, /op signin/);
  const entries = await readCommandLog(tools.logFile);
  assert.equal(entries.some(entry => entry.tool === "docker" && entry.args[0] === "build"), false);
});

test("internal-logs prints a friendly empty state when no runs are recorded", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "bimo-state-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const text = await invoke(["internal-logs", "--state-root", directory, "--deployment", "demo"]);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout, "no runs recorded for deployment demo\n");
  assert.equal(text.stderr, "");

  const json = await invoke([
    "internal-logs", "--state-root", directory, "--deployment", "demo", "--json",
  ]);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { deployment: "demo", run: null, events: [] });
});

test("nested docker error prefixes collapse to one bimo prefix per boundary", async t => {
  const tools = await fakeDeployTools(t);
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "bimo-home-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".local", "share", "bimo", "deployments", "fleet-demo", "runs"), {
    recursive: true,
  });
  const payload = "bimo: docker exited 1: bimo-agent: agent exited 1; errorStatus=401";
  const result = await invoke([
    "logs", "--deployment", "fleet-demo", "--image", "bimo-workflow:test", "--json",
  ], { env: { ...tools.env, HOME: home, BIMO_TEST_READ_FAIL: payload } });
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    `bimo: docker exited 1: ${payload.slice("bimo: ".length)}\n`,
  );
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.command, "logs");
  assert.equal(receipt.error.message, `docker exited 1: ${payload.slice("bimo: ".length)}`);
});

test("publish --json reports a run without a publication-ready record as a structured failure", async t => {
  const tools = await fakeDeployTools(t, { controller: "publish-resume-missing" });
  const runId = "20240101000000-abcd1234";
  const result = await invoke([
    "publish", "--deployment", "pod-demo", "--run", runId,
    "--host", "example.invalid",
    "--github-secret-ref", "op://Test/Bimo publisher/github",
    "--image", "bimo-workflow:test", "--json",
  ], { env: tools.env });
  assert.equal(result.code, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.command, "publish");
  assert.equal(receipt.error.message, `ssh exited 1: no publication-ready record found for run ${runId}`);
  assert.equal(
    result.stderr,
    `bimo: ssh exited 1: no publication-ready record found for run ${runId}\n`,
  );
});

test("internal-publish-resume names the run when no publication-ready record exists", async t => {
  const { directory } = await fakePublicationStore(t, { ready: false });
  const missing = await invoke(["internal-publish-resume", "--state-root", directory], {
    input: resumeEnvelope("20240909000000-ffff9999"),
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr,
    /no publication-ready record found for run 20240909000000-ffff9999/);
});

test("organize and deploy print no run ID when the run never starts", async t => {
  const tools = await fakeDeployTools(t);
  const env = { ...tools.env, BIMO_TEST_OP_FAIL: "1" };
  const organize = await invoke(
    organizeArgs("Build a small status page.").filter(value => value !== "--json"),
    { env },
  );
  assert.equal(organize.code, 1);
  assert.match(organize.stderr, /failed to resolve --secret-ref via 1Password/);
  assert.doesNotMatch(organize.stderr, /^run: /m);

  const deploy = await invoke(deployArgs(tools.taskFile).filter(value => value !== "--json"), { env });
  assert.equal(deploy.code, 1);
  assert.match(deploy.stderr, /failed to resolve --secret-ref via 1Password/);
  assert.doesNotMatch(deploy.stderr, /^run: /m);

  const commands = await readCommandLog(tools.logFile);
  assert.equal(commands.some(entry => (entry.command ?? entry.args ?? [])[0] === "rmdir"), false);
});

test("runs and status agree on attempts for a run recorded without currentAttempt", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "bimo-state-organizer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = "20240101000000-dddd4444";
  await mkdir(path.join(directory, runId));
  await writeFile(path.join(directory, runId, "run.json"), `${JSON.stringify({
    version: 1,
    runId,
    type: "organizer",
    status: "completed",
    promptSha256: "a".repeat(64),
    agents: 1,
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:05:00.000Z",
  }, null, 2)}\n`);
  await writeFile(path.join(directory, runId, "events.jsonl"), [
    JSON.stringify({
      version: 1, sequence: 1, timestamp: "2024-01-01T00:00:00.000Z", runId, type: "run.started",
    }),
    JSON.stringify({
      version: 1, sequence: 2, timestamp: "2024-01-01T00:05:00.000Z", runId,
      type: "run.completed", template: "react-app", templateDigest: "b".repeat(64),
    }),
  ].join("\n") + "\n");
  await writeFile(path.join(directory, "latest"), `${runId}\n`);

  const runs = await invoke(["internal-runs", "--state-root", directory, "--deployment", "demo", "--json"]);
  assert.equal(runs.code, 0, runs.stderr);
  assert.equal(JSON.parse(runs.stdout).runs[0].attempts, 1);

  const status = await invoke([
    "internal-status", "--state-root", directory, "--deployment", "demo", "--json",
  ]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).attempts, 1);
});

test("an unknown option without a value reports unknown, not a missing value", async t => {
  const tools = await fakeDeployTools(t);
  for (const [args, pattern] of [
    [["deploy", "react-app", "--bogus"], /unknown option: --bogus/],
    [["organize", "-p", "Build a small status page.", "--bogus"], /unknown option: --bogus/],
    [["logs", "--deployment", "fleet-demo", "--bogus"], /unknown option: --bogus/],
    [["runs", "--deployment", "fleet-demo", "--bogus"], /unknown option: --bogus/],
    [["status", "--deployment", "fleet-demo", "--bogus"], /unknown option: --bogus/],
    [["doctor", "--bogus"], /unknown option: --bogus/],
    [["cancel", "--deployment", "fleet-demo", "--bogus"], /unknown option: --bogus/],
    [["publish", "--deployment", "fleet-demo", "--bogus"], /unknown option: --bogus/],
    [["status", "--deployment"], /--deployment requires a value/],
  ]) {
    const result = await invoke(args, { env: tools.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("the -n range error names the flag the user typed", async t => {
  const tools = await fakeDeployTools(t);
  const common = [
    "--deployment", "organizer-demo", "--host", "example.invalid",
    "--secret-ref", "op://Test/Bimo/openrouter",
  ];
  const short = await invoke([
    "organize", "-p", "Build a small status page.", "-n", "5", ...common,
  ], { env: tools.env });
  assert.equal(short.code, 1);
  assert.match(short.stderr, /-n must be an integer from 1 to 3/);

  const long = await invoke([
    "organize", "--prompt", "Build a small status page.", "--agents", "5", ...common,
  ], { env: tools.env });
  assert.equal(long.code, 1);
  assert.match(long.stderr, /--agents must be an integer from 1 to 3/);
  assert.deepEqual(await readCommandLog(tools.logFile), []);
});

test("bimo version aliases --version and exits 0", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const result = await invoke(["version"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, "");
});

test("organize and deploy help name the OpenRouter key and deploy shows --public-url", async () => {
  const deploy = await invoke(["help", "deploy"]);
  assert.equal(deploy.code, 0, deploy.stderr);
  assert.match(deploy.stdout, /--public-url URL/);
  assert.match(deploy.stdout, /--secret-ref must resolve to an OpenRouter API key/);

  const organize = await invoke(["help", "organize"]);
  assert.equal(organize.code, 0, organize.stderr);
  assert.match(organize.stdout, /--secret-ref must resolve to an OpenRouter API key/);
});

test("failed deploy and organize reap the empty deployment state they prepared", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke(deployArgs(tools.taskFile), { env: tools.env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /controller name is already in use/);
  const remoteCommands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  const hostRoot = "/var/lib/bimo/deployments/fleet-demo";
  const controllerIndex = remoteCommands.findIndex(command => command.includes("internal-run"));
  const reapIndex = remoteCommands.findIndex(command => command[0] === "rmdir");
  assert.ok(controllerIndex >= 0, "controller was not launched");
  assert.ok(reapIndex > controllerIndex, "empty deployment state was not reaped");
  assert.deepEqual(remoteCommands[reapIndex], [
    "rmdir", `${hostRoot}/runs`, `${hostRoot}/workspace`, hostRoot,
  ]);
});

test("a failed organize reaps the empty deployment state it prepared", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke(organizeArgs("Build a small status page."), { env: tools.env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /controller name is already in use/);
  const remoteCommands = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command);
  const hostRoot = "/var/lib/bimo/deployments/organizer-demo";
  const controllerIndex = remoteCommands.findIndex(command => command.includes("internal-organize"));
  const reapIndex = remoteCommands.findIndex(command => command[0] === "rmdir");
  assert.ok(controllerIndex >= 0, "controller was not launched");
  assert.ok(reapIndex > controllerIndex, "empty deployment state was not reaped");
  assert.deepEqual(remoteCommands[reapIndex], [
    "rmdir", `${hostRoot}/runs`, `${hostRoot}/worktrees`, hostRoot,
  ]);
});

test("read commands report an absent deployment without creating state on the target", async t => {
  const tools = await fakeDeployTools(t);
  const env = { ...tools.env, BIMO_TEST_STATE_MISSING: "1" };
  const runId = "20240101000000-abcd1234";

  const runs = await invoke([
    "runs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--json",
  ], { env });
  assert.equal(runs.code, 0, runs.stderr);
  assert.deepEqual(JSON.parse(runs.stdout), { deployment: "fleet-demo", runs: [] });

  const status = await invoke([
    "status", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--json",
  ], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    deployment: "fleet-demo", runId: null, state: "none", phase: null,
    startedAt: null, finishedAt: null, attempts: 0, lastEvent: null,
  });

  const statusRun = await invoke([
    "status", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--run", runId, "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(statusRun.code, 1);
  assert.match(statusRun.stderr, new RegExp(`unknown run: ${runId}`));

  const logs = await invoke([
    "logs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(logs.code, 0, logs.stderr);
  assert.equal(logs.stdout, "no runs recorded for deployment fleet-demo\n");

  const logsRun = await invoke([
    "logs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--run", runId, "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(logsRun.code, 1);
  assert.match(logsRun.stderr, new RegExp(`unknown run: ${runId}`));

  const follow = await invoke([
    "logs", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test", "--follow",
  ], { env });
  assert.equal(follow.code, 0, follow.stderr);
  assert.equal(follow.stdout, "no runs recorded for deployment fleet-demo\n");

  const cancel = await invoke([
    "cancel", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--run", runId, "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(cancel.code, 1);
  assert.match(cancel.stderr, new RegExp(`unknown run: ${runId}`));

  const publish = await invoke([
    "publish", "--deployment", "pod-demo", "--host", "example.invalid",
    "--run", runId, "--github-secret-ref", "op://Test/Bimo publisher/github",
    "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(publish.code, 1);
  assert.match(publish.stderr, new RegExp(`no publication-ready record found for run ${runId}`));

  const publishLatest = await invoke([
    "publish", "--deployment", "pod-demo", "--host", "example.invalid",
    "--github-secret-ref", "op://Test/Bimo publisher/github", "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(publishLatest.code, 1);
  assert.match(publishLatest.stderr, /no latest run is recorded/);

  const internals = (await readCommandLog(tools.logFile))
    .filter(entry => entry.tool === "ssh")
    .map(entry => entry.command)
    .filter(command => command.some(value => value.startsWith("internal-")));
  assert.deepEqual(internals, []);
});

test("local read commands report an absent deployment without creating state directories", async t => {
  const tools = await fakeDeployTools(t);
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "bimo-home-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...tools.env, HOME: home };

  const logs = await invoke([
    "logs", "--deployment", "fleet-demo", "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(logs.code, 0, logs.stderr);
  assert.equal(logs.stdout, "no runs recorded for deployment fleet-demo\n");

  const runs = await invoke([
    "runs", "--deployment", "fleet-demo", "--image", "bimo-workflow:test", "--json",
  ], { env });
  assert.equal(runs.code, 0, runs.stderr);
  assert.deepEqual(JSON.parse(runs.stdout), { deployment: "fleet-demo", runs: [] });

  const status = await invoke([
    "status", "--deployment", "fleet-demo", "--image", "bimo-workflow:test",
  ], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /state: none/);

  assert.equal((await readdir(home)).includes(".local"), false);
});

test("cancel pins the terminal vocabulary of a cancelled run", async t => {
  const tools = await fakeDeployTools(t);
  const result = await invoke([
    "cancel", "--deployment", "fleet-demo", "--host", "example.invalid",
    "--image", "bimo-workflow:test",
  ], { env: { ...tools.env, BIMO_TEST_KILL: "bimo-fleet-demo-controller" } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    "sent SIGTERM to bimo-fleet-demo-controller;"
      + " the run will finish as failed with reason 'deployment cancelled'\n",
  );
});

test("SIGINT to an attached deploy detaches with a cancel hint and exit 130", async t => {
  const tools = await fakeDeployTools(t, { controller: "hang" });
  const child = spawn(process.execPath, [cli, ...deployArgs(tools.taskFile)], {
    cwd: root,
    env: tools.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const deadline = Date.now() + 10_000;
  let launched = false;
  while (Date.now() < deadline && !launched) {
    const log = await readFile(tools.logFile, "utf8").catch(() => "");
    launched = log.includes("internal-run");
    if (!launched) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(launched, "controller was not launched");
  child.kill("SIGINT");
  const code = await new Promise(resolve => child.on("close", resolve));
  assert.equal(code, 130);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(
    Buffer.concat(stderr).toString("utf8"),
    "detaching; the run continues on the target"
      + " — use bimo cancel --deployment fleet-demo to stop it\n",
  );
});
