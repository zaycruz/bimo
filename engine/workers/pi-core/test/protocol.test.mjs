import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HostToolBridge, parseFrame } from "../dist/protocol.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "protocol",
  "fixtures",
);

function fixtureLines(name) {
  return fs
    .readFileSync(path.join(fixturesDir, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

test("tool call waits for the matching host result", async () => {
  const sent = [];
  const bridge = new HostToolBridge((name, args, id) => sent.push({ name, args, id }));
  const result = bridge.call("factory.read_state", {}, "tool-1");
  assert.deepEqual(sent, [{ name: "factory.read_state", args: {}, id: "tool-1" }]);
  bridge.accept("tool-1", { ok: true });
  assert.deepEqual(await result, { ok: true });
});

test("unknown and duplicate tool result identities fail closed", async () => {
  const bridge = new HostToolBridge(() => {});
  const pending = bridge.call("factory.read_state", {}, "tool-1");
  await assert.rejects(bridge.call("factory.read_state", {}, "tool-1"), /duplicate_tool_call_id/);
  assert.throws(() => bridge.accept("other", {}), /unknown_tool_result/);
  bridge.failAll("cancelled");
  await assert.rejects(pending, /cancelled/);
});

test("parser rejects malformed and unknown control frames", () => {
  assert.throws(() => parseFrame(""), /invalid_frame_json/);
  assert.throws(() => parseFrame(JSON.stringify({ protocol: "agent-worker/v1", extra: true })), /invalid_frame_unknown_field/);
  assert.throws(() => parseFrame("{}".padEnd(100), 10), /frame_too_large/);
});

test("shared protocol fixtures parse identically to Rust", () => {
  // The worker-side parser accepts only control-to-worker frames. The shared
  // legal handshake must yield exactly one accepted frame (the hello_ack) and
  // reject the worker-to-control hello, matching the Rust contract test in
  // tests/worker_contract.rs.
  const legal = fixtureLines("legal-handshake.jsonl");
  assert.equal(legal.length, 2);
  assert.doesNotThrow(() => parseFrame(legal[1]));
  assert.throws(() => parseFrame(legal[0]), /invalid_frame_identity/);

  const illegal = fixtureLines("illegal-sequence.jsonl");
  assert.equal(illegal.length, 1);
  assert.throws(() => parseFrame(illegal[0]), /invalid_frame_identity/);
});
