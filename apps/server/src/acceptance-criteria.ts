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
      ? explicit.slice(0, 12)
      : [objective.trim()];

  return source.map((text, index) => ({
    id: `criterion_${index + 1}`,
    text,
    required: true,
    status: 'pending',
    evidence: [],
  }));
}

function stateArray(
  state: unknown,
  camel: string,
  snake: string,
): unknown[] {
  const record =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  const value =
    record?.[camel] ??
    record?.[snake];

  return Array.isArray(value)
    ? value
    : [];
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

  const changedFiles =
    stateArray(
      state,
      'changedFiles',
      'changed_files',
    ).filter(
      (value): value is string =>
        typeof value === 'string',
    );

  const inspectedFiles =
    stateArray(
      state,
      'inspectedFiles',
      'inspected_files',
    );

  const relevantSymbols =
    stateArray(
      state,
      'relevantSymbols',
      'relevant_symbols',
    );

  const diagnosticsValue =
    validation['code.diagnostics'];

  const diagnostics =
    diagnosticsValue && typeof diagnosticsValue === 'object'
      ? (diagnosticsValue as { success?: unknown })
      : undefined;

  const testsValue =
    validation['tests.run'];

  const tests =
    testsValue && typeof testsValue === 'object'
      ? (testsValue as { success?: unknown })
      : undefined;

  const validationPassed =
    diagnostics?.success === true ||
    tests?.success === true;

  const reviewValue =
    validation.review;

  const review =
    reviewValue && typeof reviewValue === 'object'
      ? (reviewValue as { status?: unknown })
      : undefined;

  const reviewApproved =
    review?.status ===
    'approved';

  const changedSource =
    changedFiles.some((path) =>
      /\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml)$/i
        .test(path),
    );

  const inspectionEstablished =
    inspectedFiles.length > 0 ||
    relevantSymbols.length > 0 ||
    validationPassed;

  const evidence: string[] = [];

  if (changedFiles.length) {
    evidence.push(
      `Changed files recorded: ${changedFiles.join(', ')}`,
    );
  }

  if (validationPassed) {
    evidence.push(
      'Successful diagnostics or test validation is recorded.',
    );
  }

  if (reviewApproved) {
    evidence.push(
      'Independent final patch review is approved.',
    );
  }

  if (
    !changedFiles.length &&
    inspectionEstablished
  ) {
    evidence.push(
      'Repository inspection evidence is recorded.',
    );
  }

  const blockers: string[] = [];

  if (changedFiles.length) {
    if (
      changedSource &&
      !validationPassed
    ) {
      blockers.push(
        'Source/configuration files changed but no successful tests.run or code.diagnostics result is recorded.',
      );
    }

    if (!reviewApproved) {
      blockers.push(
        'Files changed but the independent final review has not been approved.',
      );
    }
  }
  else if (!inspectionEstablished) {
    blockers.push(
      'No successful repository inspection or validation evidence is recorded.',
    );
  }

  const proven =
    blockers.length === 0;

  const updatedCriteria: AcceptanceCriterion[] =
    criteria.map(
      (criterion) => ({
        ...criterion,
        status:
          proven
            ? 'proven'
            : 'pending',
        evidence:
          proven
            ? Array.from(
                new Set([
                  ...(criterion.evidence ?? []),
                  ...evidence,
                ]),
              )
            : criterion.evidence ?? [],
      }),
    );

  await persistValidationState(
    state,
    threadId,
    {
      ...validation,

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
