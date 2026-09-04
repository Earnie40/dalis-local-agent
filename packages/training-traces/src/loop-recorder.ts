import { stripHiddenReasoning } from './capture';
import type { ContextRef, Evidence, TraceSource, TrainingStep } from './types';

/**
 * Turns agent-loop events into trace steps.
 *
 * Two invariants are enforced here rather than left to callers:
 *   1. Hidden reasoning is stripped from every model turn before it is recorded.
 *   2. Only tool results may carry evidence. A model turn is text and nothing
 *      else, so a model's claim can never be promoted into a verification step.
 */

export interface LoopEventLike {
  type: 'model_request' | 'model_response' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'context_compaction' | 'context_refresh' | 'reasoning_mode' | 'validation' | 'budget';
  turn: number;
  content?: string;
  toolCall?: { id?: string; name: string; arguments: Record<string, unknown> };
  result?: {
    output: string;
    success: boolean;
    denied?: boolean;
    error?: string;
    evidence?: Array<{ kind: string; summary: string; detail?: Record<string, unknown> }>;
  };
  message?: string;
  budget?: { mode?: string; turns: number; maxTurns: number; toolCalls: number; maxToolCalls: number; reserveTurns?: number };
}

export interface LoopRecorderOptions {
  source: TraceSource;
  /** References describing the context supplied to the model this run. */
  contextRefs?: ContextRef[];
  /** Tool observations longer than this are summarized in the trace. */
  maxResultSummaryChars?: number;
}

const DEFAULT_SUMMARY_CHARS = 1200;

export class LoopTraceRecorder {
  private readonly steps: TrainingStep[] = [];
  private sequence = 0;
  private strippedReasoningTurns = 0;

  constructor(private readonly options: LoopRecorderOptions) {}

  private next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private now(): string {
    return new Date().toISOString();
  }

  record(event: LoopEventLike): void {
    const limit = this.options.maxResultSummaryChars ?? DEFAULT_SUMMARY_CHARS;

    if (event.type === 'model_response') {
      const { content, stripped } = stripHiddenReasoning(event.content ?? '');
      if (stripped) this.strippedReasoningTurns += 1;

      this.steps.push({
        type: 'model_response',
        sequence: this.next(),
        timestamp: this.now(),
        content,
        hiddenReasoningStripped: stripped,
        // Context references are attached to the first model turn: that is the
        // turn whose input the rest of the trajectory is conditioned on.
        contextRefs: this.sequence === 1 ? this.options.contextRefs : undefined,
      });
      return;
    }

    // Provider-emitted thinking is a UI preview, not training evidence.
    if (event.type === 'thinking') return;

    if (event.type === 'tool_call' && event.toolCall) {
      this.steps.push({
        type: 'tool_call',
        sequence: this.next(),
        timestamp: this.now(),
        toolName: event.toolCall.name,
        toolCallId: event.toolCall.id,
        arguments: event.toolCall.arguments,
      });
      return;
    }

    if (event.type === 'tool_result' && event.toolCall) {
      const result = event.result;
      const evidence: Evidence[] = (result?.evidence ?? []).map((item) => ({
        kind: item.kind as Evidence['kind'],
        summary: item.summary,
        detail: item.detail,
      }));

      this.steps.push({
        type: 'tool_result',
        sequence: this.next(),
        timestamp: this.now(),
        toolName: event.toolCall.name,
        toolCallId: event.toolCall.id,
        success: result?.success ?? false,
        resultSummary: summarize(result?.output ?? '', limit),
        truncated: (result?.output.length ?? 0) > limit,
        evidence: evidence.length ? evidence : undefined,
      });
      return;
    }

    if (
      event.type === 'model_request' ||
      event.type === 'budget' ||
      event.type === 'context_compaction' ||
      event.type === 'context_refresh' ||
      event.type === 'reasoning_mode' ||
      event.type === 'validation'
    ) {
      this.recordRuntimeEvent({ event: event.type === 'model_request' || event.type === 'budget' ? 'phase' : event.type, message: event.message ?? event.type });
      return;
    }

    if (event.type === 'error') {
      this.steps.push({
        type: 'error',
        sequence: this.next(),
        timestamp: this.now(),
        // A provider failure ends the run, so it is high severity by definition.
        severity: 'high',
        message: event.message ?? 'unknown error',
        resolved: false,
      });
    }
  }

  recordRuntimeEvent(input: {
    event: 'phase' | 'checkpoint' | 'context_compaction' | 'context_refresh' | 'reasoning_mode' | 'validation' | 'plan_update' | 'review';
    phase?: string;
    message: string;
  }): void {
    this.steps.push({
      type: 'runtime_event',
      sequence: this.next(),
      timestamp: this.now(),
      event: input.event,
      phase: input.phase,
      message: input.message.slice(0, 1600),
    });
  }

  /** Records a verification step. Only the tool layer may call this. */
  recordVerification(step: {
    command: string;
    exitCode: number;
    stdoutSummary: string;
    stderrSummary: string;
    durationMs: number;
    testCounts?: { passed: number; failed: number; skipped: number };
    buildResult?: 'passed' | 'failed';
  }): void {
    this.steps.push({
      type: 'verification',
      sequence: this.next(),
      timestamp: this.now(),
      ...step,
      evidence: [
        {
          kind: 'exit_code',
          summary: `${step.command} exited ${step.exitCode}`,
          detail: { exitCode: step.exitCode },
        },
      ],
    });
  }

  get strippedTurns(): number {
    return this.strippedReasoningTurns;
  }

  collect(): TrainingStep[] {
    return [...this.steps];
  }
}

function summarize(output: string, limit: number): string {
  if (output.length <= limit) return output;
  return `${output.slice(0, limit)}\n… [${output.length - limit} characters omitted]`;
}
