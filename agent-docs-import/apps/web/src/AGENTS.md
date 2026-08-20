# Web Source Agent Instructions

These instructions apply to `apps/web/src/`.

Current source files visible in this area include:
- `AgentPanel.tsx`
- `api.ts`
- `App.tsx`
- `main.tsx`
- `styles.css`

## `AgentPanel.tsx`

Keep agent interaction state explicit.

When displaying tool or task activity:
- show real runtime state
- do not fabricate progress
- show approval requirements clearly
- expose errors in useful but non-sensitive language
- preserve cancellation/stop controls if supported

## `api.ts`

Keep HTTP details centralized here when consistent with existing architecture.

Handle:
- base URL/configuration
- request serialization
- response parsing
- typed API results
- error normalization

Do not hard-code production hosts if environment configuration exists.

Do not place secret credentials in frontend requests.

## `App.tsx`

Keep application-level orchestration here when appropriate, but avoid turning it into a large monolithic component.

Reuse existing components and state patterns.

## `main.tsx`

Treat this as application bootstrap.

Avoid placing feature logic here.

## `styles.css`

Prefer consistent reusable classes over one-off duplication.

Do not make unrelated global style changes for a local component task.

## Validation

After frontend source changes:
- run TypeScript checks when available
- run the web build
- inspect browser/runtime behavior for interactive changes when practical
