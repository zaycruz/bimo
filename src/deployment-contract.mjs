import { resolveDeploymentTarget } from "./deployment-target.mjs";

const ID = /^[a-z][a-z0-9-]{0,31}$/u;
const SECRET_REF = /^op:\/\/[^/\u0000-\u001f\u007f]{1,255}\/[^/\u0000-\u001f\u007f]{1,255}\/[^/\u0000-\u001f\u007f]{1,255}$/u;
const MANIFEST_FIELDS = [
  "schemaVersion", "clientId", "agentId", "lifecycle", "runtime", "target",
  "workload", "model", "secretRefs", "limits",
];
const TEMPLATES = ["react-solo", "react-app", "parallel-engineering-pod", "pi-palantir-pod"];

function fail(message) {
  throw new Error(message);
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    fail(`${label} has an invalid field set`);
  }
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(`${label} must contain only enumerable data fields`);
    }
  }
}

function validateIdentity(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function validateTarget(target) {
  // Inspect the kind descriptor without invoking an accessor on caller input.
  const kind = target && Object.getOwnPropertyDescriptor(target, "kind")?.value;
  if (kind === "local") {
    assertExactFields(target, ["kind"], "target");
    // Planning local intent must not probe HOME or resolve a Docker context.
    return Object.freeze({ kind });
  }
  if (kind === "ssh") {
    assertExactFields(target, ["kind", "host"], "target");
    if (typeof target.host !== "string" || target.host.length > 300) fail("target host is invalid");
    resolveDeploymentTarget({ target: kind, host: target.host }, { home: "/" });
    return Object.freeze({ kind, host: target.host });
  }
  if (kind === "proxmox-lxc") {
    assertExactFields(target, ["kind", "proxmox", "vmid"], "target");
    if (typeof target.proxmox !== "string" || target.proxmox.length > 300
        || typeof target.vmid !== "string" || !/^\d{1,9}$/u.test(target.vmid)) {
      fail("target Proxmox configuration is invalid");
    }
    resolveDeploymentTarget({ target: kind, proxmox: target.proxmox, vmid: target.vmid }, { home: "/" });
    return Object.freeze({ kind, proxmox: target.proxmox, vmid: target.vmid });
  }
  fail("target kind is unsupported");
}

function validateWorkload(lifecycle, runtime, workload) {
  if (lifecycle === "job" && ["opencode", "pi"].includes(runtime)) {
    assertExactFields(workload, ["template"], "workload");
    if (!TEMPLATES.includes(workload.template)) fail("job template is unsupported");
    return Object.freeze({ template: workload.template });
  }
  if (lifecycle === "service" && runtime === "hermes") {
    assertExactFields(workload, ["service"], "workload");
    if (workload.service !== "aurum") fail("service workload is unsupported");
    return Object.freeze({ service: workload.service });
  }
  fail("runtime and lifecycle combination is unsupported");
}

function validateModel(model, secretRefs) {
  assertExactFields(model, ["provider", "fallback"], "model");
  assertExactFields(secretRefs, ["model"], "secretRefs");
  if (!["openrouter", "local"].includes(model.provider) || model.fallback !== "disabled") {
    fail("model policy is unsupported");
  }
  if (model.provider === "openrouter") {
    if (typeof secretRefs.model !== "string" || !SECRET_REF.test(secretRefs.model)) {
      fail("model secret must be a 1Password reference");
    }
  } else if (secretRefs.model !== null) {
    fail("local model secret reference must be null");
  }
  return Object.freeze({ provider: model.provider, fallback: model.fallback });
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`${label} is invalid`);
  return value;
}

function validateLimits(limits) {
  assertExactFields(limits, ["memoryMiB", "cpus", "maxConcurrentRuns", "runTimeoutSeconds"], "limits");
  if (!Number.isFinite(limits.cpus) || limits.cpus < 0.25 || limits.cpus > 64) fail("CPU limit is invalid");
  return Object.freeze({
    memoryMiB: boundedInteger(limits.memoryMiB, 128, 65_536, "memory limit"),
    cpus: limits.cpus,
    maxConcurrentRuns: boundedInteger(limits.maxConcurrentRuns, 1, 8, "concurrency limit"),
    runTimeoutSeconds: boundedInteger(limits.runTimeoutSeconds, 1, 7_200, "run timeout"),
  });
}

export function validateDeploymentManifest(input) {
  assertExactFields(input, MANIFEST_FIELDS, "deployment manifest");
  if (input.schemaVersion !== 1) fail("deployment manifest schemaVersion must be 1");
  const clientId = validateIdentity(input.clientId, "client ID");
  const agentId = validateIdentity(input.agentId, "agent ID");
  const target = validateTarget(input.target);
  const workload = validateWorkload(input.lifecycle, input.runtime, input.workload);
  const model = validateModel(input.model, input.secretRefs);
  const limits = validateLimits(input.limits);
  return Object.freeze({
    schemaVersion: 1, clientId, agentId, lifecycle: input.lifecycle, runtime: input.runtime,
    target, workload, model, secretRefs: Object.freeze({ model: input.secretRefs.model }), limits,
  });
}

export function planDeployment(input) {
  const manifest = validateDeploymentManifest(input);
  const limitations = [
    "Plan only: no deployment or durable identity has been created.",
    "Resource limits, credential bindings and client isolation have not been applied or enforced.",
  ];
  if (manifest.lifecycle === "service") limitations.push("The Hermes service executor is not implemented.");
  if (manifest.model.provider === "local") limitations.push("The local model provider is not implemented.");
  return Object.freeze({
    schemaVersion: 1,
    planOnly: true,
    executionSupported: false,
    identity: `${manifest.clientId}/${manifest.agentId}`,
    manifest,
    limitations: Object.freeze(limitations),
  });
}
