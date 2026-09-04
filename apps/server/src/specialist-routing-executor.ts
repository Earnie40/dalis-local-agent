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

export type SpecialistId =
  | 'repo-explorer'
  | 'debugger'
  | 'coder'
  | 'reviewer'
  | 'test-engineer'
  | 'security-reviewer'
  | 'variant-hunter'
  | 'ci-fixer';

interface SpecialistRoutingOptions {
  threadId: string;
  parentObjective: string;
}

interface RouteDecision {
  agentId: SpecialistId;
  score: number;
  reasons: string[];
}

interface ScoreEntry {
  score: number;
  reasons: string[];
}

const SPECIALISTS: SpecialistId[] = [
  'repo-explorer',
  'debugger',
  'coder',
  'reviewer',
  'test-engineer',
  'security-reviewer',
  'variant-hunter',
  'ci-fixer',
];

function makeScores():
  Record<SpecialistId, ScoreEntry> {
  return {
    'repo-explorer': { score: 0, reasons: [] },
    debugger: { score: 0, reasons: [] },
    coder: { score: 0, reasons: [] },
    reviewer: { score: 0, reasons: [] },
    'test-engineer': { score: 0, reasons: [] },
    'security-reviewer': { score: 0, reasons: [] },
    'variant-hunter': { score: 0, reasons: [] },
    'ci-fixer': { score: 0, reasons: [] },
  };
}

function add(
  scores:
    Record<SpecialistId, ScoreEntry>,
  agentId: SpecialistId,
  weight: number,
  reason: string,
): void {
  scores[agentId].score +=
    weight;

  scores[agentId].reasons.push(
    reason,
  );
}

function textMatches(
  text: string,
  pattern: RegExp,
): boolean {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function arrayLength(
  value: unknown,
): number {
  return Array.isArray(value)
    ? value.length
    : 0;
}

function chooseSpecialist(
  objective: string,
  parentObjective: string,
  state: unknown,
): RouteDecision {
  const stateRecord =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : undefined;
  const scores =
    makeScores();

  const text = [
    parentObjective,
    objective,
  ]
    .join('\n')
    .toLowerCase();

  /*
   * Repository exploration and architecture.
   */
  if (
    textMatches(
      text,
      /\b(find|locate|where|inspect|explore|trace|architecture|repository structure|dependency graph|understand implementation)\b/i,
    )
  ) {
    add(
      scores,
      'repo-explorer',
      4,
      'Task emphasizes repository discovery or architecture.',
    );
  }

  /*
   * Debugging / root-cause work.
   */
  if (
    textMatches(
      text,
      /\b(debug|bug|failure|failed|exception|error|crash|broken|root cause|regression|unexpected|not working)\b/i,
    )
  ) {
    add(
      scores,
      'debugger',
      5,
      'Task contains failure or root-cause signals.',
    );
  }

  /*
   * Implementation.
   */
  if (
    textMatches(
      text,
      /\b(implement|create|add|modify|change|update|wire|integrate|refactor|replace|patch|build feature|write code)\b/i,
    )
  ) {
    add(
      scores,
      'coder',
      5,
      'Task requests implementation or code modification.',
    );
  }

  /*
   * Final/code review.
   */
  if (
    textMatches(
      text,
      /\b(review|reviewer|git diff|final patch|regression review|code review|approve|approval|changes_required)\b/i,
    )
  ) {
    add(
      scores,
      'reviewer',
      6,
      'Task explicitly concerns patch or implementation review.',
    );
  }

  /*
   * Tests / diagnostics / verification.
   */
  if (
    textMatches(
      text,
      /\b(test|tests|testing|typecheck|type check|diagnostic|validate|validation|verify|vitest|jest|build failure|compile|lint)\b/i,
    )
  ) {
    add(
      scores,
      'test-engineer',
      5,
      'Task emphasizes validation or testing.',
    );
  }

  /*
   * Security review.
   */
  if (
    textMatches(
      text,
      /\b(security|authorization|authentication|permission|privilege|secret|credential|token exposure|injection|tenant isolation|trust boundary|vulnerability|unsafe|scope bypass)\b/i,
    )
  ) {
    add(
      scores,
      'security-reviewer',
      8,
      'Task contains security or authorization concerns.',
    );
  }

  /*
   * Search for related defect variants.
   */
  if (
    textMatches(
      text,
      /\b(variant|similar issue|similar bug|same pattern|other occurrences|other instances|find all occurrences|systemic pattern)\b/i,
    )
  ) {
    add(
      scores,
      'variant-hunter',
      7,
      'Task asks for structurally similar instances.',
    );
  }

  /*
   * CI-specific work.
   */
  if (
    textMatches(
      text,
      /\b(ci|github actions|workflow failure|pipeline|continuous integration|build pipeline|action failure|runner failure)\b/i,
    )
  ) {
    add(
      scores,
      'ci-fixer',
      8,
      'Task concerns CI or pipeline failure.',
    );
  }

  const knownErrors =
    stateRecord?.knownErrors ??
    stateRecord?.known_errors;

  const errorCount =
    arrayLength(
      knownErrors,
    );

  if (errorCount > 0) {
    add(
      scores,
      'debugger',
      Math.min(
        4,
        errorCount,
      ),
      `${errorCount} recorded failure(s) exist in parent working state.`,
    );
  }

  const validationValue =
    stateRecord?.validationState ??
    stateRecord?.validation_state;

  const validation: Record<string, unknown> =
    validationValue && typeof validationValue === 'object'
      ? (validationValue as Record<string, unknown>)
      : {};

  const reviewValue = validation.review;

  const review =
    reviewValue && typeof reviewValue === 'object'
      ? (reviewValue as { status?: unknown })
      : undefined;

  const reviewStatus = review?.status;

  if (
    reviewStatus ===
    'changes_required'
  ) {
    add(
      scores,
      'coder',
      5,
      'Independent review currently requires implementation changes.',
    );

    add(
      scores,
      'debugger',
      2,
      'Reviewer rejection may require root-cause analysis.',
    );
  }

  if (
    reviewStatus ===
    'approved'
  ) {
    add(
      scores,
      'reviewer',
      -4,
      'Current patch already has reviewer approval.',
    );
  }

  const validationRequired =
    validation?.required ===
    true;

  const diagnostics =
    validation?.['code.diagnostics'];
  const diagnosticsRecord =
    diagnostics && typeof diagnostics === 'object'
      ? (diagnostics as Record<string, unknown>)
      : undefined;

  const tests =
    validation?.['tests.run'];
  const testsRecord =
    tests && typeof tests === 'object'
      ? (tests as Record<string, unknown>)
      : undefined;

  const diagnosticsPassed =
    diagnosticsRecord?.success === true;

  const testsPassed =
    testsRecord?.success === true;

  if (
    validationRequired &&
    !diagnosticsPassed &&
    !testsPassed
  ) {
    add(
      scores,
      'test-engineer',
      4,
      'Working state requires validation that has not yet passed.',
    );
  }

  const changedFiles =
    stateRecord?.changedFiles ??
    stateRecord?.changed_files;

  if (
    arrayLength(changedFiles) > 0 &&
    textMatches(
      text,
      /\b(review|check|inspect patch|final)\b/i,
    )
  ) {
    add(
      scores,
      'reviewer',
      3,
      'Parent run contains changed files ready for review.',
    );
  }

  /*
   * Stable fallback:
   * if nothing strongly classified the work,
   * repository exploration is safer than speculative mutation.
   */
  const highest =
    Math.max(
      ...SPECIALISTS.map(
        (id) =>
          scores[id].score,
      ),
    );

  if (highest <= 0) {
    add(
      scores,
      'repo-explorer',
      1,
      'No stronger specialist signal exists; inspect first.',
    );
  }

  /*
   * Deterministic tie-breaking. Higher-risk/specialized roles
   * win ties before generic coding/exploration.
   */
  const priority:
    SpecialistId[] = [
      'security-reviewer',
      'ci-fixer',
      'reviewer',
      'variant-hunter',
      'test-engineer',
      'debugger',
      'coder',
      'repo-explorer',
    ];

  const selected =
    [...SPECIALISTS]
      .sort(
        (a, b) => {
          const difference =
            scores[b].score -
            scores[a].score;

          if (difference !== 0) {
            return difference;
          }

          return (
            priority.indexOf(a) -
            priority.indexOf(b)
          );
        },
      )[0];

  return {
    agentId: selected,
    score:
      scores[selected].score,
    reasons:
      scores[selected].reasons,
  };
}

export class SpecialistRoutingExecutor
implements ToolExecutor {
  constructor(
    private readonly inner:
      ToolExecutor,

    private readonly options:
      SpecialistRoutingOptions,
  ) {}

  listTools() {
    return this.inner.listTools();
  }

  async execute(
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    if (
      call.name !==
      'agent.delegate'
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const args = {
      ...(call.arguments ?? {}),
    } as Record<
      string,
      unknown
    >;

    const requestedAgentId =
      typeof args.agentId ===
      'string'
        ? args.agentId.trim()
        : '';

    /*
     * Explicit specialist selection remains authoritative.
     * Only "auto" or a missing agentId activates routing.
     */
    if (
      requestedAgentId &&
      requestedAgentId !==
        'auto'
    ) {
      return this.inner.execute(
        call,
        signal,
      );
    }

    const objective =
      typeof args.objective ===
      'string'
        ? args.objective.trim()
        : '';

    let state: any =
      null;

    try {
      state =
        await loadWorkingState(
          this.options.threadId,
        );
    } catch {
      state = null;
    }

    const decision =
      chooseSpecialist(
        objective,
        this.options
          .parentObjective,
        state,
      );

    args.agentId =
      decision.agentId;

    /*
     * Preserve routing provenance in durable state.
     */
    if (state) {
      try {
        const validationState =
          state.validationState ??
          state.validation_state ??
          {};

        const existing =
          Array.isArray(
            validationState
              .specialistRouting,
          )
            ? validationState
                .specialistRouting
            : [];

        await saveWorkingState({
          ...(state as any),

          threadId:
            this.options.threadId,

          validationState: {
            ...validationState,

            specialistRouting: [
              ...existing.slice(
                -19,
              ),

              {
                requested:
                  requestedAgentId ||
                  'auto',

                selected:
                  decision.agentId,

                score:
                  decision.score,

                reasons:
                  decision.reasons,

                objective:
                  objective.slice(
                    0,
                    1200,
                  ),

                routedAt:
                  new Date()
                    .toISOString(),
              },
            ],
          },
        } as any);
      } catch (error) {
        console.warn(
          'Unable to persist specialist route:',
          error instanceof Error
            ? error.message
            : String(error),
        );
      }
    }

    const routedCall:
      NormalizedToolCall = {
        ...call,

        arguments: args,
      };

    const result =
      await this.inner.execute(
        routedCall,
        signal,
      );

    return {
      ...result,

      output: [
        'SPECIALIST_ROUTE',
        `requested: ${
          requestedAgentId ||
          'auto'
        }`,
        `selected: ${decision.agentId}`,
        `score: ${decision.score}`,
        ...decision.reasons.map(
          (reason) =>
            `reason: ${reason}`,
        ),
        '',
        result.output ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
}
