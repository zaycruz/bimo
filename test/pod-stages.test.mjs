import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { POD_STAGES } from "../src/pod-stages.mjs";

const EXPECTED = Object.freeze([
  "planner",
  "engineering-a",
  "engineering-b",
  "qa-tests",
  "checker-engineering-a",
  "checker-engineering-b",
  "checker-qa-tests",
  "integration",
  "qa",
  "testing",
  "trusted-verification",
  "pre-publication-scan",
  "draft-pr-publication",
]);

test("POD_STAGES contains all 13 stages in the exact prescribed order", () => {
  assert.equal(POD_STAGES.length, 13);
  assert.deepEqual([...POD_STAGES], EXPECTED);
});

test("POD_STAGES is frozen", () => {
  assert.equal(Object.isFrozen(POD_STAGES), true);
});

test("starter source contains every required stage label", () => {
  const starterPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "starters",
    "react",
    "src",
    "main.jsx",
  );
  const source = readFileSync(starterPath, "utf8");
  for (const label of EXPECTED) {
    assert.ok(source.includes(label), `starter source must contain "${label}"`);
  }
});
