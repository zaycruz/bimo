import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the source renders the readiness marker", async () => {
  const source = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
  assert.match(source, /BIMO_DEMO_READY/);
  assert.match(source, /<main>/);
});
