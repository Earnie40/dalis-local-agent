import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
} from '@dacai-local-agent/agent-core';

import {
  dependencyImpact,
  hybridSymbolSearch,
} from '@dacai-local-agent/repository-index';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';

const MUTATION_TOOLS = new Set([
  'filesystem.edit',
  'filesystem.write',
  'filesystem.move',
  'filesystem.copy',
]);

interface ValidationRoutingExecutorOptions {
  threadId: string;
  objective: string;
}

interface ValidationRoute {
  kind: 'post_edit_validation_route';
  targetPath: string;
  packageRoot?: string;
  relevantSymbols: string[];
  relatedTests: string[];
  recommendedSequence: Array<{
    order: number;
    tool: string;
    scope: string;
    reason: string;
  }>;
}

function stringValue(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key];

    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return undefined;
}

function mutationPath(
  call: NormalizedToolCall,
): string | undefined {
  const input =
    (call.arguments ?? {}) as Record<string, unknown>;

  return stringValue(
    input,
    'path',
    'filePath',
    'destination',
    'to',
    'source',
    'from',
  );
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function packageRoot(
  path: string,
): string | undefined {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');

  if (
    parts.length >= 2 &&
    (
      parts[0] === 'packages' ||
      parts[0] === 'apps'
    )
  ) {
    return `${parts[0]}/${parts[1]}`;
  }

  return undefined;
}

function unique(values: string[]): string[] {
  return Array.from(
    new Set(
      values.filter(Boolean),
    ),
  );
}

function isImpactGate(
  result: LoopToolResult,
): boolean {
  return (
    result.output?.includes(
      '"kind": "pre_edit_impact_gate"',
    ) === true ||
    result.output?.includes(
      '"kind":"pre_edit_impact_gate"',
    ) === true
  );
}

export class ValidationRoutingExecutor
implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly options:
      ValidationRoutingExecutorOptions,
  ) {}

  listTools() {
    return this.inner.listTools();
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    const result =
      await this.inner.execute(
        call,
        signal,
      );

    if (
      !MUTATION_TOOLS.has(call.name) ||
      !result.success ||
      result.denied ||
      isImpactGate(result)
    ) {
      return result;
    }

    const path = mutationPath(call);

    if (!path) {
      return result;
    }

    const normalizedPath =
      normalizePath(path);

    const root =
      packageRoot(normalizedPath);

    let symbols:
      Awaited<
        ReturnType<typeof hybridSymbolSearch>
      > = [];

    try {
      symbols =
        await hybridSymbolSearch(
          [
            this.options.objective,
            normalizedPath,
          ].join('\n'),
          10,
        );
    } catch {
      symbols = [];
    }

    const pathSymbols =
      symbols.filter((symbol) => {
        const candidate =
          symbol.filePath
            ?.replace(/\\/g, '/')
            .toLowerCase();

        return candidate ===
          normalizedPath.toLowerCase();
      });

    const selected =
      (
        pathSymbols.length
          ? pathSymbols
          : symbols
      ).slice(0, 5);

    const relatedTests: string[] = [];

    for (const symbol of selected) {
      if (!symbol.name) continue;

      try {
        const impact =
          await dependencyImpact(
            symbol.name,
          );

        if (
          Array.isArray(
            impact.relatedTests,
          )
        ) {
          relatedTests.push(
            ...impact.relatedTests,
          );
        }
      } catch {
        // Missing graph information must not
        // break a successful mutation.
      }
    }

    const uniqueTests =
      unique(relatedTests);

    const route: ValidationRoute = {
      kind:
        'post_edit_validation_route',

      targetPath:
        normalizedPath,

      packageRoot: root,

      relevantSymbols:
        unique(
          selected
            .map(
              (symbol) =>
                symbol.name ?? '',
            ),
        ),

      relatedTests:
        uniqueTests,

      recommendedSequence: [
        {
          order: 1,
          tool:
            'code.diagnostics',

          scope:
            normalizedPath,

          reason:
            'Check the changed source first for immediate TypeScript or language diagnostics.',
        },

        ...(uniqueTests.length
          ? [
              {
                order: 2,
                tool: 'tests.run',
                scope:
                  uniqueTests.join(', '),
                reason:
                  'Run tests already associated with the affected symbols before broader validation.',
              },
            ]
          : []),

        ...(root
          ? [
              {
                order:
                  uniqueTests.length
                    ? 3
                    : 2,

                tool:
                  'tests.run',

                scope: root,

                reason:
                  'If targeted validation is insufficient or fails, validate the affected workspace package.',
              },
            ]
          : []),

        {
          order:
            uniqueTests.length
              ? root
                ? 4
                : 3
              : root
                ? 3
                : 2,

          tool:
            'tests.run',

          scope:
            'repository',

          reason:
            'Escalate to repository-wide validation only when the narrower checks cannot establish correctness.',
        },
      ],
    };

    try {
      const state =
        await loadWorkingState(
          this.options.threadId,
        );

      if (state) {
        const validationState =
          state.validation_state ??
          state.validationState ??
          {};

        await saveWorkingState({
          threadId:
            this.options.threadId,

          objective:
            state.objective ??
            this.options.objective,

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
            unique([
              ...(
                state.relevant_symbols ??
                state.relevantSymbols ??
                []
              ),
              ...route.relevantSymbols,
            ]),

          changedFiles:
            unique([
              ...(
                state.changed_files ??
                state.changedFiles ??
                []
              ),
              normalizedPath,
            ]),

          knownErrors:
            state.known_errors ??
            state.knownErrors ??
            [],

          architectureFacts:
            state.architecture_facts ??
            state.architectureFacts ??
            [],

          validationState: {
            ...validationState,
            required: true,
            route,
            generatedAt:
              new Date().toISOString(),
          },
        });
      }
    } catch (error) {
      console.warn(
        'Unable to persist validation route:',
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    const original =
      result.output ?? '';

    return {
      ...result,

      output: [
        original,
        '',
        'POST_EDIT_VALIDATION_REQUIRED',
        JSON.stringify(
          route,
          null,
          2,
        ),
        '',
        'The mutation succeeded. Validation has NOT yet been completed. Follow the narrowest relevant validation steps above before finalizing.',
      ]
        .filter(Boolean)
        .join('\n'),

      evidence: [
        ...(result.evidence ?? []),

        {
          kind:
            'validation-route',

          summary:
            `Generated post-edit validation route for ${normalizedPath}.`,

          detail: {
            targetPath:
              normalizedPath,

            packageRoot:
              root,

            relatedTests:
              uniqueTests,

            validated: false,
          },
        },
      ],
    };
  }
}
