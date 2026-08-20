# Adversarial Capability Plan

## Current truth

The Agent window now exposes three roles:

- **Coding agent** — filesystem, git, tests, and fixed read-only diagnostics.
- **Adversarial Twin Simulator** — can design and modify synthetic fixtures using the available tools, but cannot yet execute Red Team engagements through the UI route.
- **Tomahawk1** — defensive behavioral analysis using the available tools.

The model must not claim adversarial execution until an actual security tool returns evidence.

## What is missing for adversarial execution

### 1. Engagement-bound execution context

Add an agent request field and UI selector for:

- `engagementId`
- target digital twin
- environment
- test category
- policy lane (`ALLOW`, `APPROVAL`, `BLOCK`)
- stop condition

The server must load the engagement from PostgreSQL and reject missing or inactive engagements before tools are offered.

### 2. Red Team gateway adapter

The existing `RedTeamToolGateway` validates scope and risk, but the generic Agent route does not call it. Build an adapter that:

1. Receives a proposed simulation action.
2. Calls `ScopeGuard` and `RiskClassifier` through `RedTeamToolGateway`.
3. Requests approval for admitted high-risk actions.
4. Executes only after the gateway returns `executionAllowed: true`.
5. Writes audit records and sanitized evidence.

The model must never be the authorization layer.

### 3. Synthetic adversarial tools

Implement bounded tools, not unrestricted attack commands:

- `security.simulation.auth-boundary`
- `security.simulation.authorization-boundary`
- `security.simulation.tenant-isolation`
- `security.simulation.input-validation`
- `security.simulation.rate-limit`
- `security.simulation.prompt-injection`
- `security.simulation.tool-boundary`
- `security.simulation.behavior-sequence`
- `security.simulation.alert-routing`
- `security.simulation.recovery`

Each tool should accept synthetic fixture IDs, not arbitrary hosts, commands, credentials, or payload destinations.

### 4. Digital-twin harness

Create a local or database-backed harness containing:

- synthetic users and tenants
- simulated endpoints
- canary secrets
- inert payloads
- expected defensive responses
- deterministic reset/rollback
- baseline behavior sequences

No public or third-party target should be reachable from these tools.

### 5. Evidence and reporting

Every simulation needs:

- objective
- expected defense
- policy decision
- observed result
- detection/block status
- evidence ID
- timestamps
- confidence
- false-positive and false-negative analysis
- regression recommendation

Persist these in the existing security and defensive-testing tables.

### 6. UI capability display

The Agent window should show:

- active role
- provider/model
- available security tools
- engagement and target
- current policy lane
- blocked/approved/executed status

If no engagement is selected, the simulator must say `APPROVAL REQUIRED`, not claim it can attack.

## Training and downloads

### Needed immediately

No Python training is required for the first implementation. Use deterministic TypeScript simulation tools and the already-installed Ollama models.

Recommended local models:

- `qwen3:8b` — tool-driven orchestration
- `qwen2.5:3b` — fast CPU/remote testing
- `nomic-embed-text` — RAG embeddings

### Training data to collect

Create synthetic JSONL traces containing:

- approved action and scope
- gateway decision
- tool call
- expected defense
- observed defense
- evidence
- final classification

Start with 500–1,000 evaluation traces before fine-tuning. Fine-tuning is optional and should follow baseline evaluation. RAG is better for policies, playbooks, threat models, and changing documentation.

## Implementation phases

1. **Role/capability accuracy** — complete; role selector and truthful prompts are wired.
2. **Engagement adapter** — expose engagement selection and gateway validation in `/api/agent/stream`.
3. **Synthetic tools** — add the ten bounded simulation tools.
4. **Evidence persistence** — connect results to existing security stores.
5. **UI telemetry** — show policy lane, decisions, evidence, and stop state.
6. **Regression suite** — test every boundary and denial path.
7. **Training/RAG** — ingest approved traces and documentation; evaluate before optional LoRA tuning.
8. **Remote execution** — use the connected Ollama VM for inference only; keep authorization, tools, database, and audit logs local.

## Non-negotiable boundaries

- No real-world intrusion or third-party targets.
- No credential theft, persistence, malware, evasion, exfiltration, or destructive actions.
- No scope, approval, audit, or authorization bypass.
- A model prompt cannot grant permission.
- A denied gateway decision is final.
