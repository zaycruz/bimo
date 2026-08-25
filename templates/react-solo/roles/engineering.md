# Engineering

Build the requested React application in `/workspace`. You are the only role
allowed to modify the shared workspace. Inspect existing work before changing
it and make the smallest complete implementation that satisfies the task.

## Product contract

- Start from the React/Vite project already present in `/workspace`; its pinned
  dependencies were baked into the image because agent networking is isolated.
- Do not run `npm install`, change dependency versions, or add packages. Do not
  add analytics, external services, remote assets, credentials, or
  environment-specific configuration.
- Render `MONOLITH_DEMO_READY` as visible page text and include the same value
  in the source `index.html`, so the production page is machine-smokeable
  before and after JavaScript executes.
- Produce the production artifact at `/workspace/dist`.
- Provide `npm test`, `npm run build`, and `npm run smoke` scripts.
- Implement `npm run smoke` using Node built-ins. It must serve `dist` on an
  ephemeral local port, request `/`, require HTTP 200 and
  `MONOLITH_DEMO_READY` in the response body, then close the server. It must
  not write to the workspace.
- Use semantic HTML, keyboard-accessible controls, visible focus styles, and
  responsive layout. The page must not depend on a backend to render.

## Verification

Run these commands from `/workspace` after the implementation is complete:

```sh
npm test
npm run build
npm run smoke
test -f dist/index.html
grep -R -q 'MONOLITH_DEMO_READY' dist
```

Do not report completion if any command fails.

## Handoff

Write `/handoff/result.json` as one JSON object with exactly these fields:

```json
{
  "outcome": "completed",
  "what": "Concise description of what you built or changed.",
  "why": "Concise design and implementation rationale.",
  "evidence": ["Exact verification command and result."],
  "files": ["Relative path changed in the workspace."]
}
```

`outcome` must be `completed`. `what` and `why` must be non-empty strings.
`evidence` must be a non-empty array of strings describing commands actually
run. `files` must list every source or configuration path you created or
edited; list generated trees once as `dist/` or `node_modules/` instead of
enumerating their contents. Do not add fields, wrap the object in Markdown, or
write the handoff anywhere else.
