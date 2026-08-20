import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

interface ResumeOptions {
  threadId: string;
  workspaceId?: string;
  fallbackObjective?: string;
}

interface TaskNode {
  id: string;
  objective: string;
  status:
    | 'pending'
    | 'in_progress'
    | 'complete'
    | 'blocked';
  dependsOn?: string[];
  mutation?: boolean;
  evidence?: string[];
  blocker?: string;
}

export interface RecoveredRun {
  threadId: string;
  objective: string;
  resumePrompt: string;
  reconciliationNodeIds: string[];
  completedNodeIds: string[];
  pendingNodeIds: string[];
  blockedNodeIds: string[];
}

interface TaskGraphLike {
  nodes?: unknown;
  updatedAt?: unknown;
  objective?: unknown;
}

function validationState(
  state: unknown,
): Record<string, unknown> {
  if (!state || typeof state !== 'object') {
    return {};
  }

  const record = state as Record<string, unknown>;
  const value = record.validationState ?? record.validation_state;

  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function taskGraph(
  state: unknown,
): TaskGraphLike | undefined {
  const value = validationState(
    state,
  ).taskGraph;

  return value && typeof value === 'object'
    ? (value as TaskGraphLike)
    : undefined;
}

function stringArray(
  value: unknown,
): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === 'string',
      )
    : [];
}

function resolveObjective(
  state: unknown,
  fallback?: string,
): string {
  const validation =
    validationState(state);

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  const graph =
    validation.taskGraph &&
    typeof validation.taskGraph === 'object'
      ? (validation.taskGraph as { objective?: unknown })
      : undefined;

  const candidates = [
    stateRecord?.currentGoal,
    stateRecord?.current_goal,
    stateRecord?.originalGoal,
    stateRecord?.original_goal,
    stateRecord?.objective,
    validation.acceptanceObjective,
    graph?.objective,
    fallback,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      candidate.trim()
    ) {
      return candidate.trim();
    }
  }

  throw new Error(
    'The persisted run has no recoverable original objective.',
  );
}

function compactErrors(
  state: unknown,
): unknown[] {
  const record =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  const value =
    record?.knownErrors ??
    record?.known_errors;

  return Array.isArray(value)
    ? value.slice(-8)
    : [];
}

function changedFiles(
  state: unknown,
): string[] {
  const record =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  return Array.from(
    new Set(
      stringArray(
        record?.changedFiles ??
          record?.changed_files,
      ),
    ),
  ).slice(0, 30);
}

function inspectedFiles(
  state: unknown,
): string[] {
  const record =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  return Array.from(
    new Set(
      stringArray(
        record?.inspectedFiles ??
          record?.inspected_files,
      ),
    ),
  ).slice(0, 30);
}

export async function recoverInterruptedRun(
  options: ResumeOptions,
): Promise<RecoveredRun> {
  const state =
    await loadWorkingState(
      options.threadId,
    );

  if (!state) {
    throw new Error(
      `No persisted agent run exists for "${options.threadId}".`,
    );
  }

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  const storedWorkspace =
    stateRecord
      .workspaceId ??
    stateRecord
      .workspace_id;

  if (
    storedWorkspace &&
    options.workspaceId &&
    storedWorkspace !==
      options.workspaceId
  ) {
    throw new Error(
      'The requested run belongs to a different workspace.',
    );
  }

  const validation =
    validationState(state);

  const objective =
    resolveObjective(
      state,
      options.fallbackObjective,
    );

  const graph =
    taskGraph(state);

  const nodes:
    TaskNode[] =
      Array.isArray(
        graph?.nodes,
      )
        ? (graph.nodes as TaskNode[])
        : [];

  const completed =
    nodes.filter(
      (node) =>
        node.status ===
        'complete',
    );

  const inProgress =
    nodes.filter(
      (node) =>
        node.status ===
        'in_progress',
    );

  /*
   * An interrupted in_progress node is NOT assumed incomplete.
   *
   * A mutation may have committed before the connection/process
   * disappeared. Put it back in pending state, but separately
   * require reconciliation before it may execute again.
   */
  const reconciliationNodeIds =
    inProgress.map(
      (node) => node.id,
    );

  if (graph && inProgress.length) {
    graph.nodes =
      nodes.map(
        (node) => {
          if (
            node.status !==
            'in_progress'
          ) {
            return node;
          }

          return {
            ...node,

            status:
              'pending',

            evidence:
              Array.from(
                new Set([
                  ...(node.evidence ?? []),

                  'Previous execution was interrupted while this node was in_progress. Reconcile actual repository/runtime state before re-executing.',
                ]),
              ),
          };
        },
      );

    graph.updatedAt =
      new Date()
        .toISOString();
  }

  const resumeCount =
    Number(
      validation
        .resumeCount ??
      0,
    ) + 1;

  const resumeRecord = {
    count:
      resumeCount,

    resumedAt:
      new Date()
        .toISOString(),

    previousRunStatus:
      validation.runStatus,

    previousStopReason:
      validation.stopReason,

    reconciliationNodeIds,

    completedNodeIds:
      completed.map(
        (node) => node.id,
      ),
  };

  await saveWorkingState({
    ...stateRecord,

    threadId:
      options.threadId,

    validationState: {
      ...validation,

      taskGraph:
        graph,

      runStatus:
        'resuming',

      resumeCount,

      latestResume:
        resumeRecord,

      resumeReconciliationRequired:
        reconciliationNodeIds,
    },
  } as AgentWorkingState);

  const updatedNodes:
    TaskNode[] =
      Array.isArray(
        graph?.nodes,
      )
        ? (graph.nodes as TaskNode[])
        : [];

  const pending =
    updatedNodes.filter(
      (node) =>
        node.status ===
        'pending',
    );

  const completedIds =
    updatedNodes
      .filter(
        (node) =>
          node.status ===
          'complete',
      )
      .map(
        (node) => node.id,
      );

  const blockedIds =
    updatedNodes
      .filter(
        (node) =>
          node.status ===
          'blocked',
      )
      .map(
        (node) => node.id,
      );

  const persistedChangedFiles =
    changedFiles(state);

  const persistedInspectedFiles =
    inspectedFiles(state);

  const knownErrors =
    compactErrors(state);

  const resumePrompt = [
    'RESUMED_DURABLE_AGENT_RUN',
    '',
    `Persisted thread ID: ${options.threadId}`,
    '',
    'ORIGINAL USER OBJECTIVE:',
    objective,
    '',
    'RECOVERY CONTRACT:',
    '- Continue the original objective. Do not treat this resume request as a new task.',
    '- Preserve all verified completed graph nodes.',
    '- Do not repeat successful repository inspection merely because the new model turn has no transcript of it.',
    '- Use persisted state as prior evidence, but verify current mutable repository/runtime state when necessary.',
    '- An interrupted mutation may already have landed.',
    '- For every node listed under RECONCILIATION REQUIRED, inspect the current repository, Git diff, validation state, or relevant runtime evidence BEFORE executing that node again.',
    '- If current evidence proves the interrupted node already completed successfully, mark it complete with agent.plan.update instead of repeating the mutation.',
    '- If the work did not land or remains incomplete, execute only the missing portion.',
    '- Continue from ready DAG nodes after reconciliation.',
    '- Do not reset or discard unrelated existing changes.',
    '- Do not declare TASK_COMPLETE until the normal acceptance, validation, review, and graph completion gates pass.',
    '',
    'PERSISTED EXECUTION STATE:',
    JSON.stringify(
      {
        completedNodeIds:
          completedIds,

        pendingNodeIds:
          pending.map(
            (node) => node.id,
          ),

        blockedNodeIds:
          blockedIds,

        reconciliationNodeIds,

        changedFiles:
          persistedChangedFiles,

        inspectedFiles:
          persistedInspectedFiles,

        recentKnownErrors:
          knownErrors,

        previousValidation:
          {
            runStatus:
              validation.runStatus,

            stopReason:
              validation.stopReason,

            review:
              validation.review,

            adaptiveReasoning:
              validation.adaptiveReasoning,

            latestDelegationConsensus:
              validation.latestDelegationConsensus,
          },
      },
      null,
      2,
    ),
    '',
    'Continue execution now from the persisted state.',
  ].join('\n');

  return {
    threadId:
      options.threadId,

    objective,

    resumePrompt,

    reconciliationNodeIds,

    completedNodeIds:
      completedIds,

    pendingNodeIds:
      pending.map(
        (node) => node.id,
      ),

    blockedNodeIds:
      blockedIds,
  };
}

export async function markRunInterrupted(
  threadId: string,
  reason: string,
): Promise<void> {
  const state =
    await loadWorkingState(
      threadId,
    );

  if (!state) {
    return;
  }

  const validation =
    validationState(state);

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  await saveWorkingState({
    ...stateRecord,

    threadId,

    validationState: {
      ...validation,

      runStatus:
        'interrupted',

      interruptionReason:
        reason,

      interruptedAt:
        new Date()
          .toISOString(),
    },
  } as AgentWorkingState);
}
