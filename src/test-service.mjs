import { validateDeploymentManifest } from "./deployment-contract.mjs";
import { commandForTarget, resolveDeploymentTarget } from "./deployment-target.mjs";

const FIELDS = Object.freeze(["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ExecMainStatus", "NRestarts"]);
const ACTIONS = Object.freeze(["status", "start", "stop", "restart"]);

function fail(message) {
  throw new Error(`test service: ${message}`);
}

function assertExactFields(value, fields) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail("invalid receipt fields");
}

export function testServiceUnit(input) {
  const manifest = validateDeploymentManifest(input);
  if (manifest.lifecycle !== "service" || manifest.runtime !== "hermes") {
    fail("requires a service/hermes/aurum manifest");
  }
  // Dots cannot occur inside validated IDs, so identity pairs cannot collide.
  return `bimo-test-${manifest.clientId}.${manifest.agentId}.service`;
}

export function parseServiceStatus(stdout, unit) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 4096) fail("invalid status size");
  const values = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const match = /^([A-Za-z]+)=([^\r\n]*)$/u.exec(line);
    if (!match || !FIELDS.includes(match[1]) || Object.hasOwn(values, match[1])) fail("invalid status fields");
    values[match[1]] = match[2];
  }
  assertExactFields(values, FIELDS);
  if (values.Id !== unit || values.LoadState !== "loaded") fail("unit must be loaded with the exact test identity; aliases are unsupported");
  if (!["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "refreshing"].includes(values.ActiveState)
      || !/^[a-z][a-z-]{0,63}$/u.test(values.SubState)) fail("invalid service state");
  for (const field of ["MainPID", "ExecMainStatus", "NRestarts"]) {
    if (!/^(0|[1-9][0-9]{0,9})$/u.test(values[field]) || Number(values[field]) > 2147483647) fail("invalid service counters");
    values[field] = Number(values[field]);
  }
  return Object.freeze(values);
}

function serviceTarget(target) {
  if (target.kind === "local") return Object.freeze({ kind: "local" });
  return resolveDeploymentTarget(Object.freeze({ ...target, target: target.kind }));
}

function serviceEnvironment() {
  // System units use the system bus; never inherit bus redirection, provider
  // keys, GitHub tokens, 1Password auth or arbitrary systemctl/SSH settings.
  const env = {};
  for (const key of ["PATH", "HOME", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length <= 4096 && !/[\u0000\r\n]/u.test(value)) env[key] = value;
  }
  return Object.freeze(env);
}

export async function manageTestService(action, input, execute) {
  if (!ACTIONS.includes(action)) fail("action must be status, start, stop, or restart");
  const manifest = validateDeploymentManifest(input);
  const unit = testServiceUnit(manifest);
  const target = serviceTarget(manifest.target);
  const env = serviceEnvironment();
  const deadline = Date.now() + 30_000;
  async function run(args) {
    const timeoutMs = Math.min(10_000, deadline - Date.now());
    if (timeoutMs <= 0) fail("operation deadline exceeded; observed state is unknown");
    const invocation = commandForTarget(target, ["systemctl", "--no-pager", "--no-ask-password", ...args, unit]);
    try {
      return await execute(invocation.command, Object.freeze(invocation.args), Object.freeze({ timeoutMs, maxOutputBytes: 4096, env }));
    } catch {
      // Never forward arbitrary systemctl/SSH stderr (which may contain secrets).
      fail("command failed or exceeded its deadline/output limit; observed state is unknown");
    }
  }
  async function status() {
    const result = await run(["show", `--property=${FIELDS.join(",")}`]);
    if (result.code !== 0) fail("status command failed");
    return parseServiceStatus(result.stdout, unit);
  }
  let observed = await status();
  async function transition(operation) {
    const result = await run([operation]);
    if (result.code !== 0) fail("lifecycle command failed; observed state is unknown");
    observed = await status();
    const expected = operation === "start" ? ["active", "running"] : ["inactive", "dead"];
    if (observed.ActiveState !== expected[0] || observed.SubState !== expected[1]
        || (operation === "start" ? observed.MainPID === 0 : observed.MainPID !== 0)) {
      fail(`${operation} did not reach the expected process state`);
    }
  }
  if (action === "restart") {
    await transition("stop");
    await transition("start");
  } else if (action !== "status") {
    await transition(action);
  }
  const receipt = {
    schemaVersion: 1,
    scope: "test-only",
    action,
    identity: `${manifest.clientId}/${manifest.agentId}`,
    target: manifest.target,
    unit,
    observed,
    limitations: Object.freeze([
      "Manages a pre-provisioned test unit; no agent, credentials, isolation or resource limits were provisioned.",
      "Process state does not prove model, channel, application health or recovery of in-flight requests.",
    ]),
  };
  assertExactFields(receipt, ["schemaVersion", "scope", "action", "identity", "target", "unit", "observed", "limitations"]);
  return Object.freeze(receipt);
}
