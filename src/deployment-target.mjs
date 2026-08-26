import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SSH_TARGET = /^(?:[a-z_][a-z0-9_-]*@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const TARGET_KINDS = ["local", "ssh", "proxmox-lxc"];
const REMOTE_ROOT = "/var/lib/bimo/deployments";
const LOCAL_ROOT_PARTS = [".local", "share", "bimo", "deployments"];

function fail(message) {
  throw new Error(message);
}

function validateSshTarget(value) {
  if (!SSH_TARGET.test(value ?? "")) fail("SSH target contains unsupported characters");
  return value;
}

function validateLocalHome(home) {
  if (typeof home !== "string" || home.length > 4_096 || !path.isAbsolute(home)
      || path.normalize(home) !== home || /[\u0000\r\n]/u.test(home)) {
    fail("local home directory must be canonical and absolute");
  }
  return home;
}

function resolveLocalHome(home) {
  const validated = validateLocalHome(home);
  let resolved;
  try {
    resolved = realpathSync.native(validated);
  } catch {
    fail("local home directory must exist");
  }
  if (resolved !== validated) fail("local home directory must not be a symlink");
  return validated;
}

export function resolveDeploymentTarget(options = {}, { home = os.homedir() } = {}) {
  const requested = options.target;
  const hasHost = Object.hasOwn(options, "host");
  const hasProxmox = Object.hasOwn(options, "proxmox");
  const hasVmid = Object.hasOwn(options, "vmid");
  if (requested !== undefined && !TARGET_KINDS.includes(requested)) {
    fail("--target must be local, ssh, or proxmox-lxc");
  }

  if (!requested && hasHost && hasProxmox) fail("use only one target");
  const kind = requested
    ?? (hasHost ? "ssh" : hasProxmox ? "proxmox-lxc" : "local");

  if (kind === "local") {
    if (hasHost) fail("--host is not valid with --target local");
    if (hasProxmox) fail("--proxmox is not valid with --target local");
    if (hasVmid) fail("--vmid is only valid with --target proxmox-lxc");
    return Object.freeze({ kind, runtime: "docker", home: resolveLocalHome(home) });
  }

  if (kind === "ssh") {
    if (!hasHost || !options.host) fail("--host is required with --target ssh");
    if (hasProxmox) fail("--proxmox is only valid with --target proxmox-lxc");
    if (hasVmid) fail("--vmid is only valid with --target proxmox-lxc");
    return Object.freeze({
      kind,
      runtime: "docker",
      sshTarget: validateSshTarget(options.host),
    });
  }

  if (hasHost) fail("--host is only valid with --target ssh");
  if (!hasProxmox || !options.proxmox) fail("--proxmox is required with --target proxmox-lxc");
  validateSshTarget(options.proxmox);
  if (!/^\d{1,9}$/.test(options.vmid ?? "")) fail("--vmid must be numeric with --proxmox");
  return Object.freeze({
    kind,
    runtime: "docker",
    sshTarget: options.proxmox,
    vmid: options.vmid,
  });
}

export function commandForTarget(target, command) {
  if (!target || !TARGET_KINDS.includes(target.kind)
      || !Array.isArray(command) || command.length < 1
      || command.some(value => typeof value !== "string" || !value)) {
    fail("invalid deployment target command");
  }
  if (target.kind === "local") {
    return { command: command[0], args: command.slice(1) };
  }
  const prefix = target.kind === "proxmox-lxc"
    ? ["pct", "exec", target.vmid, "--"]
    : [];
  return {
    command: "ssh",
    args: [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      target.sshTarget,
      ...prefix,
      ...command,
    ],
  };
}

export function deploymentRootForTarget(target, deployment) {
  if (!target || !TARGET_KINDS.includes(target.kind) || !NAME.test(deployment ?? "")) {
    fail("invalid deployment target root");
  }
  if (target.kind !== "local") return `${REMOTE_ROOT}/${deployment}`;
  return path.join(validateLocalHome(target.home ?? os.homedir()), ...LOCAL_ROOT_PARTS, deployment);
}

export function isDeploymentHostRoot(hostRoot, deployment, { localHome } = {}) {
  if (typeof hostRoot !== "string" || hostRoot.length > 4_096
      || !NAME.test(deployment ?? "") || !path.isAbsolute(hostRoot)
      || path.normalize(hostRoot) !== hostRoot || /[\u0000\r\n]/u.test(hostRoot)) {
    return false;
  }
  if (hostRoot === `${REMOTE_ROOT}/${deployment}`) return true;
  if (localHome === undefined) return false;
  try {
    return hostRoot === deploymentRootForTarget({ kind: "local", home: localHome }, deployment);
  } catch {
    return false;
  }
}

export function builtInTargetCatalog() {
  return Object.freeze([
    Object.freeze({ kind: "local", runtime: "docker", configuration: "automatic" }),
    Object.freeze({ kind: "ssh", runtime: "docker", configuration: "--host HOST" }),
    Object.freeze({
      kind: "proxmox-lxc",
      runtime: "docker",
      configuration: "--proxmox HOST --vmid ID",
    }),
  ]);
}
