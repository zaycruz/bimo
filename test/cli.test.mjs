import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";

import { runController } from "../src/monolith.mjs";
import { loadWorkflow } from "../src/workflow.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "bin", "monolith");

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
const BASE_CONFIG = {
  Entrypoint: ["/app/bin/monolith"],
  Env: ["NODE_ENV=production"],
  WorkingDir: "/app",
  Labels: { "dev.ascii.monolith": "workflow" },
};
const REORDERED_CONFIG = {
  Labels: { "dev.ascii.monolith": "workflow" },
  WorkingDir: "/app",
  Env: ["NODE_ENV=production"],
  Entrypoint: ["/app/bin/monolith"],
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

function imageInspect(imageId, { config = BASE_CONFIG, layers = BASE_LAYERS } = {}) {
  return JSON.stringify([{
    Id: imageId,
    Architecture: "amd64",
    Os: "linux",
    Config: config,
    RootFS: { Type: "layers", Layers: layers },
  }]);
}

async function fakeDeployTools(t, {
  remoteImageId = REMOTE_IMAGE_ID,
  remoteConfig = REORDERED_CONFIG,
  remoteLayers = BASE_LAYERS,
  controller = "conflict",
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "monolith-cli-test-"));
  const logFile = path.join(directory, "commands.jsonl");
  const taskFile = path.join(directory, "task.txt");
  await writeFile(logFile, "");
  await writeFile(taskFile, "Build the test application.\n");

  const docker = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MONOLITH_TEST_LOG, JSON.stringify({ tool: "docker", args }) + "\\n");
if (args[0] === "image" && args[1] === "inspect") process.stdout.write(process.env.MONOLITH_TEST_LOCAL_INSPECT + "\\n");
else if (args[0] === "save") process.stdout.write("fake-image-archive");
`;
  const ssh = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.slice(5);
const log = value => fs.appendFileSync(process.env.MONOLITH_TEST_LOG, JSON.stringify(value) + "\\n");
log({ tool: "ssh", args, command });
if (command[0] === "docker" && command[1] === "load") {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write("Loaded image\\n"));
} else if (command[0] === "docker" && command[1] === "image" && command[2] === "inspect") {
  process.stdout.write(process.env.MONOLITH_TEST_REMOTE_INSPECT + "\\n");
} else if (command[0] === "docker" && command[1] === "run") {
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
    if (process.env.MONOLITH_TEST_CONTROLLER === "conflict") {
      process.stderr.write("Conflict: controller name is already in use\\n");
      process.exitCode = 125;
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
require("node:fs").appendFileSync(process.env.MONOLITH_TEST_LOG, JSON.stringify({ tool: "op" }) + "\\n");
process.stdout.write("sk-or-v1-${"k".repeat(32)}\\n");
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
      MONOLITH_TEST_LOG: logFile,
      MONOLITH_TEST_LOCAL_INSPECT: imageInspect(LOCAL_IMAGE_ID),
      MONOLITH_TEST_REMOTE_INSPECT: imageInspect(remoteImageId, { config: remoteConfig, layers: remoteLayers }),
      MONOLITH_TEST_CONTROLLER: controller,
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
    "--secret-ref", "op://Test/Monolith/key",
    "--public-url", "http://example.invalid:8080",
    "--image", "monolith-workflow:test",
    "--json",
  ];
}

test("the installed CLI lists the packaged React workflow", async () => {
  const result = await run("list", "--json");
  assert.deepEqual(result.templates.map(template => template.name), ["react-app", "react-solo"]);
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
    "--host-root", "/var/lib/monolith/deployments/fleet-demo",
  ], { input: JSON.stringify(envelope) });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /template digest does not match/);

  envelope.templateDigest = "$(id)";
  const injection = await invoke([
    "internal-run",
    "--host-root", "/var/lib/monolith/deployments/fleet-demo",
  ], { input: JSON.stringify(envelope) });
  assert.equal(injection.code, 1);
  assert.match(injection.stderr, /controller envelope is invalid/);
});

test("deploy rejects image shell syntax before local execution", async () => {
  for (const image of ["monolith:latest;id", "$(id)", "monolith:latest\nid"]) {
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
      assert.match(transferTag, /^monolith-transfer:[a-f0-9]{12}-[a-f0-9]{32}$/);
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
  assert.match(localTag[3], /^monolith-transfer:[a-f0-9]{12}-[a-f0-9]{32}$/);
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
    command[0] === "docker" && command[1] === "rm" && command.includes("monolith-fleet-demo-controller")
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

test("controller signal cancellation aborts runtime and prevents verify or publish", async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), "monolith-controller-test-"));
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
