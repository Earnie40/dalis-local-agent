import {
  createHash,
} from 'node:crypto';

import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

type RequirementStatus =
  | 'passed'
  | 'pending'
  | 'blocked'
  | 'warning'
  | 'not_applicable';

interface ManifestRequirement {
  id: string;
  label: string;
  status: RequirementStatus;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface CompletionManifest {
  kind: 'completion_manifest';

  id: string;
  threadId: string;
  objective: string;

  status:
    | 'complete'
    | 'incomplete'
    | 'blocked';

  completionEligible: boolean;

  changedFiles: string[];

  requirements:
    ManifestRequirement[];

  blockers: ManifestRequirement[];

  pending: ManifestRequirement[];

  warnings: ManifestRequirement[];

  evidenceSummary: {
    taskGraph?: unknown;
    validation?: unknown;
    review?: unknown;
    visual?: unknown;
    consensus?: unknown;
    risk?: unknown;
    transaction?: unknown;
    environment?: unknown;
    semanticIndex?: unknown;
  };

  generatedAt: string;
}

interface ManifestOptions {
  threadId: string;
  objective: string;
}

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const PASS =
  new Set([
    'pass',
    'passed',
    'approved',
    'approve',
    'complete',
    'completed',
    'ready',
    'satisfied',
    'success',
    'successful',
    'verified',
  ]);

const BLOCK =
  new Set([
    'block',
    'blocked',
    'failed',
    'failure',
    'rejected',
    'reject',
    'changes_required',
    'changes-required',
    'error',
  ]);

const PENDING =
  new Set([
    'pending',
    'running',
    'in_progress',
    'in-progress',
    'planned',
    'required',
    'incomplete',
    'mixed',
    'insufficient',
  ]);

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

function uniqueStrings(
  values: unknown[],
): string[] {
  return Array.from(
    new Set(
      values.filter(
        (
          value,
        ): value is string =>
          typeof value ===
            'string' &&
          value.trim().length >
            0,
      )
      .map(
        (value) =>
          value.trim(),
      ),
    ),
  );
}

function normalizedDecision(
  value: unknown,
): string | undefined {
  if (
    typeof value !==
    'string'
  ) {
    return undefined;
  }

  return value
    .trim()
    .toLowerCase()
    .replace(
      /\s+/g,
      '_',
    );
}

function classifyDecision(
  value: unknown,
):
  | 'passed'
  | 'pending'
  | 'blocked'
  | undefined {
  const decision =
    normalizedDecision(
      value,
    );

  if (!decision) {
    return undefined;
  }

  if (
    PASS.has(decision)
  ) {
    return 'passed';
  }

  if (
    BLOCK.has(decision)
  ) {
    return 'blocked';
  }

  if (
    PENDING.has(decision)
  ) {
    return 'pending';
  }

  return undefined;
}

function collectDecisions(
  value: unknown,
  depth = 0,
): Array<
  'passed' |
  'pending' |
  'blocked'
> {
  if (
    depth > 5 ||
    value == null
  ) {
    return [];
  }

  if (
    typeof value ===
      'string'
  ) {
    const result =
      classifyDecision(
        value,
      );

    return result
      ? [result]
      : [];
  }

  if (
    Array.isArray(value)
  ) {
    return value.flatMap(
      (item) =>
        collectDecisions(
          item,
          depth + 1,
        ),
    );
  }

  if (
    typeof value !==
      'object'
  ) {
    return [];
  }

  const record =
    value as
      Record<
        string,
        unknown
      >;

  const decisions:
    Array<
      'passed' |
      'pending' |
      'blocked'
    > = [];

  /*
   * Prefer semantic state fields rather than arbitrary strings
   * buried inside evidence text.
   */
  for (
    const key
    of [
      'verdict',
      'decision',
      'status',
      'outcome',
      'result',
      'state',
    ]
  ) {
    if (
      key in record
    ) {
      decisions.push(
        ...collectDecisions(
          record[key],
          depth + 1,
        ),
      );
    }
  }

  /*
   * Acceptance/checklist containers may hold criteria arrays.
   */
  for (
    const key
    of [
      'criteria',
      'requirements',
      'items',
      'checks',
      'gates',
    ]
  ) {
    if (
      key in record
    ) {
      decisions.push(
        ...collectDecisions(
          record[key],
          depth + 1,
        ),
      );
    }
  }

  return decisions;
}

function aggregateDecision(
  value: unknown,
):
  | 'passed'
  | 'pending'
  | 'blocked'
  | undefined {
  const decisions =
    collectDecisions(
      value,
    );

  if (
    decisions.includes(
      'blocked',
    )
  ) {
    return 'blocked';
  }

  if (
    decisions.includes(
      'pending',
    )
  ) {
    return 'pending';
  }

  if (
    decisions.includes(
      'passed',
    )
  ) {
    return 'passed';
  }

  return undefined;
}

function requirement(
  id: string,
  label: string,
  status:
    RequirementStatus,
  summary: string,
  detail?:
    Record<string, unknown>,
): ManifestRequirement {
  return {
    id,
    label,
    status,
    summary,
    detail,
  };
}

interface GraphNodeLike {
  id?: unknown;
  status?: unknown;
}

function graphRequirement(
  graph: unknown,
): ManifestRequirement {
  const graphNodes =
    graph && typeof graph === 'object'
      ? (graph as { nodes?: unknown }).nodes
      : undefined;

  if (
    !graph ||
    !Array.isArray(graphNodes)
  ) {
    return requirement(
      'task-graph',
      'Task graph',
      'not_applicable',
      'No dependency task graph was required for this run.',
    );
  }

  const nodes: GraphNodeLike[] =
    graphNodes;

  const blocked =
    nodes.filter(
      (node) =>
        node.status ===
        'blocked' ||
        node.status ===
        'failed',
    );

  const remaining =
    nodes.filter(
      (node) =>
        node.status !==
          'complete' &&
        node.status !==
          'completed',
    );

  if (
    blocked.length
  ) {
    return requirement(
      'task-graph',
      'Task graph',
      'blocked',
      `${blocked.length} task-graph node(s) are blocked.`,
      {
        blockedNodeIds:
          blocked.map(
            (node) =>
              node.id,
          ),
      },
    );
  }

  if (
    remaining.length
  ) {
    return requirement(
      'task-graph',
      'Task graph',
      'pending',
      `${remaining.length} task-graph node(s) remain incomplete.`,
      {
        remainingNodeIds:
          remaining.map(
            (node) =>
              node.id,
          ),
      },
    );
  }

  return requirement(
    'task-graph',
    'Task graph',
    'passed',
    `All ${nodes.length} task-graph node(s) are complete.`,
  );
}

interface GateLike {
  id?: unknown;
  status?: unknown;
}

function diffValidationRequirement(
  plan: unknown,
  changedFiles:
    string[],
): ManifestRequirement {
  if (
    !changedFiles.length
  ) {
    return requirement(
      'diff-validation',
      'Diff-aware validation',
      'not_applicable',
      'No current-run changed files require diff validation.',
    );
  }

  if (!plan || typeof plan !== 'object') {
    return requirement(
      'diff-validation',
      'Diff-aware validation',
      'pending',
      'Repository changes exist but no current diff-aware validation plan is available.',
    );
  }

  const planRecord =
    plan as { gates?: unknown; generation?: unknown };

  const gates: GateLike[] =
    Array.isArray(
      planRecord.gates,
    )
      ? planRecord.gates
      : [];

  const failed =
    gates.filter(
      (gate) =>
        gate.status ===
          'failed' ||
        gate.status ===
          'blocked',
    );

  const pending =
    gates.filter(
      (gate) =>
        gate.status !==
        'passed',
    );

  if (
    failed.length
  ) {
    return requirement(
      'diff-validation',
      'Diff-aware validation',
      'blocked',
      `${failed.length} required validation gate(s) failed.`,
      {
        gates:
          failed.map(
            (gate) => ({
              id:
                gate.id,

              status:
                gate.status,
            }),
          ),
      },
    );
  }

  if (
    pending.length
  ) {
    return requirement(
      'diff-validation',
      'Diff-aware validation',
      'pending',
      `${pending.length} required validation gate(s) remain.`,
      {
        gates:
          pending.map(
            (gate) => ({
              id:
                gate.id,

              status:
                gate.status,
            }),
          ),
      },
    );
  }

  return requirement(
    'diff-validation',
    'Diff-aware validation',
    'passed',
    `All ${gates.length} diff-derived validation gate(s) passed.`,
    {
      generation:
        planRecord.generation,
    },
  );
}

function reviewRequirement(
  validation: Record<string, unknown>,
  changedFiles:
    string[],
): ManifestRequirement {
  if (
    !changedFiles.length
  ) {
    return requirement(
      'final-review',
      'Final patch review',
      'not_applicable',
      'No current-run mutation requires final patch review.',
    );
  }

  const review =
    validation
      .latestFinalReview ??
    validation
      .finalReview ??
    validation
      .latestReview ??
    validation.review ??
    validation
      .reviewState;

  const decision =
    aggregateDecision(
      review,
    );

  if (
    decision ===
    'blocked'
  ) {
    return requirement(
      'final-review',
      'Final patch review',
      'blocked',
      'Final review contains a blocking or changes-required verdict.',
    );
  }

  if (
    decision ===
    'pending'
  ) {
    return requirement(
      'final-review',
      'Final patch review',
      'pending',
      'Final review has not reached an approved state.',
    );
  }

  if (
    decision ===
    'passed'
  ) {
    return requirement(
      'final-review',
      'Final patch review',
      'passed',
      'Final patch review is approved.',
    );
  }

  return requirement(
    'final-review',
    'Final patch review',
    'pending',
    'Repository changes exist but no approved final-review evidence was found.',
  );
}

interface VisualStateLike {
  required?: unknown;
  generation?: unknown;
  validatedGeneration?: unknown;
  status?: unknown;
}

function visualRequirement(
  visual: unknown,
): ManifestRequirement {
  const visualState =
    visual && typeof visual === 'object'
      ? (visual as VisualStateLike)
      : undefined;

  if (
    !visualState?.required
  ) {
    return requirement(
      'ui-visual',
      'Rendered UI validation',
      'not_applicable',
      'The current change set does not require rendered UI evidence.',
    );
  }

  const current =
    Number(
      visualState.generation ??
      0,
    );

  const validated =
    Number(
      visualState
        .validatedGeneration ??
      0,
    );

  if (
    visualState.status ===
      'blocked'
  ) {
    return requirement(
      'ui-visual',
      'Rendered UI validation',
      'blocked',
      'Rendered UI validation is blocked.',
      {
        generation:
          current,
      },
    );
  }

  if (
    visualState.status ===
      'changes_required'
  ) {
    return requirement(
      'ui-visual',
      'Rendered UI validation',
      'blocked',
      'Rendered vision evidence requires UI changes.',
      {
        generation:
          current,
      },
    );
  }

  if (
    visualState.status ===
      'passed' &&
    current ===
      validated
  ) {
    return requirement(
      'ui-visual',
      'Rendered UI validation',
      'passed',
      `UI generation ${current} has current vision-backed approval.`,
    );
  }

  return requirement(
    'ui-visual',
    'Rendered UI validation',
    'pending',
    `UI generation ${current} has not been visually approved.`,
    {
      generation:
        current,

      validatedGeneration:
        validated,

      status:
        visualState.status,
    },
  );
}

interface ChangeRiskLike {
  depth?: unknown;
}

interface ConsensusLike {
  decision?: unknown;
  status?: unknown;
}

function consensusRequirement(
  consensus: unknown,
  risk: unknown,
): ManifestRequirement {
  const riskState =
    risk && typeof risk === 'object'
      ? (risk as ChangeRiskLike)
      : undefined;

  if (
    riskState?.depth !==
    'deep'
  ) {
    return requirement(
      'deep-specialist-consensus',
      'Deep specialist consensus',
      'not_applicable',
      'Current change risk does not require deep specialist consensus.',
    );
  }

  if (!consensus || typeof consensus !== 'object') {
    return requirement(
      'deep-specialist-consensus',
      'Deep specialist consensus',
      'pending',
      'Deep-risk change lacks delegated specialist consensus.',
    );
  }

  const consensusState =
    consensus as ConsensusLike;

  const decision =
    normalizedDecision(
      consensusState.decision ??
      consensusState.status,
    );

  if (
    decision ===
      'ready' ||
    decision ===
      'approved' ||
    decision ===
      'passed'
  ) {
    return requirement(
      'deep-specialist-consensus',
      'Deep specialist consensus',
      'passed',
      'Deep-risk change has supporting delegated specialist consensus.',
    );
  }

  if (
    decision ===
      'changes_required'
  ) {
    return requirement(
      'deep-specialist-consensus',
      'Deep specialist consensus',
      'blocked',
      'Specialist consensus contains a blocking finding.',
    );
  }

  return requirement(
    'deep-specialist-consensus',
    'Deep specialist consensus',
    'pending',
    `Specialist consensus is not ready: ${decision ?? 'unknown'}.`,
  );
}

interface TransactionLike {
  id?: unknown;
  status?: unknown;
}

function transactionRequirement(
  transaction: unknown,
  changedFiles:
    string[],
): ManifestRequirement {
  if (
    !changedFiles.length
  ) {
    return requirement(
      'transaction',
      'Mutation transaction',
      'not_applicable',
      'No current-run mutation transaction is required.',
    );
  }

  if (!transaction || typeof transaction !== 'object') {
    return requirement(
      'transaction',
      'Mutation transaction',
      'passed',
      'No active rollback transaction remains.',
    );
  }

  const transactionState =
    transaction as TransactionLike;

  if (
    transactionState.status ===
      'rollback_failed'
  ) {
    return requirement(
      'transaction',
      'Mutation transaction',
      'blocked',
      'Mutation transaction is in rollback_failed state.',
      {
        transactionId:
          transactionState.id,
      },
    );
  }

  return requirement(
    'transaction',
    'Mutation transaction',
    'pending',
    `Mutation transaction ${transactionState.id} remains ${transactionState.status}.`,
    {
      transactionId:
        transactionState.id,

      status:
        transactionState.status,
    },
  );
}

interface EnvironmentIssueLike {
  resolvedAt?: unknown;
  recoverable?: unknown;
  attempts?: unknown;
  kind?: unknown;
  summary?: unknown;
}

function environmentRequirement(
  recovery: unknown,
): ManifestRequirement {
  const recoveryState =
    recovery && typeof recovery === 'object'
      ? (recovery as { latestIssue?: unknown })
      : undefined;

  const issue =
    recoveryState?.latestIssue &&
    typeof recoveryState.latestIssue === 'object'
      ? (recoveryState.latestIssue as EnvironmentIssueLike)
      : undefined;

  if (
    !issue ||
    issue.resolvedAt
  ) {
    return requirement(
      'environment',
      'Environment/dependencies',
      'passed',
      issue
        ? 'Latest classified environment issue was resolved.'
        : 'No unresolved environment/dependency blocker is recorded.',
    );
  }

  if (
    issue.recoverable &&
    Number(
      issue.attempts ??
      0,
    ) < 2
  ) {
    return requirement(
      'environment',
      'Environment/dependencies',
      'pending',
      `Recoverable environment issue remains: ${issue.kind}.`,
      {
        kind:
          issue.kind,

        attempts:
          issue.attempts,
      },
    );
  }

  return requirement(
    'environment',
    'Environment/dependencies',
    'blocked',
    `Unresolved environment blocker: ${issue.kind}.`,
    {
      kind:
        issue.kind,

      summary:
        issue.summary,

      attempts:
        issue.attempts,
    },
  );
}

function acceptanceRequirement(
  state: unknown,
  validation: Record<string, unknown>,
): ManifestRequirement {
  const stateAcceptance =
    state && typeof state === 'object'
      ? (state as { acceptanceCriteria?: unknown }).acceptanceCriteria
      : undefined;

  const acceptance =
    validation
      .acceptanceCriteria ??
    validation
      .acceptance ??
    validation
      .acceptanceState ??
    stateAcceptance;

  if (!acceptance) {
    return requirement(
      'acceptance',
      'Acceptance criteria',
      'not_applicable',
      'No separately persisted acceptance-criteria object is present; existing loop completion guards remain authoritative.',
    );
  }

  const decision =
    aggregateDecision(
      acceptance,
    );

  if (
    decision ===
      'blocked'
  ) {
    return requirement(
      'acceptance',
      'Acceptance criteria',
      'blocked',
      'One or more acceptance criteria are blocked or failed.',
    );
  }

  if (
    decision ===
      'pending'
  ) {
    return requirement(
      'acceptance',
      'Acceptance criteria',
      'pending',
      'One or more acceptance criteria remain incomplete.',
    );
  }

  if (
    decision ===
      'passed'
  ) {
    return requirement(
      'acceptance',
      'Acceptance criteria',
      'passed',
      'Persisted acceptance criteria are satisfied.',
    );
  }

  return requirement(
    'acceptance',
    'Acceptance criteria',
    'pending',
    'Acceptance criteria exist but no satisfied state can be established.',
  );
}

function replanRequirement(
  validation: Record<string, unknown>,
): ManifestRequirement {
  if (
    validation
      .replanRequired ===
      true
  ) {
    return requirement(
      'replan',
      'Replanning state',
      'pending',
      'A failure/review signal still requires surgical replanning.',
    );
  }

  return requirement(
    'replan',
    'Replanning state',
    'passed',
    'No unresolved replanning signal remains.',
  );
}

function reconciliationRequirement(
  validation: Record<string, unknown>,
  graph: unknown,
): ManifestRequirement {
  const ids: string[] =
    Array.isArray(
      validation
        .resumeReconciliationRequired,
    )
      ? validation
          .resumeReconciliationRequired
      : [];

  if (!ids.length) {
    return requirement(
      'resume-reconciliation',
      'Interrupted-run reconciliation',
      'not_applicable',
      'No interrupted nodes require reconciliation.',
    );
  }

  const graphNodes =
    graph && typeof graph === 'object'
      ? (graph as { nodes?: unknown }).nodes
      : undefined;

  const nodes: GraphNodeLike[] =
    Array.isArray(
      graphNodes,
    )
      ? graphNodes
      : [];

  const unresolved =
    ids.filter(
      (id: string) => {
        const node =
          nodes.find(
            (
              candidate,
            ) =>
              candidate.id ===
              id,
          );

        return (
          !node ||
          (
            node.status !==
              'complete' &&
            node.status !==
              'completed'
          )
        );
      },
    );

  if (
    unresolved.length
  ) {
    return requirement(
      'resume-reconciliation',
      'Interrupted-run reconciliation',
      'pending',
      `${unresolved.length} interrupted node(s) still require reconciliation.`,
      {
        nodeIds:
          unresolved,
      },
    );
  }

  return requirement(
    'resume-reconciliation',
    'Interrupted-run reconciliation',
    'passed',
    'All interrupted nodes were reconciled.',
  );
}

function semanticRequirement(
  semantic: unknown,
): ManifestRequirement {
  const semanticState =
    semantic && typeof semantic === 'object'
      ? (semantic as { status?: unknown })
      : undefined;

  if (
    semanticState?.status ===
      'stale'
  ) {
    return requirement(
      'semantic-index',
      'Semantic index freshness',
      'warning',
      'Semantic repository index is stale; direct source/Git evidence must remain authoritative.',
    );
  }

  return requirement(
    'semantic-index',
    'Semantic index freshness',
    'passed',
    'No stale semantic-index state is recorded.',
  );
}

function changedFilesFromState(
  state: unknown,
  validation: Record<string, unknown>,
): string[] {
  const diffValidationPlan =
    validation.diffValidationPlan &&
    typeof validation.diffValidationPlan === 'object'
      ? (validation.diffValidationPlan as { changedFiles?: unknown })
      : undefined;

  const planFiles: unknown[] =
    Array.isArray(
      diffValidationPlan
        ?.changedFiles,
    )
      ? diffValidationPlan.changedFiles
      : [];

  const stateRecord =
    state && typeof state === 'object'
      ? (state as { changedFiles?: unknown; changed_files?: unknown })
      : undefined;

  const trackerFiles: unknown[] =
    Array.isArray(
      stateRecord
        ?.changedFiles,
    )
      ? stateRecord.changedFiles
      : Array.isArray(
          stateRecord
            ?.changed_files,
        )
        ? stateRecord
            .changed_files
        : [];

  const activeTransaction =
    validation.activeTransaction &&
    typeof validation.activeTransaction === 'object'
      ? (validation.activeTransaction as { entries?: unknown })
      : undefined;

  const transactionFiles: unknown[] =
    Array.isArray(
      activeTransaction
        ?.entries,
    )
      ? activeTransaction.entries
          .map(
            (entry: unknown) =>
              entry && typeof entry === 'object'
                ? (entry as { path?: unknown }).path
                : undefined,
          )
      : [];

  return uniqueStrings([
    ...trackerFiles,
    ...planFiles,
    ...transactionFiles,
  ]);
}

export async function buildCompletionManifest(
  options:
    ManifestOptions,
): Promise<CompletionManifest> {
  const state =
    await loadWorkingState(
      options.threadId,
    );

  if (!state) {
    throw new Error(
      `Working state "${options.threadId}" does not exist.`,
    );
  }

  const validation =
    validationState(
      state,
    );

  const graph =
    validation
      .taskGraph;

  const changedFiles =
    changedFilesFromState(
      state,
      validation,
    );

  const requirements:
    ManifestRequirement[] = [
      graphRequirement(
        graph,
      ),

      diffValidationRequirement(
        validation
          .diffValidationPlan,

        changedFiles,
      ),

      reviewRequirement(
        validation,
        changedFiles,
      ),

      visualRequirement(
        validation
          .uiVisual,
      ),

      consensusRequirement(
        validation
          .latestDelegationConsensus,

        validation
          .changeRisk,
      ),

      transactionRequirement(
        validation
          .activeTransaction,

        changedFiles,
      ),

      environmentRequirement(
        validation
          .environmentRecovery,
      ),

      acceptanceRequirement(
        state,
        validation,
      ),

      replanRequirement(
        validation,
      ),

      reconciliationRequirement(
        validation,
        graph,
      ),

      semanticRequirement(
        validation
          .semanticIndex,
      ),
    ];

  const blockers =
    requirements.filter(
      (item) =>
        item.status ===
        'blocked',
    );

  const pending =
    requirements.filter(
      (item) =>
        item.status ===
        'pending',
    );

  const warnings =
    requirements.filter(
      (item) =>
        item.status ===
        'warning',
    );

  const completionEligible =
    blockers.length ===
      0 &&
    pending.length ===
      0;

  const status =
    blockers.length
      ? 'blocked'
      : pending.length
        ? 'incomplete'
        : 'complete';

  const fingerprint =
    createHash(
      'sha256',
    )
      .update(
        JSON.stringify({
          objective:
            options.objective,

          changedFiles,

          requirements:
            requirements.map(
              (item) => ({
                id:
                  item.id,

                status:
                  item.status,

                summary:
                  item.summary,
              }),
            ),
        }),
      )
      .digest('hex');

  const manifest:
    CompletionManifest = {
      kind:
        'completion_manifest',

      id:
        fingerprint.slice(
          0,
          24,
        ),

      threadId:
        options.threadId,

      objective:
        options.objective,

      status,

      completionEligible,

      changedFiles,

      requirements,

      blockers,

      pending,

      warnings,

      evidenceSummary: {
        taskGraph:
          graph,

        validation:
          validation
            .diffValidationPlan,

        review:
          validation
            .latestFinalReview ??
          validation
            .finalReview ??
          validation
            .latestReview ??
          validation.review,

        visual:
          validation
            .uiVisual,

        consensus:
          validation
            .latestDelegationConsensus,

        risk:
          validation
            .changeRisk,

        transaction:
          validation
            .activeTransaction,

        environment:
          validation
            .environmentRecovery,

        semanticIndex:
          validation
            .semanticIndex,
      },

      generatedAt:
        new Date()
          .toISOString(),
    };

  const history =
    Array.isArray(
      validation
        .completionManifestHistory,
    )
      ? validation
          .completionManifestHistory
      : [];

  const previous =
    validation.completionManifest &&
    typeof validation.completionManifest === 'object'
      ? (validation.completionManifest as { id?: unknown; status?: unknown })
      : undefined;

  const historyChanged =
    !previous ||
    previous.id !==
      manifest.id ||
    previous.status !==
      manifest.status;

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  await saveWorkingState({
    ...stateRecord,

    threadId:
      options.threadId,

    validationState: {
      ...validation,

      completionManifest:
        manifest,

      completionManifestHistory:
        historyChanged
          ? [
              ...history.slice(
                -19,
              ),

              manifest,
            ]
          : history,
    },
  } as AgentWorkingState);

  return manifest;
}

export async function completionManifestGuard(
  threadId: string,
  objective: string,
): Promise<{
  ok: boolean;
  message?: string;
}> {
  let manifest:
    CompletionManifest;

  try {
    manifest =
      await buildCompletionManifest({
        threadId,
        objective,
      });
  } catch (error) {
    return {
      ok: false,

      message: [
        'COMPLETION MANIFEST UNAVAILABLE:',
        error instanceof Error
          ? error.message
          : String(error),
        '',
        'Do not emit TASK_COMPLETE until durable completion state can be evaluated.',
      ].join('\n'),
    };
  }

  if (
    manifest
      .completionEligible
  ) {
    return {
      ok: true,
    };
  }

  return {
    ok: false,

    message: [
      'COMPLETION MANIFEST NOT READY:',
      `status: ${manifest.status}`,
      `manifest: ${manifest.id}`,
      '',
      ...manifest.blockers.map(
        (item) =>
          `BLOCKED ${item.id}: ${item.summary}`,
      ),
      ...manifest.pending.map(
        (item) =>
          `PENDING ${item.id}: ${item.summary}`,
      ),
      '',
      'Continue the original task and resolve these requirements.',
      'Do not emit TASK_COMPLETE yet.',
    ].join('\n'),
  };
}

export class CompletionManifestExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      ManifestOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const base =
      existing.find(
        (tool) =>
          tool.name ===
          'code.review.prepare',
      ) ??
      existing[0];

    if (!base) {
      return existing;
    }

    const additions:
      ToolSchema[] = [];

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.completion.manifest',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.completion.manifest',

          'Build and persist the unified completion evidence manifest from current DAG, validation, review, visual, risk, transaction, environment and recovery state.',
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.completion.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.completion.status',

          'Recalculate whether current durable evidence actually permits TASK_COMPLETE.',
        ),
      );
    }

    return [
      ...existing,
      ...additions,
    ];
  }

  async execute(
    call:
      NormalizedToolCall,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name ===
        'code.completion.manifest' ||
      call.name ===
        'code.completion.status'
    ) {
      try {
        const manifest =
          await buildCompletionManifest(
            this.options,
          );

        return {
          success: true,

          output:
            JSON.stringify(
              {
                ...manifest,

                nextAction:
                  manifest
                    .completionEligible
                    ? 'Current persisted evidence permits TASK_COMPLETE, subject to any lower-level loop guards that remain authoritative.'
                    : 'Resolve every pending/blocking manifest requirement before TASK_COMPLETE.',
              },
              null,
              2,
            ),

          evidence: [
            {
              kind:
                'completion-manifest',

              summary:
                manifest
                  .completionEligible
                  ? `Completion manifest ${manifest.id} is eligible.`
                  : `Completion manifest ${manifest.id} is ${manifest.status}.`,

              detail: {
                manifestId:
                  manifest.id,

                status:
                  manifest.status,

                completionEligible:
                  manifest
                    .completionEligible,

                blockers:
                  manifest
                    .blockers
                    .map(
                      (item) =>
                        item.id,
                    ),

                pending:
                  manifest
                    .pending
                    .map(
                      (item) =>
                        item.id,
                    ),
              },
            },
          ],
        };
      } catch (error) {
        return {
          success: false,

          error:
            'completion-manifest-build-failed',

          output:
            error instanceof Error
              ? error.message
              : String(error),
        };
      }
    }

    return this.inner.execute(
      call,
      signal,
    );
  }
}

/**
 * `base` may, at runtime, be a tool description shaped more loosely than the
 * declared `ToolSchema` type (some executors in this codebase duck-type
 * `parameters`/`schema` alongside or instead of `inputSchema`). This helper
 * copies whichever shape it was given, so it accepts/returns an open record.
 */
function virtualTool(
  base: ToolSchema | undefined,
  name: string,
  description: string,
): ToolSchema {
  // Cast to an open record locally: some executors elsewhere in this codebase
  // duck-type tools with `parameters`/`schema` fields the declared ToolSchema
  // type doesn't have, and this function must preserve/copy whichever shape
  // it was actually given at runtime.
  const baseRecord =
    base as (ToolSchema & Record<string, unknown>) | undefined;

  const result: Record<string, unknown> = {
    ...(baseRecord ?? {}),
    name,
    description,
  };

  if (
    base &&
    'inputSchema' in base
  ) {
    result.inputSchema =
      EMPTY_SCHEMA;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      EMPTY_SCHEMA;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      EMPTY_SCHEMA;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      EMPTY_SCHEMA;
  }

  // Invariant enforced above: result.inputSchema is always populated by one
  // of the branches (either copied from base or defaulted to EMPTY_SCHEMA).
  return result as unknown as ToolSchema;
}
