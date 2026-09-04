import {
  basename,
  dirname,
  resolve,
} from 'node:path';

import {
  createId,
} from '@dacai-local-agent/shared';

import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';
import { extractChangedPaths, isMutationTool } from '@dacai-local-agent/agent-core';

import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

import {
  refreshSemanticIndex,
} from './incremental-index-refresh';

interface TransactionOptions {
  threadId: string;
  workspaceRoot: string;
}

interface TransactionEntry {
  path: string;
  existedBefore: boolean;
  backupPath: string | null;
  preHash: string | null;
  postHash: string | null;
  size?: number;
}

interface TransactionRecord {
  id: string;

  status:
    | 'active'
    | 'rollback_recommended'
    | 'rolled_back'
    | 'rollback_failed'
    | 'committed';

  entries:
    TransactionEntry[];

  mutationCount: number;

  validationFailures: number;

  createdAt: string;

  updatedAt: string;

  rollbackReason?: string;
}

interface CommitGateLike {
  id?: unknown;
  status?: unknown;
}

interface ConflictLike {
  path?: unknown;
  expected?: unknown;
  observed?: unknown;
}

const STATUS_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties:
    false,
};

const REASON_SCHEMA = {
  type: 'object',

  properties: {
    reason: {
      type: 'string',
    },
  },

  additionalProperties:
    false,
};

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
  toolSchema: Record<string, unknown>,
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
      toolSchema;
  }

  if (
    baseRecord &&
    'parameters' in baseRecord
  ) {
    result.parameters =
      toolSchema;
  }

  if (
    baseRecord &&
    'schema' in baseRecord
  ) {
    result.schema =
      toolSchema;
  }

  if (
    !('inputSchema' in result) &&
    !('parameters' in result) &&
    !('schema' in result)
  ) {
    result.inputSchema =
      toolSchema;
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

async function activeTransaction(
  threadId: string,
): Promise<
  TransactionRecord |
  undefined
> {
  const state =
    await loadWorkingState(
      threadId,
    );

  const txValue =
    validationState(
      state,
    ).activeTransaction;

  const tx =
    txValue && typeof txValue === 'object'
      ? (txValue as TransactionRecord)
      : undefined;

  if (
    tx &&
    (
      tx.status ===
        'active' ||
      tx.status ===
        'rollback_recommended'
    )
  ) {
    return tx;
  }

  return undefined;
}

async function persistTransaction(
  threadId: string,
  transaction:
    TransactionRecord |
    null,
  historyEntry?: Record<string, unknown>,
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

  const history =
    Array.isArray(
      validation
        .transactionHistory,
    )
      ? validation
          .transactionHistory
      : [];

  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};

  await saveWorkingState({
    ...stateRecord,

    threadId,

    validationState: {
      ...validation,

      activeTransaction:
        transaction,

      transactionHistory:
        historyEntry
          ? [
              ...history.slice(
                -19,
              ),

              historyEntry,
            ]
          : history,
    },
  } as AgentWorkingState);
}

function mutationPaths(
  call:
    NormalizedToolCall,
): string[] {
  if (
    !isMutationTool(call.name)
  ) {
    return [];
  }

  return extractChangedPaths(call.name, call.arguments ?? {});
}

function commandKey(
  tool: unknown,
): string {
  const propertiesValue =
    schema(tool)
      .properties;

  const properties: Record<string, unknown> =
    propertiesValue && typeof propertiesValue === 'object'
      ? (propertiesValue as Record<string, unknown>)
      : {};

  for (
    const candidate
    of [
      'command',
      'cmd',
      'script',
    ]
  ) {
    if (
      candidate in
      properties
    ) {
      return candidate;
    }
  }

  return 'command';
}

function quoted(
  value: string,
): string {
  return `"${value.replace(
    /"/g,
    '""',
  )}"`;
}

function psLiteral(
  value: string,
): string {
  return (
    "'" +
    value.replace(
      /'/g,
      "''",
    ) +
    "'"
  );
}

function helperReport(
  output: string,
): unknown {
  const match =
    output.match(
      /DACAI_TRANSACTION_JSON:([A-Za-z0-9_-]+)/,
    );

  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(
      Buffer.from(
        match[1],
        'base64url',
      ).toString(
        'utf8',
      ),
    );
  } catch {
    return undefined;
  }
}

interface HashReportEntry {
  path: string;
  hash?: string | null;
}

function hashMap(
  report: unknown,
): Map<
  string,
  string | null
> {
  const entries =
    report && typeof report === 'object'
      ? (report as { entries?: unknown }).entries
      : undefined;

  return new Map(
    (
      Array.isArray(
        entries,
      )
        ? (entries as HashReportEntry[])
        : []
    ).map(
      (entry) => [
        entry.path,
        entry.hash ??
          null,
      ],
    ),
  );
}

function outputReferencesFiles(
  output: string,
  entries:
    TransactionEntry[],
): boolean {
  const text =
    output
      .replace(
        /\\/g,
        '/',
      )
      .toLowerCase();

  return entries.some(
    (entry) => {
      const path =
        entry.path
          .replace(
            /\\/g,
            '/',
          )
          .toLowerCase();

      const name =
        basename(path)
          .toLowerCase();

      return (
        text.includes(path) ||
        (
          name.length >=
            5 &&
          text.includes(name)
        )
      );
    },
  );
}

function copyCall(
  tool: unknown,
  source: string,
  destination: string,
): NormalizedToolCall {
  const propertiesValue =
    schema(tool)
      .properties;

  const properties: Record<string, unknown> =
    propertiesValue && typeof propertiesValue === 'object'
      ? (propertiesValue as Record<string, unknown>)
      : {};

  const args:
    Record<
      string,
      unknown
    > = {};

  if (
    'source' in
    properties
  ) {
    args.source =
      source;
  } else if (
    'from' in
    properties
  ) {
    args.from =
      source;
  } else if (
    'sourcePath' in
    properties
  ) {
    args.sourcePath =
      source;
  } else {
    args.source =
      source;
  }

  if (
    'destination' in
    properties
  ) {
    args.destination =
      destination;
  } else if (
    'to' in
    properties
  ) {
    args.to =
      destination;
  } else if (
    'destinationPath' in
    properties
  ) {
    args.destinationPath =
      destination;
  } else if (
    'target' in
    properties
  ) {
    args.target =
      destination;
  } else {
    args.destination =
      destination;
  }

  return {
    name:
      'filesystem.copy',

    arguments:
      args,
  };
}

export class TransactionalMutationExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      TransactionOptions,
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
          'code.transaction.status',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.transaction.status',

          'Read the currently active transactional mutation recovery point and its tracked files.',

          STATUS_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.transaction.rollback',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.transaction.rollback',

          'Guardedly restore only files owned by the current mutation transaction. Rollback refuses to overwrite files whose current fingerprints differ from the transaction output.',

          REASON_SCHEMA,
        ),
      );
    }

    if (
      !existing.some(
        (tool) =>
          tool.name ===
          'code.transaction.commit',
      )
    ) {
      additions.push(
        virtualTool(
          base,

          'code.transaction.commit',

          'Commit the current mutation transaction after its required validation evidence has passed.',

          REASON_SCHEMA,
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
      'code.transaction.status'
    ) {
      return this.status();
    }

    if (
      call.name ===
      'code.transaction.rollback'
    ) {
      return this.rollback(
        typeof call.arguments
          ?.reason ===
          'string'
          ? call.arguments
              .reason
          : 'Explicit agent rollback request.',

        signal,
      );
    }

    if (
      call.name ===
      'code.transaction.commit'
    ) {
      return this.commit(
        typeof call.arguments
          ?.reason ===
          'string'
          ? call.arguments
              .reason
          : 'Validated transaction committed.',

        signal,
      );
    }

    const paths =
      mutationPaths(
        call,
      );

    /*
     * Non-mutation calls execute normally, then may influence
     * transaction state.
     */
    if (
      paths.length === 0
    ) {
      const result =
        await this.inner.execute(
          call,
          signal,
        );

      return this.observeValidation(
        call,
        result,
        signal,
      );
    }

    const shell =
      this.inner
        .listTools()
        .find(
          (tool) =>
            tool.name ===
            'shell.run',
        );

    /*
     * Do not silently claim transactional safety when the
     * underlying authorized shell capability is unavailable.
     */
    if (!shell) {
      return {
        success: false,

        error:
          'transaction-snapshot-unavailable',

        output:
          'A repository mutation was requested but transactional snapshot support requires the authorized shell.run capability.',
      };
    }

    const existing =
      await activeTransaction(
        this.options.threadId,
      );

    const transactionId =
      existing?.id ??
      createId(
        'txn',
      );

    const alreadyTracked =
      new Set(
        (
          existing?.entries ??
          []
        ).map(
          (entry) =>
            entry.path
              .replace(
                /\\/g,
                '/',
              ),
        ),
      );

    const newPaths =
      paths.filter(
        (path) =>
          !alreadyTracked.has(
            path.replace(
              /\\/g,
              '/',
            ),
          ),
      );

    let snapshotEntries:
      TransactionEntry[] =
        [];

    if (
      newPaths.length
    ) {
      const snapshotResult =
        await this.helper(
          {
            operation:
              'snapshot',

            transactionId,

            paths:
              newPaths,
          },

          signal,
        );

      if (
        !snapshotResult.success
      ) {
        return {
          success: false,

          denied:
            snapshotResult.denied,

          error:
            'transaction-snapshot-failed',

          output: [
            'TRANSACTION_SNAPSHOT_FAILED',
            snapshotResult.output,
            '',
            'The requested repository mutation was NOT executed.',
          ].join(
            '\n',
          ),
        };
      }

      const reportValue =
        helperReport(
          snapshotResult.output,
        );

      const report =
        reportValue && typeof reportValue === 'object'
          ? (reportValue as { entries?: unknown })
          : undefined;

      snapshotEntries =
        Array.isArray(
          report?.entries,
        )
          ? (report.entries as TransactionEntry[])
          : [];
    }

    /*
     * Fingerprint immediately before this particular mutation
     * attempt. This distinguishes a no-op impact gate from a
     * real mutation to an already-tracked transaction file.
     */
    const beforeResult =
      await this.helper(
        {
          operation:
            'fingerprint',

          paths,
        },

        signal,
      );

    if (
      !beforeResult.success
    ) {
      return {
        success: false,

        denied:
          beforeResult.denied,

        error:
          'transaction-fingerprint-failed',

        output: [
          'Unable to establish the pre-mutation fingerprint.',
          'The requested mutation was NOT executed.',
          beforeResult.output,
        ].join(
          '\n',
        ),
      };
    }

    const before =
      hashMap(
        helperReport(
          beforeResult.output,
        ),
      );

    const result =
      await this.inner.execute(
        call,
        signal,
      );

    const afterResult =
      await this.helper(
        {
          operation:
            'fingerprint',

          paths,
        },

        signal,
      );

    if (
      !afterResult.success
    ) {
      return {
        ...result,

        output: [
          result.output ??
            '',
          '',
          'TRANSACTION_POST_FINGERPRINT_FAILED',
          'The operation may have mutated repository state.',
          'Do not repeat the mutation blindly.',
          afterResult.output,
        ].join(
          '\n',
        ),
      };
    }

    const after =
      hashMap(
        helperReport(
          afterResult.output,
        ),
      );

    const changedPaths =
      paths.filter(
        (path) => {
          const normalized =
            path.replace(
              /\\/g,
              '/',
            );

          return (
            (
              before.get(
                normalized,
              ) ??
              null
            ) !==
            (
              after.get(
                normalized,
              ) ??
              null
            )
          );
        },
      );

    /*
     * Example: first ImpactAwareExecutor call returned its
     * pre-edit gate and no actual source changed.
     */
    if (
      changedPaths.length ===
      0
    ) {
      if (!existing) {
        await this.cleanup(
          transactionId,
          signal,
        );
      }

      return result;
    }

    const entryMap =
      new Map<
        string,
        TransactionEntry
      >();

    for (
      const entry
      of existing?.entries ??
      []
    ) {
      entryMap.set(
        entry.path,
        {
          ...entry,
        },
      );
    }

    for (
      const entry
      of snapshotEntries
    ) {
      if (
        !entryMap.has(
          entry.path,
        )
      ) {
        entryMap.set(
          entry.path,
          {
            ...entry,
          },
        );
      }
    }

    /*
     * Post-hash always advances to the newest transaction-owned
     * output. The original pre-image never changes.
     */
    for (
      const [
        path,
        entry,
      ]
      of entryMap
    ) {
      if (
        after.has(
          path,
        )
      ) {
        entry.postHash =
          after.get(path) ??
          null;
      } else {
        const fingerprint =
          await this.helper(
            {
              operation:
                'fingerprint',

              paths: [
                path,
              ],
            },

            signal,
          );

        if (
          fingerprint.success
        ) {
          entry.postHash =
            hashMap(
              helperReport(
                fingerprint.output,
              ),
            ).get(
              path,
            ) ??
            null;
        }
      }
    }

    const now =
      new Date()
        .toISOString();

    const transaction:
      TransactionRecord = {
        id:
          transactionId,

        status:
          'active',

        entries:
          Array.from(
            entryMap.values(),
          ),

        mutationCount:
          (
            existing
              ?.mutationCount ??
            0
          ) + 1,

        validationFailures:
          existing
            ?.validationFailures ??
          0,

        createdAt:
          existing
            ?.createdAt ??
          now,

        updatedAt:
          now,
      };

    await persistTransaction(
      this.options.threadId,
      transaction,
    );

    /*
     * If a mutation tool reported failure but fingerprints prove
     * it partially changed repository state, rollback immediately.
     */
    if (
      !result.success
    ) {
      const rollback =
        await this.rollback(
          `Mutation tool ${call.name} failed after changing repository state.`,

          signal,
        );

      return {
        ...result,

        output: [
          result.output ??
            '',
          '',
          'PARTIAL_MUTATION_DETECTED',
          ...changedPaths.map(
            (path) =>
              `- ${path}`,
          ),
          '',
          rollback.output,
        ].join(
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
        'TRANSACTION_ACTIVE',
        `id: ${transaction.id}`,
        `mutations: ${transaction.mutationCount}`,
        'Recovery point preserves the exact pre-transaction contents of:',
        ...transaction.entries.map(
          (entry) =>
            `- ${entry.path}`,
        ),
      ].join(
        '\n',
      ),

      evidence: [
        ...(
          result.evidence ??
          []
        ),

        {
          kind:
            'mutation-transaction',

          summary:
            `Repository mutation protected by transaction ${transaction.id}.`,

          detail: {
            transactionId:
              transaction.id,

            paths:
              transaction.entries.map(
                (entry) =>
                  entry.path,
              ),

            mutationCount:
              transaction.mutationCount,
          },
        },
      ],
    };
  }

  private async observeValidation(
    call:
      NormalizedToolCall,

    result:
      LoopToolResult,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    const transaction =
      await activeTransaction(
        this.options.threadId,
      );

    if (!transaction) {
      return result;
    }

    /*
     * Successful final independent review commits the recovery
     * transaction.
     */
    if (
      call.name ===
        'code.review.record' &&
      result.success
    ) {
      const verdict =
        String(
          call.arguments
            ?.verdict ??
          '',
        ).toLowerCase();

      if (
        verdict ===
          'approved' ||
        verdict ===
          'pass' ||
        verdict ===
          'passed'
      ) {
        const committed =
          await this.commit(
            'Independent final patch review approved the transaction.',

            signal,
          );

        return {
          ...result,

          output: [
            result.output ??
              '',
            '',
            committed.output,
          ].join(
            '\n',
          ),
        };
      }
    }

    if (
      (
        call.name !==
          'code.diagnostics' &&
        call.name !==
          'tests.run'
      ) ||
      result.success ||
      result.denied
    ) {
      return result;
    }

    /*
     * Do not rollback merely because some unrelated/pre-existing
     * repository check is failing.
     */
    if (
      !outputReferencesFiles(
        result.output ??
          '',
        transaction.entries,
      )
    ) {
      return result;
    }

    transaction.validationFailures +=
      1;

    transaction.status =
      'rollback_recommended';

    transaction.updatedAt =
      new Date()
        .toISOString();

    await persistTransaction(
      this.options.threadId,
      transaction,
    );

    const state =
      await loadWorkingState(
        this.options.threadId,
      );

    const currentValidation =
      validationState(
        state,
      );

    const changeRisk =
      currentValidation.changeRisk &&
      typeof currentValidation.changeRisk === 'object'
        ? (currentValidation.changeRisk as { depth?: unknown })
        : undefined;

    const depth =
      changeRisk
        ?.depth ??
      currentValidation.validationDepth ??
      'standard';

    /*
     * One validation failure should normally be repaired.
     * Two transaction-attributable failures after attempted
     * correction indicate the branch is unstable enough for
     * guarded automatic rollback.
     */
    if (
      transaction
        .validationFailures >=
        2 &&
      depth !==
        'fast'
    ) {
      const rollback =
        await this.rollback(
          `${call.name} failed repeatedly with diagnostics referencing transaction-owned files.`,

          signal,
        );

      return {
        ...result,

        output: [
          result.output ??
            '',
          '',
          'REPEATED_TRANSACTION_VALIDATION_FAILURE',
          `count: ${transaction.validationFailures}`,
          `risk depth: ${depth}`,
          '',
          rollback.output,
        ].join(
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
        'TRANSACTION_ROLLBACK_RECOMMENDED',
        `validation failures: ${transaction.validationFailures}`,
        'The failure directly references transaction-owned files.',
        'Repair the implementation once before rollback is automatically considered.',
      ].join(
        '\n',
      ),
    };
  }

  private async status():
    Promise<LoopToolResult> {
    const transaction =
      await activeTransaction(
        this.options.threadId,
      );

    if (!transaction) {
      return {
        success: true,

        output:
          JSON.stringify(
            {
              active:
                false,
            },
            null,
            2,
          ),
      };
    }

    return {
      success: true,

      output:
        JSON.stringify(
          {
            active:
              true,

            transaction,
          },
          null,
          2,
        ),
    };
  }

  private async commit(
    reason: string,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    const transaction =
      await activeTransaction(
        this.options.threadId,
      );

    if (!transaction) {
      return {
        success: true,

        output:
          'No active mutation transaction requires commit.',
      };
    }

    const state =
      await loadWorkingState(
        this.options.threadId,
      );

    const planValue =
      validationState(
        state,
      ).diffValidationPlan;

    const plan =
      planValue && typeof planValue === 'object'
        ? (planValue as { gates?: unknown })
        : undefined;

    const remaining: CommitGateLike[] =
      Array.isArray(
        plan?.gates,
      )
        ? (plan.gates as CommitGateLike[]).filter(
            (gate) =>
              gate.status !==
              'passed',
          )
        : [];

    if (
      remaining.length
    ) {
      return {
        success: false,

        error:
          'transaction-validation-incomplete',

        output: [
          'TRANSACTION_COMMIT_BLOCKED',
          '',
          'Required validation still remains:',
          ...remaining.map(
            (gate) =>
              `- ${gate.id}: ${gate.status}`,
          ),
        ].join(
          '\n',
        ),
      };
    }

    transaction.status =
      'committed';

    transaction.updatedAt =
      new Date()
        .toISOString();

    await persistTransaction(
      this.options.threadId,
      null,

      {
        ...transaction,
        commitReason:
          reason,
      },
    );

    await this.cleanup(
      transaction.id,
      signal,
    );

    return {
      success: true,

      output: [
        'TRANSACTION_COMMITTED',
        `id: ${transaction.id}`,
        `reason: ${reason}`,
        'Recovery snapshots released.',
      ].join(
        '\n',
      ),

      evidence: [
        {
          kind:
            'mutation-transaction-commit',

          summary:
            `Mutation transaction ${transaction.id} committed.`,

          detail: {
            transactionId:
              transaction.id,

            mutationCount:
              transaction.mutationCount,
          },
        },
      ],
    };
  }

  private async rollback(
    reason: string,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
    const transaction =
      await activeTransaction(
        this.options.threadId,
      );

    if (!transaction) {
      return {
        success: false,

        error:
          'no-active-transaction',

        output:
          'No active mutation transaction is available for rollback.',
      };
    }

    /*
     * Critical conflict guard:
     *
     * Nothing is restored unless every current file still
     * matches the last output produced by this transaction.
     */
    const verifyResult =
      await this.helper(
        {
          operation:
            'verify',

          entries:
            transaction.entries,
        },

        signal,
      );

    if (
      !verifyResult.success
    ) {
      return {
        success: false,

        error:
          'rollback-verification-failed',

        output: [
          'TRANSACTION_ROLLBACK_REFUSED',
          verifyResult.output,
        ].join(
          '\n',
        ),
      };
    }

    const verificationValue =
      helperReport(
        verifyResult.output,
      );

    const verification =
      verificationValue && typeof verificationValue === 'object'
        ? (verificationValue as { safe?: unknown; conflicts?: unknown })
        : undefined;

    if (
      verification
        ?.safe !==
      true
    ) {
      transaction.status =
        'rollback_failed';

      transaction.rollbackReason =
        'Current workspace differs from the transaction post-image.';

      transaction.updatedAt =
        new Date()
          .toISOString();

      await persistTransaction(
        this.options.threadId,
        transaction,
      );

      return {
        success: false,

        error:
          'transaction-conflict',

        output: [
          'TRANSACTION_ROLLBACK_REFUSED',
          '',
          'One or more transaction files changed after the agent recovery point.',
          'Rollback will not overwrite newer user/agent work.',
          '',
          ...(
            (
              Array.isArray(verification?.conflicts)
                ? verification.conflicts
                : []
            ) as ConflictLike[]
          ).map(
            (conflict) =>
              `- ${conflict.path}: expected ${conflict.expected ?? '<absent>'}, observed ${conflict.observed ?? '<absent>'}`,
          ),
        ].join(
          '\n',
        ),
      };
    }

    const copyTool =
      this.inner
        .listTools()
        .find(
          (tool) =>
            tool.name ===
            'filesystem.copy',
        );

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
          'rollback-shell-unavailable',

        output:
          'Rollback cannot proceed because shell.run is unavailable.',
      };
    }

    const restored:
      string[] = [];

    /*
     * Reverse order is safer for move/copy chains.
     */
    for (
      const entry
      of [
        ...transaction.entries,
      ].reverse()
    ) {
      if (
        entry.existedBefore
      ) {
        if (
          !entry.backupPath
        ) {
          return {
            success: false,

            error:
              'transaction-backup-missing',

            output:
              `Backup path is missing for "${entry.path}".`,
          };
        }

        let restoreResult:
          LoopToolResult;

        if (copyTool) {
          restoreResult =
            await this.inner.execute(
              copyCall(
                copyTool,
                entry.backupPath,
                entry.path,
              ),

              signal,
            );
        } else {
          const parent =
            dirname(
              resolve(
                this.options
                  .workspaceRoot,

                entry.path,
              ),
            );

          const command =
            [
              'powershell',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              quoted(
                `$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path ${psLiteral(parent)} | Out-Null; Copy-Item -LiteralPath ${psLiteral(entry.backupPath)} -Destination ${psLiteral(resolve(this.options.workspaceRoot, entry.path))} -Force`,
              ),
            ].join(
              ' ',
            );

          restoreResult =
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

        if (
          !restoreResult.success
        ) {
          transaction.status =
            'rollback_failed';

          transaction.rollbackReason =
            `Restore failed for ${entry.path}.`;

          await persistTransaction(
            this.options.threadId,
            transaction,
          );

          return {
            success: false,

            error:
              'rollback-restore-failed',

            output: [
              'TRANSACTION_ROLLBACK_PARTIAL',
              `Failed restoring: ${entry.path}`,
              restoreResult.output ??
                '',
              '',
              'Do not perform another broad rollback. Inspect current file fingerprints first.',
            ].join(
              '\n',
            ),
          };
        }

        restored.push(
          entry.path,
        );

        continue;
      }

      /*
       * File did not exist before this transaction.
       * Remove exactly that file; no git clean/reset.
       */
      const absolute =
        resolve(
          this.options
            .workspaceRoot,

          entry.path,
        );

      const command =
        [
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          quoted(
            `$ErrorActionPreference='Stop'; if (Test-Path -LiteralPath ${psLiteral(absolute)}) { Remove-Item -LiteralPath ${psLiteral(absolute)} -Force }`,
          ),
        ].join(
          ' ',
        );

      const removeResult =
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

      if (
        !removeResult.success
      ) {
        transaction.status =
          'rollback_failed';

        transaction.rollbackReason =
          `Removal failed for transaction-created file ${entry.path}.`;

        await persistTransaction(
          this.options.threadId,
          transaction,
        );

        return {
          success: false,

          error:
            'rollback-remove-failed',

          output: [
            'TRANSACTION_ROLLBACK_PARTIAL',
            `Failed removing transaction-created file: ${entry.path}`,
            removeResult.output ??
              '',
          ].join(
            '\n',
          ),
        };
      }

      restored.push(
        entry.path,
      );
    }

    /*
     * Ensure semantic repository intelligence describes the
     * restored source, not the abandoned transaction output.
     */
    try {
      await refreshSemanticIndex(
        this.options
          .workspaceRoot,

        transaction.entries.map(
          (entry) =>
            entry.path,
        ),

        signal,
      );
    } catch {
      /*
       * Rollback itself remains authoritative. The agent is told
       * to use direct source inspection if semantic refresh fails.
       */
    }

    transaction.status =
      'rolled_back';

    transaction.rollbackReason =
      reason;

    transaction.updatedAt =
      new Date()
        .toISOString();

    await persistTransaction(
      this.options.threadId,
      null,

      {
        ...transaction,

        restored,
      },
    );

    await this.cleanup(
      transaction.id,
      signal,
    );

    /*
     * Recalculate actual remaining workspace diff after restore.
     * This preserves any changes that were already present before
     * the transaction.
     */
    if (
      this.inner
        .listTools()
        .some(
          (tool) =>
            tool.name ===
            'code.validation.plan',
        )
    ) {
      await this.inner.execute(
        {
          name:
            'code.validation.plan',

          arguments: {},
        },

        signal,
      ).catch(
        () => undefined,
      );
    }

    return {
      success: true,

      output: [
        'TRANSACTION_ROLLED_BACK',
        `id: ${transaction.id}`,
        `reason: ${reason}`,
        '',
        'Restored transaction-owned paths:',
        ...restored.map(
          (path) =>
            `- ${path}`,
        ),
        '',
        'Pre-existing unrelated workspace changes were not reset or stashed.',
      ].join(
        '\n',
      ),

      evidence: [
        {
          kind:
            'mutation-transaction-rollback',

          summary:
            `Guardedly rolled back transaction ${transaction.id}.`,

          detail: {
            transactionId:
              transaction.id,

            paths:
              restored,

            reason,
          },
        },
      ],
    };
  }

  private async helper(
    request:
      Record<
        string,
        unknown
      >,

    signal?:
      AbortSignal,
  ): Promise<LoopToolResult> {
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
          'shell.run is unavailable.',
      };
    }

    const payload =
      Buffer.from(
        JSON.stringify({
          ...request,

          workspaceRoot:
            this.options
              .workspaceRoot,
        }),

        'utf8',
      ).toString(
        'base64url',
      );

    const script =
      resolve(
        this.options
          .workspaceRoot,

        'scripts',
        'transaction-snapshot.mjs',
      );

    return this.inner.execute(
      {
        name:
          'shell.run',

        arguments: {
          [
            commandKey(
              shell,
            )
          ]:
            [
              'node',
              quoted(
                script,
              ),
              '--payload',
              payload,
            ].join(
              ' ',
            ),
        },
      },

      signal,
    );
  }

  private async cleanup(
    transactionId:
      string,

    signal?:
      AbortSignal,
  ): Promise<void> {
    try {
      await this.helper(
        {
          operation:
            'cleanup',

          transactionId,
        },

        signal,
      );
    } catch {
      /*
       * A stale internal recovery backup is safer than deleting
       * source. Cleanup failure does not invalidate commit/
       * rollback correctness.
       */
    }
  }
}
