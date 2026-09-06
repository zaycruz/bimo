import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { planDeployment } from "./deployment-contract.mjs";

const MAX_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 2_000;

function fail(message) {
  throw new Error(message);
}

async function readManifestBytes(file, signal) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    signal.throwIfAborted();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) fail("manifest must be a regular file of at most 65536 bytes");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    signal.throwIfAborted();
    if (length > MAX_BYTES) fail("manifest must be a regular file of at most 65536 bytes");
    return buffer.subarray(0, length);
  } finally {
    await handle?.close();
  }
}

async function readBoundedManifest(file) {
  if (typeof file !== "string" || file.length < 1 || file.length > 4096 || /[\u0000-\u001f\u007f]/u.test(file)) {
    fail("manifest path is invalid");
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("manifest read deadline exceeded"));
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readManifestBytes(file, controller.signal), deadline]);
  } catch {
    fail("cannot read manifest: use a regular non-symlink file of at most 65536 bytes");
  } finally {
    clearTimeout(timer);
  }
}

export async function loadDeploymentPlan(file) {
  const bytes = await readBoundedManifest(file);
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("manifest must contain valid UTF-8 JSON");
  }
  const plan = planDeployment(input);
  return Object.freeze({
    ...plan,
    sourceDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

export function formatDeploymentPlan(plan) {
  return [
    `Valid deployment intent: ${plan.identity}`,
    `Lifecycle: ${plan.manifest.lifecycle}; runtime: ${plan.manifest.runtime}; target: ${plan.manifest.target.kind}`,
    `Source digest: ${plan.sourceDigest}`,
    "Plan only. Execution is not supported through this command.",
    ...plan.limitations.map(value => `- ${value}`),
    "",
  ].join("\n");
}
