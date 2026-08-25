#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid option: ${flag ?? ""}`);
    options[flag.slice(2)] = value;
  }
  const port = Number(options.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("--port is invalid");
  return { root: options.root ?? "/site", port };
}

function descendant(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function headers(contentType) {
  return {
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; connect-src 'none'; form-action 'none'; img-src 'self' data:; manifest-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; worker-src 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await realpath(options.root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) fail("static root must be a directory");

  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/healthz") {
        response.writeHead(200, headers("application/json; charset=utf-8"));
        response.end('{"status":"ok"}\n');
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { ...headers("text/plain; charset=utf-8"), allow: "GET, HEAD" });
        response.end("method not allowed\n");
        return;
      }
      const url = new URL(request.url, "http://localhost");
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400, headers("text/plain; charset=utf-8"));
        response.end("bad request\n");
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      if (relative.endsWith(".map")
          || relative.split("/").some(segment => segment === ".." || !segment || segment.startsWith("."))) {
        response.writeHead(404, headers("text/plain; charset=utf-8"));
        response.end("not found\n");
        return;
      }
      const candidate = path.join(root, ...relative.split("/"));
      let target = await realpath(candidate).catch(() => null);
      let stat = target ? await lstat(target).catch(() => null) : null;
      if (!target || !stat?.isFile() || !descendant(root, target)) {
        target = path.join(root, "index.html");
        target = await realpath(target).catch(() => null);
        stat = target ? await lstat(target).catch(() => null) : null;
      }
      if (!target || !stat?.isFile() || !descendant(root, target)) {
        response.writeHead(404, headers("text/plain; charset=utf-8"));
        response.end("not found\n");
        return;
      }
      response.writeHead(200, { ...headers(TYPES.get(path.extname(target)) ?? "application/octet-stream"), "content-length": stat.size });
      if (request.method === "HEAD") response.end();
      else createReadStream(target).pipe(response);
    } catch {
      response.writeHead(500, headers("text/plain; charset=utf-8"));
      response.end("internal error\n");
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;

  server.listen(options.port, "0.0.0.0", () => {
    process.stdout.write(`monolith-static listening on ${options.port}\n`);
  });
  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch(error => {
  process.stderr.write(`monolith-static: ${error.message}\n`);
  process.exitCode = 1;
});
