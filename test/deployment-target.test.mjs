import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandForTarget,
  deploymentRootForTarget,
  deploymentsRootForTarget,
  isDeploymentHostRoot,
  resolveDeploymentTarget,
} from "../src/deployment-target.mjs";

test("local is the default deployment target with a user-owned state root", () => {
  const home = os.homedir();
  const target = resolveDeploymentTarget({}, { home });

  assert.deepEqual(target, {
    kind: "local",
    runtime: "docker",
    home,
  });
  assert.equal(
    deploymentRootForTarget(target, "fleet-demo"),
    path.join(home, ".local", "share", "bimo", "deployments", "fleet-demo"),
  );
  assert.deepEqual(commandForTarget(target, ["docker", "info"]), {
    command: "docker",
    args: ["info"],
  });
});

test("local target rejects a symlinked home before constructing bind mounts", async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bimo-target-home-"));
  const realHome = path.join(parent, "real");
  const linkedHome = path.join(parent, "linked");
  await mkdir(realHome);
  await symlink(realHome, linkedHome);
  t.after(() => rm(parent, { recursive: true, force: true }));

  assert.throws(
    () => resolveDeploymentTarget({}, { home: linkedHome }),
    /local home directory must not be a symlink/,
  );
});

test("legacy and explicit SSH targets resolve to the same closed built-in adapter", () => {
  const legacy = resolveDeploymentTarget({ host: "builder.example" });
  const explicit = resolveDeploymentTarget({ target: "ssh", host: "builder.example" });

  assert.deepEqual(explicit, legacy);
  assert.deepEqual(commandForTarget(explicit, ["docker", "info"]), {
    command: "ssh",
    args: [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "builder.example",
      "docker", "info",
    ],
  });
  assert.equal(
    deploymentRootForTarget(explicit, "fleet-demo"),
    "/var/lib/bimo/deployments/fleet-demo",
  );
});

test("legacy and explicit Proxmox LXC targets retain the pct execution boundary", () => {
  const legacy = resolveDeploymentTarget({ proxmox: "root@pve-05", vmid: "212" });
  const explicit = resolveDeploymentTarget({
    target: "proxmox-lxc",
    proxmox: "root@pve-05",
    vmid: "212",
  });

  assert.deepEqual(explicit, legacy);
  assert.deepEqual(commandForTarget(explicit, ["docker", "info"]), {
    command: "ssh",
    args: [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "root@pve-05",
      "pct", "exec", "212", "--",
      "docker", "info",
    ],
  });
});

test("target selection rejects ambiguous or incomplete adapter configuration", () => {
  for (const [options, pattern] of [
    [{ target: "other" }, /--target must be local, ssh, or proxmox-lxc/],
    [{ target: "local", host: "builder.example" }, /--host is not valid with --target local/],
    [{ target: "ssh" }, /--host is required with --target ssh/],
    [{ target: "ssh", host: "builder.example", vmid: "212" }, /--vmid is only valid/],
    [{ target: "proxmox-lxc", proxmox: "pve-05" }, /--vmid must be numeric/],
    [{ host: "builder.example", proxmox: "pve-05", vmid: "212" }, /use only one target/],
  ]) {
    assert.throws(() => resolveDeploymentTarget(options), pattern);
  }
});

test("controller host roots accept only canonical remote or local deployment roots", () => {
  assert.equal(isDeploymentHostRoot("/var/lib/bimo/deployments/demo", "demo"), true);
  assert.equal(
    isDeploymentHostRoot("/Users/tester/.local/share/bimo/deployments/demo", "demo", {
      localHome: "/Users/tester",
    }),
    true,
  );
  assert.equal(
    isDeploymentHostRoot("/tmp/x/.local/share/bimo/deployments/demo", "demo", {
      localHome: "/Users/tester",
    }),
    false,
  );
  assert.equal(isDeploymentHostRoot("/var/lib/bimo/deployments/other", "demo"), false);
  assert.equal(
    isDeploymentHostRoot("/Users/tester/.local/share/bimo/deployments/other", "demo", {
      localHome: "/Users/tester",
    }),
    false,
  );
  assert.equal(
    isDeploymentHostRoot("/Users/tester/../tester/.local/share/bimo/deployments/demo", "demo", {
      localHome: "/Users/tester",
    }),
    false,
  );
});

test("deploymentsRootForTarget returns the shared deployments root per adapter", () => {
  const home = os.homedir();
  assert.equal(
    deploymentsRootForTarget(resolveDeploymentTarget({}, { home })),
    path.join(home, ".local", "share", "bimo", "deployments"),
  );
  assert.equal(
    deploymentsRootForTarget(resolveDeploymentTarget({ host: "builder.example" })),
    "/var/lib/bimo/deployments",
  );
  assert.equal(
    deploymentsRootForTarget(resolveDeploymentTarget({ proxmox: "root@pve-05", vmid: "212" })),
    "/var/lib/bimo/deployments",
  );
  assert.throws(() => deploymentsRootForTarget({ kind: "other" }), /invalid deployment target root/);
});
