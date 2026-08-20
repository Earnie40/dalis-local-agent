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

interface EnvironmentRecoveryOptions {
  threadId: string;
}

type RecoveryStrategy =
  | 'install_dependencies'
  | 'regenerate_prisma'
  | 'ensure_frontend';

type EnvironmentIssueKind =
  | 'missing_dependency'
  | 'generated_client_stale'
  | 'frontend_unavailable'
  | 'database_unavailable'
  | 'missing_environment'
  | 'port_conflict'
  | 'permission_problem'
  | 'runtime_missing';

interface EnvironmentIssue {
  id: string;

  kind:
    EnvironmentIssueKind;

  originTool: string;

  summary: string;

  recoverable: boolean;

  strategies:
    RecoveryStrategy[];

  requiresConfiguration:
    boolean;

  attempts: number;

  observedAt: string;

  lastOutput: string;

  resolvedAt?: string;
}

interface RecoveryRecord {
  issueId: string;

  strategy:
    RecoveryStrategy;

  success: boolean;

  attemptedAt: string;

  output: string;
}

const STATUS_SCHEMA = {
  type: 'object',

  properties: {},

  additionalProperties:
    false,
};

const APPLY_SCHEMA = {
  type: 'object',

  properties: {
    strategy: {
      type: 'string',

      enum: [
        'install_dependencies',
        'regenerate_prisma',
        'ensure_frontend',
      ],
    },
  },

  required: [
    'strategy',
  ],

  additionalProperties:
    false,
};

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
  schema:
    Record<string, unknown>,
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
      schema;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      schema;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      schema;
  }

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

function schema(
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

function commandKey(
  tool: unknown,
): string {
  const properties =
    schema(tool)
      .properties ??
    {};

  for (
    const key
    of [
      'command',
      'cmd',
      'script',
    ]
  ) {
    if (
      key in
      (properties as object)
    ) {
      return key;
    }
  }

  return 'command';
}

function issueId(
  tool: string,
  kind:
    EnvironmentIssueKind,
  output: string,
): string {
  return createHash(
    'sha256',
  )
    .update(
      [
        tool,
        kind,
        output.slice(
          0,
          4000,
        ),
      ].join(
        '\n',
      ),
    )
    .digest(
      'hex',
    )
    .slice(
      0,
      20,
    );
}

function classifyIssue(
  call:
    NormalizedToolCall,

  result:
    LoopToolResult,
): Omit<
  EnvironmentIssue,
  | 'id'
  | 'attempts'
  | 'observedAt'
  | 'lastOutput'
> | undefined {
  if (
    result.success ||
    result.denied
  ) {
    return undefined;
  }

  const output =
    [
      result.error ??
        '',
      result.output ??
        '',
    ]
      .join(
        '\n',
      )
      .slice(
        0,
        12_000,
      );

  /*
   * Secrets/configuration are classified before generic
   * database/network failures.
   */
  if (
    /environment variable.*(?:not found|missing|required)|missing required environment variable|DATABASE_URL.*(?:missing|not set|undefined)|(?:API_KEY|TOKEN|SECRET|PASSWORD).*(?:missing|not set|required)/i
      .test(output)
  ) {
    return {
      kind:
        'missing_environment',

      originTool:
        call.name,

      summary:
        'Required runtime configuration or secret-bearing environment state is missing.',

      recoverable:
        false,

      strategies: [],

      requiresConfiguration:
        true,
    };
  }

  if (
    /(?:postgres|postgresql|database).*(?:connection refused|could not connect|unavailable|not reachable|ECONNREFUSED)|ECONNREFUSED[^\n]*(?:5432|5433)|connect ECONNREFUSED[^\n]*(?:5432|5433)/i
      .test(output)
  ) {
    return {
      kind:
        'database_unavailable',

      originTool:
        call.name,

      summary:
        'The configured PostgreSQL/database service is unavailable.',

      recoverable:
        false,

      strategies: [],

      requiresConfiguration:
        true,
    };
  }

  if (
    /@prisma\/client did not initialize|prisma client.*(?:not generated|generate)|could not locate.*query engine|query_engine.*(?:missing|not found)|generated[\\/]+prisma.*(?:missing|not found)/i
      .test(output)
  ) {
    return {
      kind:
        'generated_client_stale',

      originTool:
        call.name,

      summary:
        'Generated Prisma/client artifacts appear missing or stale.',

      recoverable:
        true,

      strategies: [
        'regenerate_prisma',
      ],

      requiresConfiguration:
        false,
    };
  }

  /*
   * Limit dependency recovery to package-like/non-relative
   * module failures. A missing ./local-file is normally code,
   * not an install problem.
   */
  if (
    /ERR_MODULE_NOT_FOUND|Cannot find package|Module not found/i
      .test(output) ||
    /Cannot find module ['"](?:@[^/'"]+\/[^'"]+|[a-zA-Z][^./'"][^'"]*)['"]/i
      .test(output) ||
    /TS2307.*Cannot find module ['"](?:@[^/'"]+\/[^'"]+|[a-zA-Z][^./'"][^'"]*)['"]/i
      .test(output)
  ) {
    return {
      kind:
        'missing_dependency',

      originTool:
        call.name,

      summary:
        'A package/workspace dependency appears unavailable from the current installation.',

      recoverable:
        true,

      strategies: [
        'install_dependencies',
      ],

      requiresConfiguration:
        false,
    };
  }

  if (
    /EADDRINUSE|address already in use/i
      .test(output)
  ) {
    return {
      kind:
        'port_conflict',

      originTool:
        call.name,

      summary:
        'A required local port is already occupied.',

      recoverable:
        call.name.startsWith(
          'browser.',
        ) ||
        call.name.startsWith(
          'app.local.',
        ),

      strategies:
        call.name.startsWith(
          'browser.',
        ) ||
        call.name.startsWith(
          'app.local.',
        )
          ? [
              'ensure_frontend',
            ]
          : [],

      requiresConfiguration:
        false,
    };
  }

  if (
    /(?:ECONNREFUSED|ERR_CONNECTION_REFUSED|connection refused)[^\n]*(?:localhost|127\.0\.0\.1|5173|3000|4173|4321)|(?:localhost|127\.0\.0\.1)[^\n]*(?:ECONNREFUSED|ERR_CONNECTION_REFUSED)/i
      .test(output)
  ) {
    return {
      kind:
        'frontend_unavailable',

      originTool:
        call.name,

      summary:
        'The localhost frontend required for browser verification is unavailable.',

      recoverable:
        true,

      strategies: [
        'ensure_frontend',
      ],

      requiresConfiguration:
        false,
    };
  }

  if (
    /\b(?:pnpm|node|npm|git)\b.*(?:not recognized|not found|ENOENT)|spawn .* ENOENT/i
      .test(output)
  ) {
    return {
      kind:
        'runtime_missing',

      originTool:
        call.name,

      summary:
        'A required host runtime executable is unavailable.',

      recoverable:
        false,

      strategies: [],

      requiresConfiguration:
        true,
    };
  }

  if (
    /\bEACCES\b|\bEPERM\b|permission denied|access is denied/i
      .test(output)
  ) {
    return {
      kind:
        'permission_problem',

      originTool:
        call.name,

      summary:
        'Host filesystem/process permissions prevented the operation.',

      recoverable:
        false,

      strategies: [],

      requiresConfiguration:
        true,
    };
  }

  return undefined;
}

async function currentIssue(
  threadId: string,
): Promise<
  EnvironmentIssue |
  undefined
> {
  const state =
    await loadWorkingState(
      threadId,
    );

  const recovery =
    validationState(
      state,
    ).environmentRecovery;

  const latestIssue =
    recovery && typeof recovery === 'object'
      ? (recovery as { latestIssue?: unknown }).latestIssue
      : undefined;

  return latestIssue && typeof latestIssue === 'object'
    ? (latestIssue as EnvironmentIssue)
    : undefined;
}

async function persistIssue(
  threadId: string,
  issue:
    EnvironmentIssue,
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

  const recoveryValue =
    validation.environmentRecovery;

  const recovery: Record<string, unknown> =
    recoveryValue && typeof recoveryValue === 'object'
      ? (recoveryValue as Record<string, unknown>)
      : {};

  const history =
    Array.isArray(
      recovery.issueHistory,
    )
      ? recovery.issueHistory
      : [];

  const stateRecord =
    state as Record<string, unknown>;

  await saveWorkingState({
    ...stateRecord,

    threadId,

    validationState: {
      ...validation,

      environmentRecovery: {
        ...recovery,

        latestIssue:
          issue,

        issueHistory: [
          ...history.slice(
            -29,
          ),

          issue,
        ],
      },
    },
  } as AgentWorkingState);
}

async function persistRecovery(
  threadId: string,
  issue:
    EnvironmentIssue,
  record:
    RecoveryRecord,
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

  const recoveryValue =
    validation.environmentRecovery;

  const recovery: Record<string, unknown> =
    recoveryValue && typeof recoveryValue === 'object'
      ? (recoveryValue as Record<string, unknown>)
      : {};

  const records =
    Array.isArray(
      recovery
        .recoveryHistory,
    )
      ? recovery
          .recoveryHistory
      : [];

  const stateRecord =
    state as Record<string, unknown>;

  await saveWorkingState({
    ...stateRecord,

    threadId,

    validationState: {
      ...validation,

      environmentRecovery: {
        ...recovery,

        latestIssue:
          issue,

        latestRecovery:
          record,

        recoveryHistory: [
          ...records.slice(
            -29,
          ),

          record,
        ],
      },
    },
  } as AgentWorkingState);
}

export class EnvironmentRecoveryExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      EnvironmentRecoveryOptions,
  ) {}

  listTools() {
    const existing =
      this.inner.listTools();

    const base =
      existing.find(
        (tool) =>
          tool.name ===
          'shell.run',
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
          'env.recovery.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'env.recovery.status',

          'Read the most recent classified dependency/environment problem and available bounded recovery strategies.',

          STATUS_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'env.recovery.apply',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'env.recovery.apply',

          'Apply one bounded recovery strategy for the currently observed dependency/environment failure. Recovery still passes through the existing permission-controlled tool stack.',

          APPLY_SCHEMA,
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
      'env.recovery.status'
    ) {
      return this.status();
    }

    if (
      call.name ===
      'env.recovery.apply'
    ) {
      return this.apply(
        call,
        signal,
      );
    }

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    /*
     * A later successful rerun of the same operation resolves
     * the prior environment issue.
     */
    if (
      result.success
    ) {
      const issue =
        await currentIssue(
          this.options.threadId,
        );

      if (
        issue &&
        !issue.resolvedAt &&
        issue.originTool ===
          call.name
      ) {
        issue.resolvedAt =
          new Date()
            .toISOString();

        await persistIssue(
          this.options.threadId,
          issue,
        );
      }

      return result;
    }

    const classification =
      classifyIssue(
        call,
        result,
      );

    if (!classification) {
      /*
       * Failure did not look environmental. Leave it for normal
       * debugger/replanning logic rather than disguising it as
       * setup recovery.
       */
      return result;
    }

    const previous =
      await currentIssue(
        this.options.threadId,
      );

    const output =
      [
        result.error ??
          '',
        result.output ??
          '',
      ]
        .join(
          '\n',
        )
        .slice(
          0,
          8000,
        );

    const id =
      issueId(
        call.name,
        classification.kind,
        output,
      );

    const attempts =
      previous?.id === id
        ? previous.attempts
        : 0;

    const issue:
      EnvironmentIssue = {
        id,

        ...classification,

        attempts,

        observedAt:
          new Date()
            .toISOString(),

        lastOutput:
          output,
      };

    await persistIssue(
      this.options.threadId,
      issue,
    );

    if (
      !issue.recoverable
    ) {
      return {
        ...result,

        output: [
          result.output ??
            '',
          '',
          'ENVIRONMENT_BLOCKER_CLASSIFIED',
          `kind: ${issue.kind}`,
          `summary: ${issue.summary}`,
          '',
          issue.requiresConfiguration
            ? 'This requires real environment/configuration state. Do not fabricate values or route around the failure.'
            : 'No bounded automatic recovery is available.',
          '',
          issue.kind ===
            'database_unavailable'
            ? 'Do not automatically apply migrations, create a database, or change DATABASE_URL merely because connectivity failed.'
            : '',
          issue.kind ===
            'missing_environment'
            ? 'Discover existing configuration sources if available, but never invent credentials, API keys, tokens, passwords, or connection strings.'
            : '',
        ]
          .filter(Boolean)
          .join(
            '\n',
          ),
      };
    }

    return {
      ...result,

      output: [
        result.output ??
          '',
        '',
        'ENVIRONMENT_RECOVERY_AVAILABLE',
        `kind: ${issue.kind}`,
        `summary: ${issue.summary}`,
        `attempts: ${issue.attempts}`,
        '',
        'Bounded recovery strategies:',
        ...issue.strategies.map(
          (strategy) =>
            `- ${strategy}`,
        ),
        '',
        issue.attempts >= 2
          ? 'The same environment recovery has already been attempted repeatedly. Do not loop. Inspect the underlying environment or classify it as blocked.'
          : 'Use env.recovery.apply with one listed strategy, then rerun only the operation that actually failed.',
        '',
        'A successful recovery does not prove the original test/build/diagnostic passed.',
      ]
        .filter(Boolean)
        .join(
          '\n',
        ),
    };
  }

  private async status():
    Promise<LoopToolResult> {
    const state =
      await loadWorkingState(
        this.options.threadId,
      );

    const recovery =
      validationState(
        state,
      ).environmentRecovery;

    return {
      success: true,

      output:
        JSON.stringify(
          recovery ?? {
            latestIssue:
              null,

            latestRecovery:
              null,
          },
          null,
          2,
        ),
    };
  }

  private async apply(
    call:
      NormalizedToolCall,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    const strategy =
      call.arguments
        ?.strategy;

    if (
      strategy !==
        'install_dependencies' &&
      strategy !==
        'regenerate_prisma' &&
      strategy !==
        'ensure_frontend'
    ) {
      return {
        success: false,

        error:
          'invalid-recovery-strategy',

        output:
          'env.recovery.apply requires a supported recovery strategy.',
      };
    }

    const issue =
      await currentIssue(
        this.options.threadId,
      );

    if (!issue) {
      return {
        success: false,

        error:
          'no-environment-issue',

        output:
          'No classified environment issue is currently available for recovery.',
      };
    }

    if (
      issue.resolvedAt
    ) {
      return {
        success: false,

        error:
          'environment-issue-already-resolved',

        output:
          'The latest environment issue is already resolved.',
      };
    }

    if (
      !issue.recoverable ||
      !issue.strategies.includes(
        strategy,
      )
    ) {
      return {
        success: false,

        denied: true,

        error:
          'recovery-strategy-not-authorized-for-issue',

        output: [
          `Strategy "${strategy}" is not valid for environment issue "${issue.kind}".`,
          '',
          `Allowed strategies: ${issue.strategies.join(', ') || 'none'}`,
        ].join(
          '\n',
        ),
      };
    }

    if (
      issue.attempts >= 2
    ) {
      return {
        success: false,

        error:
          'environment-recovery-loop-prevented',

        output: [
          'ENVIRONMENT_RECOVERY_LOOP_PREVENTED',
          '',
          `Issue: ${issue.kind}`,
          'The same bounded recovery has already been attempted twice.',
          'Do not keep reinstalling/regenerating/restarting the same environment component.',
          'Inspect the actual underlying configuration or mark the dependency as blocked.',
        ].join(
          '\n',
        ),
      };
    }

    let recoveryResult:
      LoopToolResult;

    if (
      strategy ===
      'ensure_frontend'
    ) {
      const available =
        this.inner
          .listTools()
          .some(
            (tool) =>
              tool.name ===
              'app.local.ensure',
          );

      if (!available) {
        return {
          success: false,

          error:
            'local-app-lifecycle-unavailable',

          output:
            'app.local.ensure is unavailable, so the bounded frontend recovery cannot run.',
        };
      }

      recoveryResult =
        await this.inner.execute(
          {
            name:
              'app.local.ensure',

            arguments: {},
          },

          signal,
        );
    } else {
      const shell =
        this.inner
          .listTools()
          .find(
            (tool) =>
              tool.name ===
              'shell.run',
          );

      if (!shell) {
        return {
          success: false,

          error:
            'shell-run-unavailable',

          output:
            'The bounded recovery requires the authorized shell.run capability.',
        };
      }

      const command =
        strategy ===
          'install_dependencies'
          ? 'pnpm install --frozen-lockfile'
          : 'pnpm exec prisma generate';

      recoveryResult =
        await this.inner.execute(
          {
            name:
              'shell.run',

            arguments: {
              [
                commandKey(
                  shell,
                )
              ]:
                command,
            },
          },

          signal,
        );
    }

    issue.attempts +=
      1;

    const record:
      RecoveryRecord = {
        issueId:
          issue.id,

        strategy,

        success:
          recoveryResult.success,

        attemptedAt:
          new Date()
            .toISOString(),

        output:
          String(
            recoveryResult.output ??
            '',
          ).slice(
            0,
            8000,
          ),
      };

    await persistRecovery(
      this.options.threadId,
      issue,
      record,
    );

    if (
      !recoveryResult.success
    ) {
      return {
        ...recoveryResult,

        output: [
          recoveryResult.output ??
            '',
          '',
          'ENVIRONMENT_RECOVERY_FAILED',
          `strategy: ${strategy}`,
          `attempt: ${issue.attempts}`,
          '',
          issue.attempts >= 2
            ? 'Automatic recovery for this issue is now exhausted. Do not repeat the same recovery.'
            : 'Inspect this recovery failure before trying another permitted strategy.',
        ].join(
          '\n',
        ),
      };
    }

    return {
      success: true,

      output: [
        recoveryResult.output ??
          '',
        '',
        'ENVIRONMENT_RECOVERY_APPLIED',
        `issue: ${issue.kind}`,
        `strategy: ${strategy}`,
        `attempt: ${issue.attempts}`,
        '',
        `Rerun the original failed operation: ${issue.originTool}`,
        'Do not claim the original validation/build/test succeeded until that operation itself returns successful evidence.',
      ].join(
        '\n',
      ),

      evidence: [
        ...(
          recoveryResult.evidence ??
          []
        ),

        {
          kind:
            'environment-recovery',

          summary:
            `Applied ${strategy} for ${issue.kind}.`,

          detail: {
            issueId:
              issue.id,

            strategy,

            originTool:
              issue.originTool,

            attempt:
              issue.attempts,
          },
        },
      ],
    };
  }
}
