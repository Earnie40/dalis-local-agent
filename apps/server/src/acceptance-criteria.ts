import { reasoningAcceptance, requirementHasEvidence, type ReasoningState } from '@dacai-local-agent/agent-core';
import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

export interface AcceptanceCriterion {
  id: string;
  text: string;
  required: boolean;
  status: 'pending' | 'proven';
  evidence: string[];
}

export interface AcceptanceCheck {
  ok: boolean;
  message?: string;
  criteria: AcceptanceCriterion[];
}

function deriveCriteria(
  objective: string,
): AcceptanceCriterion[] {
  const lines = objective
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const explicit = lines
    .filter((line) =>
      /^(?:[-*]\s+|\d+[.)]\s+)/.test(line),
    )
    .map((line) =>
      line.replace(
        /^(?:[-*]\s+|\d+[.)]\s+)/,
        '',
      ).trim(),
    )
    .filter(Boolean);

  const source =
    explicit.length > 1
      ? explicit
      : [objective.trim()];

  return source.map((text, index) => ({
    id: `criterion_${index + 1}`,
    text,
    required: true,
    status: 'pending',
    evidence: [],
  }));
}

function validationState(
  state: unknown,
): Record<string, unknown> {
  const record =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  const value =
    record?.validationState ??
    record?.validation_state;

  return value &&
    typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
}

async function persistValidationState(
  state: unknown,
  threadId: string,
  nextValidationState:
    Record<string, unknown>,
): Promise<void> {
  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  await saveWorkingState({
    ...stateRecord,
    threadId,
    validationState:
      nextValidationState,
  } as AgentWorkingState);
}

export async function initializeAcceptanceCriteria(
  threadId: string,
  objective: string,
): Promise<void> {
  const state =
    await loadWorkingState(threadId);

  if (!state) {
    return;
  }

  const validation =
    validationState(state);

  if (
    Array.isArray(
      validation.acceptanceCriteria,
    ) &&
    validation.acceptanceCriteria.length
  ) {
    return;
  }

  await persistValidationState(
    state,
    threadId,
    {
      ...validation,

      acceptanceCriteria:
        deriveCriteria(objective),

      acceptanceObjective:
        objective,

      acceptanceInitializedAt:
        new Date().toISOString(),
    },
  );
}

export async function checkAcceptanceCompletion(
  threadId: string,
  objective: string,
  currentReasoning?: ReasoningState,
): Promise<AcceptanceCheck> {
  let state =
    await loadWorkingState(threadId);

  if (!state) {
    return {
      ok: false,
      message:
        'Persistent working state is unavailable for this run.',
      criteria:
        deriveCriteria(objective),
    };
  }

  let validation =
    validationState(state);

  let criteria =
    Array.isArray(
      validation.acceptanceCriteria,
    )
      ? validation.acceptanceCriteria as AcceptanceCriterion[]
      : [];

  if (!criteria.length) {
    await initializeAcceptanceCriteria(
      threadId,
      objective,
    );

    state =
      await loadWorkingState(threadId);

    validation =
      validationState(state);

    criteria =
      Array.isArray(
        validation.acceptanceCriteria,
      )
        ? validation.acceptanceCriteria
        : deriveCriteria(objective);
  }

  // Owner-requested invariant: each original output has its own admissible
  // evidence. A shared "inspection happened" flag cannot prove every criterion.
  const reasoning = currentReasoning ?? validation.reasoning as ReasoningState | undefined;
  const check = reasoningAcceptance(reasoning, objective);
  const proven = check.ok;
  const blockers = check.missing;
  const updatedCriteria: AcceptanceCriterion[] = reasoning?.goal === objective
    ? reasoning.requiredEvidence.map(requirement => {
      const evidence = reasoning.evidence.filter(item => item.requirementId === requirement.id && item.accepted && !item.contradicted);
      return { id: requirement.id, text: requirement.output, required: true,
        status: requirementHasEvidence(reasoning, requirement) ? 'proven' : 'pending', evidence: evidence.map(item => item.id) };
    })
    : criteria.map(criterion => ({ ...criterion, status: 'pending', evidence: [] }));

  await persistValidationState(
    state,
    threadId,
    {
      ...validation,

      reasoning,
      acceptanceCriteria:
        updatedCriteria,

      acceptanceCheck: {
        ok: proven,
        blockers,
        checkedAt:
          new Date().toISOString(),
      },
    },
  );

  if (!proven) {
    return {
      ok: false,

      message: [
        'Acceptance criteria are not yet proven.',
        ...blockers.map(
          (blocker) =>
            `- ${blocker}`,
        ),
        '',
        'Continue the original task using available tools. Do not declare TASK_COMPLETE yet.',
      ].join('\n'),

      criteria:
        updatedCriteria,
    };
  }

  return {
    ok: true,
    criteria:
      updatedCriteria,
  };
}
