import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("engineering, qa, and testing loop once before completion", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "monolith-state-"));
  const { stdout } = await exec("node", [
    "src/runner.mjs", "run", "workflows/engineering-loop.json",
    "--task", "demo", "--state-dir", stateDir, "--workspace", root,
  ], {
    cwd: root,
    env: { ...process.env, MONOLITH_AGENT_COMMAND_JSON: '["node","test/fixture-agent.mjs"]' },
  });

  assert.match(stdout, /completed in 2 round\(s\)/);
  const state = JSON.parse(await readFile(path.join(stateDir, "run.json"), "utf8"));
  assert.equal(state.status, "completed");
  assert.deepEqual(state.history.map(item => `${item.state}:${item.result}`), [
    "engineering:completed",
    "qa:failed",
    "engineering:completed",
    "qa:passed",
    "testing:passed",
  ]);
  assert.equal(state.history[1].message, "QA requested one correction.");
});
