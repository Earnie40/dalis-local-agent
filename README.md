# DacaiLocalAgent

Tomahawk1 production-style security tests use the fail-closed
[`LIVE_VALIDATION` control plane](docs/LIVE_VALIDATION.md). Unit and CI mocks
remain isolated under the explicit `SIMULATION` mode.

A local-first AI agent platform scaffold built for reusable multi-project use.

## Overview

This repository is intentionally designed as a foundation for a future local-first agent platform that can operate across arbitrary software projects, repositories, files, websites, APIs, databases, cloud systems, and task types.

It is not a project-specific application, and it avoids coupling to any single codebase.

## Local setup (Windows PowerShell)

1. Install Node.js 22+, pnpm, PostgreSQL 16, and Ollama.
2. Open PowerShell in the repository root.
3. Install dependencies and create your env file:

```powershell
pnpm install
Copy-Item .env.example .env
```

4. Provision the dedicated least-privileged database role. The superuser
   password is used for this one invocation only and is never stored:

```powershell
$env:PGSUPERPASSWORD="<superuser password>"
node scripts/provision-db.mjs
Remove-Item Env:PGSUPERPASSWORD
```

   Paste the printed `DATABASE_URL` into `.env` (which is gitignored).

5. Run it:

```powershell
pnpm dev
```

6. Open the web app at http://localhost:5173 and the API at http://localhost:3001/health.
   `GET /api/providers` reports which inference instances are configured.

Image/video generation uses a server-managed Runpod connection in development
and authenticated HTTPS in production. See
[Image and video generation deployment](docs/MEDIA_GENERATION_DEPLOYMENT.md).

### Default low-refusal Qwen model

Install the community `huihui_ai/qwen3-abliterated:8b` checkpoint with:

```powershell
pnpm model:install:qwen-uncensored
```

The `chat` and `coder` aliases use this checkpoint by default. The explicit
`qwen_uncensored` alias remains available in the model picker as well. The
checkpoint does not bypass DACAIS tool permissions, workspace containment,
approvals, or audit logging. Tool-loop use is admitted only after the existing
runtime capability probe verifies the model's tool-call behavior.

PostgreSQL is required — the server fails fast with a clear configuration error
rather than falling back to a second persistence layer.

## Workspace scripts

```powershell
pnpm install
pnpm dev
pnpm build
pnpm typecheck
pnpm test
```

## Architecture goals

- **Local-first inference** via Ollama; the platform is fully functional with zero paid API keys
- **Hybrid Supervisor Mode** — a Claude Code session delegates bounded, token-heavy work
  through MCP to local Ollama workers, which return structured findings and evidence
- **Pluggable inference endpoints** — providers are named instances (`local_ollama`,
  `remote_gpu_ollama`, `huggingface`, `anthropic`), so inference can move to a GPU VM
  while every tool, secret, and database stays on this machine
- Multi-workspace support with enforced path containment
- Agent roles from configuration
- Tool registry, layered permissions, and audit trails
- Training-trace capture for future local-model fine-tuning
- Swiss-style defaults for safety and usage control

## Status

See [docs/STATUS.md](docs/STATUS.md) for what is LIVE VERIFIED, tested, or still a stub.
Phase 1 (foundations, persistence, provider instances, security, trace schema) is complete;
real inference calls land in Phase 2.
