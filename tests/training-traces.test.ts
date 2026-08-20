import { describe, expect, it } from 'vitest';
import {
  classifyTrace,
  computeEligibility,
  deriveOutcome,
  stripHiddenReasoning,
} from '../packages/training-traces/src/capture';
import type { TrainingStep, TrainingTrace } from '../packages/training-traces/src/types';

const provenance = {
  agentPromptVersion: 'v1',
  toolSchemaVersion: 'v1',
  providerInstanceId: 'local_ollama',
  usageClass: 'LOCAL_OLLAMA' as const,
  model: 'qwen2.5-coder:latest',
  modelDigest: 'sha256-60e05f21',
  routerVersion: 'v1',
  configHash: 'abc123',
};

function trace(overrides: Partial<TrainingTrace> = {}): TrainingTrace {
  const steps: TrainingStep[] = [
    { type: 'model_response', sequence: 1, timestamp: 't', content: 'Plan', hiddenReasoningStripped: false },
    { type: 'tool_call', sequence: 2, timestamp: 't', toolName: 'filesystem.read', arguments: {}, toolCallId: 'c1' },
    {
      type: 'verification',
      sequence: 3,
      timestamp: 't',
      command: 'pnpm test',
      exitCode: 0,
      stdoutSummary: '12 passed',
      stderrSummary: '',
      durationMs: 900,
    },
  ];

  return {
    traceId: 'tr_1',
    taskId: 'task_1',
    workspaceId: 'ws_1',
    agentRole: 'coder',
    providerInstanceId: 'local_ollama',
    model: 'qwen2.5-coder:latest',
    taskType: 'code_task',
    objective: 'Fix the failing test',
    constraints: [],
    source: 'mcp',
    startedAt: 't',
    steps,
    classification: 'successful',
    provenance,
    sanitizationPassed: true,
    eligibleForTraining: false,
    outcome: {
      completed: true,
      reverted: false,
      turnCount: 1,
      toolCallCount: 1,
      retryCount: 0,
      durationMs: 1000,
      verificationPassed: true,
    },
    ...overrides,
  };
}

describe('hidden reasoning is never persisted', () => {
  it('strips think blocks from model output', () => {
    const { content, stripped } = stripHiddenReasoning(
      '<think>the user probably wants X, let me reconsider</think>The bug is in parseConfig().',
    );

    expect(content).toBe('The bug is in parseConfig().');
    expect(content).not.toContain('reconsider');
    expect(stripped).toBe(true);
  });

  it('drops an unterminated think block from a truncated stream', () => {
    const { content } = stripHiddenReasoning('Answer first.<think>then rambling that never closed');
    expect(content).toBe('Answer first.');
  });

  it('leaves ordinary output untouched', () => {
    const { content, stripped } = stripHiddenReasoning('Fixed the off-by-one in slice().');
    expect(content).toBe('Fixed the off-by-one in slice().');
    expect(stripped).toBe(false);
  });
});

describe('claims cannot become evidence', () => {
  it('derives outcome flags only from verification steps', () => {
    const claimOnly: TrainingStep[] = [
      {
        type: 'model_response',
        sequence: 1,
        timestamp: 't',
        content: 'Tests should pass now.',
        hiddenReasoningStripped: false,
      },
    ];

    const outcome = deriveOutcome(claimOnly, {
      completed: true,
      reverted: false,
      durationMs: 100,
      retryCount: 0,
    });

    expect(outcome.testsPassed).toBeUndefined();
    expect(outcome.verificationPassed).toBeUndefined();
  });

  it('marks verification passed when the tool layer recorded exit code 0', () => {
    const outcome = deriveOutcome(trace().steps, {
      completed: true,
      reverted: false,
      durationMs: 100,
      retryCount: 0,
    });

    expect(outcome.verificationPassed).toBe(true);
    expect(outcome.toolCallCount).toBe(1);
  });

  it('classifies a failing verification as failed', () => {
    const steps = trace().steps.map((step) =>
      step.type === 'verification' ? { ...step, exitCode: 1 } : step,
    ) as TrainingStep[];

    const outcome = deriveOutcome(steps, { completed: true, reverted: false, durationMs: 1, retryCount: 0 });
    expect(classifyTrace(outcome, steps)).toBe('failed');
  });
});

describe('training eligibility is earned, never assumed', () => {
  it('accepts a completed coding task with objective evidence', () => {
    expect(computeEligibility(trace())).toMatchObject({ eligible: true });
  });

  it('refuses a trace whose sanitization has not passed', () => {
    expect(computeEligibility(trace({ sanitizationPassed: false })).eligible).toBe(false);
  });

  it('refuses casual chat even when it completed', () => {
    expect(computeEligibility(trace({ taskType: 'chat' })).eligible).toBe(false);
  });

  it('refuses a reverted or negatively rated trace', () => {
    expect(
      computeEligibility(
        trace({ outcome: { ...trace().outcome!, reverted: true }, classification: 'reverted' }),
      ).eligible,
    ).toBe(false);

    expect(
      computeEligibility(trace({ humanFeedback: { rating: 'bad', ratedAt: 't' } })).eligible,
    ).toBe(false);
  });

  it('refuses a trace with no objective evidence', () => {
    const noEvidence = trace({
      steps: [
        { type: 'model_response', sequence: 1, timestamp: 't', content: 'Done!', hiddenReasoningStripped: false },
        { type: 'tool_call', sequence: 2, timestamp: 't', toolName: 'filesystem.read', arguments: {}, toolCallId: 'c1' },
      ],
    });

    expect(computeEligibility(noEvidence)).toMatchObject({ eligible: false });
  });

  it('refuses a trace with an unresolved high-severity error', () => {
    const withError = trace({
      steps: [
        ...trace().steps,
        { type: 'error', sequence: 4, timestamp: 't', severity: 'high', message: 'crash', resolved: false },
      ],
    });

    expect(computeEligibility(withError).eligible).toBe(false);
  });

  it('honours a manual override in both directions', () => {
    expect(computeEligibility(trace({ eligibilityOverride: false })).eligible).toBe(false);
    expect(computeEligibility(trace({ taskType: 'chat', eligibilityOverride: true })).eligible).toBe(true);
  });
});
