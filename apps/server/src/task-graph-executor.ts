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

type TaskNodeStatus =
  | 'pending'
  | 'in_progress'
  | 'complete'
  | 'blocked';

interface TaskGraphNode {
  id: string;
  objective: string;
  agentId: string;
  dependsOn: string[];
  status: TaskNodeStatus;
  mutation: boolean;
  evidence: string[];
  blocker?: string;
}

interface PersistedTaskGraph {
  kind: 'dependency_task_graph';
  objective: string;
  nodes: TaskGraphNode[];
  createdAt: string;
  updatedAt: string;
}

interface TaskGraphExecutorOptions {
  threadId: string;
  parentObjective: string;
}

const DECOMPOSE_SCHEMA = {
  type: 'object',

  properties: {
    nodes: {
      type: 'array',
      minItems: 2,
      maxItems: 20,

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

            description:
              'True when the node may modify repository state.',
          },
        },

        required: [
          'id',
          'objective',
        ],

        additionalProperties: false,
      },
    },
  },

  required: [
    'nodes',
  ],

  additionalProperties: false,
};

const STATUS_SCHEMA = {
  type: 'object',

  properties: {},

  additionalProperties: false,
};

const UPDATE_SCHEMA = {
  type: 'object',

  properties: {
    id: {
      type: 'string',
    },

    status: {
      type: 'string',

      enum: [
        'pending',
        'in_progress',
        'complete',
        'blocked',
      ],
    },

    evidence: {
      type: 'array',

      items: {
        type: 'string',
      },
    },

    blocker: {
      type: 'string',
    },
  },

  required: [
    'id',
    'status',
  ],

  additionalProperties: false,
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

  const result: Record<string, unknown> = {
    ...(baseRecord ?? {}),
    name,
    description,
  };

  if (
    base &&
    'inputSchema' in base
  ) {
    result.inputSchema = schema;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters = schema;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema = schema;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema = schema;
  }

  return result as unknown as ToolSchema;
}

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
          (
            item,
          ): item is string =>
            typeof item ===
              'string' &&
            item.trim().length >
              0,
        )
        .map(
          (item) =>
            item.trim(),
        ),
    ),
  );
}

function validateGraph(
  nodes: TaskGraphNode[],
): void {
  const ids =
    new Set(
      nodes.map(
        (node) =>
          node.id,
      ),
    );

  if (
    ids.size !==
    nodes.length
  ) {
    throw new Error(
      'Task graph contains duplicate node IDs.',
    );
  }

  for (const node of nodes) {
    if (
      node.dependsOn.includes(
        node.id,
      )
    ) {
      throw new Error(
        `Task "${node.id}" cannot depend on itself.`,
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
          `Task "${node.id}" depends on unknown node "${dependency}".`,
        );
      }
    }
  }

  /*
   * DFS cycle detection.
   */
  const visiting =
    new Set<string>();

  const visited =
    new Set<string>();

  const byId =
    new Map(
      nodes.map(
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
        `Task graph contains a dependency cycle involving "${id}".`,
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
      visit(dependency);
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (
    const node of nodes
  ) {
    visit(node.id);
  }

  /*
   * Avoid simultaneous mutation nodes that explicitly depend
   * on one another being advertised as parallel.
   */
}

function readyNodes(
  graph: PersistedTaskGraph,
): TaskGraphNode[] {
  const completed =
    new Set(
      graph.nodes
        .filter(
          (node) =>
            node.status ===
            'complete',
        )
        .map(
          (node) =>
            node.id,
        ),
    );

  return graph.nodes.filter(
    (node) =>
      node.status ===
        'pending' &&
      node.dependsOn.every(
        (dependency) =>
          completed.has(
            dependency,
          ),
      ),
  );
}

function blockedByDependency(
  graph: PersistedTaskGraph,
): Array<{
  id: string;
  blockedBy: string[];
}> {
  const blocked =
    new Set(
      graph.nodes
        .filter(
          (node) =>
            node.status ===
            'blocked',
        )
        .map(
          (node) =>
            node.id,
        ),
    );

  return graph.nodes
    .filter(
      (node) =>
        node.status ===
        'pending',
    )
    .map(
      (node) => ({
        id: node.id,

        blockedBy:
          node.dependsOn.filter(
            (dependency) =>
              blocked.has(
                dependency,
              ),
          ),
      }),
    )
    .filter(
      (entry) =>
        entry.blockedBy.length >
        0,
    );
}

function parallelGroups(
  ready:
    TaskGraphNode[],
): {
  readonly: TaskGraphNode[];
  mutations: TaskGraphNode[];
} {
  return {
    /*
     * Read-only specialist work is safe to fan out
     * aggressively.
     */
    readonly:
      ready.filter(
        (node) =>
          !node.mutation,
      ),

    /*
     * Mutation nodes remain individually visible.
     * The parent should not fan out overlapping writers.
     */
    mutations:
      ready.filter(
        (node) =>
          node.mutation,
      ),
  };
}

async function loadGraph(
  threadId: string,
): Promise<{
  state: unknown;
  graph:
    PersistedTaskGraph |
    undefined;
}> {
  const state =
    await loadWorkingState(
      threadId,
    );

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;

  const validationStateValue =
    stateRecord?.validationState ??
    stateRecord?.validation_state;

  const validationState =
    validationStateValue && typeof validationStateValue === 'object'
      ? (validationStateValue as Record<string, unknown>)
      : {};

  const graphValue = validationState.taskGraph;

  return {
    state,

    graph:
      graphValue && typeof graphValue === 'object'
        ? (graphValue as PersistedTaskGraph)
        : undefined,
  };
}

async function persistGraph(
  threadId: string,
  state: unknown,
  graph:
    PersistedTaskGraph,
): Promise<void> {
  if (!state || typeof state !== 'object') {
    throw new Error(
      `Working state "${threadId}" does not exist.`,
    );
  }

  const stateRecord =
    state as Record<string, unknown>;

  const validationStateValue =
    stateRecord.validationState ??
    stateRecord.validation_state;

  const validationState: Record<string, unknown> =
    validationStateValue && typeof validationStateValue === 'object'
      ? (validationStateValue as Record<string, unknown>)
      : {};

  const pending =
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
      );

  const completed =
    graph.nodes
      .filter(
        (node) =>
          node.status ===
          'complete',
      )
      .map(
        (node) =>
          node.objective,
      );

  await saveWorkingState({
    ...stateRecord,

    threadId,

    /*
     * Also project graph state onto the existing working-memory
     * plan fields rather than creating a competing plan model.
     */
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
      pending,

    completedSteps:
      completed,

    validationState: {
      ...validationState,
      taskGraph: graph,
    },
  } as AgentWorkingState);
}

export class TaskGraphExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      TaskGraphExecutorOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const base =
      existing.find(
        (tool) =>
          tool.name ===
          'agent.delegate',
      ) ??
      existing[0];

    if (!base) {
      return existing;
    }

    const additions: ToolSchema[] =
      [];

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'agent.plan.decompose',
      )
    ) {
      additions.push(
        virtualTool(
          base,
          'agent.plan.decompose',
          'Persist a dependency-aware execution DAG for a complex parent objective. The runtime validates node IDs, dependencies and cycles, and computes which nodes are ready for execution or fan-out.',
          DECOMPOSE_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'agent.plan.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,
          'agent.plan.status',
          'Read the current dependency-aware task graph, ready nodes, blocked dependencies and fan-out opportunities.',
          STATUS_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'agent.plan.update',
      )
    ) {
      additions.push(
        virtualTool(
          base,
          'agent.plan.update',
          'Update one task-graph node with pending, in_progress, complete or blocked status and attach concise execution evidence.',
          UPDATE_SCHEMA,
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
      'agent.plan.decompose'
    ) {
      return this.decompose(
        call,
      );
    }

    if (
      call.name ===
      'agent.plan.status'
    ) {
      return this.status();
    }

    if (
      call.name ===
      'agent.plan.update'
    ) {
      return this.update(
        call,
      );
    }

    return this.inner.execute(
      call,
      signal,
    );
  }

  private async decompose(
    call:
      NormalizedToolCall,
  ): Promise<LoopToolResult> {
    const rawNodes =
      Array.isArray(
        call.arguments
          ?.nodes,
      )
        ? call.arguments.nodes
        : [];

    if (
      rawNodes.length < 2
    ) {
      return {
        success: false,
        error:
          'invalid-task-graph',
        output:
          'A decomposed task graph requires at least two nodes.',
      };
    }

    const nodes:
      TaskGraphNode[] =
        rawNodes
          .slice(
            0,
            20,
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

              const id =
                normalizeId(
                  typeof raw?.id ===
                    'string'
                    ? raw.id
                    : `task-${index + 1}`,
                );

              const objective =
                typeof raw
                  ?.objective ===
                  'string'
                  ? raw.objective
                      .trim()
                  : '';

              if (
                !id ||
                !objective
              ) {
                throw new Error(
                  `Task graph node ${index + 1} requires a non-empty id and objective.`,
                );
              }

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

    try {
      validateGraph(
        nodes,
      );
    } catch (error) {
      return {
        success: false,

        error:
          'invalid-task-graph',

        output:
          error instanceof
            Error
            ? error.message
            : String(error),
      };
    }

    const {
      state,
    } =
      await loadGraph(
        this.options.threadId,
      );

    const now =
      new Date()
        .toISOString();

    const graph:
      PersistedTaskGraph = {
        kind:
          'dependency_task_graph',

        objective:
          this.options
            .parentObjective,

        nodes,

        createdAt:
          now,

        updatedAt:
          now,
      };

    await persistGraph(
      this.options.threadId,
      state,
      graph,
    );

    const ready =
      readyNodes(
        graph,
      );

    const groups =
      parallelGroups(
        ready,
      );

    return {
      success: true,

      output:
        JSON.stringify(
          {
            kind:
              'dependency_task_graph',

            nodeCount:
              nodes.length,

            ready:
              ready.map(
                (node) => ({
                  id:
                    node.id,
                  objective:
                    node.objective,
                  agentId:
                    node.agentId,
                  mutation:
                    node.mutation,
                }),
              ),

            fanoutEligible:
              groups.readonly.map(
                (node) => ({
                  id:
                    node.id,
                  objective:
                    node.objective,
                  agentId:
                    node.agentId,
                }),
              ),

            mutationReady:
              groups.mutations.map(
                (node) => ({
                  id:
                    node.id,
                  objective:
                    node.objective,
                  agentId:
                    node.agentId,
                }),
              ),

            instruction:
              'Execute only ready nodes. Independent read-only ready nodes may be sent through agent.delegate.fanout. Do not launch a node whose dependencies are incomplete. Avoid parallel mutation nodes that could overlap files or state.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'task-graph',

          summary:
            `Created dependency-aware task graph with ${nodes.length} nodes and ${ready.length} immediately ready node(s).`,

          detail: {
            nodes:
              nodes.length,

            ready:
              ready.map(
                (node) =>
                  node.id,
              ),
          },
        },
      ],
    };
  }

  private async status():
    Promise<LoopToolResult> {
    const {
      graph,
    } =
      await loadGraph(
        this.options.threadId,
      );

    if (!graph) {
      return {
        success: false,

        error:
          'task-graph-not-found',

        output:
          'No dependency-aware task graph exists for this run yet.',
      };
    }

    const ready =
      readyNodes(
        graph,
      );

    const groups =
      parallelGroups(
        ready,
      );

    const blocked =
      blockedByDependency(
        graph,
      );

    const complete =
      graph.nodes.filter(
        (node) =>
          node.status ===
          'complete',
      );

    const total =
      graph.nodes.length;

    return {
      success: true,

      output:
        JSON.stringify(
          {
            kind:
              'dependency_task_graph_status',

            objective:
              graph.objective,

            progress: {
              complete:
                complete.length,
              total,
              percent:
                total
                  ? Math.round(
                      (
                        complete.length /
                        total
                      ) *
                        100,
                    )
                  : 0,
            },

            nodes:
              graph.nodes,

            ready:
              ready,

            fanoutEligible:
              groups.readonly,

            mutationReady:
              groups.mutations,

            blockedByDependency:
              blocked,

            parentMayComplete:
              graph.nodes.every(
                (node) =>
                  node.status ===
                    'complete',
              ),
          },
          null,
          2,
        ),
    };
  }

  private async update(
    call:
      NormalizedToolCall,
  ): Promise<LoopToolResult> {
    const id =
      typeof call.arguments
        ?.id ===
        'string'
        ? normalizeId(
            call.arguments.id,
          )
        : '';

    const status =
      call.arguments
        ?.status;

    if (
      !id ||
      (
        status !==
          'pending' &&
        status !==
          'in_progress' &&
        status !==
          'complete' &&
        status !==
          'blocked'
      )
    ) {
      return {
        success: false,

        error:
          'invalid-task-update',

        output:
          'agent.plan.update requires a valid node id and status.',
      };
    }

    const {
      state,
      graph,
    } =
      await loadGraph(
        this.options.threadId,
      );

    if (!graph) {
      return {
        success: false,

        error:
          'task-graph-not-found',

        output:
          'No task graph exists for this run.',
      };
    }

    const node =
      graph.nodes.find(
        (candidate) =>
          candidate.id ===
          id,
      );

    if (!node) {
      return {
        success: false,

        error:
          'task-node-not-found',

        output:
          `Task graph node "${id}" was not found.`,
      };
    }

    /*
     * Hard dependency enforcement.
     */
    if (
      status ===
        'in_progress' ||
      status ===
        'complete'
    ) {
      const incomplete =
        node.dependsOn.filter(
          (dependency) => {
            const dependencyNode =
              graph.nodes.find(
                (candidate) =>
                  candidate.id ===
                  dependency,
              );

            return (
              dependencyNode
                ?.status !==
              'complete'
            );
          },
        );

      if (
        incomplete.length
      ) {
        return {
          success: false,

          error:
            'dependencies-incomplete',

          output:
            `Task "${id}" cannot become ${status} because dependencies are incomplete: ${incomplete.join(', ')}`,
        };
      }
    }

    node.status =
      status;

    node.evidence =
      Array.from(
        new Set([
          ...node.evidence,

          ...stringArray(
            call.arguments
              ?.evidence,
          ),
        ]),
      ).slice(
        -20,
      );

    node.blocker =
      status ===
        'blocked' &&
      typeof call.arguments
        ?.blocker ===
        'string'
        ? call.arguments
            .blocker
            .trim()
        : undefined;

    graph.updatedAt =
      new Date()
        .toISOString();

    await persistGraph(
      this.options.threadId,
      state,
      graph,
    );

    const ready =
      readyNodes(
        graph,
      );

    const groups =
      parallelGroups(
        ready,
      );

    return {
      success: true,

      output:
        JSON.stringify(
          {
            updated: {
              id:
                node.id,
              status:
                node.status,
              evidence:
                node.evidence,
              blocker:
                node.blocker,
            },

            nextReady:
              ready,

            fanoutEligible:
              groups.readonly,

            mutationReady:
              groups.mutations,

            complete:
              graph.nodes.every(
                (candidate) =>
                  candidate.status ===
                    'complete',
              ),
          },
          null,
          2,
        ),
    };
  }
}
