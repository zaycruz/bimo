import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadDeploymentPlan } from "../src/deployment-plan.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "bin/bimo");
const example = path.join(root, "examples/deployments/raava-engineering.json");

async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bimo-deployment-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function invoke(args, options = {}) {
  return execute(process.execPath, [cli, ...args], {
    cwd: root, timeout: 5_000, maxBuffer: 128 * 1024, ...options,
  });
}

test("deployment plans validate packaged job and Aurum service examples without external tools", async () => {
  for (const name of ["raava-engineering", "aurum-test"]) {
    const file = path.join(root, `examples/deployments/${name}.json`);
    const { stdout, stderr } = await invoke(["plan", file, "--json"], {
      env: { ...process.env, PATH: "/bimo-no-tools", HOME: "/bimo-no-home" },
    });
    assert.equal(stderr, "");
    const plan = JSON.parse(stdout);
    assert.equal(plan.planOnly, true);
    assert.equal(plan.executionSupported, false);
    assert.equal(plan.sourceDigest, `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`);
    assert.equal(plan.identity, name === "aurum-test" ? "aurum-test/aurum" : "raava/engineering");
    assert.deepEqual(Object.keys(plan).sort(), ["schemaVersion", "planOnly", "executionSupported", "identity", "manifest", "limitations", "sourceDigest"].sort());
  }
});

test("deployment plan human output and help make the execution boundary explicit", async () => {
  assert.match((await invoke(["plan", example])).stdout, /Plan only\. Execution is not supported/);
  assert.match((await invoke(["help", "plan"])).stdout, /No execution/);
  assert.match((await invoke(["--help"])).stdout, /bimo plan FILE/);
});

test("deployment plan errors produce one JSON envelope and reject unknown execution options", async () => {
  for (const args of [["plan", "--json"], ["plan", example, "--apply", "--json"], ["plan", example, "extra", "--json"]]) {
    await assert.rejects(invoke(args), error => {
      assert.equal(error.code, 1);
      const receipt = JSON.parse(error.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.error.command, "plan");
      assert.equal(error.stdout.trim().split("\n").length, 1);
      return true;
    });
  }
});

test("deployment plan reader rejects oversized, symlink, directory and special-file inputs", async t => {
  const directory = await temp(t);
  const large = path.join(directory, "large.json");
  const link = path.join(directory, "link.json");
  await writeFile(large, " ".repeat(65537));
  await symlink(example, link);
  for (const file of [large, link, directory, "/dev/null"]) {
    await assert.rejects(loadDeploymentPlan(file), /regular non-symlink file/);
  }
  const fifo = path.join(directory, "fifo");
  await execute("mkfifo", [fifo], { timeout: 2_000, maxBuffer: 1024 });
  await assert.rejects(invoke(["plan", fifo, "--json"]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).ok, false);
    return true;
  });
});

test("malformed manifests and invalid UTF-8 never echo input contents", async t => {
  const directory = await temp(t);
  const file = path.join(directory, "input.json");
  for (const bytes of [Buffer.from('{"token":"private-value"'), Buffer.from([0xff, 0xfe])]) {
    await writeFile(file, bytes);
    await assert.rejects(invoke(["plan", file, "--json"]), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).error.message, "manifest must contain valid UTF-8 JSON");
      assert.doesNotMatch(error.stdout + error.stderr, /private-value/);
      return true;
    });
  }
});
