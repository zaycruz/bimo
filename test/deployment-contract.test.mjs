import assert from "node:assert/strict";
import test from "node:test";

import { planDeployment, validateDeploymentManifest } from "../src/deployment-contract.mjs";

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    clientId: "acme",
    agentId: "delivery",
    lifecycle: "job",
    runtime: "pi",
    target: { kind: "local" },
    workload: { template: "react-solo" },
    model: { provider: "openrouter", fallback: "disabled" },
    secretRefs: { model: "op://Vault/Agent/Key" },
    limits: { memoryMiB: 2048, cpus: 1.5, maxConcurrentRuns: 1, runTimeoutSeconds: 900 },
    ...overrides,
  };
}

function assertFrozen(value) {
  assert(Object.isFrozen(value));
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") assertFrozen(child);
  }
}

test("valid job plans are immutable intent, never a claim of execution or isolation", () => {
  const input = manifest();
  const receipt = planDeployment(input);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "executionSupported", "identity", "limitations", "manifest", "planOnly", "schemaVersion",
  ]);
  assert.equal(receipt.planOnly, true);
  assert.equal(receipt.executionSupported, false);
  assert.equal(receipt.identity, "acme/delivery");
  assert.equal(receipt.schemaVersion, 1);
  assert(receipt.limitations.some(text => text.includes("not been applied or enforced")));
  assert.deepEqual(receipt.manifest, input);
  assertFrozen(receipt);
  input.target.kind = "ssh";
  input.limits.memoryMiB = 128;
  input.secretRefs.model = "op://Other/Client/Key";
  assert.equal(receipt.manifest.target.kind, "local");
  assert.equal(receipt.manifest.limits.memoryMiB, 2048);
  assert.equal(receipt.manifest.secretRefs.model, "op://Vault/Agent/Key");
});

test("Hermes Aurum service and local inference remain explicitly unsupported for execution", () => {
  const receipt = planDeployment(manifest({
    agentId: "aurum",
    lifecycle: "service", runtime: "hermes", workload: { service: "aurum" },
    model: { provider: "local", fallback: "disabled" }, secretRefs: { model: null },
  }));
  assert.equal(receipt.executionSupported, false);
  assert(receipt.limitations.some(text => text.includes("Hermes service executor is not implemented")));
  assert(receipt.limitations.some(text => text.includes("local model provider is not implemented")));
});

test("the closed target and job template choices retain exact canonical data", () => {
  for (const target of [{ kind: "local" }, { kind: "ssh", host: "deploy@server.example" },
    { kind: "proxmox-lxc", proxmox: "root@pve-05", vmid: "113" }]) {
    for (const runtime of ["pi", "opencode"]) {
      for (const template of ["react-solo", "react-app", "parallel-engineering-pod"]) {
        const value = validateDeploymentManifest(manifest({ target, runtime, workload: { template } }));
        assert.deepEqual(value.target, target);
        assert.deepEqual(value.workload, { template });
      }
    }
  }
});

test("all object boundaries reject missing and extra fields", () => {
  for (const key of Object.keys(manifest())) {
    const value = manifest();
    delete value[key];
    assert.throws(() => validateDeploymentManifest(value));
  }
  assert.throws(() => validateDeploymentManifest({ ...manifest(), command: "arbitrary" }));
  for (const field of ["target", "workload", "model", "secretRefs", "limits"]) {
    const original = manifest()[field];
    for (const key of Object.keys(original)) {
      const nested = { ...original };
      delete nested[key];
      assert.throws(() => validateDeploymentManifest(manifest({ [field]: nested })));
    }
    assert.throws(() => validateDeploymentManifest(manifest({ [field]: { ...original, command: "arbitrary" } })));
  }
});

test("identity must be explicit, bounded and cannot traverse or alias another namespace", () => {
  for (const value of [undefined, null, 1, {}, "", "../other", "acme/other", "ACME", "has space", "a".repeat(33)]) {
    for (const field of ["clientId", "agentId"]) {
      assert.throws(() => validateDeploymentManifest(manifest({ [field]: value })));
    }
  }
  assert.notEqual(planDeployment(manifest()).identity, planDeployment(manifest({ clientId: "other" })).identity);
  for (const schemaVersion of [0, 2, "1", null]) {
    assert.throws(() => validateDeploymentManifest(manifest({ schemaVersion })));
  }
});

test("runtime, lifecycle and workload combinations fail closed", () => {
  for (const overrides of [
    { runtime: "hermes" }, { runtime: "unknown" }, { lifecycle: "service" },
    { lifecycle: "daemon" }, { workload: { template: "custom" } },
    { lifecycle: "service", runtime: "hermes", workload: { service: "other" } },
    { lifecycle: "service", runtime: "hermes", workload: { template: "react-solo" } },
  ]) assert.throws(() => validateDeploymentManifest(manifest(overrides)));
});

test("targets reject unsupported kinds, shell content and ambiguous access settings", () => {
  for (const target of [
    null, [], { kind: "kubernetes" }, { kind: "local", home: "/tmp" },
    { kind: "local", host: "server" }, { kind: "ssh" },
    { kind: "ssh", host: "server; echo bad" }, { kind: "ssh", host: "-oProxyCommand=bad" },
    { kind: "ssh", host: "server", vmid: "113" },
    { kind: "proxmox-lxc", proxmox: "pve", vmid: 113 },
    { kind: "proxmox-lxc", proxmox: "pve", vmid: "1;id" },
    { kind: "proxmox-lxc", proxmox: "pve", vmid: "1234567890" },
  ]) assert.throws(() => validateDeploymentManifest(manifest({ target })));
});

test("model policy accepts references only and forbids implicit cloud fallback", () => {
  for (const value of [null, "sk-private-value", "https://secret", "op://vault/item", "op://vault/item/key\n", "op://" + "v".repeat(256) + "/item/key"]) {
    assert.throws(() => validateDeploymentManifest(manifest({ secretRefs: { model: value } })), error => {
      assert(!error.message.includes("sk-private-value"));
      return true;
    });
  }
  for (const model of [
    { provider: "openai", fallback: "disabled" },
    { provider: "local", fallback: "openrouter" },
    { provider: "openrouter", fallback: true },
    { provider: "local", fallback: "disabled", endpoint: "http://untrusted" },
  ]) assert.throws(() => validateDeploymentManifest(manifest({ model })));
  assert.throws(() => validateDeploymentManifest(manifest({ model: { provider: "local", fallback: "disabled" } })));
  assert.throws(() => validateDeploymentManifest(manifest({ secretRefs: { model: "op://v/i/k", apiKey: "private" } })));
});

test("limits enforce finite numeric bounds without coercion", () => {
  const ranges = { memoryMiB: [128, 65536], cpus: [0.25, 64], maxConcurrentRuns: [1, 8], runTimeoutSeconds: [1, 7200] };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    for (const value of [minimum, maximum]) {
      assert.equal(validateDeploymentManifest(manifest({ limits: { ...manifest().limits, [key]: value } })).limits[key], value);
    }
    const invalid = [minimum - 0.1, maximum + 1, Infinity, NaN, null, String(minimum)];
    if (key !== "cpus") invalid.push(minimum + 0.5);
    for (const value of invalid) {
      assert.throws(() => validateDeploymentManifest(manifest({ limits: { ...manifest().limits, [key]: value } })));
    }
  }
});

test("validation rejects prototypes, symbols and accessors without executing caller code", () => {
  for (const value of [[], Object.create(manifest()), null, "manifest"]) {
    assert.throws(() => validateDeploymentManifest(value));
  }
  const symbol = manifest();
  symbol[Symbol("secret")] = "hidden";
  assert.throws(() => validateDeploymentManifest(symbol));
  let calls = 0;
  const accessor = manifest();
  Object.defineProperty(accessor, "clientId", { enumerable: true, get() { calls += 1; return "acme"; } });
  assert.throws(() => validateDeploymentManifest(accessor));
  const target = {};
  Object.defineProperty(target, "kind", { enumerable: true, get() { calls += 1; return "local"; } });
  assert.throws(() => validateDeploymentManifest(manifest({ target })));
  assert.equal(calls, 0);
});
