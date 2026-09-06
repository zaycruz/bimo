import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DockerRuntime, sourceVerifierCreateArgs } from "../src/docker-runtime.mjs";
import { scanSourceSnapshot } from "../src/source-verify.mjs";

const hostRoot = "/var/lib/bimo/deployments/demo";
const image = `sha256:${"a".repeat(64)}`;
const expectedSha = "b".repeat(40);
const candidateReceipt = { files: 1, bytes: 10, sha256: "c".repeat(64) };
const options = Object.freeze({
  deployment: "demo", hostRoot, image, expectedSha,
  snapshotHost: `${hostRoot}/snapshots/run-1/candidate-1`,
  profile: "pi-palantir-v1", suite: "baseline", timeoutSeconds: 30,
  nameSuffix: "source-baseline",
  baselineSnapshotHost: `${hostRoot}/snapshots/run-1/base`,
  baselinePaths: Object.freeze(["extensions/foundry-context/scope.test.ts", "test/fixtures/example.json"]),
});

function mounts(args) {
  return args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]] : []);
}

test("Pi baseline overlays preserve candidate implementation and expose no controller authority", () => {
  const args = sourceVerifierCreateArgs(options);
  assert.deepEqual(mounts(args), [
    `type=bind,src=${options.snapshotHost},dst=/workspace,readonly`,
    `type=bind,src=${options.baselineSnapshotHost}/extensions/foundry-context/scope.test.ts,dst=/workspace/extensions/foundry-context/scope.test.ts,readonly`,
    `type=bind,src=${options.baselineSnapshotHost}/test/fixtures/example.json,dst=/workspace/test/fixtures/example.json,readonly`,
  ]);
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert(args.includes("--read-only"));
  assert(!args.includes("--env"));
  assert(!args.join(" ").includes("docker.sock"));
  const candidate = sourceVerifierCreateArgs({
    ...options, suite: "candidate", expectedSnapshot: candidateReceipt,
    baselineSnapshotHost: undefined, baselinePaths: undefined,
  });
  assert.deepEqual(mounts(candidate), [`type=bind,src=${options.snapshotHost},dst=/workspace,readonly`]);
});

test("Pi mount boundary rejects implementation overlays, escapes, duplicates and foreign snapshots", () => {
  for (const baselinePaths of [
    ["extensions/foundry-context/index.ts"], ["../test/escape.ts"], ["test/a,b.test.ts"],
    ["test/a.test.ts", "test/a.test.ts"], new Array(601).fill("test/a.test.ts"),
  ]) {
    assert.throws(() => sourceVerifierCreateArgs({ ...options, baselinePaths }), /invalid Pi baseline/);
  }
  assert.throws(() => sourceVerifierCreateArgs({
    ...options, baselineSnapshotHost: `${hostRoot}/snapshots/other-run/base`,
  }), /invalid Pi baseline snapshot/);
  assert.throws(() => sourceVerifierCreateArgs({ ...options, profile: "custom" }), /invalid source verification profile/);
  assert.throws(() => sourceVerifierCreateArgs({
    ...options, suite: "candidate", expectedSnapshot: candidateReceipt,
  }), /candidate verification cannot mount baseline/);
});

test("Pi runtime authenticates the base before creating candidate and baseline sandboxes", async t => {
  const snapshotsRoot = await mkdtemp(path.join(os.tmpdir(), "bimo-pi-runtime-"));
  t.after(() => rm(snapshotsRoot, { recursive: true, force: true }));
  const baseRoot = path.join(snapshotsRoot, "run-1", "base");
  await mkdir(path.join(baseRoot, "extensions", "foundry-context"), { recursive: true });
  for (const directory of ["test", "scripts", "omp/test", "extensions/otel-exporter/test", "extensions/foundry-role"]) {
    await mkdir(path.join(baseRoot, directory), { recursive: true });
  }
  for (const name of ["package.json", "package-lock.json", "tsconfig.json", "eslint.config.mjs", "quality-baseline.json"]) {
    await writeFile(path.join(baseRoot, name), "{}\n");
  }
  await writeFile(path.join(baseRoot, "extensions", "foundry-context", "scope.test.ts"), "export {};\n");
  await writeFile(path.join(baseRoot, "extensions", "foundry-context", "index.ts"), "export const source = 1;\n");
  await writeFile(path.join(baseRoot, "test", "scope.test.ts"), "export {};\n");
  const baseReceipt = await scanSourceSnapshot(baseRoot);
  const runtime = new DockerRuntime({
    deployment: "demo", hostRoot, image, snapshotsRoot,
    key: `sk-or-v1-${"a".repeat(40)}`, model: "openrouter/test/model",
  });
  const creates = [];
  let verifiedSnapshot = candidateReceipt;
  runtime.command = async args => {
    if (args[0] === "create") {
      creates.push(args);
      return { code: 0, stdout: `${args[args.indexOf("--suite") + 1]}\n`, stderr: "" };
    }
    if (args[0] === "start") {
      const suite = args.at(-1);
      return { code: 0, stderr: "", stdout: JSON.stringify({
        status: "passed", candidateSha: expectedSha, profile: "pi-palantir-v1", suite,
        ...(suite === "candidate" ? { snapshot: verifiedSnapshot } : {}),
        evidence: [{ authority: "trusted", command: "fixed test", outputSha256: "d".repeat(64) }],
      }) };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const request = {
    runId: "run-1", expectedSha, profile: "pi-palantir-v1", timeoutSeconds: 30,
    candidateSnapshot: { id: "candidate-1", sha: expectedSha, receipt: candidateReceipt },
    baseSnapshot: { id: "base", sha: "e".repeat(40), receipt: baseReceipt },
  };
  await assert.rejects(runtime.verifySource({
    ...request, baseSnapshot: { ...request.baseSnapshot, receipt: { ...baseReceipt, sha256: "f".repeat(64) } },
  }), /base source snapshot does not match/);
  assert.equal(creates.length, 0);
  const result = await runtime.verifySource(request);
  assert.equal(result.status, "passed");
  assert.equal(creates.length, 2);
  const baselineMounts = mounts(creates[1]);
  assert(baselineMounts.some(mount => mount.includes("dst=/workspace/extensions/foundry-context/scope.test.ts,readonly")));
  assert(!baselineMounts.some(mount => mount.includes("dst=/workspace/extensions/foundry-context/index.ts")));
  // Startup preflight checks the same authenticated base in both suites.
  verifiedSnapshot = baseReceipt;
  const selfBase = { ...request.baseSnapshot, sha: expectedSha };
  const preflight = await runtime.verifySource({
    ...request, candidateSnapshot: selfBase, baseSnapshot: selfBase,
  });
  assert.equal(preflight.status, "passed");
  assert.equal(creates.length, 4);
  for (const args of creates.slice(2)) {
    assert.deepEqual(mounts(args), [`type=bind,src=${hostRoot}/snapshots/run-1/base,dst=/workspace,readonly`]);
  }

});
