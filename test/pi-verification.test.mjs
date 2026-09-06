import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createPiIdentity, discoverPiBaselineFiles, isPiBaselinePath, piGatePlan } from '../src/pi-verification.mjs';
import { sourceBaselinePaths, verifySourceCandidate } from '../src/source-verify.mjs';

const execute = promisify(execFile);
const SHA = 'a'.repeat(40);
async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'bimo-pi-verifier-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'source');
  for (const directory of ['scripts', 'test', 'omp/test', 'extensions/otel-exporter/test', 'extensions/foundry-context', 'extensions/foundry-role']) {
    await mkdir(path.join(root, directory), { recursive: true, mode: 0o755 });
  }
  const content = {
    'package.json': '{"type":"module"}',
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    'eslint.config.mjs': 'export default [];',
    'quality-baseline.json': '{}',
    'scripts/check-quality.mjs': 'process.exitCode = 0;',
    'answer.mjs': 'export const answer = 42;',
    'test/answer.test.mjs': "import assert from 'node:assert/strict'; import {answer} from '../answer.mjs'; assert.equal(answer,42);",
  };
  for (const [name, value] of Object.entries(content)) await writeFile(path.join(root, name), value, { mode: 0o644 });
  const identityPath = path.join(parent, 'identity.json');
  await writeFile(identityPath, JSON.stringify(await createPiIdentity(root)));
  return { root, identityPath };
}

const options = (root, identityPath) => ({ workspaceRoot: root, expectedSha: SHA, profile: 'pi-palantir-v1', suite: 'baseline', timeoutSeconds: 10, piIdentityPath: identityPath });

test('Pi fixed gates reject configuration tampering and dependency shadowing before execution', async t => {
  const { root, identityPath } = await fixture(t);
  const plan = await piGatePlan(root, 'candidate', { identityPath });
  assert.equal(plan.length, 3);
  assert.equal(plan[0].args[0], '/opt/bimo-pi/node_modules/typescript/bin/tsc');
  assert.deepEqual(plan[1].args, ['scripts/check-quality.mjs']);
  assert.equal(plan[2].authority, 'advisory');
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'eslint.config.mjs', 'quality-baseline.json', 'scripts/check-quality.mjs']) {
    const original = await readFile(path.join(root, name));
    await writeFile(path.join(root, name), 'tampered');
    await assert.rejects(piGatePlan(root, 'candidate', { identityPath }), /immutable tooling/);
    await writeFile(path.join(root, name), original);
  }
  await mkdir(path.join(root, 'extensions', 'node_modules'));
  await assert.rejects(sourceBaselinePaths(root, 'pi-palantir-v1'), /node_modules shadowing/);
  assert.equal(isPiBaselinePath('test/../../answer.mjs'), false);
  assert.equal(isPiBaselinePath('extensions/foundry-context/index.ts'), false);
});

test('Pi rejects empty tests, altered trusted tests and unknown profiles', async t => {
  const { root, identityPath } = await fixture(t);
  await assert.rejects(verifySourceCandidate({ ...options(root, identityPath), profile: 'agent-selected' }), /profile is invalid/);
  await writeFile(path.join(root, 'test/answer.test.mjs'), '');
  await assert.rejects(piGatePlan(root, 'baseline', { identityPath }), /trusted baseline test changed/);
  await rm(path.join(root, 'test/answer.test.mjs'));
  await assert.rejects(piGatePlan(root, 'candidate', { identityPath }), /no baseline tests/);
});

test('trusted baseline behavior catches a candidate regression despite replacement candidate tests', async t => {
  const { root, identityPath } = await fixture(t);
  const trustedTest = await readFile(path.join(root, 'test/answer.test.mjs'));
  const relative = await discoverPiBaselineFiles(root);
  assert(relative.includes('test/answer.test.mjs'));
  assert(!relative.includes('answer.mjs'));
  // Unit fixture has no TypeScript: exercise the fixed test file list with Node directly.
  // The full Pi checkout proof separately exercises the baked tsx loader and tooling.
  const runCommand = async ({ command, args, cwd, signal, maxOutputBytes }) => {
    assert.equal(command, 'node');
    assert.equal(args[0], '--import');
    assert.equal(args[1], '/opt/bimo-pi/node_modules/tsx/dist/loader.mjs');
    try {
      const result = await execute(command, args.slice(2), { cwd, signal, maxBuffer: maxOutputBytes, env: { PATH: process.env.PATH } });
      return { code: 0, ...result };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const receipt = await verifySourceCandidate({ ...options(root, identityPath), runCommand });
  assert.equal(receipt.evidence[0].authority, 'trusted');
  await writeFile(path.join(root, 'answer.mjs'), 'export const answer = 7;');
  await writeFile(path.join(root, 'test/answer.test.mjs'), 'process.exitCode = 0;');
  // Model the runtime's readonly baseline file overlay without requiring Docker here.
  await writeFile(path.join(root, 'test/answer.test.mjs'), trustedTest);
  await assert.rejects(verifySourceCandidate({ ...options(root, identityPath), runCommand }), /Pi behavior tests exited 1/);
});
