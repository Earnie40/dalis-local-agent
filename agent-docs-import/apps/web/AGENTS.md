# Web Application Agent Instructions

These instructions apply to `apps/web/` and supplement the root `AGENTS.md`.

## Purpose

`apps/web` contains the browser client.

Current visible structure includes:
- `src/`
- `public/`
- built output under `dist/`
- `index.html`

Do not edit generated `dist/` assets as the primary implementation unless the repository explicitly requires checked-in build output.

Prefer source changes under `src/`.

## Frontend workflow

Before changing UI behavior:

1. inspect `src/App.tsx`
2. inspect `src/AgentPanel.tsx`
3. inspect `src/api.ts`
4. inspect `src/main.tsx`
5. inspect `src/styles.css`
6. trace the relevant server endpoint

Keep frontend behavior consistent with the backend API.

## API usage

Do not duplicate backend business logic in the browser.

`src/api.ts` or the existing API abstraction should own request details when practical.

Do not embed:
- API keys
- database credentials
- model provider secrets
- privileged service tokens

in browser code.

## Agent UI

The UI should communicate agent state truthfully.

Distinguish when supported:
- idle
- planning
- running
- waiting for approval
- blocked
- failed
- completed

Do not show "completed" before server/runtime verification indicates completion.

## Security

Never trust browser state for authorization.

Client-side checks may improve UX but must not replace server-side enforcement.

Avoid exposing sensitive error details to users.

## Generated output

Do not edit files inside `dist/` unless the task explicitly concerns generated artifacts.

After source changes, rebuild instead.

## Validation

Use the package's existing scripts when available.

Prefer:
- TypeScript check
- frontend build
- targeted tests
- browser/runtime smoke test where practical
