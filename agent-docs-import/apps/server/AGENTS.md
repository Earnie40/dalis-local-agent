# Server Agent Instructions

These instructions apply to `apps/server/` and supplement the repository root `AGENTS.md`.

## Purpose

`apps/server` contains the backend runtime and API surface.

Before changing server behavior, inspect:
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/status.ts`
- `src/approvals.ts`
- relevant route handlers
- shared packages imported by the server
- environment/configuration code

Do not assume route behavior from filenames alone.

## Server change workflow

For backend work:

1. Identify the route, service, or shared module responsible.
2. Trace its imports and dependencies.
3. Determine whether behavior belongs in the route or a reusable service.
4. Make the smallest appropriate change.
5. Run targeted TypeScript/tests first.
6. Run broader server validation if practical.

## Route boundaries

Keep route handlers thin when practical.

Routes should generally:
- validate input
- resolve authentication/authorization context
- call the appropriate service/runtime
- translate results to HTTP responses
- preserve consistent error behavior

Avoid placing large amounts of core agent logic directly inside route files if an existing service/runtime abstraction exists.

## Approvals

If `src/approvals.ts` participates in approval or permission decisions:

- do not bypass it for convenience
- preserve fail-closed behavior
- keep approval state explicit
- do not auto-approve sensitive operations
- add tests when changing approval logic

## Status and health

Changes to health/status handling must accurately reflect dependency state.

Do not report a dependency as healthy when it has not been checked.

When practical distinguish:
- process alive
- database reachable
- model provider reachable
- tool/runtime ready
- degraded dependencies

## Environment configuration

Do not hard-code:
- ports
- model names
- API keys
- database URLs
- external service URLs

when the project already uses environment-based configuration.

Do not print secret values in logs.

## Database

When server code needs PostgreSQL:

1. discover the connection configuration
2. use the existing DB client/pool
3. preserve connection pooling
4. avoid opening a new connection per request unless architecture requires it
5. keep transactions explicit when consistency matters
6. do not mutate production data during tests

## Agent execution

Server routes that invoke agents must use the established runtime/tool/permission boundaries.

Do not give an LLM unrestricted shell, filesystem, database, or network access from a route handler.

## Validation

Prefer relevant commands from `apps/server/package.json`.

At minimum, when available:
- TypeScript check
- targeted tests
- server build
- startup smoke test

Never claim the server starts successfully unless it was actually started or validated by an equivalent automated check.
