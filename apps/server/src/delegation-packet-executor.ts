import type {
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
} from '@dacai-local-agent/agent-core';

import type {
  DelegationTaskPacket,
} from '@dacai-local-agent/orchestrator';

import {
  loadWorkingState,
} from '@dacai-local-agent/context';

import {
  getRepositoryArchitectureMap,
} from '@dacai-local-agent/repository-index';

interface DelegationPacketExecutorOptions {
  threadId: string;
  parentObjective: string;
}

type ExtendedDelegationPacket =
  DelegationTaskPacket & {
    failureEvidence?: unknown[];
    delegatedRole?: string;
  };

function stringArray(
  value: unknown,
  limit = 15,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' &&
          entry.trim().length > 0,
      ),
    ),
  ).slice(0, limit);
}

function expectedResultFor(
  agentId: string,
): string {
  switch (agentId) {
    case 'repo-explorer':
      return 'Return verified repository locations, relevant symbols, architecture facts, and concise evidence. Do not modify code.';

    case 'debugger':
      return 'Identify the root cause from evidence and return the smallest corrective strategy, including exact affected files/symbols.';

    case 'coder':
      return 'Implement the scoped change, preserve existing architecture, and return changed files plus validation evidence.';

    case 'reviewer':
      return 'Review the supplied implementation/diff independently. Return APPROVED or CHANGES_REQUIRED with concise actionable findings.';

    case 'test-engineer':
      return 'Identify and execute the narrowest relevant validation, report exact failures, and distinguish verified results from assumptions.';

    case 'security-reviewer':
      return 'Review the scoped code for security, authorization, trust-boundary, and regression risks. Return evidence-backed findings only.';

    case 'variant-hunter':
      return 'Search for structurally similar instances of the supplied defect or risky pattern and return verified locations.';

    case 'ci-fixer':
      return 'Diagnose the supplied CI failure, identify the responsible implementation, make or recommend the smallest correction, and report verification.';

    default:
      return 'Complete only the delegated objective and return concise evidence, affected files/symbols, result, and any genuine blocker.';
  }
}

function labelFor(
  item: unknown,
): unknown {
  if (typeof item === 'string') {
    return item;
  }

  const record =
    item && typeof item === 'object'
      ? (item as { name?: unknown; path?: unknown })
      : undefined;

  return record?.name ?? record?.path;
}

function compactArchitecture(
  map: unknown,
): string[] {
  if (!map || typeof map !== 'object') {
    return [];
  }

  const record =
    map as {
      fileCount?: unknown;
      symbolCount?: unknown;
      edgeCount?: unknown;
      applications?: unknown;
      packages?: unknown;
    };

  const facts: string[] = [];

  if (record.fileCount !== undefined) {
    facts.push(
      `Indexed repository files: ${record.fileCount}`,
    );
  }

  if (record.symbolCount !== undefined) {
    facts.push(
      `Indexed symbols: ${record.symbolCount}`,
    );
  }

  if (record.edgeCount !== undefined) {
    facts.push(
      `Indexed dependency edges: ${record.edgeCount}`,
    );
  }

  if (Array.isArray(record.applications)) {
    facts.push(
      `Applications: ${record.applications
        .slice(0, 12)
        .map(labelFor)
        .filter(Boolean)
        .join(', ')}`,
    );
  }

  if (Array.isArray(record.packages)) {
    facts.push(
      `Packages: ${record.packages
        .slice(0, 20)
        .map(labelFor)
        .filter(Boolean)
        .join(', ')}`,
    );
  }

  return facts
    .filter(Boolean)
    .slice(0, 12);
}

export class DelegationPacketExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      DelegationPacketExecutorOptions,
  ) {}

  listTools() {
    return this.inner.listTools();
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name !== 'agent.delegate'
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const args = {
      ...(call.arguments ?? {}),
    } as Record<string, unknown>;

    const objective =
      typeof args.objective === 'string'
        ? args.objective.trim()
        : '';

    const agentId =
      typeof args.agentId === 'string'
        ? args.agentId.trim()
        : '';

    if (
      !objective ||
      !agentId
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    let state: unknown = null;

    try {
      state =
        await loadWorkingState(
          this.options.threadId,
        );
    } catch {
      state = null;
    }

    let architecture: unknown = null;

    try {
      architecture =
        await getRepositoryArchitectureMap();
    } catch {
      architecture = null;
    }

    const stateRecord =
      state && typeof state === 'object'
        ? (state as Record<string, unknown>)
        : undefined;

    const inspectedFiles =
      stringArray(
        stateRecord?.inspectedFiles ??
        stateRecord?.inspected_files,
        12,
      );

    const changedFiles =
      stringArray(
        stateRecord?.changedFiles ??
        stateRecord?.changed_files,
        12,
      );

    const relevantFiles =
      Array.from(
        new Set([
          ...changedFiles,
          ...inspectedFiles,
        ]),
      ).slice(0, 16);

    const relevantSymbols =
      stringArray(
        stateRecord?.relevantSymbols ??
        stateRecord?.relevant_symbols,
        18,
      );

    const architectureFacts =
      stringArray(
        stateRecord?.architectureFacts ??
        stateRecord?.architecture_facts,
        12,
      );

    const knownErrorsRaw =
      stateRecord?.knownErrors ??
      stateRecord?.known_errors;

    const knownErrors =
      Array.isArray(knownErrorsRaw)
        ? knownErrorsRaw.slice(-8)
        : [];

    const validationState =
      stateRecord?.validationState ??
      stateRecord?.validation_state ??
      {};

    const repositoryFacts =
      Array.from(
        new Set([
          ...architectureFacts,
          ...compactArchitecture(
            architecture,
          ),
        ]),
      ).slice(0, 16);

    const packet:
      ExtendedDelegationPacket = {
        objective,

        relevantFiles,

        relevantSymbols,

        repositoryFacts,

        constraints: [
          'Stay within the delegated objective.',
          'Do not broaden scope without evidence that it is necessary.',
          'Reuse existing repository architecture and helpers.',
          'Do not claim files, failures, fixes, or validation results without tool evidence.',
          'Respect the existing permission and approval boundary.',
          'Return concise conclusions and evidence; do not return hidden chain-of-thought.',
        ],

        expectedResult:
          expectedResultFor(
            agentId,
          ),

        parentThreadId:
          this.options.threadId,

        delegatedRole:
          agentId,

        failureEvidence:
          knownErrors,
      };

    /*
     * Validation/review state is useful to reviewer,
     * debugger and test workers but should stay bounded.
     */
    const supplemental =
      ['reviewer', 'debugger', 'test-engineer', 'ci-fixer']
        .includes(agentId)
        ? {
            validationState,
          }
        : {};

    const compactObjective = [
      'DELEGATED_TASK_PACKET',
      '',
      JSON.stringify(
        {
          ...packet,
          ...supplemental,
        },
        null,
        2,
      ),
      '',
      'CHILD EXECUTION CONTRACT:',
      '- Treat objective as your complete delegated scope.',
      '- Use relevantFiles and relevantSymbols as starting points, not unverified truth.',
      '- Verify important facts with your own permitted tools.',
      '- Return only the result, evidence, affected locations, and blockers.',
      '- Do not request the full parent conversation unless the delegated objective is genuinely impossible without it.',
    ].join('\n');

    const delegatedCall:
      NormalizedToolCall = {
        ...call,

        arguments: {
          ...args,
          objective:
            compactObjective,
        },
      };

    return this.inner.execute(
      delegatedCall,
      signal,
    );
  }
}
