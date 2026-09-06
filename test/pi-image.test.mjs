import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparePiVerificationImage } from '../src/pi-image.mjs';

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bimo-pi-image-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  for (const directory of ['scripts', 'test', 'omp/test', 'extensions/otel-exporter/test', 'extensions/foundry-context', 'extensions/foundry-role']) {
    await mkdir(path.join(source, directory), { recursive: true, mode: 0o755 });
  }
  for (const [name, value] of Object.entries({
    'package.json': '{"name":"pi-palantir","type":"module"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'tsconfig.json': '{}',
    'eslint.config.mjs': 'export default [];',
    'quality-baseline.json': '{}',
    'scripts/check-quality.mjs': 'process.exitCode = 0;',
    'test/answer.test.mjs': 'import "node:test";',
    '.env': 'PRIVATE_TOKEN=do-not-copy',
    'private-client-source.ts': 'client implementation',
  })) await writeFile(path.join(source, name), value, { mode: 0o644 });
  return { parent, source, output: path.join(parent, 'context') };
}

test('Pi image preparation copies only dependency manifests and hash identity into an exclusive context', async t => {
  const { source, output } = await fixture(t);
  const result = await preparePiVerificationImage(source, output, 'bimo-workflow:local');
  assert.deepEqual((await readdir(output)).sort(), ['Dockerfile', 'identity.json', 'package-lock.json', 'package.json']);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.files));
  const identity = JSON.parse(await readFile(path.join(output, 'identity.json')));
  for (const name of ['package.json', 'package-lock.json']) {
    const copied = await readFile(path.join(output, name));
    assert.deepEqual(copied, await readFile(path.join(source, name)));
    assert.equal(createHash('sha256').update(copied).digest('hex'), identity.files[name]);
  }
  const recipe = await readFile(result.dockerfile, 'utf8');
  assert.match(recipe, /^ARG BIMO_IMAGE=bimo-workflow:local\n/u);
  assert.match(recipe, /npm ci --include=dev --ignore-scripts/u);
  assert.match(recipe, /python3 bash/u);
  assert.match(recipe, /ENV PATH=\/opt\/bimo-pi\/node_modules\/\.bin:\$\{PATH\}/u);
  assert(!JSON.stringify(identity).includes('do-not-copy'));
  await assert.rejects(preparePiVerificationImage(source, output, 'bimo:local'), { code: 'EEXIST' });
  assert.equal(await readFile(result.dockerfile, 'utf8'), recipe);
});

test('Pi image preparation rejects symlinked source, manifest and output parent without creating a context', async t => {
  const { parent, source, output } = await fixture(t);
  const linked = path.join(parent, 'linked');
  await symlink(source, linked);
  await assert.rejects(preparePiVerificationImage(linked, output, 'bimo:local'), /symlink/u);
  await assert.rejects(preparePiVerificationImage(source, path.join(linked, 'context'), 'bimo:local'), /symlink/u);
  const manifest = path.join(source, 'package.json');
  await rm(manifest);
  await symlink(path.join(source, '.env'), manifest);
  await assert.rejects(preparePiVerificationImage(source, output, 'bimo:local'), /unsafe filesystem/u);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('Pi image preparation rejects unsafe metadata, oversized input and image interpolation', async t => {
  const { source, output } = await fixture(t);
  await assert.rejects(preparePiVerificationImage(source, output, 'bimo:local\nRUN bad'), /image reference/u);
  const manifest = path.join(source, 'package.json');
  await chmod(manifest, 0o666);
  await assert.rejects(preparePiVerificationImage(source, output, 'bimo:local'), /unsafe filesystem/u);
  await chmod(manifest, 0o644);
  await truncate(manifest, 10 * 1024 * 1024 + 1);
  await assert.rejects(preparePiVerificationImage(source, output, 'bimo:local'), /file is invalid/u);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});
