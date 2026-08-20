import type { UsageClass } from '@dacai-local-agent/shared';

/**
 * Training traces are lossless, sanitized, reproducible trajectories captured
 * for future LoRA/QLoRA fine-tuning of local coding models. They are kept
 * separate from telemetry on purpose: telemetry is lossy hot-path aggregation
 * that may be dropped, while a trace carries an eligibility state machine, a
 * secret-scrubbing gate, and versioned provenance.
 *
 * HARD RULE — no hidden chain-of-thought is ever recorded. Only observable
 * operational data and concise final model output. Reasoning models emit
 * <think> blocks; those are stripped before persistence (see stripHiddenReasoning).
 * Nothing here ever records or solicits a supervising model's private reasoning.
 */

export type TraceStepType =
  | 'model_response'
  | 'tool_call'
  | 'tool_result'
  | 'file_edit'
  | 'test'
  | 'verification'
  | 'runtime_event'
  | 'error';

export type TraceClassification = 'successful' | 'failed' | 'partial' | 'reverted' | 'aborted';

export type TraceSource = 'ui' | 'mcp' | 'internal';

export type HumanRating = 'good' | 'bad' | 'partial';

/**
 * What was actually supplied to the model for a turn. References, not repository
 * dumps: bytes are reconstructible from the workspace at the recorded commit.
 */
export interface ContextRef {
  kind: 'file' | 'diff' | 'memory' | 'tool_result' | 'system_prompt' | 'instruction';
  path?: string;
  startLine?: number;
  endLine?: number;
  /** sha256 of the referenced content, so an example can be reproduced later. */
  sha256?: string;
  /** Commit the reference resolves against, where the workspace is a git repo. */
  commit?: string;
  memoryId?: string;
  toolResultId?: string;
  bytes?: number;
}

/** A piece of objective evidence produced by the tool layer, never by a model. */
export interface Evidence {
  kind: 'exit_code' | 'test_counts' | 'build_result' | 'diff' | 'http_status' | 'browser_observation' | 'file_hash';
  summary: string;
  /** Content-addressed artifact on local disk when the payload is large. */
  artifactSha256?: string;
  detail?: Record<string, unknown>;
}

interface TraceStepBase {
  sequence: number;
  timestamp: string;
  contextRefs?: ContextRef[];
  files?: string[];
  evidence?: Evidence[];
  /** Concise human/model-readable summary. Never hidden reasoning. */
  resultSummary?: string;
}

/**
 * Final visible model output only. A model claim ("tests should pass") can only
 * ever land here — it can never become evidence, because nothing in the write
 * path lets a model author a verification step.
 */
export interface ModelResponseStep extends TraceStepBase {
  type: 'model_response';
  /** Post-strip visible text. <think> blocks are removed before persistence. */
  content: string;
  hiddenReasoningStripped: boolean;
}

export interface ToolCallStep extends TraceStepBase {
  type: 'tool_call';
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolResultStep extends TraceStepBase {
  type: 'tool_result';
  toolName: string;
  toolCallId?: string;
  success: boolean;
  truncated?: boolean;
}

/** Structured patch, not the whole resulting file. */
export interface FileEditStep extends TraceStepBase {
  type: 'file_edit';
  path: string;
  beforeHash: string;
  afterHash: string;
  /** Inline for small diffs; large ones live in the artifact store. */
  unifiedDiff?: string;
  diffArtifactSha256?: string;
  editSource: string;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Produced exclusively by the tool-execution layer. Outcome flags such as
 * testsPassed derive only from steps of this shape.
 */
export interface VerificationStep extends TraceStepBase {
  type: 'test' | 'verification';
  command: string;
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  testCounts?: { passed: number; failed: number; skipped: number };
  buildResult?: 'passed' | 'failed';
  lintResult?: 'passed' | 'failed';
  typecheckResult?: 'passed' | 'failed';
  browserObservation?: string;
  durationMs: number;
}

export interface RuntimeEventStep extends TraceStepBase {
  type: 'runtime_event';
  event: 'phase' | 'checkpoint' | 'context_compaction' | 'context_refresh' | 'reasoning_mode' | 'validation' | 'plan_update' | 'review';
  phase?: string;
  message: string;
}

export interface ErrorStep extends TraceStepBase {
  type: 'error';
  severity: 'low' | 'medium' | 'high';
  message: string;
  resolved: boolean;
}

export type TrainingStep =
  | ModelResponseStep
  | ToolCallStep
  | ToolResultStep
  | FileEditStep
  | VerificationStep
  | RuntimeEventStep
  | ErrorStep;

/** Which behaviour produced this trajectory — needed to compare model versions. */
export interface TraceProvenance {
  agentPromptVersion: string;
  toolSchemaVersion: string;
  providerInstanceId: string;
  usageClass: UsageClass;
  model: string;
  /** Ollama blob digest where available. A friendly tag is not an identity. */
  modelDigest?: string;
  routerVersion: string;
  configHash: string;
}

export interface TrainingOutcome {
  completed: boolean;
  testsPassed?: boolean;
  buildPassed?: boolean;
  verificationPassed?: boolean;
  reverted: boolean;
  humanAccepted?: boolean;
  humanRejected?: boolean;
  requiredManualFix?: boolean;
  turnCount: number;
  toolCallCount: number;
  retryCount: number;
  durationMs: number;
}

export interface TrainingFeedback {
  rating: HumanRating;
  comment?: string;
  ratedAt: string;
  ratedBy?: string;
}

export interface TrainingTrace {
  traceId: string;
  taskId: string;
  sessionId?: string;
  workspaceId: string;
  agentRole: string;
  providerInstanceId: string;
  model: string;
  taskType: string;
  objective: string;
  constraints: string[];
  source: TraceSource;
  startedAt: string;
  completedAt?: string;
  steps: TrainingStep[];
  outcome?: TrainingOutcome;
  humanFeedback?: TrainingFeedback;
  classification: TraceClassification;
  provenance: TraceProvenance;
  /** Fail-closed: a trace is ineligible until sanitization has passed. */
  sanitizationPassed: boolean;
  sanitizationNotes?: string;
  eligibleForTraining: boolean;
  eligibilityReason?: string;
  /** Set when a human overrides the computed eligibility either way. */
  eligibilityOverride?: boolean;
  /**
   * Observable at the MCP boundary under Hybrid Supervisor Mode: what the
   * supervising session did with the returned result. Never its reasoning.
   */
  supervisorDisposition?: 'accepted' | 'retry_requested' | 'redelegated' | 'unknown';
}

export type ExportFormat = 'jsonl_trajectory' | 'sft_messages' | 'tool_use_trajectory';

export interface TrainingExportRecord {
  exportId: string;
  format: ExportFormat;
  createdAt: string;
  traceCount: number;
  /** Filters actually applied, so an export is reproducible and auditable. */
  filters: {
    classifications: TraceClassification[];
    taskTypes?: string[];
    workspaceIds?: string[];
    requireHumanRating?: boolean;
  };
  outputPath: string;
  outputSha256: string;
  /** Re-run at export time; an export never trusts the capture-time result. */
  sanitizationRerunPassed: boolean;
  excludedTraceCount: number;
}
