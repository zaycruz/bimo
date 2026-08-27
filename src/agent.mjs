#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  AGENT_INSTRUCTIONS_PATH,
  DEFAULT_AGENT_RUNTIME,
  agentRuntimeFor,
} from "./agent-runtime.mjs";

const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/;
const MAX_OUTPUT_BYTES = 1_048_576;
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u;

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

function assertSpawnArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64
      || argv.some(value => typeof value !== "string" || !value || value.length > 1_024
        || UNSAFE_CONTROL.test(value))) {
    fail("agent runtime returned an invalid spawn argv");
  }
  return argv;
}

function assertSpawnEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)
      || Object.keys(env).length < 1 || Object.keys(env).length > 32
      || Object.entries(env).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)
        || typeof value !== "string" || !value || value.length > 1_024
        || UNSAFE_CONTROL.test(value))) {
    fail("agent runtime returned an invalid spawn environment");
  }
  return env;
}

function assertDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object"
      || typeof diagnostics.stdout !== "function" || typeof diagnostics.stderr !== "function"
      || typeof diagnostics.failure !== "function") {
    fail("agent runtime returned invalid diagnostics");
  }
  return diagnostics;
}

function runAgent(runtime, { model, timeoutSeconds, role }) {
  return new Promise((resolve, reject) => {
    const gateway = process.env.BIMO_GATEWAY_URL;
    if (!gateway || !/^http:\/\/[a-z0-9.-]+:\d{2,5}\/api\/v1$/.test(gateway)) {
      reject(new Error("BIMO_GATEWAY_URL is invalid"));
      return;
    }
    let argv;
    let env;
    let diagnostics;
    try {
      argv = assertSpawnArgv(runtime.spawnArgv({ model, role }));
      env = assertSpawnEnv(runtime.spawnEnv({ gateway }));
      diagnostics = assertDiagnostics(runtime.createDiagnostics());
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      env,
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

    const consume = (chunk, stream) => {
      outputBytes += chunk.length;
      if (stream === "stdout") diagnostics.stdout(chunk);
      else diagnostics.stderr(chunk);
      hash.update(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) terminate();
    };
    child.stdout.on("data", chunk => consume(chunk, "stdout"));
    child.stderr.on("data", chunk => consume(chunk, "stderr"));
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
      else if (code !== 0) reject(new Error(diagnostics.failure(code)));
      else resolve({ outputSha256: hash.digest("hex"), outputBytes });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtime = agentRuntimeFor(process.env.BIMO_AGENT_RUNTIME ?? DEFAULT_AGENT_RUNTIME);
  const prompt = await readFile(AGENT_INSTRUCTIONS_PATH);
  if (!prompt.length || prompt.length > 256 * 1024) fail("prompt must contain 1 to 262144 bytes");
  const existing = await lstat("/handoff/result.json").catch(() => null);
  if (existing) await unlink("/handoff/result.json");

  const result = await runAgent(runtime, options);
  const handoff = await lstat("/handoff/result.json").catch(() => null);
  if (!handoff?.isFile() || handoff.isSymbolicLink() || handoff.size < 2 || handoff.size > 65_536) {
    fail("agent did not create a regular bounded /handoff/result.json");
  }
  process.stdout.write(`${JSON.stringify({ status: "completed", ...result })}\n`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
const invokedFromBimo = process.argv[1]
  ? path.basename(process.argv[1]) === "bimo"
  : false;
if (invokedPath === import.meta.url || invokedFromBimo) {
  main().catch(error => {
    process.stderr.write(`bimo-agent: ${error.message}\n`);
    process.exitCode = 1;
  });
}
