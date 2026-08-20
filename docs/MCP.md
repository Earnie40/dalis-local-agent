# MCP — Hybrid Supervisor Mode

DacaiLocalAgent exposes its local workers to an MCP client so a supervising
session (Claude Code) can delegate token-heavy work to models running on this
machine, and spend its own tokens only on evaluating the result.

```
you → Claude Code (Anthropic model, lead architect)
        │  MCP over stdio
        ▼
      dacai-local-agent-mcp   (thin bridge, no engine of its own)
        │  loopback HTTP
        ▼
      DacaiLocalAgent server  (task queue · permissions · audit · telemetry)
        │
        ▼
      local Ollama worker → filesystem / git / tests
        │
        ▼
      structured findings + evidence → back to Claude Code
```

These are **external local agents exposed through MCP that operationally serve
as delegated workers**. They are not native Claude subagents.

## Why a thin bridge

The stdio process handles MCP protocol only and forwards every call to the
running server. The delegation engine, database pool, concurrency caps,
permission engine, audit trail, and telemetry therefore exist exactly once — so
a task started by Claude Code is visible and cancellable in the web UI, and
`MAX_LOCAL_WORKERS` is enforced globally rather than per-process.

If the server is not running, the tools return a clear error rather than
silently falling back to some second half-implementation.

## Setup

1. Start DacaiLocalAgent (leave it running):

   ```powershell
   pnpm dev
   ```

2. Build the bridge once:

   ```powershell
   pnpm --filter @dacai-local-agent/mcp build
   ```

3. Register a workspace for the repository you want delegated work on — via
   Agent mode in the web UI, or:

   ```powershell
   curl -X POST http://127.0.0.1:3001/api/workspaces -H "Content-Type: application/json" `
     -d '{"displayName":"my-project","rootPath":"C:/path/to/project","write":false,"shell":true}'
   ```

4. Register the MCP server with Claude Code:

   ```powershell
   claude mcp add dacai-local-agent -- node C:/Users/Kyleh/DacaiLocalAgent/packages/mcp/dist/bin.js
   ```

   Set `DACAI_API_URL` if the server is not on `http://127.0.0.1:3001`.

## Tools

| Tool | Role | Access |
| --- | --- | --- |
| `local_agent.explore_repo` | repo-explorer | read-only |
| `local_agent.debug_task` | debugger | read-only |
| `local_agent.code_task` | coder | needs workspace write |
| `local_agent.review_task` | reviewer | read-only |
| `local_agent.test_task` | test-engineer | needs workspace shell |
| `local_agent.get_task` | — | poll a running task |
| `local_agent.cancel_task` | — | stop a running task |

Delegation tools take `objective` and `workspace` (a registered root path or
id), plus an optional `maxTurns`. They wait up to `DACAI_MCP_WAIT_MS`
(default 4 minutes) and otherwise return a task id to poll — long work survives
a dropped connection because the task lives in Postgres, not in the request.

Results are deliberately concise: worker, cost, evidence, then findings. The
point of delegating is to spend few supervisor tokens.

```
task: task_ninbbkmf
status: completed
worker: repo-explorer · qwen3:8b (local)
cost: 5 turns · 3 tool calls · 4469 in / 228 out tokens · $0 (local inference)
trace: tr_4cirps3o

--- findings ---
…
```

## What the workers can and cannot do

- Everything runs through the same permission engine as the UI. Paths are
  contained to the registered workspace; child processes get a minimal
  environment with no credentials.
- **Delegated tasks have no approval gate.** Nobody is watching a background
  task, so high-impact operations (destructive, network, credential-touching)
  fail closed rather than waiting for a click that will never come. Interactive
  Agent mode in the web UI asks; delegation refuses.
- A read-only role stays read-only even in a workspace that grants write.
- Inspection roles must actually inspect: a role with an evidence requirement
  cannot answer until it has successfully read a file or run a command. Without
  this, a worker will answer a question from a filename and prior knowledge.

## Cost and telemetry

Every delegated run writes a `usage_events` row stamped `source='mcp'`,
`usage_class='LOCAL_OLLAMA'`, and the worker role, so local work is
distinguishable from supervisor activity and provably free:

```sql
SELECT usage_class, source, worker_role, sum(input_tokens), sum(output_tokens)
  FROM usage_events GROUP BY 1,2,3;
```
