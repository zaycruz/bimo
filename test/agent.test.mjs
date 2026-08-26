import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createOpenCodeDiagnostics } from "../src/agent.mjs";

const monolithScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "monolith",
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

test("bin monolith dispatches the agent entrypoint", async () => {
  const child = spawn(process.execPath, [monolithScript, "agent", "--bad"], {
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
  assert.equal(Buffer.concat(stderr).toString("utf8"), "monolith-agent: invalid option: --bad\n");
});
