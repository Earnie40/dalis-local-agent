# Server Routes Agent Instructions

These instructions apply to `apps/server/src/routes/`.

Current route files include:
- `agent.ts`
- `chat.ts`
- `defensive.ts`
- `memory.ts`
- `rag.ts`
- `security.ts`
- `tasks.ts`

Treat these as API boundaries. Do not assume all business logic belongs in the route itself.

## General route rules

Every route change should consider:

- input validation
- authentication
- authorization
- request scope
- error handling
- logging
- secret exposure
- model/tool permissions
- tenant or user isolation
- database effects
- audit/evidence effects

Prefer consistent response shapes and status codes with existing routes.

## `agent.ts`

For agent execution endpoints:

- resolve the requested agent/task explicitly
- pass only authorized tools/capabilities
- preserve permission and approval boundaries
- enforce step/time/resource limits
- return truthful execution state
- distinguish planning, running, blocked, failed, and completed states when supported

Do not mark work completed merely because the model produced text.

## `chat.ts`

Chat endpoints should not become privileged execution bypasses.

If chat can trigger tools:
- use the same tool registry and permission model as normal agent execution
- preserve approval requirements
- maintain conversation context carefully
- limit context size intentionally
- do not inject secrets into model-visible messages unless strictly required

## `defensive.ts`

Defensive/security operations must stay within explicitly authorized scope.

Prefer:
- observation
- validation
- evidence collection
- bounded defensive actions
- reversible actions

Do not widen targets, hosts, networks, or permissions beyond the configured authorization scope.

Security boundary failures should fail closed.

## `memory.ts`

Memory endpoints should distinguish:

- conversational memory
- task state
- durable application data
- vector/RAG knowledge
- sensitive user data

Do not store secrets or unnecessary raw credentials in memory.

When storing model-generated memory:
- include provenance when possible
- avoid treating unsupported model inference as fact
- preserve deletion/update paths if the architecture supports them

## `rag.ts`

RAG endpoints must separate:
- ingestion
- chunking
- embeddings
- retrieval
- ranking
- generation

Do not silently mix embedding models or vector dimensions.

Before changing retrieval behavior inspect the existing database/vector schema.

Prefer returning source/provenance metadata with retrieved knowledge when the application supports it.

## `security.ts`

Security routes require the strictest review.

Do not:
- weaken auth
- expose secrets
- disable checks to make requests pass
- trust client-supplied privilege claims
- reveal sensitive internal configuration unnecessarily

Use least privilege and fail closed.

## `tasks.ts`

Task execution should have explicit lifecycle state.

When supported use states such as:
- queued
- running
- waiting_for_approval
- blocked
- failed
- completed
- cancelled

Persist state consistently if tasks survive process restarts.

Do not claim task completion based only on a model response; require the runtime's verification criteria.

## Error handling

Do not leak:
- stack traces
- secrets
- internal connection strings
- private file paths
- private keys
- raw provider credentials

to normal API clients.

Log enough context for diagnosis without logging secrets.

## Validation

After route changes, run targeted route/server tests if available, then TypeScript/build checks.
