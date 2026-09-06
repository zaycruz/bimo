import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rename, rm, symlink, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { loadPodTemplate } from "../src/pod-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const execute = promisify(execFile);

test("Pi pod reuses digest-bound prompts with repository-specific write boundaries", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bimo-pi-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["pi-palantir-pod", "parallel-engineering-pod"]) {
    await cp(path.join(root, "templates", name), path.join(directory, name), { recursive: true });
  }
  const first = await loadPodTemplate("pi-palantir-pod", { templateRoot: directory });
  assert.equal(first.template.verificationProfile, "pi-palantir-v1");
  assert.deepEqual(Object.values(first.template.writers).map(writer => writer.allowedWriteRoots), [["extensions"], ["omp"], ["test"]]);
  await appendFile(path.join(directory, "parallel-engineering-pod/roles/planner.md"), "\nUpdated prompt evidence.\n");
  const second = await loadPodTemplate("pi-palantir-pod", { templateRoot: directory });
  assert.notEqual(first.templateDigest, second.templateDigest);
  await rename(path.join(directory, "parallel-engineering-pod"), path.join(directory, "saved"));
  await symlink(path.join(directory, "saved"), path.join(directory, "parallel-engineering-pod"));
  await assert.rejects(loadPodTemplate("pi-palantir-pod", { templateRoot: directory }), /requires the built-in engineering prompts/);
});

test("Pi deploy requires a prepared image and the supported repository before external calls", async () => {
  for (const args of [
    ["deploy", "pi-palantir-pod", "--json"],
    ["deploy", "pi-palantir-pod", "--deployment", "pi-test", "--image", "bimo:pi", "--repository", "https://github.com/example/other.git", "--json"],
  ]) {
    await assert.rejects(execute(process.execPath, [path.join(root, "bin/bimo"), ...args], {
      cwd: root, timeout: 5_000, maxBuffer: 64 * 1024,
    }), error => {
      assert.equal(error.code, 1);
      assert.match(JSON.parse(error.stdout).error.message, /requires --image|requires the raava-solutions/);
      return true;
    });
  }
});
