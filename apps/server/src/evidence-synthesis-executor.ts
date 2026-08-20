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

interface EvidenceSynthesisOptions {
  threadId: string;
  parentObjective: string;
}

type ConsensusDecision =
  | 'ready'
  | 'changes_required'
  | 'mixed'
  | 'pending'
  | 'insufficient';

interface ChildEvidence {
  taskId: string;
  agentId?: string;
  status?: string;

  result: string;

  evidence: unknown[];

  errors: unknown[];

  weight: number;

  classification:
    | 'support'
    | 'block'
    | 'informational'
    | 'pending';

  reasons: string[];
}

const SYNTHESIS_SCHEMA = {
  type: 'object',

  properties: {
    taskIds: {
      type: 'array',
      minItems: 2,
      maxItems: 12,

      items: {
        type: 'string',
      },
    },

    decisionGoal: {
      type: 'string',

      description:
        'Optional narrow question the parent wants the child evidence to resolve.',
    },
  },

  required: [
    'taskIds',
  ],

  additionalProperties:
    false,
};

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
  schema: Record<string, unknown>,
): ToolSchema {
  const baseRecord =
    base as (ToolSchema & Record<string, unknown>) | undefined;

  const tool: Record<string, unknown> = {
    ...(baseRecord ?? {}),
    name,
    description,
  };

  if (
    base &&
    'inputSchema' in base
  ) {
    tool.inputSchema =
      schema;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    tool.parameters =
      schema;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    tool.schema =
      schema;
  }

  if (
    !('inputSchema' in tool) &&
    !('parameters' in tool) &&
    !('schema' in tool)
  ) {
    tool.inputSchema =
      schema;
  }

  return tool as unknown as ToolSchema;
}

function inferStatusIdKey(
  tool: unknown,
): string {
  const record =
    tool && typeof tool === 'object'
      ? (tool as Record<string, unknown>)
      : undefined;

  const schema =
    record?.inputSchema ??
    record?.parameters ??
    record?.schema;

  const schemaRecord =
    schema && typeof schema === 'object'
      ? (schema as Record<string, unknown>)
      : undefined;

  const propertiesValue =
    schemaRecord?.properties;

  const properties: Record<string, unknown> =
    propertiesValue && typeof propertiesValue === 'object'
      ? (propertiesValue as Record<string, unknown>)
      : {};

  for (
    const candidate
    of [
      'taskId',
      'id',
      'task_id',
    ]
  ) {
    if (
      candidate in
      properties
    ) {
      return candidate;
    }
  }

  return 'taskId';
}

function parseJsonOutput(
  output: string,
): unknown {
  const trimmed =
    output.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(
      trimmed,
    );
  } catch {
    /*
     * Some wrapper tools prepend routing information.
     * Recover the largest obvious JSON object when possible.
     */
    const start =
      trimmed.indexOf('{');

    const end =
      trimmed.lastIndexOf('}');

    if (
      start >= 0 &&
      end > start
    ) {
      try {
        return JSON.parse(
          trimmed.slice(
            start,
            end + 1,
          ),
        );
      } catch {
        return null;
      }
    }

    return null;
  }
}

function locateTask(
  value: unknown,
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !==
      'object'
  ) {
    return null;
  }

  const record =
    value as Record<string, unknown>;

  if (
    typeof record.status ===
      'string' ||
    typeof record.agentId ===
      'string' ||
    typeof record.agent_id ===
      'string' ||
    typeof record.result ===
      'string'
  ) {
    return record;
  }

  for (
    const key
    of [
      'task',
      'data',
      'result',
      'record',
    ]
  ) {
    if (
      record[key] &&
      typeof record[key] ===
        'object'
    ) {
      const candidate =
        locateTask(
          record[key],
        );

      if (candidate) {
        return candidate;
      }
    }
  }

  return record;
}

function workerWeight(
  agentId:
    string | undefined,
): number {
  switch (agentId) {
    case 'security-reviewer':
      return 6;

    case 'test-engineer':
      return 6;

    case 'reviewer':
      return 5;

    case 'ci-fixer':
      return 5;

    case 'debugger':
      return 4;

    case 'variant-hunter':
      return 3;

    case 'coder':
      return 2;

    case 'repo-explorer':
      return 2;

    default:
      return 1;
  }
}

function includesAny(
  text: string,
  patterns: RegExp[],
): boolean {
  return patterns.some(
    (pattern) =>
      pattern.test(text),
  );
}

function classify(
  child:
    Omit<
      ChildEvidence,
      'classification' |
      'reasons'
    >,
): Pick<
  ChildEvidence,
  'classification' |
  'reasons'
> {
  const status =
    (
      child.status ??
      ''
    ).toLowerCase();

  const text =
    child.result
      .toLowerCase();

  const reasons:
    string[] = [];

  if (
    status === 'queued' ||
    status === 'running'
  ) {
    return {
      classification:
        'pending',

      reasons: [
        `Child task is still ${status}.`,
      ],
    };
  }

  if (
    status === 'failed' ||
    status === 'cancelled'
  ) {
    return {
      classification:
        'block',

      reasons: [
        `Child task ended with status ${status}.`,
      ],
    };
  }

  /*
   * Explicit negative reviewer verdict.
   */
  if (
    /\bchanges_required\b/i
      .test(text) ||
    /\bchanges required\b/i
      .test(text)
  ) {
    reasons.push(
      'Reviewer explicitly requires changes.',
    );

    return {
      classification:
        'block',
      reasons,
    };
  }

  /*
   * Explicit validation failures are authoritative blockers.
   */
  if (
    child.agentId ===
      'test-engineer' &&
    includesAny(
      text,
      [
        /\btest(?:s)? failed\b/i,
        /\bfailed test/i,
        /\btypecheck failed\b/i,
        /\bdiagnostics? failed\b/i,
        /\bcompile failed\b/i,
        /\bvalidation failed\b/i,
        /\bbuild failed\b/i,
      ],
    )
  ) {
    reasons.push(
      'Test/validation specialist reported a failed check.',
    );

    return {
      classification:
        'block',
      reasons,
    };
  }

  /*
   * Security findings take precedence over normal votes.
   */
  if (
    child.agentId ===
      'security-reviewer' &&
    includesAny(
      text,
      [
        /\bcritical\b/i,
        /\bhigh severity\b/i,
        /\bblocking\b/i,
        /\bvulnerability\b/i,
        /\bauthorization bypass\b/i,
        /\bpermission bypass\b/i,
        /\bunsafe\b/i,
      ],
    ) &&
    !includesAny(
      text,
      [
        /\bno critical\b/i,
        /\bno high severity\b/i,
        /\bno vulnerabilities\b/i,
        /\bno blocking\b/i,
      ],
    )
  ) {
    reasons.push(
      'Security specialist reported a potentially blocking security issue.',
    );

    return {
      classification:
        'block',
      reasons,
    };
  }

  if (
    includesAny(
      text,
      [
        /\bapproved\b/i,
        /\btests? passed\b/i,
        /\bvalidation passed\b/i,
        /\btypecheck passed\b/i,
        /\bbuild passed\b/i,
        /\bno blocking issues\b/i,
        /\bno regressions\b/i,
        /\bverified\b/i,
      ],
    )
  ) {
    reasons.push(
      'Child returned explicit supporting/verification evidence.',
    );

    return {
      classification:
        'support',
      reasons,
    };
  }

  return {
    classification:
      'informational',

    reasons: [
      'Child completed but did not provide an explicit pass/block verdict.',
    ],
  };
}

function compact(
  text: string,
  limit = 1800,
): string {
  const value =
    text.trim();

  if (
    value.length <=
    limit
  ) {
    return value;
  }

  return (
    value.slice(
      0,
      limit,
    ) +
    '\n...[truncated]'
  );
}

function synthesize(
  children:
    ChildEvidence[],
): {
  decision:
    ConsensusDecision;

  weightedSupport:
    number;

  weightedBlock:
    number;

  confidence:
    number;

  blockers:
    ChildEvidence[];

  supporters:
    ChildEvidence[];

  informational:
    ChildEvidence[];

  pending:
    ChildEvidence[];

  summary:
    string;
} {
  const blockers =
    children.filter(
      (child) =>
        child.classification ===
        'block',
    );

  const supporters =
    children.filter(
      (child) =>
        child.classification ===
        'support',
    );

  const informational =
    children.filter(
      (child) =>
        child.classification ===
        'informational',
    );

  const pending =
    children.filter(
      (child) =>
        child.classification ===
        'pending',
    );

  const weightedSupport =
    supporters.reduce(
      (sum, child) =>
        sum + child.weight,
      0,
    );

  const weightedBlock =
    blockers.reduce(
      (sum, child) =>
        sum + child.weight,
      0,
    );

  let decision:
    ConsensusDecision;

  /*
   * Do not synthesize an affirmative answer while required
   * children are still executing.
   */
  if (
    pending.length > 0
  ) {
    decision =
      'pending';
  }
  /*
   * Security/test/reviewer blockers are not outvoted by
   * a larger number of generic workers.
   */
  else if (
    blockers.some(
      (child) =>
        child.agentId ===
          'security-reviewer' ||
        child.agentId ===
          'test-engineer' ||
        child.agentId ===
          'reviewer',
    )
  ) {
    decision =
      'changes_required';
  }
  else if (
    weightedBlock > 0 &&
    weightedSupport > 0
  ) {
    decision =
      'mixed';
  }
  else if (
    weightedBlock > 0
  ) {
    decision =
      'changes_required';
  }
  else if (
    weightedSupport > 0
  ) {
    decision =
      'ready';
  }
  else {
    decision =
      'insufficient';
  }

  const totalWeight =
    weightedSupport +
    weightedBlock +
    informational.reduce(
      (sum, child) =>
        sum + child.weight,
      0,
    );

  const confidence =
    totalWeight > 0
      ? Math.round(
          (
            Math.max(
              weightedSupport,
              weightedBlock,
            ) /
            totalWeight
          ) *
            100,
        )
      : 0;

  const summary =
    decision === 'ready'
      ? 'Completed specialist evidence supports proceeding, with no blocking specialist finding detected.'
      : decision ===
          'changes_required'
        ? 'At least one authoritative specialist reported a blocking issue. Correct it before parent completion.'
        : decision ===
            'mixed'
          ? 'Specialists disagree. Resolve the conflicting evidence before implementation or completion.'
          : decision ===
              'pending'
            ? 'One or more delegated tasks are still running or queued.'
            : 'Child tasks completed without enough explicit evidence to support or block the parent decision.';

  return {
    decision,
    weightedSupport,
    weightedBlock,
    confidence,
    blockers,
    supporters,
    informational,
    pending,
    summary,
  };
}

export class EvidenceSynthesisExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      EvidenceSynthesisOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    if (
      existing.some(
        (tool) =>
          tool.name ===
          'agent.delegate.synthesize',
      )
    ) {
      return existing;
    }

    const statusTool =
      existing.find(
        (tool) =>
          tool.name ===
          'agent.delegate.status',
      );

    if (!statusTool) {
      return existing;
    }

    return [
      ...existing,

      virtualTool(
        statusTool,
        'agent.delegate.synthesize',
        'Collect completed delegated child tasks and deterministically synthesize their evidence into one weighted parent decision. Security, test and independent-review blockers cannot be outvoted by generic workers.',
        SYNTHESIS_SCHEMA,
      ),
    ];
  }

  async execute(
    call:
      NormalizedToolCall,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name !==
      'agent.delegate.synthesize'
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const taskIds =
      Array.isArray(
        call.arguments
          ?.taskIds,
      )
        ? Array.from(
            new Set(
              call.arguments
                .taskIds
                .filter(
                  (
                    value,
                  ): value is string =>
                    typeof value ===
                      'string' &&
                    value.trim()
                      .length > 0,
                )
                .map(
                  (value) =>
                    value.trim(),
                ),
            ),
          ).slice(
            0,
            12,
          )
        : [];

    if (
      taskIds.length < 2
    ) {
      return {
        success: false,

        error:
          'insufficient-child-tasks',

        output:
          'agent.delegate.synthesize requires at least two delegated task IDs.',
      };
    }

    const statusTool =
      this.inner
        .listTools()
        .find(
          (tool) =>
            tool.name ===
            'agent.delegate.status',
        );

    if (!statusTool) {
      return {
        success: false,

        error:
          'delegate-status-unavailable',

        output:
          'agent.delegate.status is unavailable, so child evidence cannot be synthesized.',
      };
    }

    const idKey =
      inferStatusIdKey(
        statusTool,
      );

    const statuses =
      await Promise.allSettled(
        taskIds.map(
          (taskId) =>
            this.inner.execute(
              {
                name:
                  'agent.delegate.status',

                arguments: {
                  [idKey]:
                    taskId,
                },
              },
              signal,
            ),
        ),
      );

    const children:
      ChildEvidence[] = [];

    for (
      let index = 0;
      index <
      statuses.length;
      index += 1
    ) {
      const taskId =
        taskIds[index];

      const item =
        statuses[index];

      if (
        item.status ===
        'rejected'
      ) {
        children.push({
          taskId,

          result: '',

          evidence: [],

          errors: [
            item.reason instanceof
              Error
              ? item.reason
                  .message
              : String(
                  item.reason,
                ),
          ],

          weight: 1,

          classification:
            'block',

          reasons: [
            'Unable to retrieve delegated task status.',
          ],
        });

        continue;
      }

      if (
        !item.value.success
      ) {
        children.push({
          taskId,

          result:
            item.value.output ??
            '',

          evidence:
            item.value.evidence ??
            [],

          errors: [
            item.value.error ??
              'status retrieval failed',
          ],

          weight: 1,

          classification:
            'block',

          reasons: [
            'Delegated task status retrieval failed.',
          ],
        });

        continue;
      }

      const parsed =
        parseJsonOutput(
          item.value.output,
        );

      const task =
        locateTask(
          parsed,
        );

      const agentId =
        typeof task?.agentId ===
          'string'
          ? task.agentId
          : typeof task?.agent_id ===
              'string'
            ? task.agent_id
            : undefined;

      const status =
        typeof task?.status ===
          'string'
          ? task.status
          : undefined;

      const result =
        typeof task?.result ===
          'string'
          ? task.result
          : typeof task?.output ===
              'string'
            ? task.output
            : item.value.output;

      const evidence =
        Array.isArray(
          task?.evidence,
        )
          ? task.evidence
          : item.value.evidence ??
            [];

      const errors =
        Array.isArray(
          task?.errors,
        )
          ? task.errors
          : [];

      const base = {
        taskId,
        agentId,
        status,
        result,
        evidence,
        errors,
        weight:
          workerWeight(
            agentId,
          ),
      };

      const classified =
        classify(base);

      children.push({
        ...base,
        ...classified,
      });
    }

    const consensus =
      synthesize(
        children,
      );

    const decisionGoal =
      typeof call.arguments
        ?.decisionGoal ===
        'string'
        ? call.arguments
            .decisionGoal
            .trim()
        : '';

    const compactChildren =
      children.map(
        (child) => ({
          taskId:
            child.taskId,

          agentId:
            child.agentId,

          status:
            child.status,

          classification:
            child.classification,

          weight:
            child.weight,

          reasons:
            child.reasons,

          result:
            compact(
              child.result,
            ),

          evidenceCount:
            child.evidence
              .length,

          errorCount:
            child.errors
              .length,
        }),
      );

    const synthesisRecord = {
      kind:
        'delegated_evidence_consensus',

      decision:
        consensus.decision,

      decisionGoal:
        decisionGoal ||
        undefined,

      parentObjective:
        this.options
          .parentObjective,

      confidence:
        consensus.confidence,

      weightedSupport:
        consensus.weightedSupport,

      weightedBlock:
        consensus.weightedBlock,

      summary:
        consensus.summary,

      blockers:
        consensus.blockers
          .map(
            (child) => ({
              taskId:
                child.taskId,

              agentId:
                child.agentId,

              reasons:
                child.reasons,

              result:
                compact(
                  child.result,
                  1000,
                ),
            }),
          ),

      supporters:
        consensus.supporters
          .map(
            (child) => ({
              taskId:
                child.taskId,

              agentId:
                child.agentId,

              reasons:
                child.reasons,
            }),
          ),

      pending:
        consensus.pending
          .map(
            (child) => ({
              taskId:
                child.taskId,

              agentId:
                child.agentId,

              status:
                child.status,
            }),
          ),

      children:
        compactChildren,

      synthesizedAt:
        new Date()
          .toISOString(),
    };

    try {
      const state =
        await loadWorkingState(
          this.options.threadId,
        );

      if (state && typeof state === 'object') {
        const stateRecord =
          state as Record<string, unknown>;

        const validationStateValue =
          stateRecord.validationState ??
          stateRecord.validation_state;

        const validationState: Record<string, unknown> =
          validationStateValue && typeof validationStateValue === 'object'
            ? (validationStateValue as Record<string, unknown>)
            : {};

        const existing =
          Array.isArray(
            validationState
              .delegationConsensus,
          )
            ? validationState
                .delegationConsensus
            : [];

        await saveWorkingState({
          ...stateRecord,

          threadId:
            this.options.threadId,

          validationState: {
            ...validationState,

            delegationConsensus: [
              ...existing.slice(
                -9,
              ),

              synthesisRecord,
            ],

            latestDelegationConsensus:
              synthesisRecord,
          },
        } as AgentWorkingState);
      }
    } catch (error) {
      console.warn(
        'Unable to persist delegated evidence synthesis:',
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    return {
      /*
       * A mixed or changes-required consensus is still a
       * successful synthesis operation. "success" means the
       * synthesis executed, not that the patch is approved.
       */
      success: true,

      output:
        JSON.stringify(
          {
            ...synthesisRecord,

            instruction:
              consensus.decision ===
                'ready'
                ? 'Use this consensus as supporting evidence, but still satisfy the parent acceptance/completion gates.'
                : consensus.decision ===
                    'changes_required'
                  ? 'Do not declare TASK_COMPLETE. Correct the blocking findings, revalidate, and repeat review/synthesis where relevant.'
                  : consensus.decision ===
                      'mixed'
                    ? 'Do not choose a side by vote count. Resolve the contradictory evidence with targeted inspection or another specialist.'
                    : consensus.decision ===
                        'pending'
                      ? 'Wait for the outstanding delegated tasks before synthesizing a final decision.'
                      : 'Gather stronger explicit verification evidence before making the parent decision.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'delegated-consensus',

          summary:
            `Delegated evidence synthesis result: ${consensus.decision}.`,

          detail: {
            decision:
              consensus.decision,

            confidence:
              consensus.confidence,

            weightedSupport:
              consensus.weightedSupport,

            weightedBlock:
              consensus.weightedBlock,

            taskIds,
          },
        },
      ],
    };
  }
}
