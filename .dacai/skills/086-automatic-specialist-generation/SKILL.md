# Capability 86: Automatic specialist generation

Category: `agent-orchestration`
Mode: `bounded_execution`

## Purpose

Provide DacaiLocalAgent with a reusable workflow for **Automatic specialist generation**.

This capability is a composite engineering skill. It should reuse existing
repository intelligence, task planning, specialists, permissions, browser,
validation, transaction, evidence, and completion machinery rather than creating
a parallel authorization path.

## Execution Mode

**BOUNDED EXECUTION**

Use the existing permissioned DacaiLocalAgent tools to perform this workflow when
the required primitives are available. Missing infrastructure is a blocker or
prerequisite, not permission to invent a replacement.

Execution must remain inside registered workspaces/test targets and must respect
the existing permission, resource, transaction, validation, review, and completion
layers.

## Preconditions

- agent.delegate

## Workflow

1. Re-read the current user objective.
2. Inspect the live repository/runtime state before acting.
3. Determine whether this capability is actually relevant to the objective.
4. Identify prerequisites and current authorization boundaries.
5. Prefer deterministic/local evidence before extra model calls.
6. Build the smallest bounded plan that satisfies the objective.
7. Execute only through registered tools and existing permission controls.
8. Preserve current user work and unrelated state.
9. Record objective evidence for every meaningful mutation or conclusion.
10. Run the validation/review appropriate to the actual change.
11. Distinguish observed facts from predictions, simulations, generated artifacts,
    mocks, or proposals.
12. Do not claim completion until the ordinary DacaiLocalAgent completion criteria
    are satisfied.

## Capability-specific guardrails

- Respect MAX_LOCAL_WORKERS and MAX_CONCURRENT_MODEL_REQUESTS.
- Keep parallelism bounded and justified by independent evidence.
- Record model/provider/cost/resource decisions.
- Specialists cannot bypass the parent permission boundary.
- No sub-agent may expand its own permissions.
- Prefer bounded evidence-producing specialists over open-ended debates.

## Failure behavior

- Never invent missing credentials, infrastructure, API access, files, services,
  accounts, or external authorization.
- Never weaken permissions simply to make the workflow succeed.
- Do not reinterpret a denial as a transient failure.
- If a required primitive is unavailable, record the exact missing prerequisite.
- If this capability is proposal-only, return the plan/evidence without executing
  the high-impact step.

## Completion

Successful use of this skill does not independently mean the parent task is
complete. Completion remains governed by the parent task graph, validation state,
review evidence, and completion manifest.
