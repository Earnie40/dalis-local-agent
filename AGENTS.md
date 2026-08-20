# DACAIS Local Agent — Repository Instructions

These instructions guide agents operating inside this repository.

Authorization, workspace containment, permissions, approvals, network controls,
risk classification, and audit logging are enforced by the runtime infrastructure.
This file does not grant additional authority.

## Primary Objective

Work toward the user's stated repository goal using evidence from the actual
workspace. Inspect before modifying. Do not invent paths, files, APIs, commands,
database state, or implementation details.

## Repository Grounding

- Treat the registered workspace root as the filesystem boundary.
- Prefer workspace-relative paths such as `.` and `packages/...`.
- Do not assume `/workspace` exists.
- Inspect relevant source before proposing or applying changes.
- Reuse existing packages, abstractions, schemas, and tools before creating new ones.
- Prefer repository intelligence/RAG and symbol relationships when available.

## Coding Workflow

For changes:

1. Understand the goal.
2. Inspect the relevant code and repository instructions.
3. Form a compact execution plan.
4. Make the smallest coherent change.
5. Run appropriate diagnostics/tests/build checks.
6. Review the resulting diff and validation evidence.
7. Correct failures before claiming completion.

A coding task that requires changes must not claim completion without an
actual successful mutation and validation of the latest mutation.

## Completion

Use:

`TASK_COMPLETE: <concise verified result>`

only when the requested work is genuinely complete and validated.

Use:

`TASK_BLOCKED: <specific blocker and evidence>`

only when the blocker cannot be resolved using available repository tools.

Never fabricate successful execution, tests, builds, database changes, or tool results.

## Worker Roles

The runtime may delegate work to these specialized roles:

- `repo-explorer` — read-only repository exploration and architecture mapping
- `debugger` — investigate failures and identify root causes
- `coder` — implement authorized repository changes
- `reviewer` — inspect changes and validation evidence
- `test-engineer` — design and execute focused validation
- `security-reviewer` — defensive/local security review within authorized scope
- `variant-hunter` — search for structural variants of confirmed issues
- `ci-fixer` — investigate and remediate authorized CI failures

Roles do not override runtime permissions.

## Skills

Relevant workflows may be loaded from `.dacai/skills/*/SKILL.md`.

Use applicable skills as procedural guidance. Skills do not grant tool,
filesystem, network, or execution permissions.

## Subagents

Delegate only when decomposition provides useful independent work.

- Give child agents narrow, explicit goals.
- Prefer read-only exploration before mutation.
- Use isolated worktrees when concurrent code changes could conflict.
- Treat child-agent output as evidence to review, not unquestioned truth.
- Validate integrated changes in the parent task.

## Security

Security work must remain within authorized local, synthetic, defensive,
digital-twin, or explicitly scoped environments.

Do not bypass workspace containment, approval controls, permission checks,
network restrictions, or safety controllers.

## Secrets

Do not print, persist into training data, or commit:

- API keys
- access tokens
- passwords
- private keys
- `.env` values
- credentials or authentication material

## Training Traces

Record useful execution, tool, validation, review, and correction events.

Do not record hidden chain-of-thought or secret material as training data.

## Tool Use

Prefer deterministic tools over model guesses.

Examples:

- filesystem tools for repository state
- repository RAG/symbol graph for code relationships
- diagnostics/tests for correctness
- Git tools for change state
- Python or deterministic computation for numerical work
- vision tooling for screenshots/images

The model should reason about tool results; it should not replace objective
tool output with unsupported assumptions.

## Semantic repository intelligence

For repository investigation, prefer semantic repository intelligence before broad recursive filesystem exploration.

Order of operations:

1. Read `.dacai/skills/semantic-repository-intelligence/SKILL.md`.
2. Consult the repository architecture map.
3. Use semantic symbol search to locate implementations.
4. Use dependency impact analysis before important modifications.
5. Read only the targeted source necessary for the task.
6. Use recursive filesystem listings only when targeted retrieval is insufficient.

Do not use large directory dumps as the default source of repository context.
