#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CHAT_PATH = "/api/v1/chat/completions";
const HEALTH_PATH = "/healthz";
const OPENROUTER_ORIGIN = "https://openrouter.ai";
const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_COMPLETION_TOKENS = 8_192;
const DEFAULT_MAX_CREDENTIAL_BYTES = 4_096;
const DEFAULT_LIFETIME_SECONDS = 3_600;
const MAX_LIFETIME_SECONDS = 7_200;
const MAX_HEADER_BYTES = 16 * 1024;
const MODEL_ROUTING_FIELDS = [
  "fallbacks",
  "models",
  "plugins",
  "provider",
  "route",
];

class ClientRequestError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

class UpstreamResponseTooLargeError extends Error {}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function validateCredential(credential, maxBytes = DEFAULT_MAX_CREDENTIAL_BYTES) {
  if (
    typeof credential !== "string" ||
    credential.length === 0 ||
    Buffer.byteLength(credential) > maxBytes ||
    /[\u0000-\u0020\u007f]/u.test(credential)
  ) {
    throw new TypeError("invalid credential input");
  }
  return credential;
}

function validateModel(model) {
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > 256 ||
    !/^[A-Za-z0-9._~:/-]+$/u.test(model)
  ) {
    throw new TypeError("invalid model");
  }
  return model;
}

function validateUpstreamOrigin(upstreamOrigin) {
  const url = new URL(upstreamOrigin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("invalid upstream origin");
  }
  return url;
}

function applyCompletionTokenCap(payload, maxCompletionTokens) {
  const requestedCaps = [];
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ClientRequestError(400, "invalid_completion_token_limit");
    }
    requestedCaps.push(value);
  }
  delete payload.max_tokens;
  payload.max_completion_tokens = Math.min(
    maxCompletionTokens,
    ...requestedCaps,
  );
}

export async function readCredentialFromStream(
  input,
  maxBytes = DEFAULT_MAX_CREDENTIAL_BYTES,
) {
  requirePositiveInteger(maxBytes, "maxBytes");
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) {
      throw new Error("credential input too large");
    }
    chunks.push(bytes);
    const buffered = Buffer.concat(chunks);
    const newline = buffered.indexOf(0x0a);
    if (newline !== -1) {
      if (newline !== buffered.length - 1) {
        throw new TypeError("invalid credential input");
      }
      let line = buffered.subarray(0, newline);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      let decoded;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        throw new TypeError("invalid credential input");
      }
      return validateCredential(decoded, maxBytes);
    }
  }

  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new TypeError("invalid credential input");
  }

  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  if (raw.endsWith("\r")) raw = raw.slice(0, -1);
  return validateCredential(raw, maxBytes);
}

function targetPath(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return null;
  let url;
  try {
    url = new URL(rawUrl, "http://credential-proxy.invalid");
  } catch {
    return null;
  }
  if (
    url.origin !== "http://credential-proxy.invalid" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.pathname;
}

function sendJson(response, statusCode, payload, additionalHeaders = {}) {
  if (response.destroyed || response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type": "application/json; charset=utf-8",
    ...additionalHeaders,
  });
  response.end(body);
}

function sendError(response, statusCode, code, additionalHeaders) {
  sendJson(response, statusCode, { error: code }, additionalHeaders);
}

function rejectRequest(
  request,
  response,
  statusCode,
  code,
  additionalHeaders = {},
) {
  const mustClose = !request.complete;
  request.resume();
  if (mustClose) {
    response.shouldKeepAlive = false;
    response.once("finish", () => request.destroy());
  }
  sendError(response, statusCode, code, {
    ...additionalHeaders,
    ...(mustClose ? { connection: "close" } : {}),
  });
}

function hasValidOptionalPort(value) {
  if (value === undefined) return true;
  if (!/^[1-9]\d{0,4}$/u.test(value)) return false;
  return Number(value) <= 65_535;
}

function hasAllowedHostHeader(request, listenScope) {
  const value = request.headers.host;
  if (typeof value !== "string") return false;

  if (listenScope === "isolated-network") {
    const match = /^gateway(?::([^:]+))?$/u.exec(value);
    return match !== null && hasValidOptionalPort(match[1]);
  }

  const ipv4 = /^127\.0\.0\.1(?::([^:]+))?$/u.exec(value);
  if (ipv4 !== null) return hasValidOptionalPort(ipv4[1]);
  const ipv6 = /^\[::1\](?::([^:]+))?$/u.exec(value);
  return ipv6 !== null && hasValidOptionalPort(ipv6[1]);
}

function contentLength(request) {
  const value = request.headers["content-length"];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/u.test(value)) {
    throw new ClientRequestError(400, "invalid_content_length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ClientRequestError(400, "invalid_content_length");
  }
  return parsed;
}

function readRequestBody(request, maxBytes, timeoutMs) {
  const declaredBytes = contentLength(request);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw new ClientRequestError(413, "request_body_too_large");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let complete = false;

    const finish = (error, body) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      request.off("aborted", onAborted);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      if (error) reject(error);
      else resolve(body);
    };
    const onAborted = () =>
      finish(new ClientRequestError(400, "request_aborted"));
    const onData = (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        request.pause();
        finish(new ClientRequestError(413, "request_body_too_large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () =>
      finish(new ClientRequestError(400, "request_read_failed"));
    const timer = setTimeout(
      () => finish(new ClientRequestError(408, "request_timeout")),
      timeoutMs,
    );
    timer.unref?.();

    request.on("aborted", onAborted);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

function responseContentType(headers) {
  const value = headers["content-type"];
  const contentType = Array.isArray(value) ? value[0] : value;
  if (
    typeof contentType === "string" &&
    (/^application\/json(?:;|$)/iu.test(contentType) ||
      /^text\/event-stream(?:;|$)/iu.test(contentType))
  ) {
    return contentType;
  }
  return "application/octet-stream";
}

function responseHeaders(upstreamResponse) {
  const headers = {
    "cache-control": "no-store",
    "content-type": responseContentType(upstreamResponse.headers),
  };
  const retryAfter = upstreamResponse.headers["retry-after"];
  if (typeof retryAfter === "string" && /^\d{1,6}$/u.test(retryAfter)) {
    headers["retry-after"] = retryAfter;
  }
  return headers;
}

function isEventStream(upstreamResponse) {
  return /^text\/event-stream(?:;|$)/iu.test(
    responseContentType(upstreamResponse.headers),
  );
}

async function collectResponse(upstreamResponse, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of upstreamResponse) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new UpstreamResponseTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function waitForDrain(response) {
  if (response.destroyed) return;
  await new Promise((resolve) => {
    const finish = () => {
      response.off("close", finish);
      response.off("drain", finish);
      resolve();
    };
    response.once("close", finish);
    response.once("drain", finish);
  });
}

async function streamResponse(upstreamResponse, response, maxBytes) {
  let totalBytes = 0;
  for await (const chunk of upstreamResponse) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new UpstreamResponseTooLargeError();
    if (response.destroyed) return;
    if (!response.write(chunk)) await waitForDrain(response);
  }
  if (!response.destroyed) response.end();
}

async function forwardRequest({
  request,
  response,
  body,
  credential,
  upstream,
  maxResponseBytes,
  timeoutMs,
}) {
  const controller = new AbortController();
  let clientClosed = false;
  let timedOut = false;
  const onRequestAborted = () => {
    clientClosed = true;
    controller.abort();
  };
  const onResponseClose = () => {
    if (response.writableEnded) return;
    clientClosed = true;
    controller.abort();
  };
  request.once("aborted", onRequestAborted);
  response.once("close", onResponseClose);

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const transport = upstream.protocol === "https:" ? https : http;
  try {
    const upstreamResponse = await new Promise((resolve, reject) => {
      const upstreamRequest = transport.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          protocol: upstream.protocol,
          method: "POST",
          path: CHAT_PATH,
          signal: controller.signal,
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${credential}`,
            "content-length": body.length,
            "content-type": "application/json",
            "user-agent": "monolith-credential-proxy/1",
          },
        },
        resolve,
      );
      upstreamRequest.once("error", reject);
      upstreamRequest.end(body);
    });

    const statusCode =
      Number.isInteger(upstreamResponse.statusCode) &&
      upstreamResponse.statusCode >= 200 &&
      upstreamResponse.statusCode <= 599
        ? upstreamResponse.statusCode
        : 502;

    if (isEventStream(upstreamResponse)) {
      response.writeHead(statusCode, responseHeaders(upstreamResponse));
      await streamResponse(upstreamResponse, response, maxResponseBytes);
      return;
    }

    const responseBody = await collectResponse(upstreamResponse, maxResponseBytes);
    if (response.destroyed) return;
    response.writeHead(statusCode, {
      ...responseHeaders(upstreamResponse),
      "content-length": responseBody.length,
    });
    response.end(responseBody);
  } catch (error) {
    if (clientClosed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof UpstreamResponseTooLargeError) {
      sendError(response, 502, "upstream_response_too_large");
    } else if (timedOut) {
      sendError(response, 504, "upstream_timeout");
    } else {
      sendError(response, 502, "upstream_unavailable");
    }
  } finally {
    clearTimeout(timer);
    request.off("aborted", onRequestAborted);
    response.off("close", onResponseClose);
  }
}

export function createCredentialProxy({
  credential,
  model,
  upstreamOrigin = OPENROUTER_ORIGIN,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxRequests = DEFAULT_MAX_REQUESTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
  listenScope = "loopback",
} = {}) {
  const fixedCredential = validateCredential(credential);
  const fixedModel = validateModel(model);
  const upstream = validateUpstreamOrigin(upstreamOrigin);
  requirePositiveInteger(maxRequestBodyBytes, "maxRequestBodyBytes");
  requirePositiveInteger(maxResponseBytes, "maxResponseBytes");
  requirePositiveInteger(maxRequests, "maxRequests");
  requirePositiveInteger(timeoutMs, "timeoutMs");
  requirePositiveInteger(maxConcurrency, "maxConcurrency");
  requirePositiveInteger(maxCompletionTokens, "maxCompletionTokens");
  if (listenScope !== "loopback" && listenScope !== "isolated-network") {
    throw new TypeError("invalid listenScope");
  }

  let requestCount = 0;
  let activeRequests = 0;

  const server = http.createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    (request, response) => {
      void (async () => {
        if (!hasAllowedHostHeader(request, listenScope)) {
          rejectRequest(request, response, 400, "invalid_host");
          return;
        }
        const pathname = targetPath(request.url);
        if (pathname === HEALTH_PATH) {
          if (request.method !== "GET") {
            rejectRequest(request, response, 405, "method_not_allowed", {
              allow: "GET",
            });
            return;
          }
          if (
            request.headers["content-length"] !== undefined ||
            request.headers["transfer-encoding"] !== undefined
          ) {
            rejectRequest(request, response, 400, "request_body_not_allowed");
            return;
          }
          request.resume();
          sendJson(response, 200, { status: "ok" });
          return;
        }

        if (pathname !== CHAT_PATH) {
          rejectRequest(request, response, 404, "not_found");
          return;
        }
        if (request.method !== "POST") {
          rejectRequest(request, response, 405, "method_not_allowed", {
            allow: "POST",
          });
          return;
        }
        if (requestCount >= maxRequests) {
          rejectRequest(request, response, 429, "request_limit_reached");
          return;
        }
        requestCount += 1;
        if (activeRequests >= maxConcurrency) {
          rejectRequest(request, response, 429, "concurrency_limit_reached", {
            "retry-after": "1",
          });
          return;
        }

        activeRequests += 1;
        const deadline = Date.now() + timeoutMs;
        try {
          const contentType = request.headers["content-type"];
          if (
            typeof contentType !== "string" ||
            !/^application\/json(?:;|$)/iu.test(contentType)
          ) {
            throw new ClientRequestError(415, "unsupported_media_type");
          }

          const requestBody = await readRequestBody(
            request,
            maxRequestBodyBytes,
            timeoutMs,
          );
          let payload;
          try {
            payload = JSON.parse(requestBody.toString("utf8"));
          } catch {
            throw new ClientRequestError(400, "invalid_json");
          }
          if (
            payload === null ||
            Array.isArray(payload) ||
            typeof payload !== "object"
          ) {
            throw new ClientRequestError(400, "invalid_request_body");
          }
          if (payload.model !== fixedModel) {
            throw new ClientRequestError(403, "model_not_allowed");
          }
          if (
            MODEL_ROUTING_FIELDS.some((field) =>
              Object.hasOwn(payload, field),
            )
          ) {
            throw new ClientRequestError(403, "model_routing_not_allowed");
          }
          applyCompletionTokenCap(payload, maxCompletionTokens);

          const serializedBody = Buffer.from(JSON.stringify(payload));
          if (serializedBody.length > maxRequestBodyBytes) {
            throw new ClientRequestError(413, "request_body_too_large");
          }
          const remainingMs = Math.max(1, deadline - Date.now());
          await forwardRequest({
            request,
            response,
            body: serializedBody,
            credential: fixedCredential,
            upstream,
            maxResponseBytes,
            timeoutMs: remainingMs,
          });
        } catch (error) {
          if (error instanceof ClientRequestError) {
            rejectRequest(
              request,
              response,
              error.statusCode,
              error.code,
            );
          } else {
            rejectRequest(request, response, 500, "proxy_error");
          }
        } finally {
          activeRequests -= 1;
        }
      })();
    },
  );

  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.requestTimeout = timeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = maxRequests + 1;
  server.maxConnections = maxConcurrency + 4;
  server.on("checkContinue", (request, response) => {
    rejectRequest(request, response, 417, "expectation_failed");
  });
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  return server;
}

function parsePort(value) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TypeError("invalid port");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("invalid port");
  }
  return port;
}

function parsePositiveIntegerOption(value, name) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TypeError(`invalid ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`invalid ${name}`);
  }
  return parsed;
}

function parseListenScope(value) {
  if (value === undefined) return "loopback";
  if (value !== "isolated-network") {
    throw new TypeError("invalid listen scope");
  }
  return value;
}

function parseLifetimeSeconds(value) {
  const seconds = parsePositiveIntegerOption(value, "lifetime seconds");
  if (seconds > MAX_LIFETIME_SECONDS) {
    throw new TypeError("invalid lifetime seconds");
  }
  return seconds;
}

function forceClose(server) {
  if (server === null) return;
  if (server.listening) server.close();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
}

async function main() {
  const { values } = parseArgs({
    options: {
      "lifetime-seconds": { type: "string" },
      "listen-scope": { type: "string" },
      "max-body-bytes": { type: "string" },
      "max-requests": { type: "string" },
      model: { type: "string" },
      port: { type: "string" },
      "timeout-seconds": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (process.env.CREDENTIAL_PROXY_HOST !== undefined) {
    throw new TypeError("host environment override is not allowed");
  }
  const port = parsePort(
    values.port ?? process.env.CREDENTIAL_PROXY_PORT ?? "8787",
  );
  const listenScope = parseListenScope(values["listen-scope"]);
  const host = listenScope === "isolated-network" ? "0.0.0.0" : "127.0.0.1";
  const lifetimeSeconds = parseLifetimeSeconds(
    values["lifetime-seconds"] ?? String(DEFAULT_LIFETIME_SECONDS),
  );
  const maxRequestBodyBytes = parsePositiveIntegerOption(
    values["max-body-bytes"] ?? String(DEFAULT_MAX_REQUEST_BODY_BYTES),
    "max body bytes",
  );
  const maxRequests = parsePositiveIntegerOption(
    values["max-requests"] ?? String(DEFAULT_MAX_REQUESTS),
    "max requests",
  );
  const timeoutSeconds = parsePositiveIntegerOption(
    values["timeout-seconds"] ?? String(DEFAULT_TIMEOUT_MS / 1_000),
    "timeout seconds",
  );
  const timeoutMs = timeoutSeconds * 1_000;
  requirePositiveInteger(timeoutMs, "timeoutMs");
  const model = validateModel(values.model ?? process.env.OPENROUTER_MODEL);
  let server = null;
  const lifetimeTimer = setTimeout(() => {
    forceClose(server);
    process.exit(0);
  }, lifetimeSeconds * 1_000);

  try {
    const credential = await readCredentialFromStream(process.stdin);
    server = createCredentialProxy({
      credential,
      model,
      maxRequestBodyBytes,
      maxRequests,
      timeoutMs,
      listenScope,
    });

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
      server.listen(port, host);
    });
  } catch (error) {
    clearTimeout(lifetimeTimer);
    forceClose(server);
    throw error;
  }

  const shutdown = () => {
    clearTimeout(lifetimeTimer);
    forceClose(server);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("error", () => {
    clearTimeout(lifetimeTimer);
    process.stderr.write("credential proxy server error\n");
    process.exitCode = 1;
    forceClose(server);
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
const invokedFromMonolith = process.argv[1]
  ? path.basename(process.argv[1]) === "monolith"
  : false;
if (invokedPath === import.meta.url || invokedFromMonolith) {
  main().catch(() => {
    process.stderr.write("credential proxy failed to start\n");
    process.exitCode = 1;
  });
}
