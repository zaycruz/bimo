// Bridge from the bimo CLI to the Bimo engine, the Rust runtime fabric in
// engine/ (binary `bimo-engine`). The engine places spec-declared agents on
// local or Proxmox targets; this module only finds the binary, passes a
// validated argv to it without a shell, and renders a deployment manifest
// whose target is the engine into the engine's agent spec.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeploymentPlan } from "./deployment-plan.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_BINARY = "bimo-engine";
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4_096;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 6 * 60 * 60_000;
const KILL_GRACE_MS = 5_000;
const SPEC_DIR = path.join(".bimo", "specs");
const ENVELOPE_SCHEMA = "bimo.cli/v1";

export const ENGINE_VERBS = Object.freeze({
  agent: Object.freeze(["validate", "plan", "apply", "status", "logs", "destroy", "list"]),
  pool: Object.freeze(["status", "fill", "drain"]),
  proxy: Object.freeze(["up", "status", "down"]),
});
const SPEC_VERBS = ["validate", "plan", "apply"];

function fail(message) {
  throw new Error(message);
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length > MAX_ARGS
      || argv.some(value => typeof value !== "string" || value.length > MAX_ARG_LENGTH || value.includes("\u0000"))) {
    fail(`engine arguments must be at most ${MAX_ARGS} strings of at most ${MAX_ARG_LENGTH} characters`);
  }
  return Object.freeze([...argv]);
}

function engineTimeout(env) {
  const raw = env.BIMO_ENGINE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > MAX_TIMEOUT_MS) {
    fail(`BIMO_ENGINE_TIMEOUT_MS must be an integer from 1000 to ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

async function executable(file) {
  try {
    await access(file, constants.X_OK);
    const info = await stat(file);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/** Locate bimo-engine: BIMO_ENGINE_BIN, then the newest local cargo build, then PATH. */
export async function resolveEngineBinary(env = process.env) {
  const configured = env.BIMO_ENGINE_BIN;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured) || /[\u0000-\u001f\u007f]/u.test(configured) || configured.length > MAX_ARG_LENGTH) {
      fail("BIMO_ENGINE_BIN must be an absolute path");
    }
    if (!await executable(configured)) fail("BIMO_ENGINE_BIN is not an executable file");
    return configured;
  }
  const builds = [];
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(packageRoot, "engine", "target", profile, ENGINE_BINARY);
    const info = await executable(candidate);
    if (info) builds.push({ candidate, mtime: info.mtimeMs });
  }
  if (builds.length) return builds.sort((a, b) => b.mtime - a.mtime)[0].candidate;
  for (const directory of (env.PATH ?? "").split(path.delimiter).slice(0, 64)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, ENGINE_BINARY);
    if (await executable(candidate)) return candidate;
  }
  fail("bimo-engine is not built: run `cargo build --release --manifest-path engine/Cargo.toml`, or set BIMO_ENGINE_BIN");
}

/** Run bimo-engine with a validated argv and inherited stdio; resolves to its exit code. */
export async function runEngine(argv, { env = process.env } = {}) {
  const args = validateArgv(argv);
  const timeoutMs = engineTimeout(env);
  const binary = await resolveEngineBinary(env);
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "inherit", shell: false, env });
    let timedOut = false;
    let killer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      clearTimeout(killer);
      reject(new Error(`could not start bimo-engine: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (timedOut) {
        process.stderr.write(`bimo: bimo-engine exceeded ${timeoutMs} ms and was stopped\n`);
        resolve(1);
      } else {
        resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
      }
    });
  });
}

function tomlString(value) {
  // JSON string escapes are valid TOML basic-string escapes.
  return JSON.stringify(value);
}

/** Render the engine agent spec for a deployment manifest whose target is the engine. */
export function engineSpecFromPlan(plan, { manifestPath, specDir }) {
  const { manifest } = plan;
  if (manifest.target.kind !== "engine") fail("manifest target is not the engine");
  const configDir = path.resolve(path.dirname(manifestPath), manifest.workload.config);
  const source = path.relative(path.resolve(specDir), configDir) || ".";
  const lines = [
    `# Generated by bimo from ${path.basename(manifestPath)} (${plan.sourceDigest}).`,
    "# Edit the deployment manifest, not this file. See docs/engine.md.",
    "schema_version = 1",
    `name = ${tomlString(engineAgentName(manifest))}`,
    `tenant_id = ${tomlString(manifest.clientId)}`,
    `runtime = ${tomlString(manifest.runtime)}`,
    "",
    "[source]",
    'kind = "config"',
    `path = ${tomlString(source)}`,
    "",
    "[[secrets]]",
    'env = "OPENROUTER_API_KEY"',
    `handle = ${tomlString(manifest.secretRefs.model)}`,
    'hosts = ["openrouter.ai"]',
    "",
    "[egress]",
    'allow = ["openrouter.ai"]',
    "",
    "[placement]",
    `substrate = ${tomlString(manifest.target.name)}`,
    "",
  ];
  return lines.join("\n");
}

/** The engine addresses agents by one name; Bimo identity is clientId/agentId. */
export function engineAgentName(manifest) {
  return `${manifest.clientId}-${manifest.agentId}`;
}

async function writePrivateFile(file, content) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${directory} must be a real directory`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/** Write the engine spec for a manifest under .bimo/specs/ and return its path. */
export async function materializeEngineSpec(manifestPath) {
  const plan = await loadDeploymentPlan(manifestPath);
  if (plan.manifest.target.kind !== "engine") {
    fail(`manifest target kind is ${plan.manifest.target.kind}; bimo agent runs manifests whose target kind is engine`);
  }
  const specDir = path.resolve(SPEC_DIR);
  const file = path.join(specDir, `${engineAgentName(plan.manifest)}.toml`);
  await writePrivateFile(file, engineSpecFromPlan(plan, { manifestPath, specDir }));
  return path.relative(process.cwd(), file) || file;
}

function outputIsJson(args) {
  const index = args.indexOf("--output");
  return index >= 0 && args[index + 1] === "json";
}

function bridgeFailure(verb, manifestPath, error, json) {
  if (!json) fail(error.message);
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    command: verb,
    ok: false,
    changed: false,
    result: null,
    error: { code: "spec_invalid", message: error.message, details: [{ field: "manifest", message: error.message }] },
    next: [`bimo plan ${manifestPath}`],
    idempotency_key: null,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return 1;
}

/**
 * `bimo engine ARGS`, `bimo agent VERB ...`, `bimo pool VERB ...` and
 * `bimo proxy VERB ...`. A deployment manifest (*.json) given to agent
 * validate|plan|apply is rendered into an engine spec first.
 */
export async function main(group, argv) {
  const args = [...argv];
  if (group === "engine") return await runEngine(args);
  if (group === "agent" && SPEC_VERBS.includes(args[0]) && typeof args[1] === "string" && args[1].endsWith(".json")) {
    const manifestPath = args[1];
    try {
      args[1] = await materializeEngineSpec(manifestPath);
    } catch (error) {
      return bridgeFailure(args[0], manifestPath, error, outputIsJson(args));
    }
  }
  return await runEngine([group, ...args]);
}

