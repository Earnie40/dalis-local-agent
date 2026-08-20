import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
} from '@dacai-local-agent/agent-core';

import {
  dependencyImpact,
  getRepositoryArchitectureMap,
  hybridSymbolSearch,
} from '@dacai-local-agent/repository-index';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';

const FILE_MUTATION_TOOLS = new Set([
  'filesystem.edit',
  'filesystem.write',
  'filesystem.move',
  'filesystem.copy',
]);

interface ImpactAwareExecutorOptions {
  threadId: string;
  objective: string;
}

interface PatchPlan {
  kind: 'pre_edit_impact_gate';
  executed: false;
  objective: string;
  targetPath: string;
  requestedTool: string;
  relevantSymbols: Array<{
    name?: string;
    kind?: string;
    filePath?: string;
    similarity?: number;
  }>;
  impacts: Array<{
    symbol: string;
    callers: unknown[];
    callees: unknown[];
    references: unknown[];
    relatedTests: string[];
  }>;
  architecture: {
    packages?: unknown;
    applications?: unknown;
    fileCount?: unknown;
    symbolCount?: unknown;
    edgeCount?: unknown;
  } | null;
  instruction: string;
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

function targetPath(
  call: NormalizedToolCall,
): string | undefined {
  const input =
    (call.arguments ?? {}) as Record<string, unknown>;

  if (
    call.name === 'filesystem.move' ||
    call.name === 'filesystem.copy'
  ) {
    return stringValue(
      input,
      'source',
      'from',
      'path',
    );
  }

  return stringValue(
    input,
    'path',
    'filePath',
  );
}

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function samePath(
  left: string | undefined,
  right: string,
): boolean {
  if (!left) return false;

  const a = normalizePath(left);
  const b = normalizePath(right);

  return (
    a === b ||
    a.endsWith(`/${b}`) ||
    b.endsWith(`/${a}`)
  );
}

function uniqueStrings(
  values: Array<string | undefined>,
): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string =>
          typeof value === 'string' &&
          value.length > 0,
      ),
    ),
  );
}

export class ImpactAwareExecutor
implements ToolExecutor {
  private readonly reviewedPaths =
    new Set<string>();

  constructor(
    private readonly inner: ToolExecutor,
    private readonly options:
      ImpactAwareExecutorOptions,
  ) {}

  listTools() {
    return this.inner.listTools();
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    if (!FILE_MUTATION_TOOLS.has(call.name)) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const path = targetPath(call);

    if (!path) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const key = normalizePath(path);

    /*
     * First attempted mutation of a file does not execute.
     * Instead we return impact evidence to the model.
     *
     * A subsequent mutation of that file during the same
     * run proceeds through the normal permission executor.
     */
    if (this.reviewedPaths.has(key)) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    this.reviewedPaths.add(key);

    const searchQuery = [
      this.options.objective,
      path,
    ].join('\n');

    const candidates =
      await hybridSymbolSearch(
        searchQuery,
        15,
      );

    const pathMatches = candidates.filter(
      (candidate) =>
        samePath(
          candidate.filePath,
          path,
        ),
    );

    const selected =
      (
        pathMatches.length
          ? pathMatches
          : candidates
      ).slice(0, 5);

    const impacts: PatchPlan['impacts'] = [];

    for (const candidate of selected) {
      if (!candidate.name) continue;

      try {
        const impact =
          await dependencyImpact(
            candidate.name,
          );

        const edges =
          Array.isArray(impact.edges)
            ? impact.edges
            : [];

        impacts.push({
          symbol: candidate.name,

          callers: edges.filter(
            (edge: any) =>
              edge?.target ===
              candidate.name,
          ),

          callees: edges.filter(
            (edge: any) =>
              edge?.source ===
              candidate.name,
          ),

          references:
            Array.isArray(
              impact.references,
            )
              ? impact.references
              : [],

          relatedTests:
            Array.isArray(
              impact.relatedTests,
            )
              ? impact.relatedTests
              : [],
        });
      } catch {
        // A single incomplete graph entry must not
        // break the entire pre-edit analysis.
      }
    }

    let architecture: PatchPlan['architecture'] =
      null;

    try {
      const map =
        await getRepositoryArchitectureMap();

      if (map) {
        architecture = {
          packages: map.packages,
          applications: map.applications,
          fileCount: map.fileCount,
          symbolCount: map.symbolCount,
          edgeCount: map.edgeCount,
        };
      }
    } catch {
      architecture = null;
    }

    const plan: PatchPlan = {
      kind: 'pre_edit_impact_gate',

      executed: false,

      objective:
        this.options.objective,

      targetPath: path,

      requestedTool: call.name,

      relevantSymbols:
        selected.map((candidate) => ({
          name: candidate.name,
          kind: candidate.kind,
          filePath:
            candidate.filePath,
          similarity:
            candidate.similarity,
        })),

      impacts,

      architecture,

      instruction:
        'The requested mutation has NOT executed yet. Review this dependency context, adjust the patch if necessary, then retry the mutation. The second mutation attempt for this file may proceed through the normal permission boundary.',
    };

    /*
     * Persist the patch plan into the same durable
     * working state used by the run.
     */
    try {
      const current =
        await loadWorkingState(
          this.options.threadId,
        );

      if (current) {
        const existingPlan =
          Array.isArray(current.plan)
            ? current.plan
            : [];

        const existingSymbols =
          Array.isArray(
            current.relevant_symbols,
          )
            ? current.relevant_symbols
            : Array.isArray(
                current.relevantSymbols,
              )
              ? current.relevantSymbols
              : [];

        await saveWorkingState({
          threadId:
            this.options.threadId,

          objective:
            current.objective ??
            this.options.objective,

          plan: [
            ...existingPlan,
            plan,
          ],

          completedSteps:
            current.completed_steps ??
            current.completedSteps ??
            [],

          pendingSteps:
            current.pending_steps ??
            current.pendingSteps ??
            [],

          inspectedFiles:
            current.inspected_files ??
            current.inspectedFiles ??
            [],

          relevantSymbols:
            uniqueStrings([
              ...existingSymbols,
              ...selected.map(
                (candidate) =>
                  candidate.name,
              ),
            ]),

          changedFiles:
            current.changed_files ??
            current.changedFiles ??
            [],

          knownErrors:
            current.known_errors ??
            current.knownErrors ??
            [],

          architectureFacts:
            current.architecture_facts ??
            current.architectureFacts ??
            [],

          validationState:
            current.validation_state ??
            current.validationState ??
            {},
        });
      }
    } catch (error) {
      console.warn(
        'Unable to persist patch plan:',
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    return {
      success: true,

      output:
        JSON.stringify(
          plan,
          null,
          2,
        ),

      evidence: [
        {
          kind:
            'dependency-impact',

          summary:
            `Pre-edit impact analysis generated for ${path}. Mutation not yet executed.`,

          detail: {
            targetPath: path,
            symbols:
              selected
                .map(
                  (candidate) =>
                    candidate.name,
                )
                .filter(Boolean),
            relatedTests:
              uniqueStrings(
                impacts.flatMap(
                  (impact) =>
                    impact.relatedTests,
                ),
              ),
            executed: false,
          },
        },
      ],
    };
  }
}
