import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentCreateArgs,
  bootstrapArgs,
  DockerRuntime,
  proxyCreateArgs,
  serverCreateArgs,
  snapshotDirectory,
  sourceVerifierCreateArgs,
} from "../src/docker-runtime.mjs";

const IMAGE = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APP_ID = "b".repeat(64);
const SECRET = `sk-or-v1-${"a".repeat(40)}`;
const common = { deployment: "demo", image: IMAGE };
const workflow = {
  output: {
    directory: "dist",
    maxFiles: 100,
    maxBytes: 1_000_000,
    smoke: { path: "/", status: 200, contains: "Bimo" },
  },
};

function dockerResult(overrides = {}) {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function appInspect(args, { id = APP_ID, running = true } = {}) {
  if (args.at(-1).includes("backup") && args.includes("{{.Id}}")) {
    return dockerResult({ code: 1, stderr: "Error: No such container\n" });
  }
  return dockerResult({ stdout: `${id} ${running}\n` });
}

function futureDeadline(milliseconds = 30_000) {
  return Date.now() + milliseconds;
}

function stallUntilAborted({ signal } = {}) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("command aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function receiptFor(files) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const relative of Object.keys(files).sort()) {
    const content = Buffer.from(files[relative]);
    bytes += content.length;
    hash.update(`${relative}\0${content.length}\0`);
    hash.update(content);
  }
  return { files: Object.keys(files).length, bytes, sha256: hash.digest("hex") };
}

function createRuntime(overrides = {}) {
  return new DockerRuntime({
    image: IMAGE,
    deployment: "demo",
    hostRoot: "/var/lib/bimo/deployments/demo",
    key: SECRET,
    model: "openrouter/deepseek/deepseek-v4-flash",
    port: 8080,
    publicUrl: "https://bimo.example",
    ...overrides,
  });
}

test("runtime host root is bound to its deployment name", () => {
  assert.doesNotThrow(() => createRuntime({
    hostRoot: "/Users/tester/.local/share/bimo/deployments/demo",
    localHome: "/Users/tester",
  }));
  assert.throws(
    () => createRuntime({ hostRoot: "/var/lib/bimo/deployments/another" }),
    /host root must match deployment/,
  );
  assert.throws(
    () => createRuntime({ stateRoot: "/state/../state" }),
    /state root must be canonical/,
  );
});

test("legacy role execution rejects foreign and symlinked run directories before Docker", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-run-root-"));
  t.after(() => cleanupTemporary(temporary));
  const stateRoot = path.join(temporary, "state");
  const outside = path.join(temporary, "outside");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await mkdir(path.join(outside, "run-1"), { mode: 0o700 });
  await symlink(path.join(outside, "run-1"), path.join(stateRoot, "run-1"));
  const runtime = createRuntime({ stateRoot });
  let dockerCalls = 0;
  runtime.command = async () => {
    dockerCalls += 1;
    return dockerResult();
  };
  const input = {
    role: "qa",
    step: 1,
    attempt: 1,
    access: "read",
    prompt: "bounded prompt",
    timeoutSeconds: 60,
    workspace: "/ignored",
  };
  await assert.rejects(
    runtime.runRole({ ...input, runDir: path.join(outside, "run-1") }),
    /run directory must match state root/,
  );
  await assert.rejects(
    runtime.runRole({ ...input, runDir: path.join(stateRoot, "run-1") }),
    /run directory must be a private regular directory/,
  );
  assert.equal(dockerCalls, 0);
});

function mode(stat) {
  return stat.mode & 0o777;
}

async function makeWritable(target) {
  const stat = await lstat(target).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await makeWritable(path.join(target, entry));
    }
  } else {
    await chmod(target, 0o600);
  }
}

async function cleanupTemporary(target) {
  await makeWritable(target);
  await rm(target, { recursive: true, force: true });
}

test("agent containers use only the isolated agent network and external prompt mount", () => {
  const args = agentCreateArgs({
    ...common,
    role: "qa",
    step: 2,
    network: "bimo-demo-agents",
    workspaceHost: "/var/lib/bimo/deployments/demo/workspace",
    handoffHost: "/var/lib/bimo/deployments/demo/runs/run-1/attempts/qa/handoff",
    promptHost: "/var/lib/bimo/deployments/demo/runs/run-1/attempts/qa/instructions.md",
    access: "read",
    model: "openrouter/deepseek/deepseek-v4-flash",
    timeoutSeconds: 1200,
  });
  const rendered = args.join(" ");

  assert.match(rendered, /--network bimo-demo-agents/);
  assert.match(rendered, /BIMO_GATEWAY_URL=http:\/\/gateway:8787\/api\/v1/);
  assert.match(rendered, /dst=\/workspace,readonly/);
  assert.match(rendered, /instructions\.md,dst=\/instructions\/instructions\.md,readonly/);
  assert.match(rendered, /--read-only/);
  assert.match(rendered, /--cap-drop ALL/);
  assert.match(rendered, /no-new-privileges/);
  assert.match(rendered, /--ulimit fsize=8388608:8388608/);
  assert.doesNotMatch(rendered, /--network container:|127\.0\.0\.1:8787|\.bimo-instructions/);
  assert.doesNotMatch(rendered, /OPENROUTER_API_KEY|sk-or-|docker\.sock|\/state|Users\/|\.ssh/);
});

test("only Engineering receives a writable shared workspace", () => {
  const args = agentCreateArgs({
    ...common,
    role: "engineering",
    step: 1,
    network: "bimo-demo-agents",
    workspaceHost: "/var/lib/bimo/deployments/demo/workspace",
    handoffHost: "/var/lib/bimo/deployments/demo/runs/run-1/attempts/engineering/handoff",
    promptHost: "/var/lib/bimo/deployments/demo/runs/run-1/attempts/engineering/instructions.md",
    access: "write",
    model: "openrouter/deepseek/deepseek-v4-flash",
    timeoutSeconds: 1200,
  });
  assert.match(args.join(" "), /dst=\/workspace(?: |$)/);
  assert.doesNotMatch(args.join(" "), /dst=\/workspace,readonly/);
});

test("every container run or create is pinned to the local image with --pull=never", () => {
  const receipt = { files: 12, bytes: 4_096, sha256: "c".repeat(64) };
  const cases = [
    bootstrapArgs({ ...common, workspaceHost: "/var/lib/bimo/deployments/demo/workspace" }),
    proxyCreateArgs({
      ...common,
      network: "bimo-demo-agents",
      model: "openrouter/deepseek/deepseek-v4-flash",
    }),
    agentCreateArgs({
      ...common,
      role: "qa",
      step: 2,
      network: "bimo-demo-agents",
      workspaceHost: "/var/lib/bimo/deployments/demo/workspace",
      handoffHost: "/var/lib/bimo/deployments/demo/runs/run-1/attempts/qa/handoff",
      promptHost: "/var/lib/bimo/deployments/demo/runs/run-1/attempts/qa/instructions.md",
      access: "read",
      model: "openrouter/deepseek/deepseek-v4-flash",
      timeoutSeconds: 1200,
    }),
    serverCreateArgs({
      ...common,
      outputHost: "/var/lib/bimo/deployments/demo/runs/run-1/artifact",
      port: 8080,
    }),
    sourceVerifierCreateArgs({
      deployment: "demo",
      hostRoot: "/var/lib/bimo/deployments/demo",
      image: IMAGE,
      snapshotHost: "/var/lib/bimo/deployments/demo/snapshots/run-1/candidate-1",
      expectedSha: "d".repeat(40),
      expectedSnapshot: receipt,
      profile: "bimo-repo-v1",
      suite: "candidate",
      timeoutSeconds: 300,
      nameSuffix: "source-candidate",
    }),
  ];
  for (const args of cases) {
    assert.ok(["run", "create"].includes(args[0]));
    assert.equal(args[1], "--pull=never");
  }
});

test("bootstrap is fixed, offline, and receives only the writable workspace", () => {
  const args = bootstrapArgs({
    ...common,
    workspaceHost: "/var/lib/bimo/deployments/demo/workspace",
  });
  const rendered = args.join(" ");

  assert.deepEqual(args.slice(0, 4), ["run", "--pull=never", "--rm", "--name"]);
  assert.match(rendered, /--label dev\.ascii\.bimo\.deployment=demo/);
  assert.match(rendered, /--label dev\.ascii\.bimo\.transient=true/);
  assert.match(rendered, /--network none --read-only/);
  assert.match(rendered, /src=\/var\/lib\/bimo\/deployments\/demo\/workspace,dst=\/workspace(?: |$)/);
  assert.deepEqual(args.slice(-2), [IMAGE, "bootstrap"]);
  assert.doesNotMatch(rendered, /gateway|registry|OPENROUTER|sk-or-/);
  assert.doesNotMatch(rendered, /dst=\/workspace,readonly/);
});

test("credential gateway is isolated-listener policy with a hard lifetime", () => {
  const args = proxyCreateArgs({
    ...common,
    network: "bimo-demo-agents",
    model: "openrouter/deepseek/deepseek-v4-flash",
  });
  const rendered = args.join(" ");
  assert.match(rendered, /--network bimo-demo-agents/);
  assert.match(rendered, /--network-alias gateway/);
  assert.match(rendered, /--listen-scope isolated-network/);
  assert.match(rendered, /--lifetime-seconds 3600/);
  assert.match(rendered, /--model deepseek\/deepseek-v4-flash/);
  assert.match(rendered, /--max-requests 100/);
  assert.match(rendered, /--max-concurrency 1/);
  assert.match(rendered, /--interactive/);
  assert.doesNotMatch(rendered, /OPENROUTER_API_KEY|sk-or-/);
});

test("start bootstraps offline, creates two networks, and dual-homes only the proxy", async () => {
  const runtime = createRuntime();
  const calls = [];
  runtime.command = async (args) => {
    calls.push(args);
    if (args[0] === "create" && args.includes("proxy")) {
      return dockerResult({ stdout: "proxy-id\n" });
    }
    return dockerResult();
  };
  runtime.startProxy = (containerId, input) => {
    calls.push(["start-attached", containerId, input.endsWith("\n")]);
    return { kill() {} };
  };

  await runtime.start({ deadlineAt: futureDeadline() });

  const bootstrap = calls.find(args => args[0] === "run" && args.includes("bootstrap"));
  const agentNetwork = calls.find(args => args[0] === "network" && args[1] === "create" && args.includes("--internal"));
  const egressNetwork = calls.find(args => args[0] === "network" && args[1] === "create" && !args.includes("--internal"));
  const proxyCreate = calls.find(args => args[0] === "create" && args.includes("proxy"));
  const networkConnect = calls.find(args => args[0] === "network" && args[1] === "connect");
  const readinessProbe = calls.find(args => args[0] === "run" && args.includes("probe"));
  assert.deepEqual(bootstrap.slice(0, 4), [
    "run", "--pull=never", "--rm", "--name",
  ]);
  assert(agentNetwork.includes("bimo-demo-agents"));
  assert(egressNetwork.includes("bimo-demo-egress"));
  assert.equal(proxyCreate[proxyCreate.indexOf("--network") + 1], "bimo-demo-agents");
  assert.equal(proxyCreate[proxyCreate.indexOf("--max-requests") + 1], "100");
  assert.deepEqual(networkConnect, ["network", "connect", "bimo-demo-egress", "proxy-id"]);
  assert(calls.some(args => args[0] === "start-attached" && args[1] === "proxy-id"));
  assert.equal(readinessProbe[readinessProbe.indexOf("--network") + 1], "bimo-demo-agents");
  assert.match(readinessProbe.join(" "), /http:\/\/gateway:8787\/healthz/);
  assert.doesNotMatch(calls.flat().join(" "), /--network container:/);
  assert.equal(runtime.key, null);
});

test("pod startup skips the React bootstrap but keeps the isolated credential gateway", async () => {
  const runtime = new DockerRuntime({
    image: IMAGE,
    deployment: "demo",
    hostRoot: "/var/lib/bimo/deployments/demo",
    key: SECRET,
    model: "openrouter/deepseek/deepseek-v4-flash",
    modelConcurrency: 3,
    modelRequestLimit: 300,
  });
  const calls = [];
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "create" && args.includes("proxy")) {
      return dockerResult({ stdout: "proxy-id\n" });
    }
    return dockerResult();
  };
  runtime.startProxy = () => ({ kill() {} });

  await runtime.start({ deadlineAt: futureDeadline(), bootstrap: false });

  assert.equal(calls.some(args => args[0] === "run" && args.includes("bootstrap")), false);
  assert(calls.some(args => args[0] === "network" && args[1] === "create" && args.includes("--internal")));
  const proxyCreate = calls.find(args => args[0] === "create" && args.includes("proxy"));
  assert(proxyCreate);
  assert.equal(proxyCreate[proxyCreate.indexOf("--max-concurrency") + 1], "3");
  assert.equal(proxyCreate[proxyCreate.indexOf("--max-requests") + 1], "300");
  assert(calls.some(args => args[0] === "run" && args.includes("probe")));
});

test("close removes both deployment networks after removing the proxy", async () => {
  const runtime = createRuntime();
  const calls = [];
  let killed = false;
  runtime.proxyId = "proxy-id";
  runtime.proxyProcess = { kill() { killed = true; } };
  runtime.agentNetworkCreated = true;
  runtime.egressNetworkCreated = true;
  runtime.command = async (args) => {
    calls.push(args);
    return dockerResult();
  };

  await runtime.close();

  assert.deepEqual(calls, [
    ["rm", "-f", "proxy-id"],
    ["network", "rm", "bimo-demo-agents"],
    ["network", "rm", "bimo-demo-egress"],
  ]);
  assert.equal(killed, true);
  assert.equal(runtime.key, null);
});

test("a failed proxy start cleans both networks created by this runtime", async () => {
  const runtime = createRuntime();
  const calls = [];
  runtime.command = async (args) => {
    calls.push(args);
    if (args[0] === "create" && args.includes("proxy")) throw new Error("proxy create failed");
    return dockerResult();
  };

  await assert.rejects(runtime.start({ deadlineAt: futureDeadline() }), /proxy create failed/);

  assert.deepEqual(calls.slice(-3), [
    ["rm", "-f", "bimo-demo-gateway"],
    ["network", "rm", "bimo-demo-agents"],
    ["network", "rm", "bimo-demo-egress"],
  ]);
  assert.equal(runtime.agentNetworkCreated, false);
  assert.equal(runtime.egressNetworkCreated, false);
  assert.equal(runtime.key, null);
});

test("runRole never creates or deletes a workspace instruction placeholder", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-role-"));
  t.after(() => cleanupTemporary(temporary));
  const workspace = path.join(temporary, "workspace");
  const runDir = path.join(temporary, "run-1");
  await mkdir(workspace);
  await mkdir(runDir, { mode: 0o700 });
  const preexisting = path.join(workspace, ".bimo-instructions.md");
  await writeFile(preexisting, "user-owned\n");

  const runtime = createRuntime({ stateRoot: temporary });
  let createArgs;
  const calls = [];
  runtime.command = async (args) => {
    calls.push(args);
    if (args[0] === "create") {
      createArgs = args;
      throw new Error("stop before Docker create");
    }
    return dockerResult();
  };

  await assert.rejects(runtime.runRole({
    role: "qa",
    step: 1,
    attempt: 1,
    access: "read",
    prompt: "bounded prompt",
    timeoutSeconds: 60,
    runDir,
    workspace,
  }), /stop before Docker create/);

  assert.equal(await readFile(preexisting, "utf8"), "user-owned\n");
  assert.match(createArgs.join(" "), /dst=\/instructions\/instructions\.md,readonly/);
  assert.doesNotMatch(createArgs.join(" "), /\.bimo-instructions/);
  assert(calls.some(args => args.join(" ") === "rm -f bimo-demo-qa-1"));
});

test("runAgentExecution mounts one isolated pod worktree and rejects paths outside the deployment", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-pod-role-"));
  t.after(() => cleanupTemporary(temporary));
  const stateRoot = path.join(temporary, "state");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(path.join(stateRoot, "run-1"), { mode: 0o700 });

  const runtime = createRuntime({ stateRoot });
  let createArgs;
  runtime.command = async args => {
    if (args[0] === "create") {
      createArgs = args;
      throw new Error("stop before Docker create");
    }
    return dockerResult();
  };

  const workspaceHost = "/var/lib/bimo/deployments/demo/worktrees/run-1/attempt-1-engineering-a";
  const ownedSource = `${workspaceHost}/src/owned`;
  await assert.rejects(runtime.runAgentExecution({
    executionId: "attempt-1-engineering-a",
    role: "engineering-a",
    attempt: 1,
    access: "write",
    prompt: "bounded pod prompt",
    timeoutSeconds: 60,
    runId: "run-1",
    workspaceId: "attempt-1-engineering-a",
    writeDirectories: ["src/owned"],
  }), /stop before Docker create/);

  assert.match(createArgs.join(" "), new RegExp(`src=${workspaceHost.replaceAll("/", "\\/")},dst=\\/workspace,readonly`));
  assert.match(createArgs.join(" "), /src=\/dev\/null,dst=\/workspace\/\.git,readonly/);
  assert.match(createArgs.join(" "), new RegExp(`src=${ownedSource.replaceAll("/", "\\/")},dst=\\/workspace\\/src\\/owned(?: |$)`));
  assert.match(createArgs.join(" "), /--name bimo-demo-attempt-1-engineering-a/);

  createArgs = undefined;
  await assert.rejects(runtime.runAgentExecution({
    executionId: "attempt-1-engineering-a",
    role: "engineering-a",
    attempt: 1,
    access: "write",
    prompt: "bounded pod prompt",
    timeoutSeconds: 60,
    runId: "run-1",
    workspaceId: "attempt-1-engineering-a",
  }), /invalid writable workspace directories/);
  assert.equal(createArgs, undefined);

  await assert.rejects(runtime.runAgentExecution({
    executionId: "attempt-1-engineering-a",
    role: "engineering-a",
    attempt: 1,
    access: "write",
    prompt: "bounded pod prompt",
    timeoutSeconds: 60,
    runId: "../outside",
    workspaceId: "attempt-1-engineering-a",
    writeDirectories: ["src"],
  }), /invalid agent run ID/);

  await assert.rejects(runtime.runAgentExecution({
    executionId: "attempt-1-engineering-a",
    role: "engineering-a",
    attempt: 1,
    access: "write",
    prompt: "bounded pod prompt",
    timeoutSeconds: 60,
    runId: "run-1",
    workspaceId: "attempt-1-engineering-a",
    writeDirectories: [".git"],
  }), /invalid writable workspace directory/);
});

test("source verification containers receive only immutable snapshots and no controller authority", () => {
  const receipt = { files: 12, bytes: 4_096, sha256: "c".repeat(64) };
  const candidate = sourceVerifierCreateArgs({
    deployment: "demo",
    hostRoot: "/var/lib/bimo/deployments/demo",
    image: IMAGE,
    snapshotHost: "/var/lib/bimo/deployments/demo/snapshots/run-1/candidate-1",
    expectedSha: "d".repeat(40),
    expectedSnapshot: receipt,
    profile: "bimo-repo-v1",
    suite: "candidate",
    timeoutSeconds: 300,
    nameSuffix: "source-candidate",
  });
  const baseline = sourceVerifierCreateArgs({
    deployment: "demo",
    hostRoot: "/var/lib/bimo/deployments/demo",
    image: IMAGE,
    snapshotHost: "/var/lib/bimo/deployments/demo/snapshots/run-1/candidate-1",
    baselineTestHost: "/var/lib/bimo/deployments/demo/snapshots/run-1/base/test",
    expectedSha: "d".repeat(40),
    profile: "bimo-repo-v1",
    suite: "baseline",
    timeoutSeconds: 300,
    nameSuffix: "source-baseline",
  });

  const renderedCandidate = candidate.join(" ");
  const renderedBaseline = baseline.join(" ");
  assert.match(renderedCandidate, /--network none/);
  assert.match(renderedCandidate, /dst=\/workspace,readonly/);
  assert.match(renderedCandidate, /source-verify --workspace \/workspace/);
  assert.match(renderedCandidate, /--expected-files 12 --expected-bytes 4096/);
  assert.match(renderedCandidate, new RegExp(`--expected-snapshot-sha ${"c".repeat(64)}`));
  assert.match(renderedBaseline, /dst=\/workspace\/test,readonly/);
  for (const rendered of [renderedCandidate, renderedBaseline]) {
    assert.match(rendered, /--tmpfs \/tmp:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000/);
    assert.match(rendered, /--tmpfs \/test-tools:rw,exec,nosuid,nodev,size=32m,uid=1000,gid=1000/);
    assert.doesNotMatch(rendered, /docker\.sock|dst=\/state|BIMO_GATEWAY|sk-or-v1|github_pat_/);
  }

  const local = sourceVerifierCreateArgs({
    deployment: "demo",
    hostRoot: "/Users/tester/.local/share/bimo/deployments/demo",
    localHome: "/Users/tester",
    image: IMAGE,
    snapshotHost: "/Users/tester/.local/share/bimo/deployments/demo/snapshots/run-1/candidate-1",
    expectedSha: "d".repeat(40),
    expectedSnapshot: receipt,
    profile: "bimo-repo-v1",
    suite: "candidate",
    timeoutSeconds: 300,
    nameSuffix: "source-candidate",
  });
  assert.match(local.join(" "), /src=\/Users\/tester\/\.local\/share\/bimo\/deployments\/demo\/snapshots/);
  assert.throws(() => sourceVerifierCreateArgs({
    deployment: "demo",
    hostRoot: "/Users/tester/.local/share/bimo/deployments/demo",
    localHome: "/Users/other",
    image: IMAGE,
    snapshotHost: "/Users/tester/.local/share/bimo/deployments/demo/snapshots/run-1/candidate-1",
    expectedSha: "d".repeat(40),
    expectedSnapshot: receipt,
    profile: "bimo-repo-v1",
    suite: "candidate",
    timeoutSeconds: 300,
    nameSuffix: "source-candidate",
  }), /invalid source verifier host root/);
});

test("verifySource binds candidate and immutable-base evidence without mounting controller state", async () => {
  const runtime = createRuntime();
  const candidateReceipt = { files: 12, bytes: 4_096, sha256: "c".repeat(64) };
  const calls = [];
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "create") {
      return dockerResult({ stdout: `${args.includes("bimo-demo-source-candidate") ? "candidate-id" : "baseline-id"}\n` });
    }
    if (args[0] === "start" && args.at(-1) === "candidate-id") {
      return dockerResult({ stdout: `${JSON.stringify({
        status: "passed",
        candidateSha: "d".repeat(40),
        profile: "bimo-repo-v1",
        suite: "candidate",
        snapshot: candidateReceipt,
        evidence: [
          { authority: "trusted", command: "node --check 1 source files", outputSha256: "e".repeat(64) },
          { authority: "advisory", command: "npm test", outputSha256: "f".repeat(64) },
        ],
      })}\n` });
    }
    if (args[0] === "start" && args.at(-1) === "baseline-id") {
      return dockerResult({ stdout: `${JSON.stringify({
        status: "passed",
        candidateSha: "d".repeat(40),
        profile: "bimo-repo-v1",
        suite: "baseline",
        evidence: [
          { authority: "trusted", command: "node --test 1 baseline files", outputSha256: "1".repeat(64) },
        ],
      })}\n` });
    }
    return dockerResult();
  };

  const receipt = await runtime.verifySource({
    runId: "run-1",
    expectedSha: "d".repeat(40),
    candidateSnapshot: { id: "candidate-1", sha: "d".repeat(40), receipt: candidateReceipt },
    baseSnapshot: { id: "base", sha: "a".repeat(40), receipt: { files: 10, bytes: 2_048, sha256: "b".repeat(64) } },
    profile: "bimo-repo-v1",
    timeoutSeconds: 600,
  });

  assert.equal(receipt.status, "passed");
  assert.equal(receipt.candidateSha, "d".repeat(40));
  assert.deepEqual(receipt.snapshot, candidateReceipt);
  assert.equal(receipt.evidence.filter(item => item.authority === "trusted").length, 2);
  assert.equal(receipt.evidence.filter(item => item.authority === "advisory").length, 1);
  const creates = calls.filter(args => args[0] === "create");
  assert.equal(creates.length, 2);
  assert(creates.every(args => args.includes("--network") && args[args.indexOf("--network") + 1] === "none"));
  assert(creates.every(args => !args.join(" ").includes("docker.sock") && !args.join(" ").includes("dst=/state")));
  assert(calls.some(args => args.join(" ") === "rm -f candidate-id"));
  assert(calls.some(args => args.join(" ") === "rm -f baseline-id"));
});

test("a lost network-create response reconciles the attempted deterministic network", async () => {
  const runtime = createRuntime();
  const calls = [];
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "create" && args.includes("--internal")) {
      throw new Error("transport lost after network create");
    }
    return dockerResult();
  };

  await assert.rejects(
    runtime.start({ deadlineAt: futureDeadline() }),
    /transport lost after network create/,
  );

  assert(calls.some(args => args.join(" ") === "network rm bimo-demo-agents"));
  assert.equal(calls.some(args => args[0] === "network" && args[1] === "create" && args.includes("bimo-demo-egress")), false);
  assert.equal(runtime.agentNetworkCreated, false);
});

test("start removes exactly labeled stale containers and networks before bootstrap", async () => {
  const runtime = createRuntime();
  const calls = [];
  const staleContainer = "1".repeat(12);
  const staleNetwork = "2".repeat(12);
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "ps") return dockerResult({ stdout: `${staleContainer}\n` });
    if (args[0] === "network" && args[1] === "ls") return dockerResult({ stdout: `${staleNetwork}\n` });
    if (args[0] === "create" && args.includes("proxy")) return dockerResult({ stdout: "proxy-id\n" });
    return dockerResult();
  };
  runtime.startProxy = () => ({ kill() {} });

  await runtime.start({ deadlineAt: futureDeadline() });

  const listContainers = calls.findIndex(args => args[0] === "ps");
  const removeContainers = calls.findIndex(args => args.join(" ") === `rm -f ${staleContainer}`);
  const listNetworks = calls.findIndex(args => args[0] === "network" && args[1] === "ls");
  const removeNetworks = calls.findIndex(args => args.join(" ") === `network rm ${staleNetwork}`);
  const bootstrap = calls.findIndex(args => args[0] === "run" && args.includes("bootstrap"));
  assert(listContainers < removeContainers);
  assert(removeContainers < listNetworks);
  assert(listNetworks < removeNetworks);
  assert(removeNetworks < bootstrap);
  assert.match(calls[listContainers].join(" "), /label=dev\.ascii\.bimo\.deployment=demo/);
  assert.match(calls[listContainers].join(" "), /label=dev\.ascii\.bimo\.transient=true/);
});

test("snapshotDirectory creates an independent read-only run artifact", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-snapshot-"));
  t.after(() => cleanupTemporary(temporary));
  const source = path.join(temporary, "dist");
  const destination = path.join(temporary, "artifact");
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(path.join(source, "index.html"), "verified-v1\n", { mode: 0o666 });
  await writeFile(path.join(source, "assets", "app.js"), "console.log('v1');\n", { mode: 0o777 });

  await snapshotDirectory(source, destination, {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  });
  await writeFile(path.join(source, "index.html"), "workspace-mutated\n");

  assert.equal(await readFile(path.join(destination, "index.html"), "utf8"), "verified-v1\n");
  assert.equal(mode(await lstat(destination)), 0o555);
  assert.equal(mode(await lstat(path.join(destination, "assets"))), 0o555);
  assert.equal(mode(await lstat(path.join(destination, "index.html"))), 0o444);
  assert.equal(mode(await lstat(path.join(destination, "assets", "app.js"))), 0o444);
  await assert.rejects(
    snapshotDirectory(source, destination, {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    }),
    /artifact snapshot already exists/,
  );
});

test("snapshotDirectory rejects symlinks and removes the incomplete artifact", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-symlink-"));
  t.after(() => cleanupTemporary(temporary));
  const source = path.join(temporary, "dist");
  const destination = path.join(temporary, "artifact");
  const outside = path.join(temporary, "outside.txt");
  await mkdir(source);
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(source, "escape.txt"));

  await assert.rejects(
    snapshotDirectory(source, destination, {
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    }),
    /verified output contains a symlink/,
  );
  assert.equal(await lstat(destination).catch(() => null), null);
});

test("verification passes smoke policy and snapshots output before success", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-verify-"));
  t.after(() => cleanupTemporary(temporary));
  const workspace = path.join(temporary, "workspace");
  const runDir = path.join(temporary, "run-1");
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await mkdir(runDir);
  await writeFile(path.join(workspace, "dist", "index.html"), "Bimo\n");

  const runtime = createRuntime();
  const calls = [];
  runtime.snapshotOwner = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
  runtime.command = async (args, options) => {
    calls.push({ args, options });
    if (args[0] === "create") return dockerResult({ stdout: "verify-id\n" });
    if (args[0] === "start") {
      return dockerResult({
        stdout: `${JSON.stringify({
          status: "passed",
          evidence: ["tests passed"],
          artifact: receiptFor({ "index.html": "Bimo\n" }),
        })}\n`,
      });
    }
    return dockerResult();
  };

  assert.deepEqual(await runtime.verify({
    workflow,
    workspace,
    runDir,
    timeoutSeconds: 1200,
  }), {
    status: "passed",
    evidence: ["tests passed"],
    artifact: receiptFor({ "index.html": "Bimo\n" }),
  });
  assert.equal(await readFile(path.join(runDir, "artifact", "index.html"), "utf8"), "Bimo\n");
  assert.equal(mode(await lstat(path.join(runDir, "artifact", "index.html"))), 0o444);
  assert.match(calls[0].args.join(" "), /--path \/ --status 200 --timeout-seconds 900/);
  assert(calls[1].options.timeoutMs <= 900_000);
  assert(calls[1].options.timeoutMs > 899_000);
});

test("server args publish only a run-scoped snapshot", () => {
  const finalArgs = serverCreateArgs({
    ...common,
    outputHost: "/var/lib/bimo/deployments/demo/runs/run-1/artifact",
    port: 8080,
  });
  const candidateArgs = serverCreateArgs({
    ...common,
    outputHost: "/var/lib/bimo/deployments/demo/runs/run-1/artifact",
    port: 8080,
    nameSuffix: "app-candidate-run-1",
    publish: false,
    restart: false,
  });
  const rendered = finalArgs.join(" ");

  assert.match(rendered, /runs\/run-1\/artifact,dst=\/site,readonly/);
  assert.match(rendered, /--restart unless-stopped/);
  assert.match(rendered, /--publish 8080:8080/);
  assert.doesNotMatch(rendered, /workspace|\/dist|docker\.sock|\/state|OPENROUTER/);
  assert.doesNotMatch(candidateArgs.join(" "), /--restart|--publish/);
});

async function publicationFixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-publish-"));
  t.after(() => cleanupTemporary(temporary));
  const runDir = path.join(temporary, "run-1");
  await mkdir(runDir);
  const workspace = path.join(temporary, "workspace");
  const source = path.join(workspace, "dist");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "index.html"), "Bimo\n");
  const runtime = createRuntime();
  runtime.snapshotOwner = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
  runtime.command = async args => {
    if (args[0] === "create") return dockerResult({ stdout: "verify-id\n" });
    if (args[0] === "start") {
      return dockerResult({ stdout: `${JSON.stringify({
        status: "passed",
        evidence: ["fixture verified"],
        artifact: receiptFor({ "index.html": "Bimo\n" }),
      })}\n` });
    }
    return dockerResult();
  };
  const verification = await runtime.verify({ workflow, workspace, runDir, timeoutSeconds: 30 });
  runtime.healthAttempts = 1;
  runtime.wait = async () => {};
  return { runtime, runDir, verification };
}

test("publish health-checks the candidate before interrupting the old app", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const calls = [];
  runtime.command = async (args) => {
    calls.push(args);
    if (args[0] === "container") return appInspect(args);
    return dockerResult({ stdout: args[0] === "create" ? "container-id\n" : "" });
  };

  assert.deepEqual(await runtime.publish({ workflow, runDir, timeoutSeconds: 30 }), {
    url: "https://bimo.example/",
  });
  await runtime.close();

  const candidateProbe = calls.findIndex(args => args[0] === "exec" && args[1].includes("candidate"));
  const oldRename = calls.findIndex(args => args[0] === "rename" && args[1] === "bimo-demo-app");
  const oldStop = calls.findIndex(args => args[0] === "stop" && args.at(-1).includes("backup"));
  const finalProbe = calls.findIndex(args => args[0] === "exec" && args[1] === "bimo-demo-app");
  const backupRemoval = calls.findIndex(args => args[0] === "rm" && args.at(-1).includes("backup"));

  assert(candidateProbe >= 0);
  assert(candidateProbe < oldRename);
  assert(candidateProbe < oldStop);
  assert(oldStop < finalProbe);
  assert(finalProbe < backupRemoval);
  assert.equal(calls.some(args => args[0] === "rm" && args.at(-1) === "bimo-demo-app"), false);
  assert.equal(calls.every(args => !args.join(" ").includes("/workspace/dist")), true);
  const createCalls = calls.filter(args => args[0] === "create");
  assert.match(createCalls[0].join(" "), /runs\/run-1\/artifact,dst=\/site,readonly/);
  assert.doesNotMatch(createCalls[0].join(" "), /--publish/);
  assert.match(createCalls[1].join(" "), /--publish 8080:8080/);
});

test("a failed candidate leaves the old app untouched", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const calls = [];
  runtime.command = async (args) => {
    calls.push(args);
    if (args[0] === "exec" && args[1].includes("candidate")) throw new Error("candidate unhealthy");
    return dockerResult({ stdout: args[0] === "create" ? "candidate-id\n" : "" });
  };

  await assert.rejects(runtime.publish({ workflow, runDir, timeoutSeconds: 30 }), /candidate unhealthy/);

  assert.equal(calls.some(args => args[0] === "container"), false);
  assert.equal(calls.some(args => args[0] === "rename" || args[0] === "stop"), false);
  assert.equal(calls.some(args => args[0] === "rm" && args.at(-1) === "bimo-demo-app"), false);
  assert.equal(calls.some(args => args[0] === "rm" && args.at(-1).includes("candidate")), true);
});

test("a failed final replacement restores the previously running app", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const calls = [];
  runtime.command = async (args) => {
    calls.push(args);
    if (args[0] === "container") return appInspect(args);
    if (args[0] === "exec" && args[1] === "bimo-demo-app") {
      throw new Error("replacement unhealthy");
    }
    return dockerResult({ stdout: args[0] === "create" ? "container-id\n" : "" });
  };

  await assert.rejects(runtime.publish({ workflow, runDir, timeoutSeconds: 30 }), /replacement unhealthy/);

  const candidateProbe = calls.findIndex(args => args[0] === "exec" && args[1].includes("candidate"));
  const stopOld = calls.findIndex(args => args[0] === "stop" && args.at(-1).includes("backup"));
  const removeReplacement = calls.findIndex(args => args[0] === "rm" && args.at(-1) === "bimo-demo-app");
  const restoreRename = calls.findIndex((args, index) => (
    index > removeReplacement && args[0] === "rename" && args.at(-1) === "bimo-demo-app"
  ));
  const restoreStart = calls.findIndex((args, index) => (
    index > restoreRename && args[0] === "start" && args[1] === "bimo-demo-app"
  ));

  assert(candidateProbe < stopOld);
  assert(stopOld < removeReplacement);
  assert(removeReplacement < restoreRename);
  assert(restoreRename < restoreStart);
});

test("the absolute deployment deadline rejects stalled image inspection and bootstrap", async () => {
  for (const operation of ["image", "start"]) {
    const runtime = createRuntime();
    runtime.command = async (args, options) => {
      if (operation === "start" && (args[0] === "ps" || (args[0] === "network" && args[1] === "ls"))) {
        return dockerResult();
      }
      return stallUntilAborted(options);
    };
    const startedAt = Date.now();
    const deadlineAt = futureDeadline(75);
    const promise = operation === "image"
      ? runtime.imageDigest({ deadlineAt })
      : runtime.start({ deadlineAt });

    await assert.rejects(promise, /deployment deadline exceeded/);
    assert(Date.now() - startedAt < 1_000, `${operation} exceeded its absolute deadline`);
  }
});

test("a bootstrap deadline waits for ambiguous command settlement before cleanup", async () => {
  const runtime = createRuntime();
  const calls = [];
  let bootstrapExists = false;
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) return dockerResult();
    if (args[0] === "run" && args.includes("bimo-demo-bootstrap")) {
      return new Promise(resolve => {
        setTimeout(() => {
          bootstrapExists = true;
          resolve(dockerResult());
        }, 100);
      });
    }
    if (args[0] === "rm" && args.at(-1) === "bimo-demo-bootstrap") {
      bootstrapExists = false;
    }
    return dockerResult();
  };

  await assert.rejects(runtime.start({ deadlineAt: futureDeadline(30) }), /deployment deadline exceeded/);

  const bootstrap = calls.findIndex(args => args[0] === "run" && args.includes("bimo-demo-bootstrap"));
  const cleanup = calls.findIndex(args => args.join(" ") === "rm -f bimo-demo-bootstrap");
  assert(bootstrap >= 0 && cleanup > bootstrap);
  assert.equal(bootstrapExists, false);
  await new Promise(resolve => setTimeout(resolve, 125));
  assert.equal(bootstrapExists, false);
});

test("a Docker callback cannot report success after blocking past its deadline", async () => {
  const runtime = createRuntime();
  runtime.command = async () => {
    const stopAt = Date.now() + 60;
    while (Date.now() < stopAt) {}
    return dockerResult({ stdout: `${IMAGE}\n` });
  };

  await assert.rejects(
    runtime.imageDigest({ deadlineAt: futureDeadline(20) }),
    /deployment deadline exceeded/,
  );
});

test("a stalled snapshot read is aborted by its deadline and the partial tree is removed", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-stalled-snapshot-"));
  t.after(() => cleanupTemporary(temporary));
  const source = path.join(temporary, "dist");
  const destination = path.join(temporary, "artifact");
  const sourceFile = path.join(source, "index.html");
  await mkdir(source);
  await writeFile(sourceFile, "Bimo\n");
  const startedAt = Date.now();

  await assert.rejects(snapshotDirectory(
    source,
    destination,
    { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    {
      deadlineAt: futureDeadline(75),
      operations: {
        async open(target, ...args) {
          const handle = await open(target, ...args);
          if (target !== sourceFile) return handle;
          return {
            stat: (...statArgs) => handle.stat(...statArgs),
            close: () => handle.close(),
            readFile: ({ signal }) => new Promise((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          };
        },
      },
    },
  ), /snapshot deadline exceeded/);

  assert(Date.now() - startedAt < 1_000);
  assert.equal(await lstat(destination).catch(() => null), null);
});

test("a stalled snapshot metadata callback is deadline-bounded and cleaned with trusted operations", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-stalled-metadata-"));
  t.after(() => cleanupTemporary(temporary));
  const source = path.join(temporary, "dist");
  const destination = path.join(temporary, "artifact");
  await mkdir(source);
  const startedAt = Date.now();

  await assert.rejects(snapshotDirectory(
    source,
    destination,
    { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    {
      deadlineAt: futureDeadline(75),
      operations: { readdir: async () => new Promise(() => {}) },
    },
  ), /snapshot deadline exceeded/);

  assert(Date.now() - startedAt < 1_000);
  assert.equal(await lstat(destination).catch(() => null), null);
});

test("a locked nested snapshot is made writable and removed when its receipt mismatches", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-mismatch-cleanup-"));
  t.after(() => cleanupTemporary(temporary));
  const source = path.join(temporary, "dist");
  const destination = path.join(temporary, "artifact");
  await mkdir(path.join(source, "assets", "nested"), { recursive: true });
  await writeFile(path.join(source, "assets", "nested", "app.js"), "verified\n");

  await assert.rejects(snapshotDirectory(
    source,
    destination,
    { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    {
      deadlineAt: futureDeadline(),
      expectedArtifact: { files: 1, bytes: 9, sha256: "0".repeat(64) },
      maxFiles: 10,
      maxBytes: 1_000,
    },
  ), /does not match verification receipt/);

  assert.equal(await lstat(destination).catch(() => null), null);
});

test("empty-directory fanout counts against the snapshot entry bound", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-entry-bound-"));
  t.after(() => cleanupTemporary(temporary));
  const source = path.join(temporary, "dist");
  const destination = path.join(temporary, "artifact");
  await mkdir(source);
  await Promise.all(["a", "b", "c"].map(name => mkdir(path.join(source, name))));

  await assert.rejects(snapshotDirectory(
    source,
    destination,
    { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    { deadlineAt: futureDeadline(), maxEntries: 2 },
  ), /exceeds 2 entries/);
  assert.equal(await lstat(destination).catch(() => null), null);
});

test("verification kills its container then rejects a workspace mutation that changes the snapshot receipt", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-verify-race-"));
  t.after(() => cleanupTemporary(temporary));
  const workspace = path.join(temporary, "workspace");
  const runDir = path.join(temporary, "run-1");
  const output = path.join(workspace, "dist", "index.html");
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(runDir);
  await writeFile(output, "Bimo\n");
  const runtime = createRuntime();
  runtime.snapshotOwner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  const calls = [];
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "create") return dockerResult({ stdout: "verify-id\n" });
    if (args[0] === "start") {
      return dockerResult({ stdout: `${JSON.stringify({
        status: "passed",
        evidence: ["verified original"],
        artifact: receiptFor({ "index.html": "Bimo\n" }),
      })}\n` });
    }
    if (args[0] === "rm") await writeFile(output, "Nope\n");
    return dockerResult();
  };

  await assert.rejects(runtime.verify({ workflow, workspace, runDir, timeoutSeconds: 30 }), /does not match verification receipt/);
  assert.deepEqual(calls.at(-1), ["rm", "-f", "verify-id"]);
  assert.equal(await lstat(path.join(runDir, "artifact")).catch(() => null), null);
});

test("publication deadline rejects a stalled candidate probe and still attempts candidate cleanup", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  runtime.deploymentDeadlineAt = futureDeadline(75);
  runtime.cleanupTimeoutMs = 100;
  runtime.cleanupCommandTimeoutMs = 25;
  const calls = [];
  runtime.command = async (args, options) => {
    calls.push(args);
    if (args[0] === "exec") return stallUntilAborted(options);
    return dockerResult({ stdout: args[0] === "create" ? "candidate-id\n" : "" });
  };
  const startedAt = Date.now();

  await assert.rejects(runtime.publish({ workflow, runDir, timeoutSeconds: 1 }), /publication deadline exceeded/);

  assert(Date.now() - startedAt < 1_000);
  assert(calls.some(args => args[0] === "rm" && args.at(-1).includes("candidate")));
  assert.equal(calls.some(args => args[0] === "rename" || args[0] === "stop"), false);
});

test("an ambiguous final create is reconciled before the previous app is restored", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const calls = [];
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "container") return appInspect(args);
    if (args[0] === "create" && args[args.indexOf("--name") + 1] === "bimo-demo-app") {
      throw new Error("transport lost after create");
    }
    return dockerResult({ stdout: args[0] === "create" ? "candidate-id\n" : "" });
  };

  await assert.rejects(
    runtime.publish({ workflow, runDir, timeoutSeconds: 30 }),
    /transport lost after create/,
  );

  const failedCreate = calls.findIndex(args => args[0] === "create" && args.includes("bimo-demo-app"));
  const removeUnknownReplacement = calls.findIndex((args, index) => (
    index > failedCreate && args[0] === "rm" && args.at(-1) === "bimo-demo-app"
  ));
  const restoreRename = calls.findIndex((args, index) => (
    index > removeUnknownReplacement && args[0] === "rename" && args.at(-1) === "bimo-demo-app"
  ));
  assert(failedCreate < removeUnknownReplacement);
  assert(removeUnknownReplacement < restoreRename);
  assert(calls.some((args, index) => index > restoreRename && args[0] === "start" && args[1] === "bimo-demo-app"));
});

test("an ambiguous old-app rename is reconciled without attempting a replacement", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const calls = [];
  let firstRename = true;
  runtime.command = async args => {
    calls.push(args);
    if (args[0] === "container") return appInspect(args);
    if (args[0] === "rename" && firstRename) {
      firstRename = false;
      throw new Error("transport lost after rename");
    }
    return dockerResult({ stdout: args[0] === "create" ? "candidate-id\n" : "" });
  };

  await assert.rejects(runtime.publish({ workflow, runDir, timeoutSeconds: 30 }), /transport lost after rename/);

  assert.equal(calls.filter(args => args[0] === "create").length, 1);
  assert(calls.some(args => args[0] === "rename" && args[1].includes("backup") && args[2] === "bimo-demo-app"));
  assert(calls.some(args => args[0] === "start" && args[1] === "bimo-demo-app"));
});

test("backup retirement is deferred until close and cannot roll back the healthy replacement", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  runtime.cleanupTimeoutMs = 100;
  runtime.cleanupCommandTimeoutMs = 25;
  const calls = [];
  runtime.command = async (args, options) => {
    calls.push(args);
    if (args[0] === "container") return appInspect(args);
    if (args[0] === "rm" && args.at(-1).includes("backup")) return stallUntilAborted(options);
    return dockerResult({ stdout: args[0] === "create" ? "container-id\n" : "" });
  };

  assert.deepEqual(await runtime.publish({ workflow, runDir, timeoutSeconds: 30 }), {
    url: "https://bimo.example/",
  });
  assert.equal(calls.some(args => args[0] === "rm" && args.at(-1).includes("backup")), false);
  await runtime.close();
  assert(calls.some(args => args[0] === "rm" && args.at(-1).includes("backup")));
  assert.equal(calls.some(args => args[0] === "rm" && args.at(-1) === "bimo-demo-app"), false);
  assert.equal(calls.filter(args => args[0] === "rename").length, 1);
});

test("mutating a returned verification receipt cannot change the private publication trust anchor", async (t) => {
  const { runtime, runDir, verification } = await publicationFixture(t);
  verification.artifact.sha256 = "0".repeat(64);
  runtime.command = async args => {
    if (args[0] === "container") {
      return dockerResult({ code: 1, stderr: "Error: No such container\n" });
    }
    return dockerResult({ stdout: args[0] === "create" ? "container-id\n" : "" });
  };

  assert.deepEqual(await runtime.publish({ workflow, runDir, timeoutSeconds: 30 }), {
    url: "https://bimo.example/",
  });
});

test("rollback rejects a still-running replacement instead of mistaking it for the previous app", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const oldId = "c".repeat(64);
  const newId = "d".repeat(64);
  const containers = new Map([
    ["bimo-demo-app", { id: oldId, running: true, healthy: true }],
  ]);
  runtime.command = async args => {
    const operation = args[0];
    if (operation === "container") {
      const container = containers.get(args.at(-1));
      if (!container) return dockerResult({ code: 1, stderr: "Error: No such container\n" });
      return dockerResult({
        stdout: args.includes("{{.Id}}")
          ? `${container.id}\n`
          : `${container.id} ${container.running}\n`,
      });
    }
    if (operation === "create") {
      const name = args[args.indexOf("--name") + 1];
      containers.set(name, {
        id: name.includes("candidate") ? "e".repeat(64) : newId,
        running: false,
        healthy: name.includes("candidate"),
      });
      return dockerResult({ stdout: `${name}-id\n` });
    }
    if (operation === "rename") {
      const [source, destination] = args.slice(1);
      if (containers.has(destination)) return dockerResult({ code: 1, stderr: "name conflict\n" });
      const container = containers.get(source);
      if (!container) return dockerResult({ code: 1, stderr: "no such container\n" });
      containers.delete(source);
      containers.set(destination, container);
      return dockerResult();
    }
    if (operation === "start") {
      const container = containers.get(args[1]);
      if (container) container.running = true;
      return dockerResult();
    }
    if (operation === "stop") {
      const container = containers.get(args.at(-1));
      if (container) container.running = false;
      return dockerResult();
    }
    if (operation === "exec") {
      const container = containers.get(args[1]);
      if (!container?.healthy) throw new Error("replacement unhealthy");
      return dockerResult();
    }
    if (operation === "rm") {
      const name = args.at(-1);
      if (name.includes("candidate")) containers.delete(name);
      return dockerResult();
    }
    return dockerResult();
  };

  await assert.rejects(
    runtime.publish({ workflow, runDir, timeoutSeconds: 30 }),
    error => error instanceof AggregateError
      && error.message.includes("previous app could not be restored"),
  );

  assert.deepEqual(containers.get("bimo-demo-app"), {
    id: newId,
    running: true,
    healthy: false,
  });
  assert.deepEqual(containers.get("bimo-demo-app-backup-run-1"), {
    id: oldId,
    running: false,
    healthy: true,
  });
});

test("fresh-deploy rollback rejects a failed app that cleanup did not remove", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const newId = "f".repeat(64);
  let finalExists = false;
  runtime.command = async args => {
    if (args[0] === "container") {
      if (!finalExists) return dockerResult({ code: 1, stderr: "Error: No such container\n" });
      return dockerResult({ stdout: args.includes("{{.Id}} {{.State.Running}}") ? `${newId} true\n` : `${newId}\n` });
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      if (name === "bimo-demo-app") finalExists = true;
      return dockerResult({ stdout: "container-id\n" });
    }
    if (args[0] === "exec" && args[1] === "bimo-demo-app") {
      throw new Error("replacement unhealthy");
    }
    if (args[0] === "rm" && args.at(-1) === "bimo-demo-app") {
      return dockerResult();
    }
    return dockerResult();
  };

  await assert.rejects(
    runtime.publish({ workflow, runDir, timeoutSeconds: 30 }),
    error => error instanceof AggregateError && error.message.includes("failed app could not be removed"),
  );
  assert.equal(finalExists, true);
});

test("cancelling a stalled role removes its exact active name and blocks verification", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-cancel-role-"));
  t.after(() => cleanupTemporary(temporary));
  const workspace = path.join(temporary, "workspace");
  const runDir = path.join(temporary, "run-1");
  await mkdir(workspace);
  await mkdir(runDir, { mode: 0o700 });
  const runtime = createRuntime({ stateRoot: temporary });
  runtime.deploymentDeadlineAt = futureDeadline();
  const calls = [];
  let childSettled = false;
  let roleContainerExists = false;
  let lateCreateTimer;
  let cancelStartedAt;
  runtime.command = async (args, options = {}) => {
    calls.push(args);
    if (args[0] === "create") {
      roleContainerExists = true;
      return dockerResult({ stdout: "role-id\n" });
    }
    if (args[0] === "start") {
      lateCreateTimer = setTimeout(() => { roleContainerExists = true; }, 150);
      setTimeout(() => {
        cancelStartedAt = Date.now();
        void runtime.cancel();
      }, 10);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          clearTimeout(lateCreateTimer);
          setTimeout(() => {
            childSettled = true;
            reject(new Error("child operation aborted"));
          }, 10);
        }, { once: true });
      });
    }
    if (args[0] === "rm") {
      roleContainerExists = false;
    }
    return dockerResult();
  };

  await assert.rejects(runtime.runRole({
    role: "engineering",
    step: 1,
    attempt: 1,
    access: "write",
    prompt: "cancel me",
    timeoutSeconds: 30,
    runDir,
    workspace,
  }), /deployment cancelled/);
  await runtime.cancel();

  assert(childSettled);
  assert(Date.now() - cancelStartedAt < 1_000);
  assert(calls.some(args => args.join(" ") === "rm -f bimo-demo-engineering-1"));
  await new Promise(resolve => setTimeout(resolve, 175));
  assert.equal(roleContainerExists, false);
  const callsBeforeVerify = calls.length;
  await assert.rejects(
    runtime.verify({ workflow, workspace, runDir, timeoutSeconds: 30 }),
    /deployment cancelled/,
  );
  assert.equal(calls.length, callsBeforeVerify);
  assert.strictEqual(runtime.cancel(), runtime.close());
});

test("cancel aborts and settles the underlying spawned command", async () => {
  const runtime = createRuntime();
  runtime.docker = process.execPath;
  const startedAt = Date.now();
  const operation = runtime.commandWithin(
    ["-e", "setInterval(() => {}, 1000)"],
    {},
    futureDeadline(30_000),
    "role",
  );
  setTimeout(() => { void runtime.cancel(); }, 20);

  await assert.rejects(operation, /deployment cancelled/);
  await runtime.cancel();
  assert(Date.now() - startedAt < 1_000);
});

test("near-deadline cancel kills a TERM-resistant child before its late mutation", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "bimo-runtime-cancel-child-"));
  const ready = path.join(temporary, "ready");
  const lateMarker = path.join(temporary, "late-marker");
  const runtime = createRuntime();
  t.after(async () => {
    await runtime.cancel();
    await cleanupTemporary(temporary);
  });
  runtime.docker = process.execPath;
  const deadlineAt = futureDeadline(3_000);
  const operation = runtime.commandWithin([
    "-e",
    [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => {',
      '  setTimeout(() => writeFileSync(process.argv[2], "late"), 500);',
      '});',
      'writeFileSync(process.argv[1], "ready");',
      'setInterval(() => {}, 1000);',
    ].join(""),
    ready,
    lateMarker,
  ], {}, deadlineAt, "role");
  const settledOperation = operation.then(
    value => ({ value }),
    error => ({ error }),
  );

  while (!await lstat(ready).catch(() => null) && Date.now() < deadlineAt - 1_000) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(await lstat(ready).catch(() => null), "child did not become ready before cancellation");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, deadlineAt - Date.now() - 50)));
  const cancelStartedAt = Date.now();
  const cancellation = runtime.cancel();

  const outcome = await settledOperation;
  assert.match(outcome.error?.message ?? "", /deployment cancelled/);
  await cancellation;
  assert(Date.now() - cancelStartedAt < 1_000, "cancel did not await prompt child termination");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(await lstat(lateMarker).catch(() => null), null);
});

test("publication rejects a zero timeout before any Docker command", async (t) => {
  const { runtime, runDir } = await publicationFixture(t);
  const calls = [];
  runtime.command = async args => {
    calls.push(args);
    return dockerResult();
  };

  await assert.rejects(runtime.publish({ workflow, runDir, timeoutSeconds: 0 }), /invalid publication timeout/);
  assert.deepEqual(calls, []);
});
