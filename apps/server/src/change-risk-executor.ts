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

interface RiskOptions {
  threadId: string;
}

type RiskDepth =
  | 'fast'
  | 'standard'
  | 'deep';

interface RiskAssessment {
  kind: 'change_risk_assessment';

  score: number;

  depth: RiskDepth;

  generation: number;

  changedFiles: string[];

  categories: string[];

  additions: number;

  deletions: number;

  reasons: string[];

  requirements: string[];

  assessedAt: string;
}

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const MUTATION_TOOLS =
  new Set([
    'filesystem.edit',
    'filesystem.write',
    'filesystem.move',
    'filesystem.copy',
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
      EMPTY_SCHEMA;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    tool.parameters =
      EMPTY_SCHEMA;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    tool.schema =
      EMPTY_SCHEMA;
  }

  if (
    !('inputSchema' in tool) &&
    !('parameters' in tool) &&
    !('schema' in tool)
  ) {
    tool.inputSchema =
      EMPTY_SCHEMA;
  }

  return tool as unknown as ToolSchema;
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
  gitTool: unknown,
  args: string[],
): NormalizedToolCall {
  const propertiesValue =
    toolSchema(
      gitTool,
    ).properties;

  const properties: Record<string, unknown> =
    propertiesValue && typeof propertiesValue === 'object'
      ? (propertiesValue as Record<string, unknown>)
      : {};

  if (
    'args' in properties
  ) {
    return {
      name: 'git.run',

      arguments: {
        args,
      },
    };
  }

  if (
    'argv' in properties
  ) {
    return {
      name: 'git.run',

      arguments: {
        argv: args,
      },
    };
  }

  if (
    'subcommand' in
    properties
  ) {
    return {
      name: 'git.run',

      arguments: {
        subcommand:
          args[0],

        args:
          args.slice(1),
      },
    };
  }

  return {
    name: 'git.run',

    arguments: {
      command:
        args.join(' '),
    },
  };
}

function outputText(
  result: LoopToolResult,
): string {
  const raw =
    String(
      result.output ??
      '',
    );

  try {
    const parsed =
      JSON.parse(raw);

    return (
      parsed?.stdout ??
      parsed?.output ??
      parsed?.content ??
      raw
    );
  } catch {
    return raw;
  }
}

function parseNumstat(
  text: string,
): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (
    const line
    of text.split(
      /\r?\n/,
    )
  ) {
    const match =
      line.match(
        /^(\d+|-)\s+(\d+|-)\s+/,
      );

    if (!match) {
      continue;
    }

    if (
      match[1] !== '-'
    ) {
      additions +=
        Number(
          match[1],
        );
    }

    if (
      match[2] !== '-'
    ) {
      deletions +=
        Number(
          match[2],
        );
    }
  }

  return {
    additions,
    deletions,
  };
}

function realMutation(
  call: NormalizedToolCall,
  result: LoopToolResult,
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

function categoryWeight(
  category: string,
): number {
  switch (category) {
    case 'security':
      return 25;

    case 'database':
      return 20;

    case 'orchestration':
      return 16;

    case 'api':
      return 13;

    case 'provider':
      return 12;

    case 'tools':
      return 11;

    case 'repository-index':
      return 10;

    case 'config':
      return 7;

    case 'general-code':
      return 6;

    case 'ui':
      return 5;

    case 'tests':
      return 2;

    case 'documentation':
      return 0;

    default:
      return 3;
  }
}

function sensitiveFileScore(
  files: string[],
): {
  score: number;
  reasons: string[];
} {
  let score = 0;

  const reasons:
    string[] = [];

  const rules: Array<{
    pattern: RegExp;
    score: number;
    reason: string;
  }> = [
    {
      pattern:
        /permission|authorization|authentication|approval/i,

      score: 15,

      reason:
        'authorization/permission boundary changed',
    },

    {
      pattern:
        /migration|schema\.prisma|\/db\//i,

      score: 12,

      reason:
        'database schema/persistence boundary changed',
    },

    {
      pattern:
        /agent-loop|task-runner|executor/i,

      score: 10,

      reason:
        'core autonomous execution path changed',
    },

    {
      pattern:
        /provider-registry|ollama-provider|anthropic-provider/i,

      score: 8,

      reason:
        'model/provider routing changed',
    },

    {
      pattern:
        /routes\/agent|routes\/security/i,

      score: 8,

      reason:
        'agent/API control route changed',
    },

    {
      pattern:
        /package\.json|pnpm-lock/i,

      score: 5,

      reason:
        'dependency/runtime configuration changed',
    },
  ];

  for (
    const rule
    of rules
  ) {
    if (
      files.some(
        (file) =>
          rule.pattern.test(
            file,
          ),
      )
    ) {
      score +=
        rule.score;

      reasons.push(
        rule.reason,
      );
    }
  }

  return {
    score,
    reasons,
  };
}

function requirementsFor(
  depth: RiskDepth,
): string[] {
  if (
    depth === 'deep'
  ) {
    return [
      'Use deep reasoning for unresolved implementation/review decisions.',
      'Run all diff-derived validation gates.',
      'Require independent specialist review before final patch review.',
      'Resolve conflicting specialist evidence rather than majority-voting it away.',
      'Review dependency/blast-radius evidence before completion.',
    ];
  }

  if (
    depth ===
    'standard'
  ) {
    return [
      'Use standard reasoning unless failure evidence requires escalation.',
      'Run all diff-derived validation gates.',
      'Inspect current Git diff before final review.',
      'Use specialist review when the affected subsystem is security-sensitive or architecturally central.',
    ];
  }

  return [
    'Use fast reasoning by default.',
    'Run only the diff-derived validation gates.',
    'Avoid unrelated repository-wide verification.',
  ];
}

interface DiffValidationPlanLike {
  changedFiles?: unknown;
  categories?: unknown;
  generation?: unknown;
}

function calculateRisk(
  plan: DiffValidationPlanLike | undefined,
  additions: number,
  deletions: number,
): RiskAssessment {
  const files: string[] =
    Array.isArray(
      plan?.changedFiles,
    )
      ? (plan.changedFiles as string[])
      : [];

  const categories: string[] =
    Array.isArray(
      plan?.categories,
    )
      ? (plan.categories as string[])
      : [];

  let score = 0;

  const reasons:
    string[] = [];

  const changedLines =
    additions +
    deletions;

  if (
    changedLines <= 10
  ) {
    score += 1;
  } else if (
    changedLines <= 40
  ) {
    score += 4;

    reasons.push(
      `${changedLines} changed lines`,
    );
  } else if (
    changedLines <= 120
  ) {
    score += 9;

    reasons.push(
      `${changedLines} changed lines`,
    );
  } else if (
    changedLines <= 300
  ) {
    score += 15;

    reasons.push(
      `${changedLines} changed lines`,
    );
  } else {
    score += 22;

    reasons.push(
      `large diff (${changedLines} changed lines)`,
    );
  }

  if (
    files.length >= 3
  ) {
    score += 4;

    reasons.push(
      `${files.length} changed files`,
    );
  }

  if (
    files.length >= 8
  ) {
    score += 7;
  }

  if (
    files.length >= 15
  ) {
    score += 8;

    reasons.push(
      'cross-cutting file set',
    );
  }

  for (
    const category
    of categories
  ) {
    const weight =
      categoryWeight(
        category,
      );

    score += weight;

    if (
      weight >= 10
    ) {
      reasons.push(
        `${category} boundary affected`,
      );
    }
  }

  const sensitive =
    sensitiveFileScore(
      files,
    );

  score +=
    sensitive.score;

  reasons.push(
    ...sensitive.reasons,
  );

  /*
   * Multiple high-impact subsystem categories compound risk.
   */
  const majorCategories =
    categories.filter(
      (category: string) =>
        categoryWeight(
          category,
        ) >= 10,
    );

  if (
    majorCategories.length >=
    2
  ) {
    score += 10;

    reasons.push(
      'multiple high-impact subsystems changed together',
    );
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score,
      ),
    );

  const depth:
    RiskDepth =
      score >= 55
        ? 'deep'
        : score >= 25
          ? 'standard'
          : 'fast';

  return {
    kind:
      'change_risk_assessment',

    score,

    depth,

    generation:
      Number(
        plan?.generation ??
        0,
      ),

    changedFiles:
      files,

    categories,

    additions,

    deletions,

    reasons:
      Array.from(
        new Set(
          reasons,
        ),
      ),

    requirements:
      requirementsFor(
        depth,
      ),

    assessedAt:
      new Date()
        .toISOString(),
  };
}

export class ChangeRiskExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      RiskOptions,
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
          'code.risk.assess',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.risk.assess',

          'Calculate deterministic change risk from the current diff-validation generation, diff size and affected architectural boundaries, then choose fast, standard or deep validation/review depth.',
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.risk.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.risk.status',

          'Read the most recent deterministic change-risk assessment and required validation/review depth.',
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
      'code.risk.assess'
    ) {
      return this.assess(
        signal,
      );
    }

    if (
      call.name ===
      'code.risk.status'
    ) {
      return this.status();
    }

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    /*
     * Automatically reassess after actual repository mutations
     * and explicit validation-plan rebuilds.
     */
    if (
      realMutation(
        call,
        result,
      ) ||
      (
        call.name ===
          'code.validation.plan' &&
        result.success
      )
    ) {
      try {
        const assessment =
          await this.calculate(
            signal,
          );

        return {
          ...result,

          output: [
            result.output ??
              '',
            '',
            'CHANGE_RISK_ASSESSED',
            `score: ${assessment.score}/100`,
            `depth: ${assessment.depth}`,
            '',
            'Risk factors:',
            ...(
              assessment.reasons.length
                ? assessment.reasons.map(
                    (reason) =>
                      `- ${reason}`,
                  )
                : [
                    '- minimal change surface',
                  ]
            ),
            '',
            'Execution depth:',
            ...assessment.requirements.map(
              (requirement) =>
                `- ${requirement}`,
            ),
          ]
            .filter(Boolean)
            .join('\n'),
        };
      } catch (error) {
        return {
          ...result,

          output: [
            result.output ??
              '',
            '',
            'CHANGE_RISK_ASSESSMENT_STALE',
            error instanceof Error
              ? error.message
              : String(error),
            '',
            'The preceding operation remains successful. Do not repeat it.',
          ].join('\n'),
        };
      }
    }

    return result;
  }

  private async status():
    Promise<LoopToolResult> {
    const state =
      await loadWorkingState(
        this.options.threadId,
      );

    const assessment =
      validationState(
        state,
      ).changeRisk;

    if (!assessment) {
      return {
        success: false,

        error:
          'change-risk-not-assessed',

        output:
          'No current change-risk assessment exists. Call code.risk.assess.',
      };
    }

    return {
      success: true,

      output:
        JSON.stringify(
          assessment,
          null,
          2,
        ),
    };
  }

  private async assess(
    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    try {
      const assessment =
        await this.calculate(
          signal,
        );

      return {
        success: true,

        output:
          JSON.stringify(
            assessment,
            null,
            2,
          ),

        evidence: [
          {
            kind:
              'change-risk',

            summary:
              `Change risk ${assessment.score}/100; validation depth ${assessment.depth}.`,

            detail: {
              score:
                assessment.score,

              depth:
                assessment.depth,

              generation:
                assessment.generation,

              categories:
                assessment.categories,
            },
          },
        ],
      };
    } catch (error) {
      return {
        success: false,

        error:
          'change-risk-assessment-failed',

        output:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  private async calculate(
    signal?:
      AbortSignal,
  ): Promise<RiskAssessment> {
    const state =
      await loadWorkingState(
        this.options.threadId,
      );

    if (!state) {
      throw new Error(
        'Working state is unavailable.',
      );
    }

    const validation =
      validationState(
        state,
      );

    const planValue =
      validation
        .diffValidationPlan;

    if (!planValue) {
      throw new Error(
        'No diff-aware validation plan exists. Build code.validation.plan first.',
      );
    }

    const plan =
      typeof planValue === 'object'
        ? (planValue as DiffValidationPlanLike)
        : undefined;

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
        'git.run is unavailable.',
      );
    }

    const numstatResult =
      await this.inner.execute(
        gitCall(
          gitTool,

          [
            'diff',
            'HEAD',
            '--numstat',
            '--relative',
            '--',
          ],
        ),

        signal,
      );

    const stats =
      numstatResult.success
        ? parseNumstat(
            outputText(
              numstatResult,
            ),
          )
        : {
            additions: 0,
            deletions: 0,
          };

    const assessment =
      calculateRisk(
        plan,
        stats.additions,
        stats.deletions,
      );

    const history =
      Array.isArray(
        validation
          .changeRiskHistory,
      )
        ? validation
            .changeRiskHistory
        : [];

    await saveWorkingState({
      ...(state as Record<string, unknown>),

      threadId:
        this.options.threadId,

      validationState: {
        ...validation,

        changeRisk:
          assessment,

        recommendedReasoningMode:
          assessment.depth,

        validationDepth:
          assessment.depth,

        changeRiskHistory: [
          ...history.slice(
            -19,
          ),

          assessment,
        ],
      },
    } as AgentWorkingState);

    return assessment;
  }
}
