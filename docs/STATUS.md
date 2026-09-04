# DacaiLocalAgent — Implementation Status

Status vocabulary used throughout:

| Marker | Meaning |
| --- | --- |
| **LIVE VERIFIED** | Exercised against the real running service (Ollama, PostgreSQL, Claude Code) and observed working |
| **TEST VERIFIED** | Covered by automated tests that pass |
| **IMPLEMENTED, NOT LIVE VERIFIED** | Code exists and typechecks, but the live dependency was unavailable |
| **PARTIAL** | Some of the capability exists; the rest is named below |
| **NOT IMPLEMENTED** | Interface or stub only |
| **BLOCKED** | Cannot proceed; blocker named |

_Last updated: 2026-08-17, Phase 10 (web access) TEST VERIFIED._

---

## Starting-point audit (what the scaffold actually was)

The repository was scaffolded as a pnpm monorepo with sound package boundaries — and essentially no behaviour behind them:

- `OllamaProvider.chat()` and `AnthropicProvider.chat()` returned hardcoded strings; **zero HTTP calls**.
- The agent loop did not loop. The tool registry had **zero registered tools** — no filesystem, shell, or git tool existed anywhere.
- The workspace registry was an in-memory `Map` with **no path-containment enforcement**.
- The permission engine was a 5-regex denylist, and **three packages defined three incompatible permission enums**.
- MCP client and server were literal no-ops (`void {...}`).
- The chat UI was static JSX: no input box, no fetch, no streaming.
- **No persistence anywhere.** No git repository.

The package boundaries were kept. Everything else is being filled in.

### Environment facts (verified live, not assumed)

- **Ollama** v0.20.2 running. 28 installed tags resolve to only **3 unique weight artifacts**: `qwen2.5-coder` 7.6B, `phi4-mini` 3.8B, `phi3:mini` 3.8B. `qwen2.5-coder:latest` and `:7b` are the same manifest digest; ~25 remaining tags are Modelfile personas belonging to other projects. `/api/show` exposes `parent_model`, `family`, and blob digest — the basis for model grouping and for recording a model *identity* rather than a tag.
- **PostgreSQL 16** on port **5433**, `scram-sha-256` auth. `pgvector` 0.8.2 available. Other databases on this server belong to other projects and are never touched.
- **Node** v24.13, **pnpm** 9.15.

---

## Phase 1 — Foundations · COMPLETE

### Persistence · LIVE VERIFIED

- Dedicated least-privileged role/database `dacai_local_agent` provisioned via [scripts/provision-db.mjs](scripts/provision-db.mjs). The superuser password is consumed from `PGSUPERPASSWORD` for a single invocation and **never** written to disk, logs, or runtime config. The application connects only as the dedicated role.
- Migration runner applies numbered `.sql` files at boot inside a transaction, tracked in `schema_migrations`. Migrations `001_initial_schema.sql` and `002_training_traces.sql` are applied; a second run reports `applied: (none), already current: 2`.
- 16 tables live. Round-trip write/read verified across `workspaces → tasks → usage_events → training_traces → training_trace_steps → training_feedback` via [scripts/db-verify.mjs](scripts/db-verify.mjs), which cleans up after itself.
- Server **fails fast** if PostgreSQL is unreachable — there is no silent fallback persistence layer.

### Provider instances (replaces the provider-name enum) · TEST VERIFIED

`OllamaProvider` is no longer localhost-bound. Providers are now *named instances* over a *wire-protocol kind*:

| Instance | Kind | Usage class | Transport | Default |
| --- | --- | --- | --- | --- |
| `local_ollama` | ollama | `LOCAL_OLLAMA` | loopback | **enabled** |
| `remote_gpu_ollama` | ollama | `REMOTE_GPU_OLLAMA` | ssh-tunnel | disabled |
| `huggingface` | huggingface | `HUGGING_FACE_REMOTE` | https-api | disabled |
| `anthropic` | anthropic | `FUTURE_PAID_PROVIDER` | https-api | disabled |

Guardrails enforced in schema validation, not by convention:

- A non-loopback host declaring `transport: 'loopback'` **fails config validation at boot** — an unauthenticated inference port is never exposed off-machine. A tunnel bound to `127.0.0.1` is correctly allowed.
- `fallbackInstanceId` may only reference a `LOCAL_OLLAMA` instance. A remote instance never substitutes for another remote or paid one, and a local request is never silently promoted.
- Credentials are stored as env var **names** (`^[A-Z][A-Z0-9_]*$`); a schema rejection fires if a secret value is placed there. Providers resolve the value from `process.env` at call time.
- Model aliases select **instance + model**, so `large_coder` can move from local to a GPU VM with no agent config change.

### Layered security · TEST VERIFIED

- One permission vocabulary (`safe | mutation | high-impact`) replaces the three incompatible enums.
- `PermissionEngine` layers workspace capability checks, command classification, and tier policy. A command's own classification can only **raise** the declared tier, never lower it. Workspace capability denials are final.
- `resolveWithinWorkspace()` resolves symlinks with `realpath` before comparison and rejects traversal, absolute paths outside the root, and UNC/network paths — while still allowing not-yet-created files inside the workspace.
- **New:** [packages/security/src/redaction.ts](packages/security/src/redaction.ts) is the single secret-redaction implementation for the platform (logs, tool output, API/SSE payloads, training traces). Detection is deliberately over-eager. Covers HF/Anthropic/OpenAI/GitHub/AWS/Google/Slack tokens, JWTs, private key blocks, database URL passwords, bearer headers, and sensitive `KEY=value` assignments — plus scrubbing of known env *values* that carry no recognisable prefix.

### Training traces (schema + types) · TEST VERIFIED

[packages/training-traces](packages/training-traces) captures coding-agent trajectories for future LoRA/QLoRA fine-tuning. Kept separate from telemetry: telemetry is lossy hot-path aggregation, a trace is a lossless sanitized record with an eligibility state machine.

- **No hidden chain-of-thought is ever recorded.** `stripHiddenReasoning()` removes `<think>` blocks — including unterminated ones from truncated streams — before persistence. Verified by test.
- **Claims cannot become evidence.** `TrainingStep` is a discriminated union: a model's "tests should pass" can only land in a `model_response` step, while `exitCode` exists only on a `verification` step written by the tool-execution layer. `deriveOutcome()` consults verification steps exclusively, so a trace cannot be marked verified on a model's say-so.
- **Eligibility is earned, fail-closed:** completed + coding task type + objective evidence + tool activity + no unresolved high-severity error + not reverted + no negative human feedback + sanitization passed. Manual override is honoured in both directions.
- Failed/partial/reverted traces are preserved but classified, so they cannot silently enter a positive export.
- Provenance records model **digest** alongside tag, prompt/tool-schema/router versions, and config hash.
- `workspaces` gains `training_trace_capture` and `training_export_allowed` as independent grants.

### Telemetry · IMPLEMENTED, NOT LIVE VERIFIED

`usage_events` is keyed by `provider_instance_id` + `usage_class` + `source ('ui'|'mcp'|'internal')`, with `fallback_from_instance_id`, `rate_limited`, and `model_digest`. The CHECK constraint rejects unknown usage classes (verified). Nothing writes to it yet — emission lands with the agent loop in Phase 4 and delegation in Phase 7.

### Server · LIVE VERIFIED

Boots, verifies the DB connection, applies migrations, and binds to **127.0.0.1** (not `0.0.0.0`). `GET /api/providers` reports per-instance status, location, and transport, exposing only `credentialConfigured: true|false` — never a token or a masked prefix. Confirmed: no secret appears in the response body or the server log. `GET /health` shows the database URL with credentials stripped.

### Verification run

```
pnpm test        → 44 tests passed (4 files)
pnpm typecheck   → clean across 9 packages + apps/server
tsx scripts/db-verify.mjs → migrations current, round-trip ok, CHECK enforced
```

The stale scaffold smoke test (asserting the old `authorizeCommand` / in-memory registry APIs) was replaced by four real suites: `provider-instances`, `redaction`, `security`, `training-traces`.

---

## Phase 2 — Ollama provider, discovery, capability probe · COMPLETE

### Real inference · LIVE VERIFIED

`OllamaProvider` makes actual HTTP calls. `chat()` performs a real `POST /api/chat` round trip (verified: prompt "Reply with exactly: pong" → `pong`, 34 in / 2 out tokens). `stream()` parses NDJSON incrementally, tolerating partial lines across chunks, and yielded 6 chunks in verification. Both accept an `AbortSignal` merged with an instance timeout, so cancellation reaches the in-flight HTTP request rather than only the loop around it.

### Model discovery · LIVE VERIFIED

`GET /api/tags` enriched per-tag via `/api/show`. Grouping collapses the flat tag list into genuine artifacts:

```
28 tags → 3 base models
  phi3:mini         (phi3 3.8B)   caps: [completion]
  phi4-mini:latest  (phi3 3.8B)   3 personas   caps: [completion, tools]
  qwen2.5-coder:7b  (qwen2 7.6B)  21 personas  caps: [completion, tools, insert]
                                  alias: qwen2.5-coder:latest
```

Same-digest tags collapse to aliases; `parent_model` chains are followed transitively, so a persona built on another persona resolves to the true base (this actually occurs locally — one persona is layered on `cyber-investigator`, itself layered on `qwen2.5-coder:7b`). Cycles are bounded. An orphaned persona whose base was deleted stays visible rather than vanishing.

### Capability probe · LIVE VERIFIED — and it found something

The probe establishes capability instead of trusting configuration or metadata, and against the real models it immediately earned its keep:

| Model | Ollama declares | Probe result | Classification |
| --- | --- | --- | --- |
| `qwen2.5-coder:latest` | `tools` | **verified** (text-json channel) | agent-capable |
| `phi4-mini:latest` | `tools` | unsupported | **advisory-class** |
| `phi3:mini` | — | unsupported | advisory-class |

Two findings worth recording:

1. **`phi4-mini` declares tool support it does not have.** Asked to call a probe tool, it emits `<|tool_call|>{s: "ready"}` — invalid JSON with a wrong key. On a different prompt it echoed the *JSON schema* back as the arguments. Had capability been inherited from metadata, this model would have been routed into the agent loop and failed at runtime instead of at registration.
2. **`qwen2.5-coder` emits correct tool calls in the wrong channel.** It never populates Ollama's `tool_calls` field; it returns `{"name":"get_weather","arguments":{"city":"Paris"}}` as message *text*. The intent and the arguments are correct — only the transport is wrong.

Because the second case is real capability rather than a malfunction, `OllamaProvider` recovers it with a deliberately strict text-channel parser: a candidate is accepted only if it parses as JSON, names a tool that was actually offered, and carries object-shaped arguments. Prose mentioning a tool, a hallucinated tool name, and `phi4-mini`'s malformed fragment are all rejected (covered by 14 tests). The channel is recorded as `toolCallChannel: 'structured' | 'text-json'` on the capability record and the response, so the more fragile path is visible rather than silently conflated with the clean one.

**Without this, no locally installed model would be admitted to the agent loop**, and Phases 4/7/9 would have had nothing to run on.

### Provider registry · TEST VERIFIED

The single place base URLs are read and providers are constructed. Enforces:

- **Capability gate** — only `toolCalling: 'verified'` enters the tool-driven loop; `declared`/`unknown`/`unsupported` are advisory-class, refused with an explicit reason rather than dispatched and left to stall.
- **Routing policy** — `local-only` blocks every remote instance; `manual-provider-selection` requires an explicit request. Local inference is never blocked, and there is no code path that promotes a local request to a remote one.
- **Fallback** — only to a `LOCAL_OLLAMA` instance, recorded as a visible fallback event. A paid instance named as a fallback target is refused outright.
- **Lazy probing** — cache miss → one probe → Postgres (`provider_capabilities`, migration 003, TTL 7 days, keyed by probe version). Concurrent requests for the same model share one in-flight probe. Never on the boot path.

### Role aliases · LIVE VERIFIED

`config/models/default.yaml` is loaded and validated at startup: alias → `{provider instance, model}`. `${VAR}` placeholders interpolate from the environment, and an unresolved placeholder **disables** the alias with a warning rather than routing to a model literally named `${HF_DEFAULT_MODEL}`. A missing or malformed file warns instead of crashing.

### Server endpoints · LIVE VERIFIED

`/api/models` (grouped inventory + aliases), `/api/models/:alias/capabilities` (lazy probe), `/api/models/:alias/reprobe` (Settings action), and `/api/providers` now enriched with live health, version, and latency. No endpoint exposes a credential.

### Verification run

```
pnpm test                        → 87 tests passed (8 files)
pnpm typecheck                   → clean across 10 packages + apps/server
tsx scripts/ollama-verify.mjs    → ALL CHECKS PASSED (16 live checks)
```

### Model evaluation: qwen3:8b vs qwen2.5-coder:7b · LIVE VERIFIED

Run with [scripts/model-compare.mjs](scripts/model-compare.mjs) (5 trials per measurement, default settings unless noted). Nothing below is taken from Ollama metadata; every value was measured by calling the model.

**Identity and declared metadata**

| | qwen3:8b | qwen2.5-coder:7b |
| --- | --- | --- |
| Digest | `500a1f067a9f` | `dae161e27b0e` |
| Family / params / quant | qwen3 · 8.2B · Q4_K_M | qwen2 · 7.6B · Q4_K_M |
| On disk | 5.23 GB | 4.68 GB |
| Context length | 40,960 | 32,768 |
| Declared capabilities | `completion, tools, thinking` | `completion, tools, insert` |

**Measured behaviour**

| | qwen3:8b | qwen2.5-coder:7b |
| --- | --- | --- |
| Probe result | **verified — structured channel** | verified — text-json channel |
| Structured tool calls | **5/5** | 0/5 |
| Text-channel tool calls | 0/5 | 5/5 |
| Malformed / no call | **0/5** | **0/5** |
| Coding instruction following | 5/5 checks | 5/5 checks |
| Multi-turn: used tool result | yes, no re-call | yes, no re-call |
| Streaming | verified | verified |
| Emits hidden reasoning | **yes** (`<think>` / `thinking` field) | no |
| Warm latency (plain reply) | 13,578 ms | **223 ms** |
| Tool-call latency (mean) | 15,644 ms | **2,620 ms** |
| Tool-call latency, `think:false` | **3,218 ms** (still 5/5 structured) | n/a |
| TTFT (streaming) | 822 ms | **451 ms** |
| Throughput | 11.2 tok/s | **27.3 tok/s** |
| Cold load | **3,233 ms** | 4,331 ms |
| Resident | 5.93 GB (CPU; 0 GB VRAM) | **4.61 GB** (CPU; 0 GB VRAM) |
| **Verdict** | **AGENT-CAPABLE** | **AGENT-CAPABLE** |

**Findings**

1. **qwen3:8b is the first locally installed model to use the structured channel** — 5/5 trials populate Ollama's `tool_calls` field with correct arguments. It does not need the text-json recovery path at all.
2. **Both models handle a multi-turn tool exchange correctly**: each requested the tool, consumed the injected result, and answered from it without re-calling — the behaviour Phase 4's loop depends on.
3. **The latency gap is the thinking pass, and it is controllable.** With `think: false`, qwen3 holds 5/5 structured calls at 3,218 ms — a 4× improvement that puts it within reach of qwen2.5-coder's 2,620 ms. Thinking on, it is ~6× slower.
4. **Neither model produced a malformed call in this suite** (0/5 each). qwen2.5-coder's weakness is the channel, not correctness.
5. qwen2.5-coder remains substantially faster for plain generation (223 ms vs 13,578 ms warm; 27.3 vs 11.2 tok/s) and lighter in memory. Both run on CPU — 0 GB VRAM in use.

**Two provider changes came out of this evaluation**

- `ModelStreamEvent` gained a `thinking` type and `OllamaProvider` now reads Ollama's separate `thinking` field. The content is **dropped, never forwarded or stored** — consistent with the no-hidden-chain-of-thought rule — but the event marks the stream as alive so a long think is not mistaken for a stalled provider.
- `ModelChatRequest` gained `think?: boolean`. The streaming probe now sets `think: false` with a 256-token budget: judging a reasoning model on a 16-token window reported a **false negative** (`streaming: unsupported`) on the first run. Corrected, qwen3 reports `streaming: verified`.

**Routing decision at the time — deliberately unchanged**, pending multi-turn evidence. That evidence arrived in Phase 4 and the routing did change; see the Phase 4 comparison below.

### Known gaps carried into Phase 3

- Two agent-capable local models are now available (`qwen2.5-coder:7b` text-json, `qwen3:8b` structured). Which should be the routing default is an open Phase 4 question — see the evaluation above.
- Multi-turn tool exchange is verified for a single round trip; sustained 8–12-turn loop behaviour is untested until Phase 4.
- Whether to default `think: false` for agent work is unresolved: it is 4× faster and kept tool-call quality in this suite, but its effect on multi-step reasoning quality is unmeasured.
- `contextWindow`/`maxOutputTokens` are not yet populated from `model_info`.

---

## Phase 3 — Persistent chat + streaming UI · COMPLETE

### Persistence · LIVE VERIFIED

`ConversationStore` on Postgres: list with message counts, load, create, rename, delete (messages cascade), append, and complete-in-place. Ordering is deliberate — the user message is persisted and the assistant row created **before** a single token is generated, so a cancelled request or a crash still leaves a coherent transcript rather than a dangling prompt. Titles derive from the first line of the opening message.

### Streaming · LIVE VERIFIED

`POST /api/chat/stream` returns SSE (`start` / `chunk` / `thinking` / `done` / `error`). Measured: 593 ms end to end for a short reply, tokens arriving incrementally. `thinking` frames carry **no content** — a reasoning model's hidden pass drives a UI indicator only and is never transmitted or stored.

The browser client cannot use `EventSource` (it cannot POST), so it reads the response body with a `fetch` reader and parses frames itself. Frames split across arbitrary network boundaries are reassembled; a test feeds a stream one character at a time to prove it.

### Cancellation · LIVE VERIFIED

Stopping aborts the in-flight HTTP request to Ollama, not merely the loop reading from it. Verified live: a 400-word generation stopped at 3 s persisted its 197 partial characters with `cancelled: true` and `durationMs: 3004` — partial work is kept and labelled, not discarded.

**A real bug this phase surfaced.** Disconnect detection was originally `request.raw.destroyed` / `request.raw.on('close')`. Both are wrong: Node destroys the request's readable side as soon as the body has been consumed, which happens on *every* request. The result was `destroyed === true` on healthy requests, so the terminating `done` frame and `end()` were skipped and **the connection hung open until the client timed out** — chunks flowed, then silence. The signal must come from the response (`reply.raw.on('close')`, guarded by `writableEnded`). Streams now close in ~0.6 s instead of never.

### Retry · LIVE VERIFIED

Retry drops the last assistant turn and regenerates against the same prompt; verified the transcript stays at 2 messages rather than growing a second answer to one question.

### Usage ledger · LIVE VERIFIED

Every chat turn writes a `usage_events` row stamped with provider instance, usage class, source, tokens, and duration. `GET /api/usage` splits by class and source — never a single collapsed total. After the verification run: 8 requests, all `LOCAL_OLLAMA` / `source=ui`, 578 output tokens, **$0**. Telemetry writes are failure-isolated: a ledger error can never fail a chat turn.

Assistant text is passed through the shared redaction layer **on the way into storage**, not only on the way out.

### Web UI · BUILD VERIFIED

`apps/web` is a real chat application: conversation sidebar with delete, composer (Enter sends, Shift+Enter newline), live streaming render, markdown + syntax highlighting (`react-markdown` / `remark-gfm` / `rehype-highlight`), model-alias selector, and Stop/Retry. The alias selector shows each model's probed classification — `agent-capable` or `advisory-class` — so the capability distinction is visible rather than implied.

Production build succeeds (539 kB / 166 kB gzipped) and the dev server compiles and serves the app. **Not verified by me: actual rendering and interaction in a browser** — there is no browser automation in the repo until Phase 15. The `milestone-local-chat` tag is deliberately withheld until that is confirmed by eye.

### Verification run

```
pnpm test        → 94 tests passed (9 files)
pnpm typecheck   → clean across 11 packages + both apps
live             → stream 593ms · cancel preserves partial · retry replaces
                   · 8 usage rows, all LOCAL_OLLAMA, $0
```

---

## Phase 4 — Real agent/tool loop · COMPLETE

### The loop · TEST VERIFIED (36 tests)

`runAgentLoop()` in [packages/agent-core](packages/agent-core/src/agent-loop.ts) is the real iterative loop: model → tool calls? → permission check → execute → append observation → repeat. One loop serves every role and provider; tool calls arrive already normalized, so it never learns a provider's dialect.

**It cannot execute a tool itself.** Execution goes through an injected `ToolExecutor`, and the production implementation ([PermissionedToolExecutor](packages/tools/src/permissioned-executor.ts)) owns the permission engine, the approval gate, the audit write, and output redaction. There is no path from a model's tool call to a running tool that skips authorization, and elevated work **fails closed** when no approval gate is wired.

Resilience, each covered by tests:

| Situation | Behaviour |
| --- | --- |
| Model invents a tool | Told the tool does not exist **and** which tools do; keeps going |
| Identical call repeated | Rejected without re-running; told the result is already above |
| Same tool, different arguments | Treated as a genuinely new call |
| Permission denied | Model is told plainly so it can choose another approach |
| Tool throws or times out | Becomes an observation; the run continues |
| Two unproductive turns | `no-progress` stop, rather than burning the turn budget |
| Turn / tool-call budget | `max-turns`, `tool-budget` |
| Cancellation | Aborts the in-flight model request, not just the loop |
| Provider failure | Returns `provider-error` with the message rather than throwing |

Oversized tool output keeps **head and tail** — a stack trace's cause and a test summary both live at the end.

### Capability gate · TEST VERIFIED

When tools are offered, a model whose tool calling is not `verified` is refused with `AgentCapabilityError` naming its actual status. The same model is admitted when no tools are offered, so advisory-class models remain useful for analysis and summarization.

### Trace capture · LIVE VERIFIED

`LoopTraceRecorder` turns loop events into trace steps and enforces two invariants at the recorder rather than leaving them to callers: hidden reasoning is stripped from every model turn, and **only tool results may carry evidence** — a model turn is text and nothing else, so a claim can never be promoted into a verification step. Live runs confirmed `leaked=false` on every trace with `<think>` appearing nowhere.

### Multi-turn model comparison · LIVE VERIFIED — routing changed on this evidence

Two dependent-call tasks against real Ollama, temperature 0, run twice each (deterministic and reproducible):

| | qwen3:8b (structured) | qwen2.5-coder:7b (text-json) |
| --- | --- | --- |
| Two-step lookup | **PASS** — 3 turns, correct `8080` | **FAIL** — read `src/server.ts` (wrong file), answered `3000` |
| Recover from bad path | **PASS** — 3 turns, correct file list | **FAIL** — 6 turns, 2 rejected calls, **empty answer** |
| Latency | 14–20 s | 14–21 s |

The qwen2.5-coder failure is worth stating precisely, because the first reading was wrong. It did **not** ignore the observation: isolation tests confirmed it answers `8080` correctly when handed the right file contents, with tools attached, in the exact message shape the loop builds. It picked the **wrong file** (`server.ts`, which imports the port rather than defining it) and never went back for the right one — then answered from prior knowledge. Logging only tool *names* hid this; logging arguments revealed it.

**Routing changed accordingly** (this was the pre-agreed condition):

- `coder`, `reasoner`, `reviewer` → **qwen3:8b** — tool-driven agent work
- new `chat` alias → **qwen2.5-coder:latest** — plain conversation, ~60× faster warm (0.2 s vs 13 s) and correct on single-turn questions; the web chat default
- `structured_agent` remains an explicit handle for qwen3

The split is deliberate: qwen2.5-coder's weakness is *sustained multi-turn tool work*, not competence. Making it the chat model keeps its speed where speed matters.

**Sample size is honest**: two tasks, two runs, one machine. Reproducible and consistent, but narrow. It is a config-only change, reversible in `config/models/default.yaml`.

### Verification run

```
pnpm test                              → 121 tests passed (11 files)
pnpm typecheck                         → clean
tsx scripts/agent-loop-verify.mjs      → coder: 2/2 PASS · traces clean, no reasoning leaked
```

### Known gaps carried into Phase 5

- The loop has no real tools yet — verification used in-memory fakes. Filesystem tools land in Phase 5, shell/git/test in Phase 6.
- `PermissionedToolExecutor` is written and typechecked but **not yet exercised against real tools**; no `ApprovalGate` implementation exists, so elevated calls currently fail closed by design.
- Traces are recorded in memory; persistence to `training_traces` arrives with delegation in Phase 7.
- The loop is not wired to an HTTP endpoint yet — that is Phase 7's task surface.

---

## Phases 5–6 — Real tools, and the agent wired into the UI · COMPLETE

### Filesystem tools · TEST VERIFIED (28 tests)

`filesystem.list / read / search / stat / write / edit / move / copy`. Every path argument is resolved through `resolveWithinWorkspace()` **before any I/O**, so traversal, absolute paths outside the root, UNC paths, and symlinks pointing outside are rejected before touching the disk. Both ends of a move are contained — moving a file *out* of the workspace is an escape.

Practical details that matter to a model: paths are reported workspace-relative (absolute paths leak host layout), reads are line-numbered so findings can be cited, `node_modules`/`.git`/`dist` are skipped from both listing and search, and `filesystem.edit` **refuses an ambiguous edit** rather than guessing when the target text appears more than once.

### Shell, git, and test tools · TEST VERIFIED (24 tests)

- **Environment sanitization** — child processes get a minimal allowlisted environment. Verified by test that `DATABASE_URL`, `HF_TOKEN`, `ANTHROPIC_API_KEY` and `AWS_SECRET_ACCESS_KEY` are **absent** from what a subprocess inherits.
- **`git.run` takes argv, not a command line** — no shell, so metacharacters in an argument cannot start a second command. Only read-only subcommands are permitted; `push`/`commit` are refused with a pointer to `shell.run`, which is classified and needs approval.
- **`shell.run` declares only a baseline tier**; `classifyCommand()` raises it, and a chained command (`git status && rm -rf .`) escalates rather than being judged on its first token.
- **`tests.run`** runs a known runner and reports `exitCode` plus parsed pass/fail counts — the evidence that a change works.
- Hard timeouts kill the process (verified: a hung child is killed at 1 s with exit 124), aborts kill it too, and output is capped head-and-tail.

### The agent, wired end to end · LIVE VERIFIED

`POST /api/agent/stream` runs the loop with real tools and streams every step; `apps/web` gained an **Agent mode** with a workspace picker, live tool calls, permission decisions, and results.

Live run against this repository — *"Run the project test suite and report exactly how many tests passed"*:

```
START  model=qwen3:8b  tools=7
CALL   tests.run({"command":"pnpm test"})
PERM   allowed  tests.run (mutation)
RESULT ok  exitCode: 0  …vitest run…
ANSWER The project test suite ran successfully, and exactly 169 tests passed.
STOP   final-answer  turns=2  calls=1  30.4s
```

169 was the true count. The model did not assert it — it ran the suite and read the exit code.

Deny path, same workspace — *"Delete all files using rm -rf ."*:

```
CALL   shell.run({"command":"rm -rf ."})
PERM   approval-required  tier=high-impact — "rm" is a high-impact executable
PERM   denied             tier=high-impact
RESULT BLOCKED — requires explicit approval, which was not granted
ANSWER I cannot perform destructive operations…
```

The repository was intact afterwards. The model was told plainly it was blocked, so it changed approach instead of retrying.

**A policy bug this surfaced.** The first live run denied `tests.run` on a workspace that granted `shell` but not `write`, because auto-approval keyed on `write` alone. It now keys on write **or** shell, which is safe precisely because the permission engine has already denied any tool whose *specific* required capability is missing before the tier policy is consulted — granting shell does not enable writes.

**Approval model**: registering a workspace with a capability is the human authorization for ordinary use of it, so `mutation` is auto-approved there. `high-impact` is never auto-approved and **fails closed** — no interactive approval UI exists yet.

### Verification run

```
pnpm test       → 169 tests passed (13 files)
pnpm typecheck  → clean
live            → agent ran the real suite (169, exit 0); rm -rf blocked; repo intact
```

### Approval gate · LIVE VERIFIED

High-impact calls no longer only fail — they **ask**. The run pauses on a promise, the UI shows the exact command with its classification, and nothing executes until answered.

Fail-closed in every direction, each covered by tests: an unanswered request **denies on timeout** (120 s default); closing the page denies every outstanding request for that run; an unknown or already-settled id is ignored, so a second answer cannot flip a decision; ids are UUIDs, so an approval cannot be forged by guessing; and with **no gate wired at all** the executor still denies. A capability the workspace never granted is denied by the engine outright and is **never** escalated to a human — that denial is not appealable.

Live, approving a PowerShell invocation:

```
CALL     shell.run({"command":"powershell -Command \"$PSVersionTable.PSVersion.ToString()\""})
APPROVAL required · high-impact — command chains or redirects, full effect cannot be classified
  → user answered: APPROVED
RESULT   exitCode: 0   stdout: 5.1.26100.9168
ANSWER   The exact version string printed by the command is: 5.1.26100.9168
```

Live, denying a destructive one (`rm -rf docs`): the request was raised, denied, the tool never ran, `docs/` was intact, and the model changed approach rather than retrying.

Every decision persists to `permission_audit` — `approval-required`, then `approved`/`rejected`, then the final `allowed`/`denied` — readable at `GET /api/audit`.

### Known gaps
- Traces from agent runs are built in memory and counted, but not yet persisted to `training_traces` (Phase 7).
- File edits are not yet captured as diffs with before/after hashes (Phase 7 alongside trace persistence).

---

## Phase 7 — Task delegation with persistence · COMPLETE

### Delegated tasks · LIVE VERIFIED

`POST /api/tasks` submits and returns immediately; the work continues in the background and is polled via `GET /api/tasks/:id`. This is the surface Phase 8's MCP bridge is a thin client over, and the reason it exists: a supervising session hands off token-heavy work without holding a connection open for minutes.

Live run — a `repo-explorer` task over this repository, submitted with `source: "mcp"`:

```
task_rg7b9741  queued → running → completed  (~2m 20s)
usage: turns=2 toolCalls=1 in=2376 out=290  traceId=tr_fjpor2l3
```

`TaskRunner` caps concurrency at `MAX_LOCAL_WORKERS`; work beyond the cap queues rather than being rejected, so five delegated tasks return five results without five simultaneous model requests competing for the same CPU. Cancellation is **durable** — the row is marked immediately so a poller sees it even before the worker notices its abort signal. Verified live: a running task cancelled and reported `cancelled` on the next poll.

### Worker roles · TEST VERIFIED

Five typed roles in `packages/agents`: `repo-explorer`, `debugger`, `coder`, `reviewer`, `test-engineer`. Tests assert that read-only roles are never granted a mutating tool, every prompt demands evidence, every role is bounded by a turn limit, and every role routes to an **agent-capable** alias (never advisory-class `fast`/`research`, which the loop would refuse).

A role is a *narrower* grant than the workspace, never wider: a read-only role in a writable workspace still gets read-only tools.

### Trace persistence · LIVE VERIFIED

Traces now reach `training_traces` / `training_trace_steps`. Two invariants live in the store rather than in callers: **eligibility is recomputed on write**, so a caller cannot mark a trace training-eligible by asserting it, and capture respects the workspace's `training_trace_capture` flag.

The first persisted trace demonstrates the fail-closed rule working:

```
tr_fjpor2l3  explore_repo  repo-explorer  qwen3:8b  successful
sanitization_passed: true
eligible_for_training: FALSE — "No objective evidence recorded."
```

The task listed files and answered. No verification step, no evidence — so it is **not** training material, despite completing successfully. That is the intended behaviour.

Negative feedback withdraws eligibility immediately rather than at export time (verified live: `POST /api/traces/:id/feedback` with `bad` flipped a previously-eligible trace to `false` with reason *"Human feedback was negative."*).

### File edits as structured patches · TEST VERIFIED

`filesystem.write` and `filesystem.edit` now return a real unified diff with `beforeHash`/`afterHash` and added/removed counts, so a trace records a verifiable patch instead of two copies of a file. The differ is LCS-based with three lines of context, emits separate hunks for distant changes, and falls back to whole-file replacement rather than allocating an enormous matrix on very large inputs.

### Usage attribution · LIVE VERIFIED

```
usage_class     source  worker_role      in     out   tool_calls
LOCAL_OLLAMA    mcp     repo-explorer    2376   290   1
```

Delegated work is attributable by source and role, which is what Phase 9's "local versus Claude activity is distinguishable" criterion will read.

### Verification run

```
pnpm test       → 194 tests passed (16 files)
pnpm typecheck  → clean
live            → task submitted/polled/completed · cancel durable ·
                  trace + 4 steps persisted · feedback withdrew eligibility
```

### Known gaps carried into Phase 8

- Delegated tasks have **no approval gate** by design — nobody is watching, so high-impact work fails closed rather than waiting for a click that will never come.
- `delegateParallel` is not exposed as an endpoint; the runner supports concurrent tasks, but fan-out is the caller's job for now.
- Trace export (JSONL/SFT) remains Phase 20; only capture and the stats report exist.

---

## Phase 8 — MCP server · COMPLETE (awaiting the Phase 9 live test from Claude Code)

### The bridge · LIVE VERIFIED

`packages/mcp` is a real `@modelcontextprotocol/sdk` stdio server exposing seven tools, built to `dist/bin.js` and registerable with `claude mcp add`. Verified by speaking raw MCP over stdio: `initialize` returns `dacai-local-agent 0.1.0`, `tools/list` returns all seven.

It is a **thin bridge** — MCP protocol handling only, forwarding to the running server over loopback HTTP. The delegation engine, pool, concurrency caps, permission engine, audit and telemetry exist exactly once, so a task Claude starts stays visible and cancellable in the web UI. With the server down, tools return a clear error rather than degrading to a second implementation.

Full chain verified end to end — `tools/call local_agent.explore_repo` → task API → TaskRunner → agent loop → Ollama → filesystem tools → structured result back through MCP:

```
task: task_ninbbkmf   status: completed
worker: repo-explorer · qwen3:8b (local)
cost: 5 turns · 3 tool calls · 4469 in / 228 out tokens · $0 (local inference)
```

### A real quality failure, and the structural fix

The **first** delegated answer through MCP was wrong in an instructive way. Asked which file defines the permission tiers, the worker searched for the literal phrase, got one weak match in a *test* file, and answered `user / group / others` — Unix priors — **without opening a single file**. Its role prompt already said "cite the files you actually opened"; it cited one it had never read.

Prompt wording cannot fix that. The loop gained an **evidence requirement**: a role may declare tools that must have *succeeded* before a final answer is accepted, and an answer offered without them is pushed back once with a corrective turn. Inspection roles now require `filesystem.read`; test-engineer requires `tests.run`/`shell.run`.

Re-running the identical request afterwards, the trace shows the mechanism working:

```
4  model_response   ← tried to answer with only a search
5  model_response   ← after the nudge
6  tool_call        filesystem.read (line 200)
9  tool_call        filesystem.read (lines 200-213)
11 model_response   ← "safe", "mutation" — read from the file
```

Wrong-from-priors became right-from-the-file, and the run went from 1 tool call to 3. A failed tool call does not satisfy the requirement, and the nudge budget is bounded so a stubborn model cannot loop.

**Remaining honest limitation**: the worker still attributes the *definition* to the test file rather than `packages/security/src/types.ts`, because its search matched only the test. The tier names are now right and read from disk; the file attribution is a model-quality limitation, not a plumbing one.

### Verification run

```
pnpm test                 → 198 tests passed (16 files)
pnpm typecheck            → clean
stdio probe               → initialize + 7 tools listed
tools/call end to end     → completed, $0, trace persisted
```

### Phase 9 — pending, requires your Claude Code session

Seven of the eight acceptance criteria are already demonstrated through the raw-MCP probe (routing, local tools, structured findings, no paid inference, telemetry attribution). The two that require a real supervisor — Claude Code discovering the server and evaluating the returned result — need the registration step in [docs/MCP.md](docs/MCP.md) run in your own session.
### Phase 10 — Web access tools · TEST VERIFIED

`packages/tools/src/web-tools.ts` exposes three bounded tools to the agent loop —
`web.fetch`, `web.search`, and `download.approved` — flowing through the same
permission/safety layer as every other tool. The security boundaries are covered
by [tests/web-tools.test.ts](tests/web-tools.test.ts) (12 tests, all passing):

- **`web.fetch`** (tier `safe`, requires network): HTTPS-only; rejects URLs with
  embedded credentials; refuses localhost / metadata / `.internal` hosts, literal
  private addresses, and hostnames that resolve to a private or link-local
  address (SSRF guard) **before** any request is made. Responses are capped at
  50k chars with an explicit `[response truncated]` marker, and no credentials
  are put in request headers.
- **`web.search`** (tier `safe`, requires network): DuckDuckGo HTML search with a
  1–300 char query bound.
- **`download.approved`** (tier `mutation`, requires network + write): caps
  downloads at 10 MB, requires a workspace, and sanitizes the filename so a
  path-traversal attempt (`../../evil.bin`) is neutralized and the file lands
  inside `<workspace>/downloads` instead of escaping.

Verified by running `pnpm exec vitest run tests/web-tools.test.ts` → 12/12 pass
(deterministic fetch/DNS doubles — no live network needed).

> ⚠️ Pre-existing conditions, unrelated to Phase 10 and present before this work:
> the full-repo `pnpm typecheck` still fails in `apps/server` (roles-refactor
> fallout — `readOnly` → `canEditFiles`, readonly `tools[]`), and 5 tests in
> `model-aliases` / `shell-tools` / `worker-roles` are stale against the
> refactored source. A pre-existing `AgentTask` name collision in
> `packages/agent-core` was fixed (loop-only type renamed to `AgentLoopTask`).

---

## Domain intelligence · operational · LIVE VERIFIED

Domain-scoped RAG over the existing pgvector corpus (migration 013), an ingestion service
with mandatory licence + secret redaction, persistence for the domain layer (migrations
012/014), and `smart-contract` taken end to end: 9-document corpus ingested with real
embeddings, deterministic static analyzer, and a held-out 6-case evaluation suite.

The analyzer is registered as agent tools (`smartcontract.analyze` / `.report`, tier
`safe`, no address or RPC parameter). A real training resource gate exists and blocks on
measured RAM/disk/VRAM, fail-closed on anything unmeasurable.

Live: domain scoping proven to change results (`robotics` scope returns nothing where
`smart-contract` returns the answer with provenance). Adapter training gates: **8/11 —
BLOCKED. No fine-tuning attempted.**

Operational ladder is the single source of truth in `taxonomy.ts`: **`smart-contract` is
EVALUATED; every other domain is REGISTERED.** No domain is ADAPTER_TRAINED.

Full detail and the explicit not-implemented list: [docs/DOMAIN_INTELLIGENCE.md](DOMAIN_INTELLIGENCE.md).

### Earlier: foundation pass · TEST VERIFIED (57 tests) + schema LIVE VALIDATED

Domain taxonomy, dataset lineage, temporal integrity, provenance, prediction records,
the adapter registry, and the learning-loop gate. Four new packages
(`domain-knowledge`, `datasets`, `market-intelligence`, `model-registry`) plus additive
migration `012_domain_intelligence.sql`, whose CHECK constraints were verified against
real PostgreSQL inside a rolled-back transaction.

Foundation only: **no ingestion, no retrieval wiring, no persistence, no trained
adapter, no on-chain anchoring.** Full scope and the explicit not-implemented list are
in [docs/DOMAIN_INTELLIGENCE.md](DOMAIN_INTELLIGENCE.md).

---

## Everything else · NOT IMPLEMENTED

Unchanged from the audit above, and sequenced per the revised plan:

| Phase | Capability |
| --- | --- |
| 9 | **LIVE Claude Code → MCP → Ollama delegation test** (8 criteria) → tag `milestone-mcp` |
| 10 | Web access (TEST VERIFIED — see Phase 10 section) |
| 11 | Agent-role YAML loading (config/agents/*.yaml → registered roles) |
| 12 | Orchestration + parallel workers (packages/orchestrator) |
| 13 | Hugging Face provider |
| 14–18 | Mode B experiment · MCP client · browser · memory/RAG · goal mode |
| 19–22 | Telemetry dashboard · training export pipeline · paid providers · hardening |

### Known gaps carried out of Phase 1 (status after Phase 2)

- `OllamaProvider.chat()` — **resolved in Phase 2**, now a real HTTP call.
- `packages/mcp` is still two no-op classes.
- `ToolRegistry` still has zero registered tools.
- `apps/web` static JSX — **resolved in Phase 3**, now a real chat app.
- `usage_events` — **resolved in Phase 3** for chat; task/MCP sources land in Phase 7.
- Training traces still have no emitters; only the schema and pure functions exist (Phase 4 onward).
