import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanSourceSnapshot, verifySourceCandidate } from "../src/source-verify.mjs";

const SHA = "a".repeat(40);

async function temporaryWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "monolith-source-verify-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "test"));
  await writeFile(path.join(workspaceRoot, "src", "index.mjs"), "export const ready = true;\n");
  await writeFile(path.join(workspaceRoot, "test", "base.test.mjs"), "// trusted baseline fixture\n");
  await writeFile(path.join(workspaceRoot, "package.json"), '{"name":"fixture","scripts":{"test":"node --test"}}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return workspaceRoot;
}

function successfulRunner(calls) {
  return async options => {
    calls.push(options);
    return { code: 0, stdout: `${options.args.join(" ")} passed\n`, stderr: "" };
  };
}

test("verifies the exact candidate with only the fixed source gates", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  const calls = [];
  const expectedSnapshot = await scanSourceSnapshot(workspaceRoot);

  const receipt = await verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    expectedSnapshot,
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 60,
    runCommand: successfulRunner(calls),
  });

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["node", ["--check", "src/index.mjs"]],
    ["npm", ["test"]],
    ["npm", ["run", "regression", "--if-present"]],
    ["npm", ["run", "smoke", "--if-present"]],
  ]);
  assert(calls.every(call => call.cwd === workspaceRoot));
  assert(calls.every(call => call.signal instanceof AbortSignal));
  assert(calls.every(call => call.maxOutputBytes === 2 * 1024 * 1024));
  assert.deepEqual(receipt, {
    status: "passed",
    candidateSha: SHA,
    profile: "monolith-repo-v1",
    suite: "candidate",
    snapshot: expectedSnapshot,
    evidence: receipt.evidence,
  });
  assert.equal(receipt.evidence.length, 4);
  assert(receipt.evidence.every(item => (
    Object.keys(item).sort().join(",") === "authority,command,outputSha256"
      && /^[a-f0-9]{64}$/.test(item.outputSha256)
  )));
  assert.equal(receipt.evidence[0].authority, "trusted");
  assert(receipt.evidence.slice(1).every(item => item.authority === "advisory"));
});

test("fails before execution when the immutable snapshot receipt differs", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  const calls = [];
  const expectedSnapshot = await scanSourceSnapshot(workspaceRoot);

  await assert.rejects(verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    expectedSnapshot: { ...expectedSnapshot, sha256: "b".repeat(64) },
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 60,
    runCommand: successfulRunner(calls),
  }), /source snapshot does not match its trusted receipt/);

  assert.equal(calls.length, 0);
});

test("snapshot scan rejects repository trees deeper than the trusted profile", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  let directory = workspaceRoot;
  for (let depth = 0; depth < 65; depth += 1) {
    directory = path.join(directory, "nested");
    await mkdir(directory);
  }
  await writeFile(path.join(directory, "leaf.mjs"), "export default true;\n");

  await assert.rejects(scanSourceSnapshot(workspaceRoot), /source snapshot depth limit/);
});

test("fails closed on a nonzero fixed gate without running later gates", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  const expectedSnapshot = await scanSourceSnapshot(workspaceRoot);
  const calls = [];
  const runner = async options => {
    calls.push(options);
    if (options.command === "node") return { code: 0, stdout: "", stderr: "" };
    return { code: 7, stdout: "", stderr: "failed without leaking raw output" };
  };

  await assert.rejects(verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    expectedSnapshot,
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 60,
    runCommand: runner,
  }), /source gate npm test exited 7/);

  assert.equal(calls.length, 2);
});

test("uses one absolute deadline and aborts an over-budget command", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  const expectedSnapshot = await scanSourceSnapshot(workspaceRoot);
  let observedSignal;
  const runner = async options => {
    observedSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };

  await assert.rejects(verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    expectedSnapshot,
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 1,
    runCommand: runner,
  }), /source verification timed out/);

  assert.equal(observedSignal.aborted, true);
});

test("rejects invalid input before invoking a command", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  let calls = 0;
  const runCommand = async () => { calls += 1; };

  await assert.rejects(verifySourceCandidate({
    workspaceRoot: "relative",
    expectedSha: SHA,
    expectedSnapshot: { files: 1, bytes: 1, sha256: "a".repeat(64) },
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 60,
    runCommand,
  }), /workspace root must be an absolute directory/);
  await assert.rejects(verifySourceCandidate({
    workspaceRoot,
    expectedSha: "main",
    expectedSnapshot: { files: 1, bytes: 1, sha256: "a".repeat(64) },
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 60,
    runCommand,
  }), /expected SHA is invalid/);
  await assert.rejects(verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    expectedSnapshot: { files: 1, bytes: 1, sha256: "a".repeat(64) },
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 901,
    runCommand,
  }), /source verification timeout is invalid/);
  assert.equal(calls, 0);
});

test("runs the immutable base regression suite through the fixed profile", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  const calls = [];
  const receipt = await verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    profile: "monolith-repo-v1",
    suite: "baseline",
    timeoutSeconds: 60,
    runCommand: successfulRunner(calls),
  });

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["node", ["--test", "test/base.test.mjs"]],
  ]);
  assert.equal(receipt.suite, "baseline");
  assert.equal(receipt.snapshot, undefined);
  assert.equal(receipt.evidence.length, 1);
});

test("the production runner executes the fixed candidate profile with a sanitized child environment", async t => {
  const workspaceRoot = await temporaryWorkspace(t);
  const expectedSnapshot = await scanSourceSnapshot(workspaceRoot);
  const receipt = await verifySourceCandidate({
    workspaceRoot,
    expectedSha: SHA,
    expectedSnapshot,
    profile: "monolith-repo-v1",
    suite: "candidate",
    timeoutSeconds: 30,
  });

  assert.equal(receipt.status, "passed");
  assert.deepEqual(receipt.snapshot, expectedSnapshot);
  assert.equal(receipt.evidence[0].authority, "trusted");
  assert(receipt.evidence.some(item => item.command === "npm test" && item.authority === "advisory"));
});
