# DacaiLocalAgent Architecture

## 1. Control plane

The control plane consists of the server process, workspace registry, task router, approval gate, and telemetry tracker. It coordinates requests, route policies, and high-level orchestration decisions.

## 2. Model providers

Provider abstraction separates the local-first inference layer from optional remote ones. It is built around provider **instances**, not provider names: `local_ollama` and `remote_gpu_ollama` are two instances of the same wire protocol, and an optional GPU VM or Hugging Face endpoint is just another instance.

Each instance declares a usage class (`LOCAL_OLLAMA`, `REMOTE_GPU_OLLAMA`, `HUGGING_FACE_REMOTE`, `FUTURE_PAID_PROVIDER`), a transport, and the *name* of the env var holding its credential — never the credential itself. Model aliases select an instance as well as a model, so a role can move from local CPU inference to a GPU VM without any agent configuration changing.

Three rules are enforced by config validation rather than convention: a non-loopback host may not declare `loopback` transport; a fallback may only ever resolve to a local instance; and a local request is never silently promoted to a remote or cost-incurring provider.

Remote inference is inference only. PostgreSQL, the filesystem, git, the browser, credentials, tool execution, and workspace permissions stay on this machine — local tools gather minimal context, the remote endpoint returns a response or tool request, and tools execute locally.

## 3. Local agent worker pool

The platform is designed around a worker pool and separate agent roles. Each worker can execute a task in a local runtime context while preserving a specific agent persona, tool access, and permission set.

## 4. Tool registry

The tool registry provides a generic mechanism for filesystem access, shell execution, git operations, testing, workspace navigation, and browser automation. Every tool declares a permission level and timeout.

## 5. MCP

The MCP architecture is split between client and server capabilities. The client can call external MCP servers; the server exposes `local_agent.*` task tools for external clients.

The server is the mechanism for **Hybrid Supervisor Mode**: a Claude Code session stays the lead architect and delegates bounded, token-heavy work — repository exploration, first-pass debugging, log analysis, test execution, review, bounded edits — to local Ollama workers, receiving concise structured findings and evidence rather than raw transcripts.

It ships as a thin stdio bridge that forwards to the running server over loopback HTTP, so the delegation engine, database pool, concurrency limits, and telemetry exist exactly once and delegated tasks remain visible and cancellable from the web UI.

These workers are external local agents exposed through MCP that operationally serve as delegated workers. They are not native Claude subagents.

## 6. Workspace isolation

Workspaces are independent of the repository root and are registered dynamically. Permissions and allowed directories are scoped per workspace so each task can only operate inside configured boundaries.

## 7. Memory

Persistent memory is separated into session memory, workspace memory, agent memory, and retrieval memory. This enables selective recall without bloating every prompt with the full transcript.

## 8. Claude escalation

Escalation remains explicit, measurable, and policy-driven. The default mode is ask, which allows the user to decide whether a local task should escalate to Anthropic.

## 9. Security boundaries

Destructive shell commands and high-impact infrastructure operations require approval. The permission engine is intentionally conservative and is designed to block dangerous operations by default.

## 10. Future distributed workers

The initial design keeps execution local and single-process. It is shaped so additional local or remote worker nodes can be introduced later without rewriting the core system.
