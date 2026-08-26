import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("static server did not become ready");
}

test("static server serves the artifact with a non-networking browser policy", async t => {
  const site = await mkdtemp(path.join(os.tmpdir(), "bimo-site-"));
  t.after(() => rm(site, { recursive: true, force: true }));
  await writeFile(path.join(site, "index.html"), "BIMO_DEMO_READY\n");
  await writeFile(path.join(site, ".env"), "SECRET_SHOULD_NOT_BE_SERVED\n");
  await writeFile(path.join(site, "bundle.js.map"), "SOURCE_MAP_SHOULD_NOT_BE_SERVED\n");
  const port = await freePort();
  const child = spawn(process.execPath, [
    path.join(root, "src", "serve.mjs"),
    "--root", site,
    "--port", String(port),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));

  const response = await waitFor(`http://127.0.0.1:${port}/`);
  assert.equal(await response.text(), "BIMO_DEMO_READY\n");
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /worker-src 'none'/);

  for (const unsafePath of ["/.env", "/bundle.js.map"]) {
    const denied = await fetch(`http://127.0.0.1:${port}${unsafePath}`);
    assert.equal(denied.status, 404);
    assert.doesNotMatch(await denied.text(), /SECRET_SHOULD_NOT_BE_SERVED|SOURCE_MAP_SHOULD_NOT_BE_SERVED/);
  }
});
