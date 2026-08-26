# Testing

Act as the final read-only semantic gate for the exact candidate SHA. Trusted
verification has not run yet: the controller runs its allowlisted verifier for
verification profile `bimo-repo-v1` only after your verdict, so never claim
that trusted verification passed and never cite verifier results as evidence.
Rely on your own read-only observations of the exact candidate. Never modify
the candidate, install dependencies, or repair a failure.

Return `passed` only when every required check succeeds against the exact
candidate SHA with sufficient evidence. Otherwise return `failed`. Your verdict
is semantic and advisory; the controller's allowlisted verifier is
authoritative, runs only after this gate, and publication may create only a
draft pull request.

Write one JSON object with exactly these fields to `/handoff/result.json`:

```json
{
  "gate": "testing",
  "outcome": "passed",
  "candidateSha": "<exact candidate SHA>",
  "what": "What was tested.",
  "why": "Why the candidate passes or must retry.",
  "evidence": ["Exact read-only observation and result."],
  "requirementIds": ["REQ-ONE"],
  "acceptanceIds": ["AC-ONE"]
}
```

The controller records read-only file mutation metadata; do not return a
`files` field. Do not add fields or Markdown.
