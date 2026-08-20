import type { TraceClassification, TrainingOutcome, TrainingStep, TrainingTrace, VerificationStep } from './types';

/**
 * Reasoning models (qwen, deepseek-r1 …) emit <think> blocks. They are hidden
 * chain-of-thought and are stripped before anything is persisted — the same
 * removal applied on the way to the user is applied on the way into a trace.
 */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
/** An unterminated block (stream cut short) is dropped from the open tag on. */
const UNTERMINATED_THINK = /<think>[\s\S]*$/i;

export function stripHiddenReasoning(text: string): { content: string; stripped: boolean } {
  const withoutBlocks = text.replace(THINK_BLOCK, '').replace(UNTERMINATED_THINK, '');
  const content = withoutBlocks.trim();
  return { content, stripped: content.length !== text.trim().length };
}

/** Verification steps are the only source of objective outcome flags. */
export function isVerificationStep(step: TrainingStep): step is VerificationStep {
  return step.type === 'test' || step.type === 'verification';
}

/**
 * Derives outcome flags from the trace itself. A model's assertion that tests
 * pass cannot reach these fields: only steps produced by the tool-execution
 * layer are consulted.
 */
export function deriveOutcome(
  steps: TrainingStep[],
  base: Pick<TrainingOutcome, 'completed' | 'reverted' | 'durationMs' | 'retryCount'>,
): TrainingOutcome {
  const verifications = steps.filter(isVerificationStep);
  const testSteps = verifications.filter((step) => step.type === 'test' || step.testCounts);
  const buildSteps = verifications.filter((step) => step.buildResult);

  return {
    ...base,
    testsPassed: testSteps.length ? testSteps.every((step) => step.exitCode === 0) : undefined,
    buildPassed: buildSteps.length ? buildSteps.every((step) => step.buildResult === 'passed') : undefined,
    verificationPassed: verifications.length ? verifications.every((step) => step.exitCode === 0) : undefined,
    turnCount: steps.filter((step) => step.type === 'model_response').length,
    toolCallCount: steps.filter((step) => step.type === 'tool_call').length,
  };
}

export function classifyTrace(
  outcome: TrainingOutcome,
  steps: TrainingStep[],
  aborted = false,
): TraceClassification {
  if (aborted) return 'aborted';
  if (outcome.reverted) return 'reverted';
  if (!outcome.completed) return 'failed';

  const unresolvedHighSeverity = steps.some(
    (step) => step.type === 'error' && step.severity === 'high' && !step.resolved,
  );
  if (unresolvedHighSeverity) return 'partial';
  if (outcome.verificationPassed === false) return 'failed';
  if (outcome.requiredManualFix) return 'partial';

  return 'successful';
}

/** Coding task types eligible for the coding dataset. Chat never qualifies. */
const CODING_TASK_TYPES = new Set([
  'code_task',
  'debug_task',
  'test_task',
  'review_task',
  'explore_repo',
  'refactor',
]);

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

/**
 * Fail-closed. A trace earns eligibility; it is never assumed. Every
 * interaction is NOT training material.
 */
export function computeEligibility(trace: TrainingTrace): EligibilityResult {
  if (trace.eligibilityOverride !== undefined) {
    return {
      eligible: trace.eligibilityOverride,
      reason: 'Manual override.',
    };
  }

  if (!trace.sanitizationPassed) {
    return { eligible: false, reason: 'Sanitization has not passed.' };
  }
  if (!CODING_TASK_TYPES.has(trace.taskType)) {
    return { eligible: false, reason: `Task type "${trace.taskType}" is not a coding task.` };
  }
  if (trace.classification !== 'successful') {
    return { eligible: false, reason: `Classified "${trace.classification}", not successful.` };
  }
  if (!trace.outcome?.completed) {
    return { eligible: false, reason: 'Task did not complete.' };
  }
  if (trace.outcome.reverted) {
    return { eligible: false, reason: 'Work was reverted.' };
  }
  if (trace.humanFeedback?.rating === 'bad') {
    return { eligible: false, reason: 'Human feedback was negative.' };
  }

  const hasObjectiveEvidence = trace.steps.some(
    (step) => isVerificationStep(step) || (step.evidence?.length ?? 0) > 0,
  );
  if (!hasObjectiveEvidence) {
    return { eligible: false, reason: 'No objective evidence recorded.' };
  }

  const unresolvedHighSeverity = trace.steps.some(
    (step) => step.type === 'error' && step.severity === 'high' && !step.resolved,
  );
  if (unresolvedHighSeverity) {
    return { eligible: false, reason: 'Unresolved high-severity error.' };
  }

  const toolActivity = trace.steps.some((step) => step.type === 'tool_call');
  if (!toolActivity) {
    return { eligible: false, reason: 'No tool activity — not an agent trajectory.' };
  }

  return { eligible: true, reason: 'Completed with verified evidence.' };
}
