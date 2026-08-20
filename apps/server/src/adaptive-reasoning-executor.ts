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

export type AdaptiveReasoningMode =
  | 'fast'
  | 'standard'
  | 'deep';

interface AdaptiveReasoningOptions {
  threadId: string;
  objective: string;
}

interface ReasoningSignal {
  kind: string;
  weight: number;
  description: string;
}

const MODE_RANK: Record<
  AdaptiveReasoningMode,
  number
> = {
  fast: 0,
  standard: 1,
  deep: 2,
};

function determineInitialMode(
  objective: string,
): AdaptiveReasoningMode {
  const forced =
    process.env.DACAI_REASONING_DEFAULT
      ?.trim()
      .toLowerCase();

  if (
    forced === 'fast' ||
    forced === 'standard' ||
    forced === 'deep'
  ) {
    return forced;
  }

  const text =
    objective.toLowerCase();

  if (
    /\b(architecture|migration|concurrency|deadlock|race condition|security|permission|authorization|database schema|cross-package|multi-package|distributed|transaction|consistency|state machine)\b/i
      .test(text)
  ) {
    return 'deep';
  }

  if (
    /\b(implement|add|create|modify|change|fix|debug|repair|refactor|update|wire|integrate)\b/i
      .test(text)
  ) {
    return 'standard';
  }

  return 'fast';
}

function isValidationTool(
  name: string,
): boolean {
  return (
    name === 'tests.run' ||
    name === 'code.diagnostics'
  );
}

function outputIncludes(
  result: LoopToolResult,
  text: string,
): boolean {
  return (
    result.output
      ?.toLowerCase()
      .includes(
        text.toLowerCase(),
      ) === true
  );
}

function classifySignals(
  call: NormalizedToolCall,
  result: LoopToolResult,
): ReasoningSignal[] {
  const signals: ReasoningSignal[] =
    [];

  if (
    !result.success &&
    !result.denied
  ) {
    signals.push({
      kind: 'tool-failure',
      weight: 1,
      description:
        `${call.name} failed.`,
    });
  }

  if (
    isValidationTool(call.name) &&
    !result.success
  ) {
    signals.push({
      kind: 'validation-failure',
      weight: 2,
      description:
        `${call.name} reported failed validation.`,
    });
  }

  if (
    outputIncludes(
      result,
      'changes_required',
    )
  ) {
    signals.push({
      kind: 'review-rejection',
      weight: 3,
      description:
        'Independent reviewer requested changes.',
    });
  }

  if (
    call.name ===
      'code.review.record'
  ) {
    const args =
      call.arguments ??
      {};

    if (
      args.verdict ===
      'changes_required'
    ) {
      signals.push({
        kind: 'review-rejection',
        weight: 3,
        description:
          'Final review verdict requires changes.',
      });
    }
  }

  if (
    outputIncludes(
      result,
      'pre_edit_impact_gate',
    ) &&
    (
      result.output?.length ??
      0
    ) > 18000
  ) {
    signals.push({
      kind: 'large-impact-surface',
      weight: 1,
      description:
        'Dependency impact surface is unusually large.',
    });
  }

  if (
    /timeout|timed out|provider-error/i
      .test(
        `${result.error ?? ''} ${
          result.output ?? ''
        }`,
      )
  ) {
    signals.push({
      kind: 'runtime-instability',
      weight: 1,
      description:
        'Runtime/provider instability occurred.',
    });
  }

  return signals;
}

function guidance(
  mode: AdaptiveReasoningMode,
): string {
  switch (mode) {
    case 'fast':
      return [
        'ACTIVE REASONING MODE: FAST',
        'Use targeted repository evidence.',
        'Avoid unnecessary exploration.',
        'Prefer the shortest correct tool path.',
      ].join('\n');

    case 'standard':
      return [
        'ACTIVE REASONING MODE: STANDARD',
        'Verify assumptions before editing.',
        'Inspect relevant implementation and dependency context.',
        'Prefer a minimal patch and targeted validation.',
        'Use failure evidence rather than guessing.',
      ].join('\n');

    case 'deep':
      return [
        'ACTIVE REASONING MODE: DEEP',
        'Re-evaluate important assumptions before the next mutation.',
        'Inspect architecture, callers, callees, references, affected tests, and relevant configuration when applicable.',
        'Distinguish root cause from symptoms.',
        'Consider compatibility, state, concurrency, security, and cross-package effects where relevant.',
        'Prefer a small evidence-backed correction over speculative broad rewriting.',
        'Do not expose or request hidden chain-of-thought; produce only actionable conclusions and tool-backed evidence.',
      ].join('\n');
  }
}

export class AdaptiveReasoningExecutor
implements ToolExecutor {
  private mode:
    AdaptiveReasoningMode;

  private score = 0;

  private failureCount = 0;

  private announced = false;

  private signals:
    ReasoningSignal[] = [];

  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      AdaptiveReasoningOptions,
  ) {
    this.mode =
      determineInitialMode(
        options.objective,
      );

    this.score =
      this.mode === 'deep'
        ? 4
        : this.mode === 'standard'
          ? 2
          : 0;
  }

  listTools() {
    return this.inner.listTools();
  }

  getMode():
    AdaptiveReasoningMode {
    return this.mode;
  }

  getScore(): number {
    return this.score;
  }

  private desiredMode():
    AdaptiveReasoningMode {
    if (
      this.score >= 4 ||
      this.failureCount >= 3
    ) {
      return 'deep';
    }

    if (
      this.score >= 2 ||
      this.failureCount >= 1
    ) {
      return 'standard';
    }

    return 'fast';
  }

  private escalate(
    signals: ReasoningSignal[],
  ): boolean {
    for (const signal of signals) {
      this.score +=
        signal.weight;

      this.signals.push(
        signal,
      );
    }

    if (
      signals.some(
        (signal) =>
          signal.kind ===
            'tool-failure' ||
          signal.kind ===
            'validation-failure',
      )
    ) {
      this.failureCount += 1;
    }

    const desired =
      this.desiredMode();

    if (
      MODE_RANK[desired] >
      MODE_RANK[this.mode]
    ) {
      this.mode = desired;
      return true;
    }

    return false;
  }

  private async persist():
    Promise<void> {
    try {
      const state =
        await loadWorkingState(
          this.options.threadId,
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

      await saveWorkingState({
        ...stateRecord,

        threadId:
          this.options.threadId,

        validationState: {
          ...validationState,

          adaptiveReasoning: {
            mode:
              this.mode,

            score:
              this.score,

            failureCount:
              this.failureCount,

            signals:
              this.signals.slice(
                -20,
              ),

            updatedAt:
              new Date()
                .toISOString(),
          },
        },
      } as AgentWorkingState);
    } catch (error) {
      console.warn(
        'Unable to persist adaptive reasoning state:',
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
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

    const signals =
      classifySignals(
        call,
        result,
      );

    const escalated =
      this.escalate(
        signals,
      );

    await this.persist();

    const shouldAnnounce =
      !this.announced ||
      escalated;

    if (!shouldAnnounce) {
      return result;
    }

    this.announced = true;

    const reasonText =
      signals.length
        ? [
            '',
            'Escalation signals:',
            ...signals.map(
              (item) =>
                `- ${item.kind}: ${item.description}`,
            ),
          ].join('\n')
        : '';

    return {
      ...result,

      output: [
        result.output ?? '',
        '',
        'ADAPTIVE_REASONING_STATE',
        guidance(
          this.mode,
        ),
        reasonText,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}

