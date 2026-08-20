import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
} from '@dacai-local-agent/agent-core';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

import {
  refreshSemanticIndex,
} from './incremental-index-refresh';

interface SemanticRefreshExecutorOptions {
  threadId: string;
  workspaceRoot: string;
}

const MUTATION_TOOLS =
  new Set([
    'filesystem.edit',
    'filesystem.write',
    'filesystem.move',
    'filesystem.copy',
  ]);

function stringArguments(
  args:
    Record<string, unknown>,
): string[] {
  const paths:
    string[] = [];

  for (
    const key
    of [
      'path',
      'file',
      'filePath',
      'targetPath',

      'source',
      'sourcePath',
      'from',

      'destination',
      'destinationPath',
      'target',
      'to',
    ]
  ) {
    const value =
      args[key];

    if (
      typeof value ===
        'string' &&
      value.trim()
    ) {
      paths.push(
        value.trim(),
      );
    }
  }

  return Array.from(
    new Set(paths),
  );
}

function wasRealMutation(
  call:
    NormalizedToolCall,

  result:
    LoopToolResult,
): boolean {
  if (
    !MUTATION_TOOLS.has(
      call.name,
    )
  ) {
    return false;
  }

  if (
    !result.success ||
    result.denied
  ) {
    return false;
  }

  const output =
    String(
      result.output ??
      '',
    ).toLowerCase();

  /*
   * ImpactAwareExecutor intentionally returns success=true
   * for its first pre-edit gate, but no mutation occurred.
   */
  if (
    output.includes(
      'pre_edit_impact_gate',
    )
  ) {
    return false;
  }

  if (
    output.includes(
      '"executed": false',
    ) ||
    output.includes(
      '"executed":false',
    )
  ) {
    return false;
  }

  return true;
}

async function persistFreshness(
  threadId: string,
  value: {
    status:
      'fresh' |
      'stale';

    paths:
      string[];

    error?: string;
  },
): Promise<void> {
  try {
    const state =
      await loadWorkingState(
        threadId,
      );

    if (!state || typeof state !== 'object') {
      return;
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

    const history =
      Array.isArray(
        validationState
          .semanticIndexRefreshes,
      )
        ? validationState
            .semanticIndexRefreshes
        : [];

    const record = {
      ...value,

      refreshedAt:
        new Date()
          .toISOString(),
    };

    await saveWorkingState({
      ...stateRecord,

      threadId,

      validationState: {
        ...validationState,

        semanticIndex:
          record,

        semanticIndexRefreshes: [
          ...history.slice(
            -19,
          ),

          record,
        ],
      },
    } as AgentWorkingState);
  } catch (error) {
    console.warn(
      'Unable to persist semantic-index freshness:',
      error instanceof Error
        ? error.message
        : String(error),
    );
  }
}

export class SemanticIndexRefreshExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      SemanticRefreshExecutorOptions,
  ) {}

  listTools() {
    return this.inner.listTools();
  }

  async execute(
    call:
      NormalizedToolCall,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    const result =
      await this.inner.execute(
        call,
        signal,
      );

    if (
      !wasRealMutation(
        call,
        result,
      )
    ) {
      return result;
    }

    const touchedPaths =
      stringArguments(
        call.arguments ??
          {},
      );

    try {
      const refresh =
        await refreshSemanticIndex(
          this.options
            .workspaceRoot,

          touchedPaths,

          signal,
        );

      if (
        !refresh.refreshed
      ) {
        /*
         * Non-source files such as README/config may not affect
         * code-symbol semantic retrieval.
         */
        return result;
      }

      await persistFreshness(
        this.options.threadId,
        {
          status:
            'fresh',

          paths:
            refresh
              .touchedPaths,
        },
      );

      return {
        ...result,

        output: [
          result.output ?? '',
          '',
          'SEMANTIC_INDEX_REFRESHED',
          `files: ${refresh.touchedPaths.join(', ')}`,
          'Structural symbols/dependency edges were refreshed from current repository contents.',
          'New/replaced symbol rows were semantically enriched.',
          'Subsequent repository-intelligence retrieval may use the refreshed index.',
        ]
          .filter(Boolean)
          .join('\n'),

        evidence: [
          ...(
            result.evidence ??
            []
          ),

          {
            kind:
              'semantic-index-refresh',

            summary:
              `Repository semantic index refreshed after mutation of ${refresh.touchedPaths.join(', ')}.`,

            detail: {
              paths:
                refresh.touchedPaths,

              refreshed:
                true,
            },
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      await persistFreshness(
        this.options.threadId,
        {
          status:
            'stale',

          paths:
            touchedPaths,

          error:
            message.slice(
              0,
              2000,
            ),
        },
      );

      /*
       * IMPORTANT:
       *
       * The source mutation itself already succeeded.
       * Do not report success=false here because that could
       * cause the model to replay an already-applied edit.
       */
      return {
        ...result,

        output: [
          result.output ?? '',
          '',
          'SEMANTIC_INDEX_STALE',
          `Automatic post-edit index refresh failed: ${message}`,
          '',
          'The repository mutation succeeded.',
          'Do NOT repeat the mutation.',
          'Do not rely on semantic symbol retrieval as current evidence until the index refresh succeeds.',
          'Filesystem/Git/current-source inspection remains authoritative.',
        ]
          .filter(Boolean)
          .join('\n'),

        evidence: [
          ...(
            result.evidence ??
            []
          ),

          {
            kind:
              'semantic-index-stale',

            summary:
              'Source mutation succeeded but semantic repository refresh failed.',

            detail: {
              paths:
                touchedPaths,

              error:
                message.slice(
                  0,
                  1000,
                ),
            },
          },
        ],
      };
    }
  }
}
