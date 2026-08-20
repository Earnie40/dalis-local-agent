# Web Client

This document is a reference for the `apps/web` client.

## Current visible source

```text
apps/web/src/
├── AgentPanel.tsx
├── api.ts
├── App.tsx
├── main.tsx
└── styles.css
```

## Responsibilities

The web client should:
- submit tasks/chat requests
- display runtime state
- display approvals
- surface errors safely
- show results/evidence
- provide stop/cancel controls when supported

The browser should not:
- hold privileged credentials
- enforce server authorization
- directly access PostgreSQL
- directly execute agent tools
- contain private API keys

## API boundary

Use the existing `api.ts` abstraction when practical.

Keep server contracts typed and explicit.

## Generated output

`dist/` is generated build output.

Prefer modifying source under `src/` and rebuilding.
