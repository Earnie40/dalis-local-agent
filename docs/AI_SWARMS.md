# AI swarms

DACAIS AI swarms run several bounded specialist tasks for one parent objective,
then enqueue one reviewer task to synthesize their results. Swarms reuse the
existing durable task queue, provider routing, workspace permissions, tool audit,
model-request semaphore, and `MAX_LOCAL_WORKERS` limit. Creating a swarm does not
grant a member any tool or permission that its role and workspace did not already
have.

## Lifecycle

1. The server stores the swarm before launching members.
2. Two through six member tasks are stored and attached to it.
3. The swarm is sealed, making it eligible for execution and later synthesis.
4. Members run or queue under the existing worker limit.
5. After every member reaches a terminal state, one server process claims the
   swarm and creates a reviewer coordinator.
6. The coordinator receives bounded worker results and errors, reconciles
   disagreements, and stores its final result as another durable task.

A member failure is retained for the coordinator; it is never silently discarded.
If synthesis fails after at least one member completed, the swarm reports
`partial`, not `completed`. Cancelling a swarm durably marks it cancelled and
requests cancellation of every live member and coordinator task.

## Agent tools

- `agent.swarm.create` starts a balanced, research, review, security, offensive-
  security, or defensive-security roster. The two security-force strategies
  default to all six capability lanes.
- `agent.swarm.status` returns member progress and the coordinator result.
- `agent.swarm.cancel` cancels outstanding work.

The Delegation screen exposes the same create, status, and cancellation flow.
The REST API additionally accepts an explicit `members` array for a custom
two-to-six-worker roster. Custom mutation workers share the selected workspace;
callers should give them non-overlapping assignments or use isolated worktrees
through ordinary delegation when their file changes could conflict.

## Operational boundaries

- Swarms do not bypass approval or workspace capability checks.
- Every member and coordinator uses the dedicated `swarm_qwen` alias. Runtime
  validation requires an Ollama provider and a Qwen model after all routing and
  fallback decisions; OpenAI, Anthropic, Hugging Face, and non-Qwen aliases are
  rejected for swarm inference.
- Worker and model concurrency remain bounded by runtime configuration.
- Fan-out may queue when fewer inference slots exist than members.
- Default rosters gather independent evidence and do not silently mutate files.
- The coordinator cannot certify work or validation absent from member results.
- Swarm metadata survives server and browser restarts in PostgreSQL.

## Persona-free security swarms

Swarm workers have no human name, biography, profile, demographic attributes,
or reusable cross-run persona. They are represented only by a random task ID and
their functional capability lane for the lifetime of the audited job. DACAIS
does not claim that this makes network traffic anonymous: the host address,
provider telemetry, engagement record, and permission audit remain observable.

`offensive-security` coordinates six lanes for authorized access assessment:
trust-boundary analysis, interface enumeration, intelligence gathering,
failure investigation, variant hunting, independent review, and reproducible proof.
It requires an active security engagement ID and carries that engagement's exact targets,
environments, allowed categories, and prohibited actions into every assignment.
Controlled actions against protected systems continue through the existing
LIVE_VALIDATION control plane.

`defensive-security` coordinates six lanes for asset/control mapping, detection,
root-cause analysis, gap hunting, containment/hardening review, and regression
validation. It can optionally bind to the same engagement record when defending
a specific protected environment.
