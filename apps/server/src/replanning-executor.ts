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

type NodeStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'blocked';

interface GraphNode {
  id: string;
  objective: string;
  agentId: string;
  dependsOn: string[];
  status: NodeStatus;
  mutation: boolean;
  evidence: string[];
  blocker?: string;
}

interface TaskGraph {
  kind: 'dependency_task_graph';
  objective: string;
  nodes: GraphNode[];
  createdAt: string;
  updatedAt: string;
}

interface ReplanningOptions {
  threadId: string;
  parentObjective: string;
}

interface ReplanSignal {
  kind:
    | 'tool_failure'
    | 'validation_failure'
    | 'review_rejection'
    | 'consensus_conflict';

  reason: string;
  severity: number;
}

const REPLAN_SCHEMA = {
  type: 'object',

  properties: {
    targetId: {
      type: 'string',
      description:
        'Existing non-complete graph node whose current strategy is invalid.',
    },

    reason: {
      type: 'string',
      description:
        'Concrete evidence explaining why this node needs a different strategy.',
    },

    replacementNodes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,

      items: {
        type: 'object',

        properties: {
          id: {
            type: 'string',
          },

          objective: {
            type: 'string',
          },

          agentId: {
            type: 'string',

            enum: [
              'auto',
              'repo-explorer',
              'debugger',
              'coder',
              'reviewer',
              'test-engineer',
              'security-reviewer',
              'variant-hunter',
              'ci-fixer',
            ],
          },

          dependsOn: {
            type: 'array',

            items: {
              type: 'string',
            },
          },

          mutation: {
            type: 'boolean',
          },
        },

        required: [
          'objective',
        ],

        additionalProperties:
          false,
      },
    },
  },

  required: [
    'targetId',
    'reason',
    'replacementNodes',
  ],

  additionalProperties:
    false,
};

function normalizeId(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase()
    .replace(
      /[^a-z0-9_-]+/g,
      '-',
    )
    .replace(
      /^-+|-+$/g,
      '',
    );
}

function stringArray(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' &&
            entry.trim().length > 0,
        )
        .map(
          (entry) =>
            entry.trim(),
        ),
    ),
  );
}

/**
 * `base` may, at runtime, be a tool description shaped more loosely than the
 * declared `ToolSchema` type (some executors in this codebase duck-type
 * `parameters`/`schema` alongside or instead of `inputSchema`). This helper
 * copies whichever shape it was given, so it accepts/returns an open record.
 */
function virtualTool(
  base: ToolSchema | undefined,
): ToolSchema {
  const baseRecord =
    base as (ToolSchema & Record<string, unknown>) | undefined;

  const result: Record<string, unknown> = {
    ...(baseRecord ?? {}),

    name:
      'agent.plan.replan',

    description:
      'Surgically replace one failed or disproven non-complete task-graph node while preserving verified completed work and rewiring downstream dependencies to the replacement branch.',
  };

  if (
    base &&
    'inputSchema' in base
  ) {
    result.inputSchema =
      REPLAN_SCHEMA;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      REPLAN_SCHEMA;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      REPLAN_SCHEMA;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      REPLAN_SCHEMA;
  }

  return result as unknown as ToolSchema;
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

/**
 * The persisted task graph is trusted application-owned state (this module
 * and task-graph-executor.ts are the only writers), so once we've confirmed
 * it is an object we treat it as a `TaskGraph` for the rest of this file.
 */
function graphFromState(
  state: unknown,
): TaskGraph | undefined {
  const value = validationState(
    state,
  ).taskGraph;

  return value && typeof value === 'object'
    ? (value as TaskGraph)
    : undefined;
}

function validateGraph(
  graph: TaskGraph,
): void {
  const ids =
    new Set(
      graph.nodes.map(
        (node) =>
          node.id,
      ),
    );

  if (
    ids.size !==
    graph.nodes.length
  ) {
    throw new Error(
      'Replanned graph contains duplicate IDs.',
    );
  }

  for (
    const node
    of graph.nodes
  ) {
    if (
      node.dependsOn.includes(
        node.id,
      )
    ) {
      throw new Error(
        `Node "${node.id}" depends on itself.`,
      );
    }

    for (
      const dependency
      of node.dependsOn
    ) {
      if (
        !ids.has(
          dependency,
        )
      ) {
        throw new Error(
          `Node "${node.id}" depends on unknown node "${dependency}".`,
        );
      }
    }
  }

  const visiting =
    new Set<string>();

  const visited =
    new Set<string>();

  const byId =
    new Map(
      graph.nodes.map(
        (node) => [
          node.id,
          node,
        ],
      ),
    );

  function visit(
    id: string,
  ): void {
    if (
      visited.has(id)
    ) {
      return;
    }

    if (
      visiting.has(id)
    ) {
      throw new Error(
        `Replanning created a dependency cycle involving "${id}".`,
      );
    }

    visiting.add(id);

    const node =
      byId.get(id);

    for (
      const dependency
      of node?.dependsOn ??
      []
    ) {
      visit(
        dependency,
      );
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (
    const node
    of graph.nodes
  ) {
    visit(node.id);
  }
}

async function persistGraph(
  state: unknown,
  threadId: string,
  graph: TaskGraph,
  replanRecord:
    Record<string, unknown>,
): Promise<void> {
  const validation =
    validationState(
      state,
    );

  const history =
    Array.isArray(
      validation.replanHistory,
    )
      ? validation.replanHistory
      : [];

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  await saveWorkingState({
    ...stateRecord,

    threadId,

    plan:
      graph.nodes.map(
        (node) => ({
          id: node.id,
          objective:
            node.objective,
          status:
            node.status,
          dependsOn:
            node.dependsOn,
          agentId:
            node.agentId,
        }),
      ),

    pendingSteps:
      graph.nodes
        .filter(
          (node) =>
            node.status ===
              'pending' ||
            node.status ===
              'in_progress',
        )
        .map(
          (node) =>
            node.objective,
        ),

    completedSteps:
      graph.nodes
        .filter(
          (node) =>
            node.status ===
              'complete',
        )
        .map(
          (node) =>
            node.objective,
        ),

    validationState: {
      ...validation,

      taskGraph:
        graph,

      replanRequired:
        false,

      latestReplan:
        replanRecord,

      replanHistory: [
        ...history.slice(
          -19,
        ),

        replanRecord,
      ],
    },
  } as AgentWorkingState);
}

function detectSignal(
  call: NormalizedToolCall,
  result: LoopToolResult,
): ReplanSignal | undefined {
  /*
   * Permission denials remain permission problems.
   * Replanning must never become a permission-bypass mechanism.
   */
  if (result.denied) {
    return undefined;
  }

  if (
    call.name ===
      'tests.run' &&
    !result.success
  ) {
    return {
      kind:
        'validation_failure',

      reason:
        'tests.run failed and invalidated the current execution strategy.',

      severity: 3,
    };
  }

  if (
    call.name ===
      'code.diagnostics' &&
    !result.success
  ) {
    return {
      kind:
        'validation_failure',

      reason:
        'code.diagnostics failed and invalidated the current implementation assumption.',

      severity: 3,
    };
  }

  if (
    call.name ===
      'code.review.record' &&
    call.arguments
      ?.verdict ===
      'changes_required'
  ) {
    return {
      kind:
        'review_rejection',

      reason:
        'Independent patch review returned changes_required.',

      severity: 4,
    };
  }

  if (
    call.name ===
      'agent.delegate.synthesize'
  ) {
    const output =
      result.output ??
      '';

    if (
      /"decision"\s*:\s*"changes_required"/i
        .test(output)
    ) {
      return {
        kind:
          'review_rejection',

        reason:
          'Delegated evidence consensus contains a blocking specialist finding.',

        severity: 4,
      };
    }

    if (
      /"decision"\s*:\s*"mixed"/i
        .test(output)
    ) {
      return {
        kind:
          'consensus_conflict',

        reason:
          'Delegated specialist evidence is contradictory and the current branch requires reassessment.',

        severity: 3,
      };
    }
  }

  if (
    !result.success &&
    !call.name.startsWith(
      'agent.plan.',
    )
  ) {
    return {
      kind:
        'tool_failure',

      reason:
        `${call.name} failed; retrying the same branch unchanged is not justified.`,

      severity: 2,
    };
  }

  return undefined;
}

export class ReplanningExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      ReplanningOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    if (
      existing.some(
        (tool) =>
          tool.name ===
          'agent.plan.replan',
      )
    ) {
      return existing;
    }

    const base =
      existing.find(
        (tool) =>
          tool.name ===
          'agent.plan.update',
      ) ??
      existing.find(
        (tool) =>
          tool.name ===
          'agent.delegate',
      );

    if (!base) {
      return existing;
    }

    return [
      ...existing,
      virtualTool(base),
    ];
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name ===
      'agent.plan.replan'
    ) {
      return this.replan(
        call,
      );
    }

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    const signalRecord =
      detectSignal(
        call,
        result,
      );

    if (!signalRecord) {
      return result;
    }

    let state: unknown;

    try {
      state =
        await loadWorkingState(
          this.options.threadId,
        );
    } catch {
      return result;
    }

    if (!state) {
      return result;
    }

    const graph =
      graphFromState(
        state,
      );

    if (!graph) {
      return result;
    }

    const activeNodes =
      graph.nodes.filter(
        (node) =>
          node.status ===
          'in_progress',
      );

    const validation =
      validationState(
        state,
      );

    const signals =
      Array.isArray(
        validation.replanSignals,
      )
        ? validation.replanSignals
        : [];

    const persistedSignal = {
      ...signalRecord,

      tool:
        call.name,

      activeNodeIds:
        activeNodes.map(
          (node) =>
            node.id,
        ),

      observedAt:
        new Date()
          .toISOString(),
    };

    try {
      await saveWorkingState({
        ...(state as Record<string, unknown>),

        threadId:
          this.options.threadId,

        validationState: {
          ...validation,

          replanRequired:
            true,

          latestReplanSignal:
            persistedSignal,

          replanSignals: [
            ...signals.slice(
              -19,
            ),

            persistedSignal,
          ],
        },
      } as AgentWorkingState);
    } catch {
      return result;
    }

    const activeText =
      activeNodes.length
        ? activeNodes
            .map(
              (node) =>
                node.id,
            )
            .join(', ')
        : 'none explicitly marked in_progress';

    return {
      ...result,

      output: [
        result.output ?? '',
        '',
        'AUTONOMOUS_REPLAN_SIGNAL',
        `kind: ${signalRecord.kind}`,
        `reason: ${signalRecord.reason}`,
        `severity: ${signalRecord.severity}`,
        `active graph node(s): ${activeText}`,
        '',
        'Do not blindly repeat the failed strategy.',
        activeNodes.length === 1
          ? `Reassess node "${activeNodes[0].id}". If its strategy is invalid, call agent.plan.replan and replace only that node with an evidence-backed alternative branch.`
          : 'Use agent.plan.status to identify the affected branch before replanning.',
        'Preserve completed verified nodes.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  private async replan(
    call: NormalizedToolCall,
  ): Promise<LoopToolResult> {
    const targetId =
      typeof call.arguments
        ?.targetId ===
        'string'
        ? normalizeId(
            call.arguments
              .targetId,
          )
        : '';

    const reason =
      typeof call.arguments
        ?.reason ===
        'string'
        ? call.arguments
            .reason
            .trim()
        : '';

    const rawReplacements =
      Array.isArray(
        call.arguments
          ?.replacementNodes,
      )
        ? call.arguments
            .replacementNodes
        : [];

    if (
      !targetId ||
      !reason ||
      !rawReplacements.length
    ) {
      return {
        success: false,

        error:
          'invalid-replan',

        output:
          'agent.plan.replan requires targetId, reason and at least one replacement node.',
      };
    }

    const state =
      await loadWorkingState(
        this.options.threadId,
      );

    const graph =
      graphFromState(
        state,
      );

    if (
      !state ||
      !graph
    ) {
      return {
        success: false,

        error:
          'task-graph-not-found',

        output:
          'No dependency-aware task graph exists for this run.',
      };
    }

    const target =
      graph.nodes.find(
        (node) =>
          node.id ===
          targetId,
      );

    if (!target) {
      return {
        success: false,

        error:
          'task-node-not-found',

        output:
          `Task graph node "${targetId}" was not found.`,
      };
    }

    /*
     * Verified completed work is immutable.
     */
    if (
      target.status ===
      'complete'
    ) {
      return {
        success: false,

        error:
          'completed-node-immutable',

        output:
          `Task "${targetId}" is already complete and cannot be replaced by autonomous replanning. Create a new corrective node instead.`,
      };
    }

    /*
     * A completed dependent of an incomplete target indicates
     * inconsistent state. Refuse to silently rewrite it.
     */
    const completedDependents =
      graph.nodes.filter(
        (node) =>
          node.status ===
            'complete' &&
          node.dependsOn.includes(
            targetId,
          ),
      );

    if (
      completedDependents.length
    ) {
      return {
        success: false,

        error:
          'verified-dependent-conflict',

        output:
          `Cannot replace "${targetId}" because completed verified node(s) depend directly on it: ${completedDependents.map((node) => node.id).join(', ')}`,
      };
    }

    const validation =
      validationState(
        state,
      );

    const priorHistory =
      Array.isArray(
        validation.replanHistory,
      )
        ? validation.replanHistory
        : [];

    const revision =
      priorHistory.length +
      1;

    const existingIds =
      new Set(
        graph.nodes
          .filter(
            (node) =>
              node.id !==
              targetId,
          )
          .map(
            (node) =>
              node.id,
          ),
      );

    const replacements:
      GraphNode[] =
        rawReplacements
          .slice(
            0,
            8,
          )
          .map(
            (
              rawValue: unknown,
              index,
            ) => {
              const raw =
                rawValue && typeof rawValue === 'object'
                  ? (rawValue as Record<string, unknown>)
                  : undefined;

              const objective =
                typeof raw
                  ?.objective ===
                  'string'
                  ? raw.objective
                      .trim()
                  : '';

              if (!objective) {
                throw new Error(
                  `Replacement node ${index + 1} has no objective.`,
                );
              }

              const requestedId =
                typeof raw?.id ===
                  'string'
                  ? normalizeId(
                      raw.id,
                    )
                  : '';

              const id =
                requestedId ||
                `${targetId}-r${revision}-${index + 1}`;

              if (
                !id ||
                existingIds.has(
                  id,
                )
              ) {
                throw new Error(
                  `Replacement node ID "${id}" conflicts with an existing graph node.`,
                );
              }

              existingIds.add(id);

              return {
                id,

                objective,

                agentId:
                  typeof raw
                    ?.agentId ===
                    'string'
                    ? raw.agentId
                    : 'auto',

                dependsOn:
                  stringArray(
                    raw?.dependsOn,
                  ).map(
                    normalizeId,
                  ),

                status:
                  'pending',

                mutation:
                  raw?.mutation ===
                  true,

                evidence: [],
              };
            },
          );

    const replacementIds =
      new Set(
        replacements.map(
          (node) =>
            node.id,
        ),
      );

    /*
     * Root replacement nodes inherit the original prerequisites.
     *
     * A replacement may explicitly depend on another replacement
     * to create a small internal branch.
     */
    for (
      const replacement
      of replacements
    ) {
      if (
        replacement.dependsOn
          .length === 0
      ) {
        replacement.dependsOn = [
          ...target.dependsOn,
        ];
      }

      if (
        replacement.dependsOn
          .includes(
            targetId,
          )
      ) {
        return {
          success: false,

          error:
            'replan-depends-on-removed-node',

          output:
            `Replacement "${replacement.id}" cannot depend on removed node "${targetId}".`,
        };
      }
    }

    /*
     * Terminal replacement nodes are the outputs of the new branch.
     * Existing direct dependents of the failed target are rewired
     * to those outputs.
     */
    const referencedReplacementIds =
      new Set(
        replacements.flatMap(
          (node) =>
            node.dependsOn.filter(
              (dependency) =>
                replacementIds.has(
                  dependency,
                ),
            ),
        ),
      );

    const terminalReplacementIds =
      replacements
        .filter(
          (node) =>
            !referencedReplacementIds
              .has(
                node.id,
              ),
        )
        .map(
          (node) =>
            node.id,
        );

    if (
      !terminalReplacementIds
        .length
    ) {
      return {
        success: false,

        error:
          'replan-no-terminal-node',

        output:
          'Replacement branch has no terminal node.',
      };
    }

    const rewiredDependents:
      string[] = [];

    const preservedNodes =
      graph.nodes
        .filter(
          (node) =>
            node.id !==
            targetId,
        )
        .map(
          (node) => {
            if (
              !node.dependsOn
                .includes(
                  targetId,
                )
            ) {
              return {
                ...node,
                dependsOn: [
                  ...node.dependsOn,
                ],
                evidence: [
                  ...node.evidence,
                ],
              };
            }

            rewiredDependents.push(
              node.id,
            );

            return {
              ...node,

              dependsOn:
                Array.from(
                  new Set(
                    node.dependsOn.flatMap(
                      (dependency) =>
                        dependency ===
                          targetId
                          ? terminalReplacementIds
                          : [
                              dependency,
                            ],
                    ),
                  ),
                ),

              evidence: [
                ...node.evidence,
              ],
            };
          },
        );

    /*
     * Insert the replacement branch where the old node appeared
     * so graph inspection remains human-readable.
     */
    const originalIndex =
      graph.nodes.findIndex(
        (node) =>
          node.id ===
          targetId,
      );

    const before =
      preservedNodes.slice(
        0,
        originalIndex,
      );

    const after =
      preservedNodes.slice(
        originalIndex,
      );

    const nextGraph:
      TaskGraph = {
        ...graph,

        nodes: [
          ...before,
          ...replacements,
          ...after,
        ],

        updatedAt:
          new Date()
            .toISOString(),
      };

    try {
      validateGraph(
        nextGraph,
      );
    } catch (error) {
      return {
        success: false,

        error:
          'invalid-replanned-graph',

        output:
          error instanceof
            Error
            ? error.message
            : String(error),
      };
    }

    const replanRecord = {
      revision,

      targetId,

      replacedNode: {
        id:
          target.id,

        objective:
          target.objective,

        status:
          target.status,

        dependsOn:
          target.dependsOn,

        evidence:
          target.evidence,

        blocker:
          target.blocker,
      },

      reason,

      replacementIds:
        replacements.map(
          (node) =>
            node.id,
        ),

      terminalReplacementIds,

      rewiredDependents,

      preservedCompletedIds:
        nextGraph.nodes
          .filter(
            (node) =>
              node.status ===
              'complete',
          )
          .map(
            (node) =>
              node.id,
          ),

      replannedAt:
        new Date()
          .toISOString(),
    };

    await persistGraph(
      state,
      this.options.threadId,
      nextGraph,
      replanRecord,
    );

    return {
      success: true,

      output:
        JSON.stringify(
          {
            kind:
              'surgical_task_replan',

            ...replanRecord,

            nextAction:
              'Call agent.plan.status and execute only nodes that are now ready. Do not retry the removed strategy.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'task-replan',

          summary:
            `Replaced failed graph node "${targetId}" with ${replacements.length} replacement node(s) while preserving completed work.`,

          detail: {
            targetId,

            replacementIds:
              replacements.map(
                (node) =>
                  node.id,
              ),

            rewiredDependents,
          },
        },
      ],
    };
  }
}
