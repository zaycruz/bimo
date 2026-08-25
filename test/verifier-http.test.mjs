import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { verifyArtifactHttp, verifyWorkspace } from "../src/verify.mjs";

const serveScript = path.resolve(import.meta.dirname, "../src/serve.mjs");
const verifyScript = path.resolve(import.meta.dirname, "../src/verify.mjs");
const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "monolith-verifier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\"",
      smoke: "node -e \"process.exit(0)\"",
    },
  })}\n`);
  return root;
}

function options(overrides = {}) {
  return {
    output: "dist",
    maxFiles: 10,
    maxBytes: 1024 * 1024,
    path: "/",
    status: 200,
    contains: "artifact-is-live",
    timeoutMs: 10_000,
    ...overrides,
  };
}

async function processIsGone(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test("passing npm smoke cannot bypass the verifier-owned artifact HTTP check", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "dist", "index.html"), "<h1>wrong page</h1>\n");
  await writeFile(path.join(root, "dist", "build-proof.txt"), "artifact-is-live\n");

  await assert.rejects(
    verifyWorkspace(options(), { workspaceRoot: root, serveScript }),
    /response does not contain required marker/,
  );
});

test("successful verification returns a strict structured artifact receipt", async t => {
  const root = await fixture(t);
  const app = "console.log('artifact-is-live');\n";
  const index = "<h1>artifact-is-live</h1>\n";
  await mkdir(path.join(root, "dist", "assets"));
  await writeFile(path.join(root, "dist", "assets", "app.js"), app);
  await writeFile(path.join(root, "dist", "index.html"), index);

  const receipt = await verifyWorkspace(options(), { workspaceRoot: root, serveScript });
  const sha256 = createHash("sha256")
    .update(`assets/app.js\0${Buffer.byteLength(app)}\0`)
    .update(app)
    .update(`index.html\0${Buffer.byteLength(index)}\0`)
    .update(index)
    .digest("hex");

  assert.deepEqual(Object.keys(receipt).sort(), ["artifact", "evidence", "status"]);
  assert.deepEqual(Object.keys(receipt.artifact), ["files", "bytes", "sha256"]);
  assert.deepEqual(receipt.artifact, {
    files: 2,
    bytes: Buffer.byteLength(app) + Buffer.byteLength(index),
    sha256,
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.evidence.length, 5);
  assert.match(receipt.evidence.at(-1), /artifact HTTP GET \/ returned 200/);
});

test("the verifier refuses to use the static server health endpoint as artifact proof", async () => {
  await assert.rejects(
    execute(process.execPath, [
      verifyScript,
      "--output", "dist",
      "--max-files", "10",
      "--max-bytes", "1048576",
      "--path", "/healthz",
      "--status", "200",
      "--contains", "ok",
      "--timeout-seconds", "10",
    ]),
    error => error.code === 1 && error.stderr.includes("must probe the artifact"),
  );
});

test("HTTP verification timeout kills the trusted server process", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "dist", "index.html"), "artifact-is-live\n");
  const hangingServer = path.join(root, "hanging-server.mjs");
  await writeFile(hangingServer, `
    import { writeFileSync } from "node:fs";
    import http from "node:http";
    import path from "node:path";
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (index % 2 === 0) pairs.push([value, all[index + 1]]);
      return pairs;
    }, []));
    const server = http.createServer(() => {});
    server.listen(Number(args["--port"]), "127.0.0.1", () => {
      writeFileSync(path.join(args["--root"], "server.pid"), String(process.pid));
      process.stdout.write("monolith-static listening on " + args["--port"] + "\\n");
    });
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `);

  await assert.rejects(
    verifyArtifactHttp(options({ root: path.join(root, "dist"), timeoutMs: 1_000 }), {
      serveScript: hangingServer,
      workspaceRoot: root,
    }),
    /timed out/,
  );

  const pid = Number(await readFile(path.join(root, "dist", "server.pid"), "utf8"));
  assert.equal(await processIsGone(pid), true, `server process ${pid} survived verifier timeout`);
});
