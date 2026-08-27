import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_INSTRUCTIONS_PATH,
  AGENT_RUNTIME_NAMES,
  DEFAULT_AGENT_RUNTIME,
  agentRuntimeFor,
  createOpenCodeDiagnostics,
  createPiDiagnostics,
} from "../src/agent-runtime.mjs";

test("the agent runtime registry is closed, frozen, and defaults to opencode", () => {
  assert.deepEqual([...AGENT_RUNTIME_NAMES], ["opencode", "pi"]);
  assert.ok(Object.isFrozen(AGENT_RUNTIME_NAMES));
  assert.equal(DEFAULT_AGENT_RUNTIME, "opencode");
  const runtime = agentRuntimeFor("opencode");
  assert.equal(runtime.name, "opencode");
  assert.ok(Object.isFrozen(runtime));
  assert.equal(agentRuntimeFor("opencode"), runtime);
  const pi = agentRuntimeFor("pi");
  assert.equal(pi.name, "pi");
  assert.ok(Object.isFrozen(pi));
  assert.equal(agentRuntimeFor("pi"), pi);
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

test("the pi adapter builds the exact bounded spawn argv with the gateway model mapping", () => {
  const argv = agentRuntimeFor("pi").spawnArgv({
    model: "openrouter/deepseek/deepseek-v4-flash",
    role: "qa",
  });
  assert.deepEqual(argv, [
    "pi",
    "-p",
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "read,write,edit,bash,grep,find,ls",
    "--model", "bimo-gateway/deepseek/deepseek-v4-flash",
    `@${AGENT_INSTRUCTIONS_PATH}`,
    "Follow the attached Bimo instructions exactly.",
  ]);
});

test("the pi adapter exposes only the bounded spawn environment", () => {
  const runtime = agentRuntimeFor("pi");
  const env = runtime.spawnEnv({ gateway: "http://gateway:8787/api/v1" });
  assert.deepEqual(Object.keys(env).sort(), [
    "BIMO_GATEWAY_URL", "CI", "HOME", "LANG", "PATH",
    "PI_CODING_AGENT_DIR", "PI_OFFLINE", "TMPDIR",
  ]);
  assert.equal(env.BIMO_GATEWAY_URL, "http://gateway:8787/api/v1");
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.PI_CODING_AGENT_DIR, "/home/node/.pi/agent");
  assert.equal(env.HOME, "/home/node");
  assert.ok(env.PATH.length > 0);

  env.BIMO_GATEWAY_URL = "http://attacker:1/api/v1";
  const fresh = runtime.spawnEnv({ gateway: "http://gateway:8787/api/v1" });
  assert.equal(fresh.BIMO_GATEWAY_URL, "http://gateway:8787/api/v1");
});

test("the pi adapter declares a frozen bounded seed config", () => {
  const runtime = agentRuntimeFor("pi");
  assert.deepEqual(runtime.seedConfig, {
    source: "/etc/pi/agent",
    target: "/home/node/.pi/agent",
  });
  assert.ok(Object.isFrozen(runtime.seedConfig));
  assert.equal(agentRuntimeFor("opencode").seedConfig, undefined);
});

test("pi diagnostics count bounded JSON events without leaking content", () => {
  const diagnostics = createPiDiagnostics();
  diagnostics.stdout(Buffer.from([
    '{"type":"session","id":"abc"}',
    '{"type":"agent_start"}',
    '{"type":"turn_start"}',
    '{"type":"tool_execution_start","toolName":"bash"}',
    '{"type":"message_update","delta":"hidden model text"}',
    '{"type":"turn_end","message":{"stopReason":"error","errorMessage":"401: {\\"error\\":\\"unauthorized sk-hidden\\"}"}}',
    "",
  ].join("\n")));
  diagnostics.stderr(Buffer.from("raw sk-hidden"));

  const summary = diagnostics.failure(1);
  assert.match(summary, /^agent exited 1; /u);
  assert.match(summary, /events=agent_start:1,message_update:1,session:1,tool_execution_start:1,turn_end:1,turn_start:1/u);
  assert.match(summary, /errorStatus=401/u);
  assert.match(summary, /stderrBytes=13$/u);
  assert.doesNotMatch(summary, /hidden/u);

  assert.throws(() => diagnostics.failure(1), /already finalized/);
});

test("pi diagnostics ignore undeclared event types and unbounded lines", () => {
  const diagnostics = createPiDiagnostics();
  diagnostics.stdout(Buffer.from('{"type":"bogus_custom"}\nnot json\n'));
  diagnostics.stdout(Buffer.from(`${"x".repeat(70_000)}\n{"type":"agent_end"}`));

  const summary = diagnostics.failure(null);
  assert.match(summary, /^agent exited on signal; /u);
  assert.match(summary, /events=agent_end:1/u);
  assert.doesNotMatch(summary, /errorStatus/u);
});

test("pi diagnostics surface no errorStatus for turns that stop normally", () => {
  const diagnostics = createPiDiagnostics();
  diagnostics.stdout(Buffer.from('{"type":"turn_end","message":{"stopReason":"stop"}}\n'));

  const summary = diagnostics.failure(2);
  assert.match(summary, /events=turn_end:1/u);
  assert.doesNotMatch(summary, /errorStatus/u);
});
