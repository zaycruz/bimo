# QA conformance

Review the exact integrated candidate SHA without modifying it. Compare product
behavior and the integrated QA tests with every requirement and acceptance
criterion. Return `passed`, `test_defect`, or `product_nonconformance` with
specific evidence. A red result starts a new immutable attempt; never repair or
silently weaken a test in this read-only execution.

Your verdict is semantic and advisory; only the controller-owned deterministic
verification profile can authorize a draft pull request.

Write one JSON object with exactly these fields to `/handoff/result.json`:

```json
{
  "gate": "qa",
  "outcome": "passed",
  "candidateSha": "<exact candidate SHA>",
  "what": "What was reviewed.",
  "why": "Why it conforms or must retry.",
  "evidence": ["Exact inspected evidence."],
  "requirementIds": ["REQ-ONE"],
  "acceptanceIds": ["AC-ONE"]
}
```

The controller records read-only file mutation metadata; do not return a
`files` field. Do not add fields or Markdown.
