// E2E proof that the bimo CLI drives the Bimo engine. Real bimo, real
// bimo-engine, real Hermes on the engine's local substrate: no fakes. It
// needs a built engine (cargo build --manifest-path engine/Cargo.toml) and
// the pinned tools engine/scripts/e2e-tools.sh installs. Writes a transcript
// and a report under engine/target/e2e-bimo/ as the repeatable artifact.
//
// Failure modes this proof exists to catch:
// - a deployment manifest whose target is the engine does not reach the
//   engine, or reaches it as a different agent, tenant, runtime or target;
// - bimo agent apply reports success but no runtime accepted a first task;
// - a second unchanged apply through bimo changes anything;
// - status, logs, list or destroy do not reach the engine by agent name;
// - a manifest for another target is rendered into a spec, or fails without
//   one JSON envelope on stdout;
// - the generated spec or the agent log carries the secret value;
// - an envelope drifts from the engine's CLI contract shape.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bimo = path.join(root, "bin", "bimo");
const SECRET = "sk-or-v1-bimo-engine-proof-0123456789abcdef";
const ENVELOPE_FIELDS = ["schema", "command", "ok", "changed", "result", "error", "next", "idempotency_key"].sort();
const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
const artifactDir = path.join(root, "engine", "target", "e2e-bimo", `${stamp}-${process.pid}`);
const transcript = path.join(artifactDir, "transcript.jsonl");
const work = await mkdtemp(path.join(os.tmpdir(), "bimo-engine-proof-"));
const steps = [];

async function tools() {
  const { stdout } = await execute("sh", [path.join(root, "engine", "scripts", "e2e-tools.sh")], {
    timeout: 900_000, maxBuffer: 1024 * 1024,
  });
  return Object.fromEntries(stdout.split("\n").filter(line => line.includes("=")).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function cleanEnv(installed) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never hand the proof an operator's live secret or cluster token.
    if (/^(MONOLITH|BIMO)_(SECRET_|PROXMOX_)/u.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    BIMO_SECRET_DEMO__OPENROUTER: SECRET,
    BIMO_HERMES_BIN: installed.HERMES_BIN,
    BIMO_IRON_PROXY_BIN: installed.IRON_PROXY_BIN,
    BIMO_READY_TIMEOUT_MS: "90000",
    BIMO_POOL_REFILL: "0",
  };
}

async function run(env, args) {
  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execute(process.execPath, [bimo, ...args], {
      cwd: work, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    ({ code, stdout = "", stderr = "" } = error);
  }
  const lines = stdout.trim().split("\n").filter(Boolean);
  let envelope = null;
  if (args.includes("--output") || args.includes("--json")) {
    assert.equal(lines.length, 1, `bimo ${args.join(" ")} printed ${lines.length} stdout lines:\n${stdout}\n${stderr}`);
    envelope = JSON.parse(lines[0]);
  }
  await appendFile(transcript, `${JSON.stringify({ args: ["bimo", ...args], code, envelope })}\n`);
  return { code, envelope, stderr };
}

function engineEnvelope(result, command) {
  assert.deepEqual(Object.keys(result.envelope).sort(), ENVELOPE_FIELDS);
  assert.equal(result.envelope.schema, "bimo.cli/v1");
  assert.equal(result.envelope.command, command);
  return result.envelope;
}

function ok(result, command) {
  const envelope = engineEnvelope(result, command);
  assert.equal(result.code, 0, `${command} failed: ${JSON.stringify(envelope)}\n${result.stderr}`);
  assert.equal(envelope.ok, true);
  return envelope;
}

async function step(name, body) {
  await body();
  steps.push(name);
  process.stdout.write(`ok - ${name}\n`);
}

await mkdir(artifactDir, { recursive: true });
await writeFile(transcript, "");
await cp(path.join(root, "examples", "deployments", "engine-hermes.json"), path.join(work, "engine-hermes.json"));
await cp(path.join(root, "examples", "deployments", "engine-hermes"), path.join(work, "engine-hermes"), { recursive: true });
await cp(path.join(root, "examples", "deployments", "aurum-test.json"), path.join(work, "aurum-test.json"));
const env = cleanEnv(await tools());
let applied = false;
let failure = null;

try {
  await step("bimo plan accepts an engine-target manifest and marks it executable", async () => {
    const result = await run(env, ["plan", "engine-hermes.json", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.envelope.executionSupported, true);
    assert.equal(result.envelope.identity, "demo/hermes");
    assert.deepEqual(result.envelope.manifest.target, { kind: "engine", name: "local" });
  });

  await step("bimo agent validate renders the manifest into an engine spec the engine accepts", async () => {
    const envelope = ok(await run(env, ["agent", "validate", "engine-hermes.json", "--output", "json"]), "validate");
    assert.deepEqual(
      { name: envelope.result.name, tenant: envelope.result.tenant_id, runtime: envelope.result.runtime, substrate: envelope.result.substrate },
      { name: "demo-hermes", tenant: "demo", runtime: "hermes", substrate: "local" },
    );
    const spec = await readFile(path.join(work, ".bimo", "specs", "demo-hermes.toml"), "utf8");
    assert.ok(!spec.includes(SECRET), "the generated spec carries the secret value");
    await writeFile(path.join(artifactDir, "demo-hermes.toml"), spec);
  });

  await step("bimo agent plan reports a create", async () => {
    const envelope = ok(await run(env, ["agent", "plan", "engine-hermes.json", "--output", "json"]), "plan");
    assert.equal(envelope.result.action, "create");
  });

  await step("bimo agent apply brings a real Hermes to its first accepted task", async () => {
    const envelope = ok(await run(env, ["agent", "apply", "engine-hermes.json", "--output", "json"]), "apply");
    applied = true;
    assert.equal(envelope.changed, true);
    assert.equal(envelope.result.name, "demo-hermes");
    assert.equal(envelope.result.tenant_id, "demo");
    assert.ok(Number.isInteger(envelope.result.ready_ms) && envelope.result.ready_ms > 0);
    assert.ok(envelope.result.first_task_id);
  });

  await step("a second unchanged bimo agent apply changes nothing", async () => {
    const envelope = ok(await run(env, ["agent", "apply", "engine-hermes.json", "--output", "json"]), "apply");
    assert.equal(envelope.changed, false);
  });

  await step("bimo agent status, logs and list reach the agent by name", async () => {
    const status = ok(await run(env, ["agent", "status", "demo-hermes", "--output", "json"]), "status");
    assert.equal(status.result.status, "ready");
    const logs = ok(await run(env, ["agent", "logs", "demo-hermes", "--output", "json"]), "logs");
    assert.ok(!logs.result.text.includes(SECRET), "the agent log carries the secret value");
    const list = ok(await run(env, ["agent", "list", "--output", "json"]), "list");
    assert.ok(JSON.stringify(list.result).includes("demo-hermes"));
  });

  await step("bimo agent destroy stops the agent and a second destroy changes nothing", async () => {
    const destroyed = ok(await run(env, ["agent", "destroy", "demo-hermes", "--output", "json"]), "destroy");
    assert.equal(destroyed.changed, true);
    applied = false;
    const again = ok(await run(env, ["agent", "destroy", "demo-hermes", "--output", "json"]), "destroy");
    assert.equal(again.changed, false);
    const status = ok(await run(env, ["agent", "status", "demo-hermes", "--output", "json"]), "status");
    assert.equal(status.result.status, "destroyed");
  });

  await step("a manifest for another target fails with one spec_invalid envelope and no spec", async () => {
    const result = await run(env, ["agent", "apply", "aurum-test.json", "--output", "json"]);
    const envelope = engineEnvelope(result, "apply");
    assert.equal(result.code, 1);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "spec_invalid");
    await assert.rejects(readFile(path.join(work, ".bimo", "specs", "aurum-test-aurum.toml")));
  });

  await step("bimo engine passes arguments to the engine unchanged", async () => {
    const result = await run(env, ["engine", "agent", "list", "--output", "json"]);
    ok(result, "list");
  });
} catch (error) {
  failure = error;
} finally {
  if (applied) await run(env, ["agent", "destroy", "demo-hermes", "--output", "json"]).catch(() => {});
  const report = {
    proof: "bimo-engine-bridge",
    generated_at: stamp,
    status: failure ? "FAILED" : "PASSED",
    steps,
    failure: failure ? String(failure.message).slice(0, 4_000) : null,
    transcript: path.relative(root, transcript),
  };
  await writeFile(path.join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(work, { recursive: true, force: true });
  process.stdout.write(`report: ${path.relative(root, path.join(artifactDir, "report.json"))} (${report.status})\n`);
}
if (failure) throw failure;
