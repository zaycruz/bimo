import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiIdentity, PI_PROFILE } from './pi-verification.mjs';

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RECIPE = fileURLToPath(new URL('../etc/pi-verification/Dockerfile', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(message) { throw new Error(message); }

async function checkedDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a directory path`);
  }
  const absolute = path.resolve(value);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) {
    fail(`${label} must not contain a symlink`);
  }
  return absolute;
}

async function readBounded(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) || before.size > MAX_FILE_BYTES) {
      fail('Pi image input must be a bounded regular file without unsafe metadata');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs) fail('Pi image input changed during read');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** Prepare a minimal dependency-only context. This never builds or starts an image. */
export async function preparePiVerificationImage(sourceRoot, outputDir, baseImage) {
  if (typeof baseImage !== 'string' || !IMAGE.test(baseImage)) fail('invalid Pi base image reference');
  const source = await checkedDirectory(sourceRoot, 'Pi source');
  if ((await lstat(source)).mode & 0o022) fail('Pi source contains unsafe filesystem metadata');
  if (typeof outputDir !== 'string' || !outputDir || /[\u0000-\u001f\u007f]/u.test(outputDir)) {
    fail('Pi image output must be a new directory path');
  }
  const output = path.resolve(outputDir);
  await checkedDirectory(path.dirname(output), 'Pi image output parent');
  const identity = await createPiIdentity(source);
  const payload = {};
  for (const name of ['package.json', 'package-lock.json']) {
    payload[name] = await readBounded(path.join(source, name));
    if (digest(payload[name]) !== identity.files[name]) fail('Pi image package changed during preparation');
  }
  payload['identity.json'] = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
  if (payload['identity.json'].length > 256 * 1024) fail('Pi image identity exceeds its byte limit');
  const recipe = await readBounded(RECIPE);
  payload.Dockerfile = Buffer.from(recipe.toString('utf8').replace('ARG BIMO_IMAGE\n', `ARG BIMO_IMAGE=${baseImage}\n`));
  await mkdir(output, { mode: 0o700 });
  try {
    for (const [name, content] of Object.entries(payload)) {
      await writeFile(path.join(output, name), content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    profile: PI_PROFILE,
    sourceRoot: source,
    outputDir: output,
    dockerfile: path.join(output, 'Dockerfile'),
    baseImage,
    files: Object.freeze(Object.fromEntries(Object.entries(payload).map(([name, content]) => [name, digest(content)]))),
  });
}
