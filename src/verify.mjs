#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const MAX_HTTP_BODY = 5 * 1024 * 1024;
const MAX_SERVER_OUTPUT = 64 * 1024;
const SERVE_SCRIPT = path.resolve(import.meta.dirname, "serve.mjs");

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid option: ${flag ?? ""}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) fail(`duplicate option: ${flag}`);
    options[key] = value;
  }
  const allowed = new Set(["max-files", "max-bytes", "output", "contains", "path", "status", "timeout-seconds"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`unknown option: --${key}`);
  }
  const maxFiles = Number(options["max-files"]);
  const maxBytes = Number(options["max-bytes"]);
  const status = Number(options.status);
  const timeoutSeconds = Number(options["timeout-seconds"]);
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 5_000) fail("--max-files is invalid");
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 104_857_600) fail("--max-bytes is invalid");
  if (!/^[a-zA-Z0-9._-]+$/.test(options.output ?? "")) fail("--output is invalid");
  if (typeof options.contains !== "string" || !options.contains || options.contains.length > 256) fail("--contains is invalid");
  if (typeof options.path !== "string"
      || !options.path.startsWith("/")
      || options.path.includes("..")
      || options.path.length > 256) fail("--path is invalid");
  const pathname = new URL(options.path, "http://localhost").pathname;
  if (pathname === "/healthz") fail("--path must probe the artifact, not /healthz");
  if (!Number.isInteger(status) || status < 100 || status > 599) fail("--status is invalid");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) fail("--timeout-seconds is invalid");
  return {
    maxFiles,
    maxBytes,
    output: options.output,
    contains: options.contains,
    path: options.path,
    status,
    timeoutMs: timeoutSeconds * 1_000,
  };
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp/home",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    let bytes = 0;
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
    }, timeoutMs);
    const consume = chunk => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes > MAX_COMMAND_OUTPUT) terminate();
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} ${args.join(" ")} timed out`));
      else if (bytes > MAX_COMMAND_OUTPUT) reject(new Error(`${command} output exceeded limit`));
      else if (code !== 0) reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
      else resolve(`${command} ${args.join(" ")} exited 0 (output sha256 ${hash.digest("hex")})`);
    });
  });
}

function remaining(deadline, label) {
  const milliseconds = deadline - Date.now();
  if (milliseconds < 1) fail(`${label} timed out`);
  return milliseconds;
}

function terminateGroup(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch {}
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  terminateGroup(child, "SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (stopped) return;
  terminateGroup(child, "SIGKILL");
  await Promise.race([
    closed,
    new Promise(resolve => setTimeout(resolve, 1_000)),
  ]);
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve an HTTP verification port"));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function startServer({ root, port, serveScript, workspaceRoot }) {
  return spawn(process.execPath, [serveScript, "--root", root, "--port", String(port)], {
    cwd: workspaceRoot,
    detached: true,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp/home",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForServer(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", consume);
      child.stderr.off("data", consume);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const consume = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_SERVER_OUTPUT) {
        finish(new Error("trusted static server output exceeded limit"));
        return;
      }
      output += chunk.toString("utf8");
      if (output.includes("bimo-static listening on ")) finish();
    };
    const onError = error => finish(error);
    const onClose = code => finish(new Error(`trusted static server exited ${code} before listening`));
    const timer = setTimeout(() => finish(new Error("trusted static server startup timed out")), timeoutMs);
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function probeArtifact({ url, status, contains, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > MAX_HTTP_BODY) fail("smoke response exceeds 5 MiB");
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (response.status !== status) fail(`expected HTTP ${status}, received ${response.status}`);
    if (!body.includes(contains)) fail(`response does not contain required marker: ${contains}`);
  } catch (error) {
    if (controller.signal.aborted) fail("artifact HTTP smoke timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyArtifactHttp({ root, path: smokePath, status, contains, timeoutMs }, {
  serveScript = SERVE_SCRIPT,
  workspaceRoot = "/workspace",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const port = await reservePort();
  const child = startServer({ root, port, serveScript, workspaceRoot });
  try {
    await waitForServer(child, remaining(deadline, "trusted static server startup"));
    await probeArtifact({
      url: `http://127.0.0.1:${port}${smokePath}`,
      status,
      contains,
      timeoutMs: remaining(deadline, "artifact HTTP smoke"),
    });
    return `artifact HTTP GET ${smokePath} returned ${status} with the required marker`;
  } finally {
    await stopServer(child);
  }
}

async function scanOutput(root, maximumFiles, maximumBytes, contains) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  let markerFound = false;

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) fail(`output contains a symlink: ${relative}`);
      if (stat.isDirectory()) await visit(target);
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > maximumFiles) fail(`output exceeds ${maximumFiles} files`);
        if (bytes > maximumBytes) fail(`output exceeds ${maximumBytes} bytes`);
        const content = await readFile(target);
        hash.update(`${relative}\0${stat.size}\0`);
        hash.update(content);
        if (content.includes(Buffer.from(contains))) markerFound = true;
      } else fail(`output contains an unsupported entry: ${relative}`);
    }
  }

  await visit(root);
  if (!files) fail("output directory is empty");
  if (!markerFound) fail(`output does not contain required marker: ${contains}`);
  return { files, bytes, sha256: hash.digest("hex") };
}

export async function verifyWorkspace(options, {
  workspaceRoot = "/workspace",
  serveScript = SERVE_SCRIPT,
} = {}) {
  const deadline = Date.now() + options.timeoutMs;
  const evidence = [];
  const runCheck = args => run("npm", args, {
    cwd: workspaceRoot,
    timeoutMs: remaining(deadline, `npm ${args.join(" ")}`),
  });
  evidence.push(await runCheck(["test"]));
  evidence.push(await runCheck(["run", "build"]));
  evidence.push(await runCheck(["run", "smoke"]));
  const outputRoot = path.join(workspaceRoot, options.output);
  const stat = await lstat(outputRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`missing output directory: ${options.output}`);
  const artifact = await scanOutput(outputRoot, options.maxFiles, options.maxBytes, options.contains);
  evidence.push(`artifact ${options.output}/ contains ${artifact.files} files and ${artifact.bytes} bytes (sha256 ${artifact.sha256})`);
  evidence.push(await verifyArtifactHttp({
    root: outputRoot,
    path: options.path,
    status: options.status,
    contains: options.contains,
    timeoutMs: remaining(deadline, "artifact HTTP smoke"),
  }, { serveScript, workspaceRoot }));
  return { status: "passed", evidence, artifact };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await verifyWorkspace(options);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (["verify.mjs", "bimo"].includes(path.basename(process.argv[1] ?? ""))) {
  main().catch(error => {
    process.stderr.write(`bimo-verify: ${error.message}\n`);
    process.exitCode = 1;
  });
}
