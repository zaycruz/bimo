#!/usr/bin/env node

import process from "node:process";

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
  const status = Number(options.status);
  const url = new URL(options.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "gateway"].includes(url.hostname)) fail("probe URL must use container-local HTTP");
  if (!Number.isInteger(status) || status < 100 || status > 599) fail("--status is invalid");
  if (typeof options.contains !== "string" || !options.contains || options.contains.length > 256) fail("--contains is invalid");
  return { url, status, contains: options.contains };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const response = await fetch(options.url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  if (Buffer.byteLength(body) > 5 * 1024 * 1024) fail("smoke response exceeds 5 MiB");
  if (response.status !== options.status) fail(`expected HTTP ${options.status}, received ${response.status}`);
  if (!body.includes(options.contains)) fail(`response does not contain required marker: ${options.contains}`);
  process.stdout.write(`${JSON.stringify({ status: response.status, contains: options.contains })}\n`);
}

main().catch(error => {
  process.stderr.write(`monolith-probe: ${error.message}\n`);
  process.exitCode = 1;
});
