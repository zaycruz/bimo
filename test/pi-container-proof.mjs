// Required Linux CI integration proof. Synthetic source only; not a Pi product test suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deploymentRootForTarget } from "../src/deployment-target.mjs";
import { sourceVerifierCreateArgs } from "../src/docker-runtime.mjs";
import { preparePiVerificationImage } from "../src/pi-image.mjs";
import { discoverPiBaselineFiles } from "../src/pi-verification.mjs";
import { scanSourceSnapshot } from "../src/source-verify.mjs";

const execute = promisify(execFile);
const localHome = await mkdtemp(path.join(os.tmpdir(), "bimo-pi-container-"));
const deployment = `proof-${process.pid}`;
const hostRoot = deploymentRootForTarget({ kind: "local", home: localHome }, deployment);
const runRoot = path.join(hostRoot, "snapshots", "run-1");
const base = path.join(runRoot, "base");
const image = `bimo-pi-proof:${process.pid}`;
const expectedSha = "a".repeat(40);
const containers = new Set();
const command = (file, args, options = {}) => execute(file, args, {
  timeout: 600_000, maxBuffer: 4 * 1024 * 1024, ...options,
});

async function file(relative, content) {
  const destination = path.join(base, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, { mode: 0o644 });
}

async function fixture() {
  await mkdir(base, { recursive: true });
  for (const directory of ["test", "scripts", "omp/test", "extensions/otel-exporter/test", "extensions/foundry-role"]) {
    await mkdir(path.join(base, directory), { recursive: true });
  }
  await file("package.json", JSON.stringify({
    name: "pi-palantir-synthetic-ci", version: "0.0.0", private: true, type: "module",
    devDependencies: {
      "@types/node": "22.19.0", "@typescript-eslint/parser": "8.46.4",
      eslint: "9.39.1", "eslint-plugin-sonarjs": "3.0.5", tsx: "4.19.2", typescript: "5.7.3",
    },
  }));
  await command("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: base });
  await file("tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true },
    include: ["extensions/**/*.ts"],
  }));
  await file("eslint.config.mjs", `import parser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
export default [{ files: ['extensions/**/*.ts'], languageOptions: { parser }, plugins: { sonarjs },
  rules: { complexity: ['error', 10], 'sonarjs/cognitive-complexity': ['error', 15] } }];\n`);
  await file("quality-baseline.json", "{}\n");
  await file("scripts/check-quality.mjs", `import { ESLint } from 'eslint';
const results = await new ESLint().lintFiles(['extensions/**/*.ts']);
if (results.some(result => result.errorCount > 0 || result.warningCount > 0)) {
  throw new Error('synthetic fixture complexity check failed');
}\n`);
  await file("extensions/foundry-context/value.ts", "export function value(): number { return 7; }\n");
  await file("extensions/foundry-context/value.test.ts", `import assert from 'node:assert/strict';
import test from 'node:test';
import { value } from './value.ts';
test('production behavior', () => assert.equal(value(), 7));\n`);
  await file("test/sandbox.test.mjs", `import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
test('sandbox is readonly without operator credentials', async () => {
  for (const name of ['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'BIMO_PROOF_SECRET']) assert.equal(process.env[name], undefined);
  for (const destination of ['/opt/bimo-pi/identity.json', '/node_modules/.proof-write', '/workspace/package.json']) {
    await assert.rejects(writeFile(destination, 'tamper'), error => ['EROFS', 'EACCES'].includes(error.code));
  }
});\n`);
}

async function verify(snapshotHost, suite, nameSuffix, expectedFailure) {
  const args = sourceVerifierCreateArgs({
    deployment, hostRoot, localHome, image, snapshotHost, expectedSha,
    profile: "pi-palantir-v1", suite, timeoutSeconds: 90, nameSuffix,
    ...(suite === "candidate"
      ? { expectedSnapshot: await scanSourceSnapshot(snapshotHost, { rejectNodeModules: true }) }
      : { baselineSnapshotHost: base, baselinePaths: await discoverPiBaselineFiles(base) }),
  });
  const name = args[args.indexOf("--name") + 1];
  containers.add(name);
  await command("docker", args);
  const inspected = JSON.parse((await command("docker", ["inspect", name])).stdout)[0];
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert(inspected.Mounts.every(mount => mount.RW === false));
  assert(!inspected.Mounts.some(mount => mount.Source.includes("docker.sock")));
  assert(!inspected.Config.Env.some(value => /^(OPENROUTER_API_KEY|GITHUB_TOKEN|BIMO_PROOF_SECRET)=/.test(value)));
  let result;
  try {
    result = await command("docker", ["start", "-ai", name], { timeout: 100_000 });
  } catch (error) {
    if (!expectedFailure) throw error;
    assert.equal(error.killed, false, "failure must come from verification, not the host timeout");
    assert.match(`${error.stdout}\n${error.stderr}`, expectedFailure);
    return;
  }
  assert.equal(expectedFailure, undefined, "a tampered candidate unexpectedly passed verification");
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.suite, suite);
  assert.equal(receipt.candidateSha, expectedSha);
}

try {
  await fixture();
  const context = path.join(localHome, "image-context");
  await preparePiVerificationImage(base, context, "bimo-workflow:ci");
  await command("docker", ["build", "--tag", image, context]);
  await verify(base, "candidate", "preflight-candidate");
  await verify(base, "baseline", "preflight-baseline");
  const candidate = path.join(runRoot, "candidate");
  await cp(base, candidate, { recursive: true });
  await verify(candidate, "candidate", "good-candidate");
  await verify(candidate, "baseline", "good-baseline");

  // Candidate-authored assertions can agree with broken production code.
  // The baseline must still execute its original assertion against that code.
  const changed = path.join(runRoot, "changed");
  await cp(base, changed, { recursive: true });
  await writeFile(path.join(changed, "extensions/foundry-context/value.ts"), "export function value(): number { return 8; }\n");
  const testPath = path.join(changed, "extensions/foundry-context/value.test.ts");
  await writeFile(testPath, (await readFile(testPath, "utf8")).replace("value(), 7", "value(), 8"));
  await verify(changed, "candidate", "changed-candidate");
  await verify(changed, "baseline", "changed-baseline", /source gate Pi behavior tests exited 1/);

  const forged = path.join(runRoot, "forged");
  await cp(base, forged, { recursive: true });
  await writeFile(path.join(forged, "tsconfig.json"), '{"compilerOptions":{"strict":false}}\n');
  await verify(forged, "candidate", "forged-config", /Pi verifier immutable tooling configuration changed/);
  process.stdout.write("Pi container proof passed: real TypeScript, complexity and behavior gates; baseline catches rewritten assertions; tooling and sandbox boundaries hold.\n");
} finally {
  for (const name of containers) {
    await command("docker", ["rm", "-f", name], { timeout: 30_000 }).catch(() => {});
  }
  await command("docker", ["image", "rm", image], { timeout: 30_000 }).catch(() => {});
  await rm(localHome, { recursive: true, force: true });
}
