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

interface DiffAwareValidationOptions {
  threadId: string;
}

type ChangeCategory =
  | 'ui'
  | 'api'
  | 'database'
  | 'config'
  | 'security'
  | 'orchestration'
  | 'provider'
  | 'repository-index'
  | 'tools'
  | 'tests'
  | 'documentation'
  | 'general-code';

type GateStatus =
  | 'pending'
  | 'passed'
  | 'failed';

interface ValidationGate {
  id: string;

  label: string;

  status: GateStatus;

  reason: string;

  satisfiedBy: string[];

  evidence?: string;

  updatedAt?: string;
}

interface DiffValidationPlan {
  kind:
    'diff_validation_plan';

  generation: number;

  fingerprint: string;

  changedFiles: string[];

  categories:
    ChangeCategory[];

  gates:
    ValidationGate[];

  scopeHints: string[];

  createdAt: string;

  updatedAt: string;
}

const MUTATION_TOOLS =
  new Set([
    'filesystem.edit',
    'filesystem.write',
    'filesystem.move',
    'filesystem.copy',
  ]);

const PLAN_SCHEMA = {
  type: 'object',
  properties: {},
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
    result.inputSchema =
      PLAN_SCHEMA;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      PLAN_SCHEMA;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      PLAN_SCHEMA;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      PLAN_SCHEMA;
  }

  return result as unknown as ToolSchema;
}

function toolSchema(
  tool: unknown,
): Record<string, unknown> {
  const record =
    tool && typeof tool === 'object'
      ? (tool as Record<string, unknown>)
      : undefined;

  const value =
    record?.inputSchema ??
    record?.parameters ??
    record?.schema;

  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function gitCall(
  tool: unknown,
  args: string[],
): NormalizedToolCall {
  const propertiesValue =
    toolSchema(
      tool,
    ).properties;

  const properties: Record<string, unknown> =
    propertiesValue && typeof propertiesValue === 'object'
      ? (propertiesValue as Record<string, unknown>)
      : {};

  if (
    'args' in
    properties
  ) {
    return {
      name:
        'git.run',

      arguments: {
        args,
      },
    };
  }

  if (
    'argv' in
    properties
  ) {
    return {
      name:
        'git.run',

      arguments: {
        argv:
          args,
      },
    };
  }

  if (
    'subcommand' in
      properties
  ) {
    return {
      name:
        'git.run',

      arguments: {
        subcommand:
          args[0],

        args:
          args.slice(1),
      },
    };
  }

  const commandKey =
    'command' in
      properties
      ? 'command'
      : 'cmd' in
          properties
        ? 'cmd'
        : 'command';

  return {
    name:
      'git.run',

    arguments: {
      [commandKey]:
        args.join(
          ' ',
        ),
    },
  };
}

function observableOutput(
  result:
    LoopToolResult,
): string {
  const raw =
    String(
      result.output ??
      '',
    );

  try {
    const parsed =
      JSON.parse(raw);

    for (
      const value
      of [
        parsed?.stdout,
        parsed?.output,
        parsed?.content,
        parsed?.result,
      ]
    ) {
      if (
        typeof value ===
          'string'
      ) {
        return value;
      }
    }
  } catch {
    // Human-readable git output is also valid.
  }

  return raw;
}

function parseStatusPaths(
  output: string,
): string[] {
  const paths:
    string[] = [];

  for (
    const line
    of output.split(
      /\r?\n/,
    )
  ) {
    if (
      line.trim().length <
      4
    ) {
      continue;
    }

    /*
     * git status --short:
     * XY path
     * XY old -> new
     */
    const candidate =
      line.slice(3)
        .trim()
        .split(
          ' -> ',
        )
        .pop()
        ?.trim();

    if (
      candidate &&
      !candidate.startsWith(
        '{',
      )
    ) {
      paths.push(
        candidate.replace(
          /^"|"$/g,
          '',
        ),
      );
    }
  }

  return Array.from(
    new Set(paths),
  );
}

function normalized(
  path: string,
): string {
  return path
    .replace(
      /\\/g,
      '/',
    )
    .replace(
      /^\.\//,
      '',
    )
    .toLowerCase();
}

function categoryFor(
  path: string,
): ChangeCategory[] {
  const p =
    normalized(path);

  const categories:
    ChangeCategory[] =
      [];

  if (
    p.endsWith('.md') ||
    p.startsWith(
      'docs/',
    )
  ) {
    categories.push(
      'documentation',
    );
  }

  if (
    p.startsWith(
      'apps/web/',
    ) ||
    /\.(tsx|jsx|css|scss|sass|less|html|vue|svelte)$/
      .test(p)
  ) {
    categories.push(
      'ui',
    );
  }

  if (
    p.startsWith(
      'apps/server/src/routes/',
    ) ||
    p.includes(
      '/api/',
    ) ||
    p.includes(
      'route',
    )
  ) {
    categories.push(
      'api',
    );
  }

  if (
    p.includes(
      '/migrations/',
    ) ||
    p.includes(
      'schema.prisma',
    ) ||
    p.includes(
      'repository-store',
    ) ||
    p.includes(
      'db/'
    ) ||
    p.endsWith(
      '.sql',
    )
  ) {
    categories.push(
      'database',
    );
  }

  if (
    p.startsWith(
      'packages/security/',
    ) ||
    p.includes(
      'permission',
    ) ||
    p.includes(
      'approval',
    ) ||
    p.includes(
      'authorization',
    ) ||
    p.includes(
      'authentication',
    ) ||
    p.includes(
      'scope-guard',
    ) ||
    p.includes(
      'redaction',
    )
  ) {
    categories.push(
      'security',
    );
  }

  if (
    p.startsWith(
      'packages/orchestrator/',
    ) ||
    p.startsWith(
      'packages/agent-core/',
    ) ||
    p.startsWith(
      'packages/context/',
    ) ||
    p.includes(
      'executor.ts',
    ) ||
    p.endsWith(
      'apps/server/src/routes/agent.ts',
    )
  ) {
    categories.push(
      'orchestration',
    );
  }

  if (
    p.startsWith(
      'packages/providers/',
    ) ||
    p.startsWith(
      'config/models/',
    )
  ) {
    categories.push(
      'provider',
    );
  }

  if (
    p.startsWith(
      'packages/repository-index/',
    )
  ) {
    categories.push(
      'repository-index',
    );
  }

  if (
    p.startsWith(
      'packages/tools/',
    )
  ) {
    categories.push(
      'tools',
    );
  }

  if (
    p.includes(
      '.test.',
    ) ||
    p.includes(
      '.spec.',
    ) ||
    p.startsWith(
      'tests/',
    )
  ) {
    categories.push(
      'tests',
    );
  }

  if (
    p.startsWith(
      'config/',
    ) ||
    p.endsWith(
      '.yaml',
    ) ||
    p.endsWith(
      '.yml',
    ) ||
    p.endsWith(
      '.json',
    ) ||
    p.endsWith(
      '.toml',
    ) ||
    p.endsWith(
      '.env.example',
    ) ||
    p.endsWith(
      'package.json',
    ) ||
    p.endsWith(
      'pnpm-lock.yaml',
    )
  ) {
    categories.push(
      'config',
    );
  }

  if (
    categories.length ===
      0 &&
    /\.(ts|js|tsx|jsx|mjs|cjs|py|go|rs|java)$/
      .test(p)
  ) {
    categories.push(
      'general-code',
    );
  }

  return categories;
}

function isExecutableSource(
  path: string,
): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/
    .test(
      normalized(path),
    );
}

function interactiveUiDiff(
  diff: string,
): boolean {
  return /\b(onClick|onSubmit|onChange|onKeyDown|navigate\(|router|useRouter|modal|dialog|dropdown|menu|button|form|drawer|tab|aria-expanded|pointer|keydown)\b/i
    .test(diff);
}

function securitySensitiveDiff(
  diff: string,
): boolean {
  return /\b(auth|authorization|authentication|permission|approval|secret|credential|tenant|scope|sandbox|allowlist|deny|redact|token|trust boundary)\b/i
    .test(diff);
}

function gate(
  id: string,
  label: string,
  reason: string,
  satisfiedBy:
    string[],
): ValidationGate {
  return {
    id,
    label,
    reason,
    satisfiedBy,
    status:
      'pending',
  };
}

function makePlan(
  previous:
    DiffValidationPlan |
    undefined,

  changedFiles:
    string[],

  diffText:
    string,

  statusText:
    string,
): DiffValidationPlan {
  const categorySet =
    new Set<
      ChangeCategory
    >();

  for (
    const path
    of changedFiles
  ) {
    for (
      const category
      of categoryFor(path)
    ) {
      categorySet.add(
        category,
      );
    }
  }

  if (
    securitySensitiveDiff(
      diffText,
    )
  ) {
    categorySet.add(
      'security',
    );
  }

  const categories =
    Array.from(
      categorySet,
    );

  const fingerprint =
    createHash(
      'sha256',
    )
      .update(
        [
          statusText,
          diffText,
        ].join(
          '\n---DIFF---\n',
        ),
      )
      .digest(
        'hex',
      );

  const sameGeneration =
    previous
      ?.fingerprint ===
      fingerprint;

  const generation =
    sameGeneration
      ? previous
          .generation
      : (
          previous
            ?.generation ??
          0
        ) + 1;

  const gates:
    ValidationGate[] =
      [];

  const codeChanged =
    changedFiles.some(
      isExecutableSource,
    );

  const runtimeChanged =
    categories.some(
      (category) =>
        [
          'api',
          'database',
          'security',
          'orchestration',
          'provider',
          'repository-index',
          'tools',
          'general-code',
        ].includes(
          category,
        ),
    );

  const uiChanged =
    categories.includes(
      'ui',
    );

  const interactionChanged =
    uiChanged &&
    interactiveUiDiff(
      diffText,
    );

  const securityChanged =
    categories.includes(
      'security',
    );

  if (
    codeChanged
  ) {
    gates.push(
      gate(
        'diagnostics',

        'Code diagnostics',

        'Executable source changed.',

        [
          'code.diagnostics',
        ],
      ),
    );
  }

  if (
    runtimeChanged ||
    uiChanged
  ) {
    gates.push(
      gate(
        'targeted-tests',

        'Targeted tests',

        'Runtime-affecting implementation changed.',

        [
          'tests.run',
        ],
      ),
    );
  }

  if (
    uiChanged
  ) {
    gates.push(
      gate(
        'ui-visual',

        'Rendered visual validation',

        'UI/rendering source changed.',

        [
          'ui.visual.record',
        ],
      ),
    );
  }

  if (
    interactionChanged
  ) {
    gates.push(
      gate(
        'ui-interaction',

        'Runtime UI interaction verification',

        'The diff changes interactive UI behavior.',

        [
          'browser.interact',
        ],
      ),
    );
  }

  if (
    securityChanged
  ) {
    gates.push(
      gate(
        'security-review',

        'Security specialist evidence',

        'Security/trust-boundary code or behavior changed.',

        [
          'agent.delegate.synthesize',
        ],
      ),
    );
  }

  const scopeHints =
    Array.from(
      new Set(
        changedFiles
          .map(
            (path) => {
              const p =
                normalized(
                  path,
                );

              if (
                p.startsWith(
                  'apps/web/',
                )
              ) {
                return 'apps/web';
              }

              if (
                p.startsWith(
                  'apps/server/',
                )
              ) {
                return 'apps/server';
              }

              const match =
                p.match(
                  /^(packages\/[^/]+)/,
                );

              if (match) {
                return match[1];
              }

              if (
                p.startsWith(
                  'tests/',
                )
              ) {
                return 'tests';
              }

              return undefined;
            },
          )
          .filter(
            (
              value,
            ): value is string =>
              Boolean(value),
          ),
      ),
    );

  /*
   * Preserve already-passed evidence only when the actual
   * diff fingerprint has not changed.
   */
  if (
    sameGeneration &&
    previous
  ) {
    for (
      const newGate
      of gates
    ) {
      const oldGate =
        previous.gates.find(
          (candidate) =>
            candidate.id ===
            newGate.id,
        );

      if (
        oldGate?.status ===
          'passed'
      ) {
        newGate.status =
          'passed';

        newGate.evidence =
          oldGate.evidence;

        newGate.updatedAt =
          oldGate.updatedAt;
      }
    }
  }

  const now =
    new Date()
      .toISOString();

  return {
    kind:
      'diff_validation_plan',

    generation,

    fingerprint,

    changedFiles,

    categories,

    gates,

    scopeHints,

    createdAt:
      sameGeneration &&
      previous
        ? previous.createdAt
        : now,

    updatedAt:
      now,
  };
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

async function persistPlan(
  threadId: string,
  plan:
    DiffValidationPlan,
): Promise<void> {
  const state =
    await loadWorkingState(
      threadId,
    );

  if (!state) {
    return;
  }

  const validation =
    validationState(
      state,
    );

  const stateRecord =
    state as Record<string, unknown>;

  await saveWorkingState({
    ...stateRecord,

    threadId,

    validationState: {
      ...validation,

      diffValidationPlan:
        plan,
    },
  } as AgentWorkingState);
}

async function readPlan(
  threadId: string,
): Promise<
  DiffValidationPlan |
  undefined
> {
  const state =
    await loadWorkingState(
      threadId,
    );

  const value = validationState(
    state,
  ).diffValidationPlan;

  return value && typeof value === 'object'
    ? (value as DiffValidationPlan)
    : undefined;
}

function realMutation(
  call:
    NormalizedToolCall,

  result:
    LoopToolResult,
): boolean {
  if (
    !MUTATION_TOOLS.has(
      call.name,
    ) ||
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

  return !(
    output.includes(
      'pre_edit_impact_gate',
    ) ||
    output.includes(
      '"executed": false',
    ) ||
    output.includes(
      '"executed":false',
    )
  );
}

function gateResult(
  gate:
    ValidationGate,

  call:
    NormalizedToolCall,

  result:
    LoopToolResult,
): {
  matched: boolean;
  passed: boolean;
  evidence?: string;
} {
  if (
    !gate.satisfiedBy.includes(
      call.name,
    )
  ) {
    return {
      matched: false,
      passed: false,
    };
  }

  if (
    gate.id ===
      'ui-visual'
  ) {
    const passed =
      result.success &&
      /UI_VISUAL_VALIDATION_PASSED/i
        .test(
          result.output ??
          '',
        );

    return {
      matched: true,
      passed,

      evidence:
        passed
          ? 'ui.visual.record returned a vision-backed passed verdict.'
          : 'Visual validation did not pass.',
    };
  }

  if (
    gate.id ===
      'security-review'
  ) {
    if (
      !result.success
    ) {
      return {
        matched: true,
        passed: false,
        evidence:
          'Delegated evidence synthesis failed.',
      };
    }

    const output =
      result.output ??
      '';

    const hasSecurityReviewer =
      /"agentId"\s*:\s*"security-reviewer"/i
        .test(output);

    const blocking =
      /"decision"\s*:\s*"(changes_required|mixed|pending)"/i
        .test(output);

    return {
      matched: true,

      passed:
        hasSecurityReviewer &&
        !blocking,

      evidence:
        hasSecurityReviewer
          ? (
              blocking
                ? 'Security-specialist synthesis contains unresolved/blocking evidence.'
                : 'Security-reviewer evidence was included in non-blocking delegated consensus.'
            )
          : 'Consensus did not contain security-reviewer evidence.',
    };
  }

  return {
    matched: true,

    passed:
      result.success &&
      !result.denied,

    evidence:
      `${call.name} returned success=${result.success}.`,
  };
}

export class DiffAwareValidationExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      DiffAwareValidationOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const base =
      existing.find(
        (tool) =>
          tool.name ===
          'git.run',
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
          'code.validation.plan',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.validation.plan',

          'Rebuild the targeted validation checklist from the current actual Git status/diff.',
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.validation.plan.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.validation.plan.status',

          'Read the current diff-aware validation checklist and remaining required evidence.',
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
      'code.validation.plan'
    ) {
      return this.rebuild(
        signal,
      );
    }

    if (
      call.name ===
      'code.validation.plan.status'
    ) {
      return this.status();
    }

    /*
     * Hard validation gate before final review.
     */
    if (
      call.name ===
      'code.review.prepare'
    ) {
      const plan =
        await readPlan(
          this.options.threadId,
        );

      if (plan) {
        const remaining =
          plan.gates.filter(
            (gate) =>
              gate.status !==
              'passed',
          );

        if (
          remaining.length
        ) {
          return {
            success: false,

            error:
              'diff-validation-incomplete',

            output: [
              'DIFF_AWARE_VALIDATION_INCOMPLETE',
              '',
              `generation: ${plan.generation}`,
              '',
              'Remaining evidence:',
              ...remaining.map(
                (gate) =>
                  `- ${gate.id}: ${gate.label} [${gate.status}] — ${gate.reason}`,
              ),
              '',
              'Run only the required validation above, then retry final patch review.',
            ].join('\n'),
          };
        }
      }
    }

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    /*
     * Every actual mutation rebuilds the plan from the actual
     * repository diff.
     */
    if (
      realMutation(
        call,
        result,
      )
    ) {
      try {
        const rebuilt =
          await this.buildPlan(
            signal,
          );

        return {
          ...result,

          output: [
            result.output ??
              '',
            '',
            'DIFF_AWARE_VALIDATION_PLAN',
            `generation: ${rebuilt.generation}`,
            `categories: ${rebuilt.categories.join(', ') || 'none'}`,
            '',
            'Required evidence:',
            ...(
              rebuilt.gates.length
                ? rebuilt.gates.map(
                    (gate) =>
                      `- ${gate.id}: ${gate.label} — ${gate.reason}`,
                  )
                : [
                    '- No additional runtime validation gates were derived from this diff.',
                  ]
            ),
            '',
            rebuilt.scopeHints.length
              ? `Suggested validation scope: ${rebuilt.scopeHints.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      } catch (error) {
        /*
         * Mutation already succeeded. Never tell the model the
         * edit failed simply because planning failed.
         */
        return {
          ...result,

          output: [
            result.output ??
              '',
            '',
            'DIFF_VALIDATION_PLAN_STALE',
            error instanceof Error
              ? error.message
              : String(error),
            '',
            'The mutation succeeded. Do NOT repeat it.',
            'Rebuild validation planning with code.validation.plan before final review.',
          ].join('\n'),
        };
      }
    }

    /*
     * Automatically consume objective validation evidence.
     */
    const plan =
      await readPlan(
        this.options.threadId,
      );

    if (
      plan &&
      plan.gates.length
    ) {
      let changed =
        false;

      for (
        const gate
        of plan.gates
      ) {
        const observation =
          gateResult(
            gate,
            call,
            result,
          );

        if (
          !observation
            .matched
        ) {
          continue;
        }

        gate.status =
          observation.passed
            ? 'passed'
            : 'failed';

        gate.evidence =
          observation.evidence;

        gate.updatedAt =
          new Date()
            .toISOString();

        changed = true;
      }

      if (changed) {
        plan.updatedAt =
          new Date()
            .toISOString();

        await persistPlan(
          this.options.threadId,
          plan,
        );

        const remaining =
          plan.gates.filter(
            (gate) =>
              gate.status !==
              'passed',
          );

        return {
          ...result,

          output: [
            result.output ??
              '',
            '',
            'DIFF_VALIDATION_PROGRESS',
            `generation: ${plan.generation}`,
            ...plan.gates.map(
              (gate) =>
                `- ${gate.id}: ${gate.status}`,
            ),
            '',
            remaining.length
              ? `${remaining.length} required validation gate(s) remain.`
              : 'All diff-derived validation gates are satisfied. Final patch review may proceed.',
          ].join('\n'),
        };
      }
    }

    return result;
  }

  private async status():
    Promise<LoopToolResult> {
    const plan =
      await readPlan(
        this.options.threadId,
      );

    if (!plan) {
      return {
        success: false,

        error:
          'validation-plan-not-found',

        output:
          'No diff-aware validation plan exists yet. Call code.validation.plan or perform a real mutation.',
      };
    }

    return {
      success: true,

      output:
        JSON.stringify(
          {
            ...plan,

            readyForReview:
              plan.gates.every(
                (gate) =>
                  gate.status ===
                  'passed',
              ),

            remaining:
              plan.gates.filter(
                (gate) =>
                  gate.status !==
                  'passed',
              ),
          },
          null,
          2,
        ),
    };
  }

  private async rebuild(
    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    try {
      const plan =
        await this.buildPlan(
          signal,
        );

      return {
        success: true,

        output:
          JSON.stringify(
            {
              ...plan,

              readyForReview:
                plan.gates.every(
                  (gate) =>
                    gate.status ===
                    'passed',
                ),
            },
            null,
            2,
          ),

        evidence: [
          {
            kind:
              'diff-validation-plan',

            summary:
              `Built generation ${plan.generation} validation plan for ${plan.changedFiles.length} changed file(s).`,

            detail: {
              categories:
                plan.categories,

              gates:
                plan.gates.map(
                  (gate) =>
                    gate.id,
                ),
            },
          },
        ],
      };
    } catch (error) {
      return {
        success: false,

        error:
          'validation-plan-build-failed',

        output:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  private async buildPlan(
    signal?:
      AbortSignal,
  ): Promise<DiffValidationPlan> {
    const gitTool =
      this.inner
        .listTools()
        .find(
          (tool) =>
            tool.name ===
            'git.run',
        );

    if (!gitTool) {
      throw new Error(
        'git.run is unavailable; actual diff-aware validation planning cannot be built.',
      );
    }

    const statusResult =
      await this.inner.execute(
        gitCall(
          gitTool,

          [
            'status',
            '--short',
            '--untracked-files=all',
          ],
        ),

        signal,
      );

    if (
      !statusResult.success
    ) {
      throw new Error(
        `Unable to inspect Git status: ${statusResult.output}`,
      );
    }

    const diffResult =
      await this.inner.execute(
        gitCall(
          gitTool,

          [
            'diff',
            'HEAD',
            '--no-ext-diff',
            '--unified=0',
            '--relative',
            '--',
          ],
        ),

        signal,
      );

    /*
     * A repository with no HEAD yet may legitimately fail the
     * HEAD diff. Status still gives us the actual changed paths.
     */
    const statusText =
      observableOutput(
        statusResult,
      );

    const diffText =
      diffResult.success
        ? observableOutput(
            diffResult,
          )
        : '';

    const changedFiles =
      parseStatusPaths(
        statusText,
      );

    const previous =
      await readPlan(
        this.options.threadId,
      );

    const plan =
      makePlan(
        previous,
        changedFiles,
        diffText,
        statusText,
      );

    await persistPlan(
      this.options.threadId,
      plan,
    );

    return plan;
  }
}
