import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { manageTestService, parseServiceStatus, testServiceUnit } from "../src/test-service.mjs";

const example = JSON.parse(await readFile(new URL("../examples/deployments/aurum-test.json", import.meta.url)));
const manifest = { ...example, target: { kind: "local" } };
const unit = testServiceUnit(manifest);
function status(state = "inactive", id = unit) {
  return `Id=${id}\nLoadState=loaded\nActiveState=${state}\nSubState=${state === "active" ? "running" : "dead"}\nMainPID=${state === "active" ? 123 : 0}\nExecMainStatus=0\nNRestarts=0\n`;
}

function fixture(initial = "inactive") {
  const calls = [];
  let current = initial;
  return {
    calls,
    execute: async (command, args, limits) => {
      calls.push({ command, args, limits });
      assert.equal(Object.isFrozen(args), true);
      assert.equal(Object.isFrozen(limits), true);
      assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 10_000);
      assert.equal(limits.maxOutputBytes, 4096);
      assert.equal(Object.isFrozen(limits.env), true);
      assert.ok(Object.keys(limits.env).every(key => ["PATH", "HOME", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "LC_CTYPE"].includes(key)));
      if (args.includes("stop")) current = "inactive";
      if (args.includes("start")) current = "active";
      return { code: 0, stdout: status(current), stderr: "" };
    },
  };
}

test("test identities are unambiguous and reject job or dotted IDs", () => {
  const first = testServiceUnit({ ...manifest, clientId: "a-b", agentId: "c" });
  const second = testServiceUnit({ ...manifest, clientId: "a", agentId: "b-c" });
  assert.notEqual(first, second);
  assert.equal(first, "bimo-test-a-b.c.service");
  assert.throws(() => testServiceUnit({ ...manifest, clientId: "a.b" }), /client ID/);
  assert.throws(() => testServiceUnit({ ...manifest, lifecycle: "job", runtime: "pi", workload: { template: "react-solo" } }), /service\/hermes/);
});

test("inactive status is factual, exact-shaped, and does not expose credential references", async () => {
  const fake = fixture();
  const receipt = await manageTestService("status", manifest, fake.execute);
  assert.equal(receipt.scope, "test-only");
  assert.equal(receipt.observed.ActiveState, "inactive");
  assert.equal(fake.calls.length, 1);
  assert.equal(JSON.stringify(receipt).includes("op://"), false);
  assert.deepEqual(Object.keys(receipt).sort(), ["action", "identity", "limitations", "observed", "schemaVersion", "scope", "target", "unit"]);
  assert.equal(Object.isFrozen(receipt.observed), true);
});

test("restart checks identity, stops to inactive before starting, and observes active process", async () => {
  const fake = fixture("active");
  const receipt = await manageTestService("restart", example, fake.execute);
  assert.equal(receipt.observed.MainPID, 123);
  assert.deepEqual(fake.calls.map(call => call.args.find(arg => ["show", "start", "stop"].includes(arg))), ["show", "stop", "show", "start", "show"]);
  for (const call of fake.calls) {
    assert.equal(call.command, "ssh");
    assert.deepEqual(call.args.slice(0, 9), ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", example.target.proxmox, "pct", "exec", "100", "--"]);
    assert.equal(call.args.at(-1), unit);
    assert.ok(call.args.includes("--no-ask-password"));
  }
});

test("foreign, aliased, missing and malformed unit status prevents every mutation", async () => {
  const invalid = [status("inactive", "hermes-gateway.service"), status().replace("LoadState=loaded", "LoadState=not-found"), status() + "Environment=SECRET\n", status().replace("MainPID=0", "MainPID=-1"), status() + "Id=" + unit + "\n", status().replace("NRestarts=0\n", "")];
  for (const stdout of invalid) {
    let calls = 0;
    await assert.rejects(manageTestService("start", manifest, async () => { calls++; return { code: 0, stdout }; }), /test service:/);
    assert.equal(calls, 1);
  }
  assert.throws(() => parseServiceStatus("x".repeat(4097), unit), /size/);
});

test("failed or timed-out transitions do not continue or disclose backend output", async () => {
  for (const failure of ["permission denied SECRET", "timed out SECRET", "output exceeded SECRET"]) {
    let calls = 0;
    await assert.rejects(manageTestService("restart", manifest, async () => {
      if (++calls === 1) return { code: 0, stdout: status("active") };
      throw new Error(failure);
    }), error => !error.message.includes("SECRET") && /observed state is unknown/.test(error.message));
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(manageTestService("restart", manifest, async () => {
    calls++;
    return { code: 0, stdout: status("active") };
  }), /stop did not reach/);
  assert.equal(calls, 3);
});


test("CLI uses the bounded executor and suppresses failing service stderr", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bimo-test-service-"));
  try {
    const file = path.join(directory, "manifest.json");
    const executable = path.join(directory, "systemctl");
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(executable, `#!${process.execPath}
if (process.env.BIMO_FIXTURE_FAIL) { process.stderr.write("PRIVATE_SERVICE_VALUE"); process.exit(1); }
process.stdout.write(${JSON.stringify(status())});
`);
    await chmod(executable, 0o755);
    const options = { env: { ...process.env, PATH: directory, OPENROUTER_API_KEY: "PRIVATE_MODEL", GITHUB_TOKEN: "PRIVATE_GIT", OP_SERVICE_ACCOUNT_TOKEN: "PRIVATE_OP", DBUS_SYSTEM_BUS_ADDRESS: "PRIVATE_BUS" }, encoding: "utf8", timeout: 5000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"] };
    const cli = new URL("../bin/bimo", import.meta.url);
    const receipt = JSON.parse(execFileSync(process.execPath, [cli.pathname, "service", "status", file, "--json"], options));
    assert.equal(receipt.scope, "test-only");
    assert.equal(receipt.observed.ActiveState, "inactive");
    await writeFile(executable, `#!${process.execPath}\nprocess.stderr.write("PRIVATE_SERVICE_VALUE"); process.exit(1);\n`);
    assert.throws(() => execFileSync(process.execPath, [cli.pathname, "service", "start", file, "--json"], options), error => error.status === 1 && !error.stderr.includes("PRIVATE_SERVICE_VALUE") && error.stderr.includes("test service:"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
