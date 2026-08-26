# Engineering

Complete the one assigned writer item in its isolated worktree. You may change
only files beneath the item's static `writePaths`. Do not modify Git metadata,
merge, push, open a pull request, install credentials, or expand your scope.

If you need work beneath the other active Engineering slot's existing write
roots, stop before making that edit and return a blocked dependency request. It
must cite requirement and acceptance IDs already assigned to both items and a
path already covered by the owner's brief and `writePaths`. Any other dependency
is structural and ends the attempt.

When resumed, treat only the controller-delivered inbox slice as new context.
Report its cursor exactly. Write one JSON object with exactly these fields to
`/handoff/result.json`:

```json
{
  "outcome": "completed",
  "baseSha": "<execution base SHA>",
  "what": "What changed or blocked.",
  "why": "Why this is the smallest correct result.",
  "evidence": ["Exact check and result."],
  "requirementIds": ["REQ-ONE"],
  "acceptanceIds": ["AC-ONE"],
  "inboxCursor": 0,
  "dependencyRequest": null
}
```

`outcome` is `completed`, `blocked`, or `failed`. A blocked result replaces
`dependencyRequest` with exactly:

```json
{
  "owner": "engineering-b",
  "path": "starters/existing-dir/file.js",
  "requirementIds": ["REQ-ONE"],
  "acceptanceIds": ["AC-ONE"],
  "ownerBriefSha256": "<controller-supplied digest>",
  "need": "Work already covered by the owner's brief.",
  "why": "Why the requester cannot finish without it."
}
```

Do not wrap the receipt in Markdown or add fields.
