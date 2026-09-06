import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const PI_PROFILE = 'pi-palantir-v1';
const TOOL_ROOT = '/opt/bimo-pi';
const ROOT_FILES = Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json', 'eslint.config.mjs', 'quality-baseline.json']);
const TREES = Object.freeze(['scripts', 'test', 'omp/test', 'extensions/otel-exporter/test']);
const MIXED = Object.freeze(['extensions/foundry-context', 'extensions/foundry-role']);
const SAFE_PATH = /^[a-zA-Z0-9_.@/-]+$/;
const hash = content => createHash('sha256').update(content).digest('hex');
function fail(message) { throw new Error(message); }

function safeRelative(name) {
  return typeof name === 'string' && SAFE_PATH.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..' && part !== 'node_modules');
}

export function isPiBaselinePath(name) {
  return safeRelative(name) && (ROOT_FILES.includes(name)
    || TREES.some(directory => name.startsWith(`${directory}/`))
    || MIXED.some(directory => name.startsWith(`${directory}/`) && !name.slice(directory.length + 1).includes('/') && name.endsWith('.test.ts')));
}

async function checkedFile(root, name) {
  if (!safeRelative(name)) fail('Pi verifier contains an unsafe path');
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (stat.mode & 0o022)) fail('Pi verifier contains unsafe filesystem metadata');
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10 * 1024 * 1024) fail('Pi verifier file is invalid');
  const content = await readFile(current);
  if (content.length !== stat.size) fail('Pi verifier file changed during read');
  return content;
}

export async function discoverPiBaselineFiles(root) {
  const files = [...ROOT_FILES];
  let entriesSeen = 0;
  async function visit(relative, depth = 0) {
    if (depth > 64) fail('Pi verifier directory depth exceeded');
    const stat = await lstat(path.join(root, relative));
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Pi verifier directory is invalid');
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (++entriesSeen > 100_000) fail('Pi verifier entry limit exceeded');
      const name = `${relative}/${entry.name}`;
      if (!safeRelative(name) || entry.isSymbolicLink()) fail('Pi verifier contains an unsafe path');
      if (entry.isDirectory()) await visit(name, depth + 1);
      else if (entry.isFile()) files.push(name);
      else fail('Pi verifier contains a non-regular entry');
      if (files.length > 500) fail('Pi verifier baseline file limit exceeded');
    }
  }
  for (const directory of TREES) await visit(directory);
  for (const directory of MIXED) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    if (entries.length > 10_000) fail('Pi verifier entry limit exceeded');
    for (const entry of entries) {
      if (entry.name.endsWith('.test.ts')) files.push(`${directory}/${entry.name}`);
    }
  }
  if (files.length > 500) fail('Pi verifier baseline file limit exceeded');
  for (const name of files) await checkedFile(root, name);
  return Object.freeze(files.sort());
}

export async function createPiIdentity(root) {
  const paths = await discoverPiBaselineFiles(root);
  const files = {};
  const tests = {};
  for (const name of paths) {
    const digest = hash(await checkedFile(root, name));
    if (ROOT_FILES.includes(name) || name.startsWith('scripts/')) files[name] = digest;
    if (/\.test\.(ts|mjs)$/.test(name)) tests[name] = digest;
  }
  if (!Object.keys(tests).length) fail('Pi verification profile found no baseline tests');
  return Object.freeze({ profile: PI_PROFILE, files: Object.freeze(files), tests: Object.freeze(tests) });
}

function validateIdentity(identity) {
  if (!identity || Object.keys(identity).sort().join(',') !== 'files,profile,tests' || identity.profile !== PI_PROFILE) {
    fail('Pi verifier tool identity is invalid');
  }
  for (const map of [identity.files, identity.tests]) {
    if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length || Object.keys(map).length > 500) {
      fail('Pi verifier tool identity is invalid');
    }
    for (const [name, digest] of Object.entries(map)) {
      if (!safeRelative(name) || !/^[a-f0-9]{64}$/.test(digest)) fail('Pi verifier tool identity is invalid');
    }
  }
  if (ROOT_FILES.some(name => !Object.hasOwn(identity.files, name)) || !Object.hasOwn(identity.files, 'scripts/check-quality.mjs')) {
    fail('Pi verifier tool identity is incomplete');
  }
  if (Object.keys(identity.tests).some(name => !/\.test\.(ts|mjs)$/.test(name))) fail('Pi verifier test identity is invalid');
}

export async function piGatePlan(root, suite, { identityPath = `${TOOL_ROOT}/identity.json` } = {}) {
  if (!['candidate', 'baseline'].includes(suite)) fail('Pi verification suite is invalid');
  const stat = await lstat(identityPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail('Pi verifier tool identity is invalid');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  validateIdentity(identity);
  const current = await createPiIdentity(root);
  if (Object.keys(current.files).length !== Object.keys(identity.files).length
      || Object.entries(current.files).some(([name, digest]) => identity.files[name] !== digest)) fail('Pi verifier immutable tooling configuration changed');
  if (suite === 'baseline') {
    for (const [name, digest] of Object.entries(identity.tests)) {
      if (hash(await checkedFile(root, name)) !== digest) fail('Pi verifier trusted baseline test changed');
    }
  }
  const tests = Object.keys(suite === 'baseline' ? identity.tests : current.tests).sort();
  const gate = (label, args, authority = 'trusted') => Object.freeze({ command: 'node', args: Object.freeze(args), label, authority });
  const behavior = gate('Pi behavior tests', ['--import', `${TOOL_ROOT}/node_modules/tsx/dist/loader.mjs`, '--test', ...tests], suite === 'baseline' ? 'trusted' : 'advisory');
  if (suite === 'baseline') return Object.freeze([behavior]);
  return Object.freeze([
    gate('Pi TypeScript typecheck', [`${TOOL_ROOT}/node_modules/typescript/bin/tsc`, '--noEmit', '--project', 'tsconfig.json']),
    gate('Pi complexity ratchet', ['scripts/check-quality.mjs']),
    behavior,
  ]);
}
