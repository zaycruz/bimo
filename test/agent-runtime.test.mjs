import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_INSTRUCTIONS_PATH,
  AGENT_RUNTIME_NAMES,
  DEFAULT_AGENT_RUNTIME,
  agentRuntimeFor,
  createOpenCodeDiagnostics,
} from "../src/agent-runtime.mjs";

test("the agent runtime registry is closed, frozen, and defaults to opencode", () => {
  assert.deepEqual([...AGENT_RUNTIME_NAMES], ["opencode"]);
  assert.ok(Object.isFrozen(AGENT_RUNTIME_NAMES));
  assert.equal(DEFAULT_AGENT_RUNTIME, "opencode");
  const runtime = agentRuntimeFor("opencode");
  assert.equal(runtime.name, "opencode");
  assert.ok(Object.isFrozen(runtime));
  assert.equal(agentRuntimeFor("opencode"), runtime);
});

test("unknown or malformed runtime names fail closed", () => {
  for (const name of [
    "bogus", "OpenCode", "opencode;id", "opencode$(id)", "opencode ai",
    "../opencode", "", "-opencode", "opencode_ai",
  ]) {
    assert.throws(() => agentRuntimeFor(name), new RegExp(`unknown agent runtime: ${name.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}`));
  }
  assert.throws(() => agentRuntimeFor(undefined), /unknown agent runtime/);
  assert.throws(() => agentRuntimeFor(null), /unknown agent runtime/);
});

test("the opencode adapter builds the exact bounded spawn argv", () => {
  const argv = agentRuntimeFor("opencode").spawnArgv({
    model: "openrouter/deepseek/deepseek-v4-flash",
    role: "qa",
  });
  assert.deepEqual(argv, [
    "opencode",
    "run",
    "--pure",
    "--auto",
    "--agent", "build",
    "--format", "json",
    "--dir", "/workspace",
    "--model", "openrouter/deepseek/deepseek-v4-flash",
    "--file", AGENT_INSTRUCTIONS_PATH,
    "--title", "bimo-qa",
    "Follow the attached Bimo instructions exactly.",
  ]);
  assert.equal(AGENT_INSTRUCTIONS_PATH, "/instructions/instructions.md");
});

test("the opencode adapter exposes only the bounded spawn environment", () => {
  const runtime = agentRuntimeFor("opencode");
  const env = runtime.spawnEnv({ gateway: "http://gateway:8787/api/v1" });
  assert.deepEqual(Object.keys(env).sort(), [
    "BIMO_GATEWAY_URL", "CI", "HOME", "LANG", "OPENCODE_CONFIG", "PATH", "TMPDIR",
  ]);
  assert.equal(env.BIMO_GATEWAY_URL, "http://gateway:8787/api/v1");
  assert.equal(env.OPENCODE_CONFIG, "/etc/opencode/opencode.json");
  assert.equal(env.HOME, "/home/node");
  assert.ok(env.PATH.length > 0);

  env.BIMO_GATEWAY_URL = "http://attacker:1/api/v1";
  const fresh = runtime.spawnEnv({ gateway: "http://gateway:8787/api/v1" });
  assert.equal(fresh.BIMO_GATEWAY_URL, "http://gateway:8787/api/v1");
});

test("opencode diagnostics count bounded JSON events without leaking content", () => {
  const diagnostics = createOpenCodeDiagnostics();
  diagnostics.stdout(Buffer.from('{"type":"step_start"}\n{"type":"error","error":{"status":500}}\n{"type":"text","part":{"text":"hidden model text"}}\n'));
  diagnostics.stderr(Buffer.from("raw sk-hidden"));

  const summary = diagnostics.failure(1);
  assert.match(summary, /^agent exited 1; /u);
  assert.match(summary, /events=error:1,step_start:1,text:1/u);
  assert.match(summary, /errorStatus=500/u);
  assert.match(summary, /stderrBytes=13$/u);
  assert.doesNotMatch(summary, /hidden/u);

  assert.throws(() => diagnostics.failure(1), /already finalized/);
});
