import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createCredentialProxy,
  readCredentialFromStream,
} from "../src/credential-proxy.mjs";

const MODEL = "anthropic/claude-sonnet-5";
const SECRET = "sk-or-v1-test-only-secret";
const CHAT_PATH = "/api/v1/chat/completions";
const bimoScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "bimo",
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outbound = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
          status: response.statusCode,
        });
      });
    });
    outbound.once("error", reject);
    outbound.end(body);
  });
}

async function connectSocket(port) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function chatBody(overrides = {}) {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  });
}

async function startProxy(t, upstream, overrides = {}) {
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const proxy = createCredentialProxy({
    credential: SECRET,
    model: MODEL,
    upstreamOrigin: upstreamUrl,
    timeoutMs: 1_000,
    ...overrides,
  });
  const proxyUrl = await listen(proxy);
  t.after(() => close(proxy));
  return proxyUrl;
}

test("reads one bounded credential from stdin-compatible input", async () => {
  assert.equal(
    await readCredentialFromStream(Readable.from([`${SECRET}\n`])),
    SECRET,
  );
  await assert.rejects(
    readCredentialFromStream(Readable.from([`${SECRET}\nsecond-line\n`])),
    /invalid credential input/,
  );
  await assert.rejects(
    readCredentialFromStream(Readable.from(["\n"])),
    /invalid credential input/,
  );
  await assert.rejects(
    readCredentialFromStream(Readable.from(["x".repeat(4_097)]), 4_096),
    /credential input too large/,
  );
});

test("starts after the credential line without waiting for stdin to close", async () => {
  const input = new PassThrough();
  const credential = readCredentialFromStream(input);
  input.write(`${SECRET}\n`);
  assert.equal(await credential, SECRET);
  input.destroy();
});

test("CLI reads the credential from stdin and emits no secret-bearing output", async (t) => {
  const portReservation = http.createServer();
  const reservationUrl = await listen(portReservation);
  const port = new URL(reservationUrl).port;
  await close(portReservation);

  const child = spawn(
    process.execPath,
    [
      bimoScript,
      "proxy",
      "--port",
      port,
      "--model",
      MODEL,
      "--max-requests",
      "100",
      "--max-concurrency",
      "3",
      "--max-body-bytes",
      "2097152",
      "--timeout-seconds",
      "300",
      "--lifetime-seconds",
      "10",
    ],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${SECRET}\n`);

  let health;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      health = await fetch(`http://127.0.0.1:${port}/healthz`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert(health, "proxy did not become healthy");
  assert.equal(health.status, 200);
  await health.body.cancel();

  const exited = new Promise((resolve) => {
    child.once("exit", (...result) => resolve(result));
  });
  child.kill("SIGTERM");
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("CLI refuses an unauthenticated non-loopback listener", async () => {
  for (const configuration of [
    {
      args: ["--host", "0.0.0.0"],
      env: {},
    },
    {
      args: ["--listen-scope", "public"],
      env: {},
    },
    {
      args: [],
      env: { CREDENTIAL_PROXY_HOST: "0.0.0.0" },
    },
  ]) {
    const child = spawn(
      process.execPath,
      [
        bimoScript,
        "proxy",
        ...configuration.args,
        "--model",
        MODEL,
      ],
      { env: configuration.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.end(`${SECRET}\n`);

    const [exitCode, signal] = await new Promise((resolve) => {
      child.once("exit", (...result) => resolve(result));
    });
    const stderrText = Buffer.concat(stderr).toString("utf8");
    assert.equal(exitCode, 1);
    assert.equal(signal, null);
    assert.equal(Buffer.concat(stdout).toString("utf8"), "");
    assert.equal(stderrText, "credential proxy failed to start\n");
    assert.doesNotMatch(stderrText, /sk-or/);
  }
});

test("CLI isolated-network mode accepts only the gateway Host", async (t) => {
  const portReservation = http.createServer();
  const reservationUrl = await listen(portReservation);
  const port = new URL(reservationUrl).port;
  await close(portReservation);

  const child = spawn(
    process.execPath,
    [
      bimoScript,
      "proxy",
      "--listen-scope",
      "isolated-network",
      "--port",
      port,
      "--model",
      MODEL,
      "--lifetime-seconds",
      "10",
    ],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${SECRET}\n`);

  let health;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      health = await request(`http://127.0.0.1:${port}/healthz`, {
        headers: { host: `gateway:${port}` },
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert(health, "isolated proxy did not become healthy");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "ok" });

  const rejected = await request(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: `127.0.0.1:${port}` },
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(JSON.parse(rejected.body), { error: "invalid_host" });

  const exited = new Promise((resolve) => {
    child.once("exit", (...result) => resolve(result));
  });
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("CLI lifetime closes active and idle connections before exiting", async (t) => {
  const portReservation = http.createServer();
  const reservationUrl = await listen(portReservation);
  const port = new URL(reservationUrl).port;
  await close(portReservation);

  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [
      bimoScript,
      "proxy",
      "--port",
      port,
      "--model",
      MODEL,
      "--lifetime-seconds",
      "2",
    ],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve) => {
    child.once("exit", (...result) => resolve(result));
  });
  child.stdin.write(`${SECRET}\n`);

  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      health = await request(`http://127.0.0.1:${port}/healthz`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert(health, "proxy did not become healthy before its lifetime elapsed");
  assert.equal(health.status, 200);

  const idle = await connectSocket(Number(port));
  const active = await connectSocket(Number(port));
  t.after(() => {
    idle.destroy();
    active.destroy();
  });
  idle.on("error", () => {});
  active.on("error", () => {});
  const idleClosed = new Promise((resolve) => idle.once("close", resolve));
  const activeClosed = new Promise((resolve) => active.once("close", resolve));
  active.write(
    `POST ${CHAT_PATH} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 1024\r\n\r\n" +
      '{"model":"incomplete',
  );

  let deadline;
  const timedOut = new Promise((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error("proxy exceeded its configured lifetime")),
      3_500,
    );
  });
  const [exitResult] = await Promise.race([
    Promise.all([exited, idleClosed, activeClosed]),
    timedOut,
  ]);
  clearTimeout(deadline);

  assert.deepEqual(exitResult, [0, null]);
  assert(Date.now() - startedAt < 3_500);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.equal(Buffer.concat(stderr).toString("utf8"), "");
});

test("health is safe and every unapproved method or route is rejected", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(500).end();
  });
  const proxyUrl = await startProxy(t, upstream);

  const health = await fetch(`${proxyUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const wrongMethod = await fetch(`${proxyUrl}${CHAT_PATH}`);
  assert.equal(wrongMethod.status, 405);

  const healthPost = await fetch(`${proxyUrl}/healthz`, { method: "POST" });
  assert.equal(healthPost.status, 405);

  const models = await fetch(`${proxyUrl}/api/v1/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(models.status, 404);
});

test("isolated-network host policy covers health and chat routes", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const proxyUrl = await startProxy(t, upstream, {
    listenScope: "isolated-network",
  });
  const port = new URL(proxyUrl).port;

  const health = await request(`${proxyUrl}/healthz`, {
    headers: { host: "gateway" },
  });
  assert.equal(health.status, 200);

  const completion = await request(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: `gateway:${port}`,
    },
    body: chatBody(),
  });
  assert.equal(completion.status, 200);
  assert.equal(upstreamRequests, 1);

  for (const host of [
    `127.0.0.1:${port}`,
    "Gateway",
    "gateway:0",
    "gateway:080",
    "gateway:65536",
    "gateway.example",
  ]) {
    const rejected = await request(`${proxyUrl}/healthz`, {
      headers: { host },
    });
    assert.equal(rejected.status, 400, host);
  }
});

test("forwards only the fixed model and replaces client credentials", async (t) => {
  const received = deferred();
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.resolve({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "completion-1", choices: [] }));
    });
  });
  const proxyUrl = await startProxy(t, upstream);

  const response = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: {
      authorization: "Bearer attacker-controlled",
      cookie: "session=do-not-forward",
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: chatBody(),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "completion-1", choices: [] });

  const forwarded = await received.promise;
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.url, CHAT_PATH);
  assert.equal(forwarded.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers["x-forwarded-for"], undefined);
  assert.equal(forwarded.body.model, MODEL);
  assert.equal(forwarded.body.max_completion_tokens, 8_192);
  assert.equal(forwarded.body.max_tokens, undefined);
});

test("normalizes and caps completion-token limits", async (t) => {
  const forwardedBodies = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      forwardedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const proxyUrl = await startProxy(t, upstream);

  for (const limits of [
    { max_tokens: 20_000 },
    { max_completion_tokens: 16_000 },
    { max_tokens: 1_000, max_completion_tokens: 2_000 },
  ]) {
    const response = await fetch(`${proxyUrl}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody(limits),
    });
    assert.equal(response.status, 200);
  }

  assert.deepEqual(
    forwardedBodies.map((body) => body.max_completion_tokens),
    [8_192, 8_192, 1_000],
  );
  assert(forwardedBodies.every((body) => body.max_tokens === undefined));

  const invalid = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody({ max_completion_tokens: "unbounded" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(forwardedBodies.length, 3);
});

test("rejects a model mismatch without contacting upstream", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200).end();
  });
  const proxyUrl = await startProxy(t, upstream);

  const response = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody({ model: "openai/gpt-5.3-codex" }),
  });
  assert.equal(response.status, 403);
  assert.equal(upstreamRequests, 0);
  assert.doesNotMatch(await response.text(), /gpt-5\.3|claude-sonnet|sk-or/);
});

test("rejects alternate OpenRouter model-routing fields", async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200).end();
  });
  const proxyUrl = await startProxy(t, upstream);

  for (const override of [
    { models: [MODEL, "openai/gpt-5.3-codex"] },
    { route: "fallback" },
    { plugins: [{ id: "auto-router", enabled: true }] },
    { fallbacks: [{ model: "openai/gpt-5.3-codex" }] },
    { provider: { sort: { partition: "none" } } },
  ]) {
    const response = await fetch(`${proxyUrl}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody(override),
    });
    assert.equal(response.status, 403);
    assert.doesNotMatch(await response.text(), /gpt-5\.3|claude-sonnet|sk-or/);
  }

  assert.equal(upstreamRequests, 0);
});

test("closes an oversized unfinished chunked request", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(500).end();
  });
  const proxyUrl = await startProxy(t, upstream, {
    maxRequestBodyBytes: 16,
  });
  const { hostname, port } = new URL(proxyUrl);
  const socket = net.connect(Number(port), hostname);
  t.after(() => socket.destroy());
  socket.setEncoding("utf8");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk;
  });

  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("proxy retained an unfinished request")),
      1_000,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  socket.write(
    `POST ${CHAT_PATH} HTTP/1.1\r\n` +
      `Host: ${hostname}:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n" +
      "20\r\n" +
      "x".repeat(32) +
      "\r\n",
  );

  await closed;
  assert.match(received, /^HTTP\/1\.1 413 /u);
  assert.match(received, /Connection: close/iu);
});

test("bounds request bytes and lifetime request count", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const proxyUrl = await startProxy(t, upstream, {
    maxRequestBodyBytes: 160,
    maxRequests: 1,
  });

  const tooLarge = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody({ messages: [{ role: "user", content: "x".repeat(256) }] }),
  });
  assert.equal(tooLarge.status, 413);

  const exhausted = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody(),
  });
  assert.equal(exhausted.status, 429);
});

test("bounds concurrency and times out a stalled upstream", async (t) => {
  const arrived = deferred();
  const release = deferred();
  const upstream = http.createServer(async (_request, response) => {
    arrived.resolve();
    await release.promise;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const proxyUrl = await startProxy(t, upstream, {
    maxConcurrency: 1,
    timeoutMs: 1_000,
  });

  const first = fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody(),
  });
  await arrived.promise;

  const second = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody(),
  });
  assert.equal(second.status, 429);

  release.resolve();
  assert.equal((await first).status, 200);

  const stalledUpstream = http.createServer(() => {});
  const stalledProxyUrl = await startProxy(t, stalledUpstream, { timeoutMs: 50 });
  const timedOut = await fetch(`${stalledProxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody(),
  });
  assert.equal(timedOut.status, 504);
  assert.doesNotMatch(await timedOut.text(), /sk-or/);
});

test("streams bounded event-stream responses", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  const proxyUrl = await startProxy(t, upstream, { maxResponseBytes: 256 });

  const response = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody({ stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(
    await response.text(),
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
  );
});

test("bounds non-streaming upstream responses", async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: "x".repeat(512) }));
  });
  const proxyUrl = await startProxy(t, upstream, { maxResponseBytes: 128 });

  const response = await fetch(`${proxyUrl}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: chatBody(),
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /sk-or|x{32}/);
});
