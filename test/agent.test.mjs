import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOpenCodeDiagnostics } from "../src/agent-runtime.mjs";
import { assertSeedConfig, seedAgentConfig } from "../src/agent.mjs";

const bimoScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "bimo",
);

test("stream diagnostics handle split JSONL and never include stdout or stderr content", () => {
  const diagnostics = createOpenCodeDiagnostics();
  diagnostics.stdout(Buffer.alloc(65_537, 0x78));
  diagnostics.stdout(Buffer.from('{"type":"error","error":{"status":500}}\n{"type":"github_pat_hidden"}\n{"type":"text","part":{"text":"model text"}}\n{"type":"err'));
  diagnostics.stdout(Buffer.from('or","error":{"status":429,"message":"Bearer hidden"}}'));
  diagnostics.stderr(Buffer.from("raw stderr sk-hidden"));

  const summary = diagnostics.failure(1);
  assert.match(summary, /events=error:1,text:1/u);
  assert.match(summary, /errorStatus=429/u);
  assert.match(summary, /stderrBytes=20$/u);
  assert.doesNotMatch(summary, /model text|github_pat|Bearer|sk-hidden/u);
});

test("bin bimo dispatches the agent entrypoint", async () => {
  const child = spawn(process.execPath, [bimoScript, "agent", "--bad"], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const [code, signal] = await new Promise(resolve => {
    child.once("exit", (...result) => resolve(result));
  });

  assert.deepEqual([code, signal], [1, null]);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(Buffer.concat(stderr).toString("utf8"), "bimo-agent: invalid option: --bad\n");
});

test("the agent entrypoint rejects an unknown BIMO_AGENT_RUNTIME before any workspace work", async () => {
  const child = spawn(process.execPath, [
    bimoScript,
    "agent",
    "--model", "openrouter/deepseek/deepseek-v4-flash",
    "--timeout-seconds", "10",
    "--role", "qa",
  ], {
    env: { BIMO_AGENT_RUNTIME: "bogus" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk));
  child.stderr.on("data", chunk => stderr.push(chunk));
  const [code, signal] = await new Promise(resolve => {
    child.once("exit", (...result) => resolve(result));
  });

  assert.deepEqual([code, signal], [1, null]);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(
    Buffer.concat(stderr).toString("utf8"),
    "bimo-agent: unknown agent runtime: bogus\n",
  );
});

test("seed config validation accepts only baked /etc sources into the HOME tmpfs", () => {
  assert.equal(assertSeedConfig(null), null);
  assert.equal(assertSeedConfig(undefined), null);
  const seed = assertSeedConfig({
    source: "/etc/pi/agent",
    target: "/home/node/.pi/agent",
  });
  assert.deepEqual(seed, { source: "/etc/pi/agent", target: "/home/node/.pi/agent" });
  assert.ok(Object.isFrozen(seed));
  for (const invalid of [
    { source: "/workspace/pi", target: "/home/node/.pi/agent" },
    { source: "/etc/pi/agent", target: "/etc/pi/agent" },
    { source: "/etc/pi/agent", target: "/tmp/pi" },
    { source: "/etc/pi/agent", target: "/home/node/../etc" },
    { source: "/etc/../etc/pi", target: "/home/node/.pi/agent" },
    { source: "/etc/pi/agent" },
    "seed",
  ]) {
    assert.throws(() => assertSeedConfig(invalid), /invalid seed config/u);
  }
});

test("seedAgentConfig copies bounded regular files and rejects symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bimo-seed-"));
  const source = path.join(root, "source");
  const target = path.join(root, "home", ".pi", "agent");
  await mkdir(path.join(source, "nested"), { recursive: true });
  await writeFile(path.join(source, "models.json"), "{}");
  await writeFile(path.join(source, "nested", "settings.json"), '{"a":1}');

  await seedAgentConfig({ source, target });
  const seeded = await readFile(path.join(target, "nested", "settings.json"), "utf8");
  assert.equal(seeded, '{"a":1}');

  await seedAgentConfig(null);

  await symlink(path.join(source, "models.json"), path.join(source, "link"));
  await assert.rejects(
    seedAgentConfig({ source, target }),
    /must not contain symlinks/u,
  );
});
