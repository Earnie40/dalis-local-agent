# Capability 30: Privilege escalation helper

Category: `system-and-operations`
Mode: `proposal_only`

## Purpose

Provide DacaiLocalAgent with a reusable workflow for **Privilege escalation helper**.

This capability is a composite engineering skill. It should reuse existing
repository intelligence, task planning, specialists, permissions, browser,
validation, transaction, evidence, and completion machinery rather than creating
a parallel authorization path.

## Execution Mode

**PROPOSAL ONLY**

This capability is recognized by the runtime, but it must not silently execute
high-impact actions. Inspect the relevant state, gather evidence, produce a
concrete bounded plan, identify exact mutations that would be required, and stop
before crossing the high-impact boundary unless a separate explicitly authorized
execution workflow exists.

## Preconditions

- Existing DacaiLocalAgent primitives relevant to the task.

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

- Do not modify operating-system security settings or escalate privileges automatically.
- Do not kill processes the runtime does not own.
- Do not delete files based only on heuristic cleanup scoring.

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
