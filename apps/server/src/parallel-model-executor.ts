import type {
  AgentLoopResult,
  LoopEvent,
  LoopToolResult,
  NormalizedToolCall,
  ToolExecutor,
  ToolSchema,
} from '@dacai-local-agent/agent-core';
import { stripHiddenReasoning } from '@dacai-local-agent/training-traces';

/**
 * The stable identity and bounded, visible result of one model participant.
 *
 * This deliberately does not contain provider messages, hidden reasoning, or
 * credentials.  Tool-layer evidence and the participant's final visible
 * answer are enough for a later writer or reviewer to make an informed next
 * request without replaying another provider's private conversation.
 */
export interface AgentEvidencePacket {
  participant: string;
  providerInstanceId: string;
  model: string;
  objective: string;
  role: ParallelParticipantRole;
  inspectedFiles: string[];
  relevantSymbols: string[];
  findings: string[];
  changedFiles: string[];
  validationResults: string[];
  objectiveEvidence: Array<{ kind: string; summary: string }>;
  unresolvedQuestions: string[];
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
}

export type ParallelParticipantRole =
  | 'repository-explorer'
  | 'architecture-reviewer'
  | 'implementation-specialist'
  | 'generalist';

export interface ParallelParticipant {
  alias: string;
  providerInstanceId: string;
  model: string;
}

export interface ParallelParticipantResult {
  participant: ParallelParticipant;
  packet: AgentEvidencePacket;
  result?: ParallelLoopResult;
  error?: string;
}

type ParallelLoopResultFields = Pick<
  AgentLoopResult,
  | 'taskId'
  | 'answer'
  | 'stopReason'
  | 'completionState'
  | 'turns'
  | 'toolCalls'
  | 'rejectedCalls'
  | 'deniedCalls'
  | 'retries'
  | 'durationMs'
  | 'usage'
  | 'workingState'
  | 'error'
>;

/**
 * Older/remote participants may predate the authoritative completion-state
 * field. Keep accepting those packets at this boundary and use the mechanical
 * stop reason only as a compatibility fallback.
 */
export type ParallelLoopResult = Omit<ParallelLoopResultFields, 'completionState'> & {
  completionState?: AgentLoopResult['completionState'];
};

export interface ParallelWorkerSuccess {
  result: ParallelLoopResult;
  packet: AgentEvidencePacket;
}

export type ParallelWorker = (
  participant: ParallelParticipant,
  role: ParallelParticipantRole,
  signal?: AbortSignal,
) => Promise<ParallelWorkerSuccess>;

export type ParallelWriter = (
  participant: ParallelParticipant,
  role: ParallelParticipantRole,
  evidence: readonly ParallelParticipantResult[],
  signal?: AbortSignal,
) => Promise<ParallelWorkerSuccess>;

export interface ParallelExecutionOptions {
  participants: ParallelParticipant[];
  objective: string;
  signal?: AbortSignal;
  /**
   * A writer never runs alongside the read-only participants.  It starts only
   * after Promise.allSettled has collected their packets.
   */
  writerAlias?: string;
  runReadOnly: ParallelWorker;
  runWriter?: ParallelWriter;
}

export interface ParallelExecutionResult {
  participants: ParallelParticipantResult[];
  synthesis: string;
}

const READ_ONLY_TOOL_NAMES = new Set([
  'filesystem.list',
  'filesystem.read',
  'filesystem.search',
  'filesystem.stat',
  'git.run',
  'system.network.info',
  'skills.list',
  'skills.read',
  'skills.find',
  'code.symbol.search',
  'code.symbol.references',
  'code.symbol.callers',
  'code.symbol.callees',
  'code.symbol.impact',
  'code.path.trace',
  'code.architecture.context',
  'code.failure.recall',
  'code.working-state.get',
  'code.validation.status',
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function safeString(value: unknown, maximum = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, maximum) : undefined;
}

function safeVisibleAnswer(value: string): string | undefined {
  return safeString(stripHiddenReasoning(value).content, 4_000);
}

function statusFor(result: ParallelLoopResult): AgentEvidencePacket['status'] {
  if (result.completionState === 'CANCELLED') return 'cancelled';
  if (result.completionState === 'GOAL_COMPLETE' || result.completionState === 'VERIFICATION_COMPLETE') return 'completed';
  if (result.completionState === 'FAILED') return 'failed';
  if (result.completionState !== undefined) return 'partial';

  // Compatibility for version-skewed worker packets. New workers should
  // always send completionState because stopReason alone is less expressive.
  if (result.stopReason === 'cancelled') return 'cancelled';
  if (result.stopReason === 'provider-error') return 'failed';
  if (result.stopReason === 'final-answer') return 'completed';
  return 'partial';
}

/** Default specialties are advisory task assignments, not authority grants. */
export function roleForParallelParticipant(alias: string): ParallelParticipantRole {
  switch (alias) {
    case 'coder':
      return 'repository-explorer';
    case 'gpu_coder':
      return 'implementation-specialist';
    case 'claude':
      return 'architecture-reviewer';
    case 'sol':
      return 'implementation-specialist';
    default:
      return 'generalist';
  }
}

/**
 * Validates the public participant list before any provider is resolved.  A
 * caller must name each participant; that explicit list is also the consent
 * boundary for paid instances under manual-provider-selection.
 */
export function normalizeParallelParticipants(
  requested: string[] | undefined,
  writerAlias?: string,
): { participants: string[]; writerAlias?: string } {
  if (!requested) return { participants: [], writerAlias: undefined };

  const participants = requested.map((alias) => alias.trim()).filter(Boolean);
  if (participants.length < 2) {
    throw new Error('Parallel execution requires at least two explicitly selected participants.');
  }
  if (participants.length > 4) {
    throw new Error('Parallel execution supports at most four participants.');
  }
  if (unique(participants).length !== participants.length) {
    throw new Error('Parallel execution participants must be unique.');
  }

  const writer = writerAlias?.trim() || undefined;
  if (writer && !participants.includes(writer)) {
    throw new Error('writerAlias must identify one of the explicitly selected participants.');
  }
  return { participants, writerAlias: writer };
}

/**
 * Read-only participants still run through the supplied PermissionedToolExecutor.
 * This wrapper only removes tools and fail-closes unexpected calls; it never
 * accesses a registry, filesystem, shell, or approval mechanism directly.
 */
export class ReadOnlyToolExecutor implements ToolExecutor {
  constructor(private readonly inner: ToolExecutor) {}

  listTools(): ToolSchema[] {
    return this.inner.listTools().filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name));
  }

  async execute(call: NormalizedToolCall, signal?: AbortSignal): Promise<LoopToolResult> {
    if (!READ_ONLY_TOOL_NAMES.has(call.name)) {
      return {
        success: false,
        denied: true,
        error: 'parallel-read-only',
        output: `Denied: ${call.name} is unavailable to a read-only parallel participant.`,
      };
    }
    return this.inner.execute(call, signal);
  }
}

/** Collect sanitized, objective tool observations for a participant packet. */
export class EvidencePacketCollector {
  private readonly inspectedFiles: string[] = [];
  private readonly relevantSymbols: string[] = [];
  private readonly validationResults: string[] = [];
  private readonly objectiveEvidence: Array<{ kind: string; summary: string }> = [];

  constructor(
    private readonly participant: ParallelParticipant,
    private readonly objective: string,
    private readonly role: ParallelParticipantRole,
  ) {}

  record(event: LoopEvent): void {
    const call = event.toolCall;
    const result = event.result;
    if (!call || !result) return;

    const path = safeString(call.arguments.path) ?? safeString(call.arguments.filePath);
    if (result.success && path && call.name.startsWith('filesystem.')) {
      this.inspectedFiles.push(path);
    }

    const symbol = safeString(call.arguments.symbol) ?? safeString(call.arguments.query);
    if (result.success && symbol && call.name.startsWith('code.symbol.')) {
      this.relevantSymbols.push(symbol);
    }

    if (call.name === 'tests.run' || call.name === 'code.diagnostics') {
      this.validationResults.push(`${call.name}: ${result.success ? 'succeeded' : 'failed'}`);
    }

    if (result.success) {
      this.objectiveEvidence.push({
        kind: 'tool-execution',
        summary: `${call.name} succeeded`,
      });
    }
    for (const evidence of result.evidence ?? []) {
      const summary = safeString(evidence.summary, 320);
      if (summary) this.objectiveEvidence.push({ kind: evidence.kind, summary });
    }
  }

  complete(result: ParallelLoopResult): AgentEvidencePacket {
    const answer = safeVisibleAnswer(result.answer);
    const unresolved = result.error ? [safeString(result.error, 700) ?? 'Participant failed.'] : [];
    return {
      participant: this.participant.alias,
      providerInstanceId: this.participant.providerInstanceId,
      model: this.participant.model,
      objective: this.objective,
      role: this.role,
      inspectedFiles: unique(this.inspectedFiles),
      relevantSymbols: unique(this.relevantSymbols),
      findings: answer ? [answer] : [],
      changedFiles: unique(result.workingState.changedFiles),
      validationResults: unique([...this.validationResults, ...result.workingState.validationResults]),
      objectiveEvidence: this.objectiveEvidence.slice(0, 80),
      unresolvedQuestions: unresolved,
      status: statusFor(result),
    };
  }

  failed(error: unknown): AgentEvidencePacket {
    const message = error instanceof Error ? error.message : String(error);
    return {
      participant: this.participant.alias,
      providerInstanceId: this.participant.providerInstanceId,
      model: this.participant.model,
      objective: this.objective,
      role: this.role,
      inspectedFiles: [],
      relevantSymbols: [],
      findings: [],
      changedFiles: [],
      validationResults: [],
      objectiveEvidence: [],
      unresolvedQuestions: [safeString(message, 700) ?? 'Participant failed.'],
      status: 'failed',
    };
  }
}

function resultFromSettlement(
  participant: ParallelParticipant,
  role: ParallelParticipantRole,
  objective: string,
  settlement: PromiseSettledResult<ParallelWorkerSuccess>,
): ParallelParticipantResult {
  if (settlement.status === 'fulfilled') {
    return { participant, packet: settlement.value.packet, result: settlement.value.result };
  }
  const collector = new EvidencePacketCollector(participant, objective, role);
  const packet = collector.failed(settlement.reason);
  return {
    participant,
    packet,
    error: packet.unresolvedQuestions[0],
  };
}

/**
 * Runs independent read-only specialists with real concurrency.  Promise.allSettled
 * intentionally preserves successful packets when a peer fails.  A selected
 * writer is sequenced after that fan-out, so two participants can never mutate
 * the shared worktree simultaneously through this coordinator.
 */
export async function executeParallelParticipants(
  options: ParallelExecutionOptions,
): Promise<ParallelExecutionResult> {
  const writer = options.writerAlias
    ? options.participants.find((participant) => participant.alias === options.writerAlias)
    : undefined;
  const readOnlyParticipants = options.participants.filter((participant) => participant !== writer);

  const settled = await Promise.allSettled(
    readOnlyParticipants.map((participant) =>
      options.runReadOnly(participant, roleForParallelParticipant(participant.alias), options.signal),
    ),
  );

  const participants = settled.map((settlement, index) => {
    const participant = readOnlyParticipants[index];
    return resultFromSettlement(
      participant,
      roleForParallelParticipant(participant.alias),
      options.objective,
      settlement,
    );
  });

  if (writer) {
    if (!options.runWriter) {
      throw new Error('A writerAlias requires a configured writer runner.');
    }
    try {
      const completed = await options.runWriter(
        writer,
        roleForParallelParticipant(writer.alias),
        participants,
        options.signal,
      );
      participants.push({ participant: writer, packet: completed.packet, result: completed.result });
    } catch (error) {
      const collector = new EvidencePacketCollector(
        writer,
        options.objective,
        roleForParallelParticipant(writer.alias),
      );
      const packet = collector.failed(error);
      participants.push({ participant: writer, packet, error: packet.unresolvedQuestions[0] });
    }
  }

  return { participants, synthesis: synthesizeParallelEvidence(participants) };
}

function summaries(results: ParallelParticipantResult[], selector: (packet: AgentEvidencePacket) => string[]): string[] {
  return results.flatMap((result) => selector(result.packet).map((value) => `${result.packet.participant}: ${value}`));
}

/**
 * This is deliberately deterministic.  It reports the models' visible advice
 * separately from tool/validation evidence and never upgrades agreement into
 * proof.  The final writer/reviewer must still obtain diagnostics, tests, or
 * runtime evidence before declaring task completion.
 */
export function synthesizeParallelEvidence(results: ParallelParticipantResult[]): string {
  const participants = results.map((result) => result.packet.participant).join(', ') || '(none)';
  const findings = summaries(results, (packet) => packet.findings).slice(0, 12);
  const objective = results
    .flatMap((result) => result.packet.objectiveEvidence.map((evidence) => `${result.packet.participant}: ${evidence.summary}`))
    .slice(0, 24);
  const unresolved = summaries(results, (packet) => packet.unresolvedQuestions).slice(0, 12);
  const changed = summaries(results, (packet) => packet.changedFiles).slice(0, 12);

  return [
    'AGREEMENTS',
    'Model agreement is advisory only; no agreement is treated as validation.',
    findings.length ? findings.join('\n') : 'No participant supplied a visible finding.',
    '',
    'DISAGREEMENTS',
    'Compare the independently identified findings above against objective evidence; the controller does not choose by vote.',
    '',
    'OBJECTIVE EVIDENCE',
    objective.length ? objective.join('\n') : 'No successful tool-layer evidence was recorded.',
    changed.length ? `Changed-file records: ${changed.join('; ')}` : 'No changed files were recorded by the parallel read-only phase.',
    '',
    'UNRESOLVED QUESTIONS',
    unresolved.length ? unresolved.join('\n') : 'No participant-reported unresolved questions.',
    '',
    'FINAL SYNTHESIS',
    `Collected independently identifiable packets from: ${participants}. Model analysis remains advisory; compiler, targeted tests, runtime behavior, repository state, and diff evidence decide completion.`,
  ].join('\n');
}
