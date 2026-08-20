import { createId } from '@dacai-local-agent/shared';

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

interface FanoutDelegationOptions {
  threadId: string;
  parentObjective: string;
}

interface FanoutTask {
  objective: string;
  agentId?: string;
}

interface LaunchRecord {
  index: number;
  objective: string;
  requestedAgentId: string;
  success: boolean;
  taskId?: string;
  output: string;
  error?: string;
}

const FANOUT_SCHEMA = {
  type: 'object',

  properties: {
    tasks: {
      type: 'array',
      minItems: 2,
      maxItems: 6,

      description:
        'Independent bounded subproblems that can be delegated without one requiring another task result first.',

      items: {
        type: 'object',

        properties: {
          objective: {
            type: 'string',
            description:
              'Exact bounded objective for this child task.',
          },

          agentId: {
            type: 'string',

            description:
              'Specialist to use, or auto for dynamic routing.',

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
    'tasks',
  ],

  additionalProperties:
    false,
};

const FANOUT_STATUS_SCHEMA = {
  type: 'object',

  properties: {
    taskIds: {
      type: 'array',
      minItems: 1,
      maxItems: 12,

      items: {
        type: 'string',
      },

      description:
        'Delegated task IDs returned by agent.delegate.fanout.',
    },
  },

  required: [
    'taskIds',
  ],

  additionalProperties:
    false,
};

/**
 * `delegateTool` may, at runtime, be a tool description shaped more loosely
 * than the declared `ToolSchema` type (some executors in this codebase
 * duck-type `parameters`/`schema` alongside or instead of `inputSchema`).
 * This helper copies whichever shape it was given, so it accepts/returns an
 * open record.
 */
function virtualTool(
  delegateTool: ToolSchema | undefined,
  name: string,
  description: string,
  schema: Record<string, unknown>,
): ToolSchema {
  const delegateRecord =
    delegateTool as (ToolSchema & Record<string, unknown>) | undefined;

  const result: Record<string, unknown> = {
    ...(delegateRecord ?? {}),

    name,
    description,
  };

  /*
   * ToolSchema adapters in the repository have used more than
   * one JSON-schema property name over time. Preserve whichever
   * representation the underlying delegate tool currently uses.
   */
  if (
    delegateTool &&
    'inputSchema' in
      delegateTool
  ) {
    result.inputSchema =
      schema;
  }

  if (
    delegateRecord &&
    'parameters' in
      delegateRecord
  ) {
    result.parameters =
      schema;
  }

  if (
    delegateRecord &&
    'schema' in
      delegateRecord
  ) {
    result.schema =
      schema;
  }

  /*
   * Fallback for current normalized ToolSchema adapters.
   */
  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      schema;
  }

  return result as unknown as ToolSchema;
}

function extractTaskId(
  output: string,
): string | undefined {
  const trimmed =
    output.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    const value =
      JSON.parse(trimmed);

    const candidates = [
      value?.taskId,
      value?.id,
      value?.task?.id,
      value?.task?.taskId,
      value?.result?.taskId,
      value?.result?.id,
    ];

    for (
      const candidate
      of candidates
    ) {
      if (
        typeof candidate ===
          'string' &&
        candidate.trim()
      ) {
        return candidate.trim();
      }
    }
  } catch {
    // Some tools return human-readable output.
  }

  const match =
    trimmed.match(
      /\b(?:taskId|task_id|task id|id)["':=\s]+(task_[A-Za-z0-9_-]+|[A-Za-z0-9_-]{8,})/i,
    );

  return match?.[1];
}

function inferStatusIdKey(
  statusTool: unknown,
): string {
  const record =
    statusTool && typeof statusTool === 'object'
      ? (statusTool as Record<string, unknown>)
      : undefined;

  const schemaValue =
    record?.inputSchema ??
    record?.parameters ??
    record?.schema;

  const schema =
    schemaValue && typeof schemaValue === 'object'
      ? (schemaValue as Record<string, unknown>)
      : undefined;

  const propertiesValue =
    schema?.properties;

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

function normalizeTask(
  value: unknown,
): FanoutTask | undefined {
  if (
    !value ||
    typeof value !==
      'object'
  ) {
    return undefined;
  }

  const item =
    value as Record<
      string,
      unknown
    >;

  if (
    typeof item.objective !==
      'string' ||
    !item.objective.trim()
  ) {
    return undefined;
  }

  return {
    objective:
      item.objective.trim(),

    agentId:
      typeof item.agentId ===
        'string' &&
      item.agentId.trim()
        ? item.agentId.trim()
        : 'auto',
  };
}

export class FanoutDelegationExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      FanoutDelegationOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const delegateTool =
      existing.find(
        (tool) =>
          tool.name ===
          'agent.delegate',
      );

    if (!delegateTool) {
      return existing;
    }

    const statusTool =
      existing.find(
        (tool) =>
          tool.name ===
          'agent.delegate.status',
      );

    const tools: ToolSchema[] = [
      ...existing,
    ];

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'agent.delegate.fanout',
      )
    ) {
      tools.push(
        virtualTool(
          delegateTool,
          'agent.delegate.fanout',
          'Launch several independent delegated specialist tasks together. Use only when the subproblems can be worked independently. Existing TaskRunner worker limits remain authoritative.',
          FANOUT_SCHEMA,
        ),
      );
    }

    if (
      statusTool &&
      !existing.some(
        (tool) =>
          tool.name ===
          'agent.delegate.fanout.status',
      )
    ) {
      tools.push(
        virtualTool(
          statusTool,
          'agent.delegate.fanout.status',
          'Retrieve the current status and results of a group of delegated task IDs.',
          FANOUT_STATUS_SCHEMA,
        ),
      );
    }

    return tools;
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name ===
      'agent.delegate.fanout'
    ) {
      return this.executeFanout(
        call,
        signal,
      );
    }

    if (
      call.name ===
      'agent.delegate.fanout.status'
    ) {
      return this.executeFanoutStatus(
        call,
        signal,
      );
    }

    return this.inner.execute(
      call,
      signal,
    );
  }

  private async executeFanout(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const rawTasks =
      Array.isArray(
        call.arguments?.tasks,
      )
        ? call.arguments.tasks
        : [];

    const tasks =
      rawTasks
        .map(normalizeTask)
        .filter(
          (
            task,
          ): task is FanoutTask =>
            Boolean(task),
        )
        .slice(0, 6);

    if (
      tasks.length < 2
    ) {
      return {
        success: false,

        error:
          'invalid-fanout',

        output:
          'agent.delegate.fanout requires at least two valid independent tasks.',
      };
    }

    const groupId =
      createId(
        'fanout',
      );

    /*
     * Promise.allSettled starts each ordinary delegation through
     * the existing executor stack. It does NOT bypass TaskRunner.
     *
     * SpecialistRoutingExecutor still resolves agentId=auto.
     * DelegationPacketExecutor still compacts context.
     * TaskRunner still owns maxLocalWorkers and queuing.
     */
    const settled =
      await Promise.allSettled(
        tasks.map(
          (
            task,
            index,
          ) =>
            this.inner.execute(
              {
                name:
                  'agent.delegate',

                arguments: {
                  objective:
                    task.objective,

                  agentId:
                    task.agentId ??
                    'auto',

                  fanoutGroupId:
                    groupId,

                  fanoutIndex:
                    index,
                },
              },
              signal,
            ),
        ),
      );

    const launches:
      LaunchRecord[] =
        settled.map(
          (
            item,
            index,
          ) => {
            const task =
              tasks[index];

            if (
              item.status ===
              'rejected'
            ) {
              return {
                index,

                objective:
                  task.objective,

                requestedAgentId:
                  task.agentId ??
                  'auto',

                success:
                  false,

                output:
                  '',

                error:
                  item.reason instanceof
                    Error
                    ? item.reason
                        .message
                    : String(
                        item.reason,
                      ),
              };
            }

            return {
              index,

              objective:
                task.objective,

              requestedAgentId:
                task.agentId ??
                'auto',

              success:
                item.value
                  .success,

              taskId:
                extractTaskId(
                  item.value
                    .output,
                ),

              output:
                item.value
                  .output,

              error:
                item.value
                  .error,
            };
          },
        );

    const taskIds =
      launches
        .map(
          (launch) =>
            launch.taskId,
        )
        .filter(
          (
            value,
          ): value is string =>
            Boolean(value),
        );

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
              .delegationFanouts,
          )
            ? validationState
                .delegationFanouts
            : [];

        await saveWorkingState({
          ...stateRecord,

          threadId:
            this.options.threadId,

          validationState: {
            ...validationState,

            delegationFanouts: [
              ...existing.slice(
                -9,
              ),

              {
                groupId,

                taskIds,

                tasks:
                  launches.map(
                    (launch) => ({
                      index:
                        launch.index,

                      objective:
                        launch.objective,

                      requestedAgentId:
                        launch.requestedAgentId,

                      taskId:
                        launch.taskId,

                      launched:
                        launch.success,
                    }),
                  ),

                createdAt:
                  new Date()
                    .toISOString(),
              },
            ],
          },
        } as AgentWorkingState);
      }
    } catch (error) {
      console.warn(
        'Unable to persist delegation fan-out:',
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    const successful =
      launches.filter(
        (launch) =>
          launch.success,
      ).length;

    return {
      success:
        successful > 0,

      error:
        successful === 0
          ? 'fanout-launch-failed'
          : undefined,

      output:
        JSON.stringify(
          {
            kind:
              'delegation_fanout',

            groupId,

            requested:
              tasks.length,

            launched:
              successful,

            taskIds,

            launches,

            instruction:
              taskIds.length
                ? 'Use agent.delegate.fanout.status with these taskIds to collect child progress/results. Do not declare the parent task complete merely because delegation was launched.'
                : 'Delegation calls returned no parseable task IDs. Inspect each launch output before proceeding.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'delegation-fanout',

          summary:
            `Launched ${successful}/${tasks.length} delegated subproblems in fan-out group ${groupId}.`,

          detail: {
            groupId,
            taskIds,
            requested:
              tasks.length,
            launched:
              successful,
          },
        },
      ],
    };
  }

  private async executeFanoutStatus(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
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

    if (!taskIds.length) {
      return {
        success: false,

        error:
          'missing-task-ids',

        output:
          'agent.delegate.fanout.status requires at least one task ID.',
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
          'status-tool-unavailable',

        output:
          'agent.delegate.status is not available in this run.',
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

    const results =
      statuses.map(
        (
          item,
          index,
        ) => {
          const taskId =
            taskIds[index];

          if (
            item.status ===
            'rejected'
          ) {
            return {
              taskId,

              success:
                false,

              error:
                item.reason instanceof
                  Error
                  ? item.reason
                      .message
                  : String(
                      item.reason,
                    ),
            };
          }

          return {
            taskId,

            success:
              item.value
                .success,

            output:
              item.value
                .output,

            error:
              item.value
                .error,
          };
        },
      );

    return {
      success:
        results.some(
          (result) =>
            result.success,
        ),

      output:
        JSON.stringify(
          {
            kind:
              'delegation_fanout_status',

            count:
              results.length,

            results,

            instruction:
              'Wait for required child tasks to reach terminal state, then compare their evidence. A completed child is evidence for its delegated subproblem, not automatic proof that the parent objective is complete.',
          },
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'delegation-fanout-status',

          summary:
            `Collected status for ${results.length} delegated tasks.`,

          detail: {
            taskIds,
          },
        },
      ],
    };
  }
}
