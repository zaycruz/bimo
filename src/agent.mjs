#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import process from "node:process";

const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/;
const MAX_OUTPUT_BYTES = 1_048_576;
const INSTRUCTIONS_PATH = "/instructions/instructions.md";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid option: ${flag ?? ""}`);
    options[flag.slice(2)] = value;
  }
  if (!MODEL.test(options.model ?? "")) fail("--model must be an OpenRouter model ID");
  const timeoutSeconds = Number(options["timeout-seconds"]);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1_800) {
    fail("--timeout-seconds must be an integer from 10 to 1800");
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(options.role ?? "")) fail("--role is invalid");
  return { model: options.model, timeoutSeconds, role: options.role };
}

function runOpenCode({ model, timeoutSeconds, role }) {
  return new Promise((resolve, reject) => {
    const gateway = process.env.MONOLITH_GATEWAY_URL;
    if (!gateway || !/^http:\/\/[a-z0-9.-]+:\d{2,5}\/api\/v1$/.test(gateway)) {
      reject(new Error("MONOLITH_GATEWAY_URL is invalid"));
      return;
    }
    const child = spawn("opencode", [
      "run",
      "--pure",
      "--auto",
      "--agent", "build",
      "--format", "json",
      "--dir", "/workspace",
      "--model", model,
      "--file", INSTRUCTIONS_PATH,
      "--title", `monolith-${role}`,
      "Follow the attached Monolith instructions exactly.",
    ], {
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/node",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "1",
        MONOLITH_GATEWAY_URL: gateway,
        OPENCODE_CONFIG: "/etc/opencode/opencode.json",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const terminate = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 2_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1_000);
    timer.unref();

    const consume = chunk => {
      outputBytes += chunk.length;
      hash.update(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) terminate();
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) reject(new Error(`agent timed out after ${timeoutSeconds} seconds`));
      else if (outputBytes > MAX_OUTPUT_BYTES) reject(new Error(`agent output exceeded ${MAX_OUTPUT_BYTES} bytes`));
      else if (code !== 0) reject(new Error(`agent exited ${code}`));
      else resolve({ outputSha256: hash.digest("hex"), outputBytes });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompt = await readFile(INSTRUCTIONS_PATH);
  if (!prompt.length || prompt.length > 256 * 1024) fail("prompt must contain 1 to 262144 bytes");
  const existing = await lstat("/handoff/result.json").catch(() => null);
  if (existing) await unlink("/handoff/result.json");

  const result = await runOpenCode(options);
  const handoff = await lstat("/handoff/result.json").catch(() => null);
  if (!handoff?.isFile() || handoff.isSymbolicLink() || handoff.size < 2 || handoff.size > 65_536) {
    fail("agent did not create a regular bounded /handoff/result.json");
  }
  process.stdout.write(`${JSON.stringify({ status: "completed", ...result })}\n`);
}

main().catch(error => {
  process.stderr.write(`monolith-agent: ${error.message}\n`);
  process.exitCode = 1;
});
