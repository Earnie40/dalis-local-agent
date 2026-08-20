import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';

const execFileAsync = promisify(execFile);

export interface ReviewPacket {
  kind: 'final_patch_review';
  threadId: string;
  objective: string;
  changedFiles: string[];
  validationState: Record<string, unknown>;
  diff: string;
  reviewInstructions: string[];
}

async function gitDiff(
  workspaceRoot: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      'diff',
      '--no-ext-diff',
      '--unified=40',
      '--',
    ],
    {
      cwd: workspaceRoot,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );

  return stdout.slice(0, 120000);
}

export async function buildFinalReviewPacket(
  threadId: string,
  workspaceRoot: string,
  objective: string,
): Promise<ReviewPacket> {
  const state =
    await loadWorkingState(threadId);

  const changedFilesValue: unknown =
    state?.changed_files ??
    state?.changedFiles ??
    [];

  const changedFiles: string[] =
    Array.isArray(changedFilesValue)
      ? Array.from(
          new Set(
            changedFilesValue.filter(
              (value): value is string =>
                typeof value === 'string',
            ),
          ),
        )
      : [];

  const validationState =
    state?.validation_state ??
    state?.validationState ??
    {};

  return {
    kind: 'final_patch_review',
    threadId,
    objective,
    changedFiles,
    validationState,
    diff: await gitDiff(workspaceRoot),
    reviewInstructions: [
      'Review only the supplied patch and objective.',
      'Identify correctness regressions.',
      'Identify incomplete requirements.',
      'Identify unnecessary or unrelated edits.',
      'Identify broken public interfaces or compatibility risks.',
      'Identify security or permission regressions.',
      'Check whether validation evidence is sufficient.',
      'Do not rewrite the implementation.',
      'Return APPROVED only if no blocking issue remains.',
      'Otherwise return CHANGES_REQUIRED with concise actionable findings.',
    ],
  };
}

export async function recordFinalReview(
  threadId: string,
  verdict: 'approved' | 'changes_required',
  summary: string,
  findings: unknown[] = [],
): Promise<void> {
  const state =
    await loadWorkingState(threadId);

  if (!state) {
    throw new Error(
      `No working state found for ${threadId}.`,
    );
  }

  const existingValidation =
    state.validation_state ??
    state.validationState ??
    {};

  await saveWorkingState({
    threadId,

    objective:
      state.objective ??
      undefined,

    plan:
      state.plan ?? [],

    completedSteps:
      state.completed_steps ??
      state.completedSteps ??
      [],

    pendingSteps:
      state.pending_steps ??
      state.pendingSteps ??
      [],

    inspectedFiles:
      state.inspected_files ??
      state.inspectedFiles ??
      [],

    relevantSymbols:
      state.relevant_symbols ??
      state.relevantSymbols ??
      [],

    changedFiles:
      state.changed_files ??
      state.changedFiles ??
      [],

    knownErrors:
      state.known_errors ??
      state.knownErrors ??
      [],

    architectureFacts:
      state.architecture_facts ??
      state.architectureFacts ??
      [],

    validationState: {
      ...existingValidation,

      review: {
        status: verdict,
        summary,
        findings,
        reviewedAt:
          new Date().toISOString(),
      },
    },
  });
}
