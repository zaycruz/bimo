#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{2,127}$/;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_LINE_BYTES = 65_536;
const INSTRUCTIONS_PATH = "/instructions/instructions.md";
const DIAGNOSTIC_EVENT_TYPES = new Set([
  "error",
  "reasoning",
  "step_finish",
  "step_start",
  "text",
  "tool_use",
]);

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

function findHttpStatus(value, depth = 0, budget = { visited: 0 }) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || depth > 4 || budget.visited >= 32) return null;
  budget.visited += 1;
  for (const key of ["status", "statusCode"]) {
    const raw = value[key];
    const status = typeof raw === "string" && /^\d{3}$/u.test(raw) ? Number(raw) : raw;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  for (const nested of Object.values(value)) {
    const status = findHttpStatus(nested, depth + 1, budget);
    if (status !== null) return status;
  }
  return null;
}

export function createOpenCodeDiagnostics() {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutLine = "";
  let discardingLine = false;
  let finished = false;
  const decoder = new TextDecoder("utf-8");
  const eventCounts = new Map();
  let errorStatus = null;
  const recordEvent = line => {
    if (!line || Buffer.byteLength(line) > MAX_DIAGNOSTIC_LINE_BYTES) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)
        || !DIAGNOSTIC_EVENT_TYPES.has(event.type)) return;
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    if (event.type === "error") errorStatus = findHttpStatus(event.error);
  };
  return {
    stdout(chunk) {
      stdoutBytes += chunk.length;
      let text = decoder.decode(chunk, { stream: true });
      if (discardingLine) {
        const newline = text.indexOf("\n");
        if (newline === -1) return;
        discardingLine = false;
        text = text.slice(newline + 1);
      }
      const lines = `${stdoutLine}${text}`.split("\n");
      stdoutLine = lines.pop() ?? "";
      for (const line of lines) recordEvent(line);
      if (Buffer.byteLength(stdoutLine) > MAX_DIAGNOSTIC_LINE_BYTES) {
        stdoutLine = "";
        discardingLine = true;
      }
    },
    stderr(chunk) {
      stderrBytes += chunk.length;
    },
    failure(code) {
      if (finished) throw new Error("OpenCode diagnostics already finalized");
      finished = true;
      const finalLine = discardingLine ? "" : `${stdoutLine}${decoder.decode()}`;
      if (finalLine) recordEvent(finalLine);
      const exit = Number.isInteger(code) ? `agent exited ${code}` : "agent exited on signal";
      const events = [...eventCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, count]) => `${type}:${count}`)
        .join(",");
      return [
        exit,
        ...(events ? [`events=${events}`] : []),
        ...(errorStatus === null ? [] : [`errorStatus=${errorStatus}`]),
        `stdoutBytes=${stdoutBytes}`,
        `stderrBytes=${stderrBytes}`,
      ].join("; ");
    },
  };
}

function runOpenCode({ model, timeoutSeconds, role }) {
  return new Promise((resolve, reject) => {
    const gateway = process.env.BIMO_GATEWAY_URL;
    if (!gateway || !/^http:\/\/[a-z0-9.-]+:\d{2,5}\/api\/v1$/.test(gateway)) {
      reject(new Error("BIMO_GATEWAY_URL is invalid"));
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
      "--title", `bimo-${role}`,
      "Follow the attached Bimo instructions exactly.",
    ], {
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/node",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "1",
        BIMO_GATEWAY_URL: gateway,
        OPENCODE_CONFIG: "/etc/opencode/opencode.json",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    let outputBytes = 0;
    const diagnostics = createOpenCodeDiagnostics();
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
