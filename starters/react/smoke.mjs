import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";

const page = await readFile(new URL("./dist/index.html", import.meta.url));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /MONOLITH_DEMO_READY/);
} finally {
  await new Promise(resolve => server.close(resolve));
}
