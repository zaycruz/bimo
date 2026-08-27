import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const legacyName = ["mono", "lith"].join("");

async function filesUnder(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }

  return files;
}

async function expand(relativePath) {
  return (await stat(path.join(root, relativePath))).isDirectory()
    ? filesUnder(relativePath)
    : [relativePath];
}

test("publishes the clean-break Bimo product contract", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  assert.equal(packageJson.name, "bimo-workflow");
  assert.equal(packageJson.version, "0.6.0");
  assert.deepEqual(packageJson.bin, { bimo: "bin/bimo" });
  assert.equal(packageJson.repository.url, "git+https://github.com/zaycruz/bimo.git");
  assert.equal(packageJson.homepage, "https://github.com/zaycruz/bimo#readme");
  assert.equal(packageJson.bugs, "https://github.com/zaycruz/bimo/issues");
  await access(path.join(root, "bin", "bimo"));
});

test("ships no legacy product identifiers", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const paths = ["package.json", "Dockerfile", "README.md"];

  for (const entry of packageJson.files) {
    if (["Dockerfile", "README.md"].includes(entry)) continue;
    paths.push(...await expand(entry));
  }

  const offenders = [];
  for (const relativePath of paths) {
    const content = await readFile(path.join(root, relativePath), "utf8");
    if (content.toLowerCase().includes(legacyName)) offenders.push(relativePath);
  }

  assert.deepEqual(offenders, []);
});
