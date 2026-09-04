import type { CompletionMessage } from './types';

export type ReasoningMode = 'fast' | 'standard' | 'deep';
export type ReasoningPreference = 'auto' | ReasoningMode;

export interface AgentLoopContextSnapshot {
  goal: string;
  turn: number;
  reasoningMode: ReasoningMode;
  plan?: string;
  knownPaths: string[];
  changedFiles: string[];
  succeededTools: string[];
  recentFailures: string[];
  validationResults: string[];
  rollingSummary?: string;
}

export interface CompactedMessages {
  messages: CompletionMessage[];
  compacted: boolean;
  estimatedTokens: number;
  rollingSummary?: string;
}

const MULTI_STEP_PATTERN = /(?:^|\n)\s*(?:\d+[.)]|[-*]\s)|\b(?:implement|refactor|debug|fix|upgrade|migrate|integrate|build|test|verify|inspect|review)\b/gi;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function chooseInitialReasoningMode(goal: string, preference: ReasoningPreference = 'auto'): ReasoningMode {
  if (preference !== 'auto') return preference;

  const matches = goal.match(MULTI_STEP_PATTERN)?.length ?? 0;
  if (goal.length > 1800 || matches >= 6) return 'deep';
  if (goal.length > 500 || matches >= 2) return 'standard';
  return 'fast';
}

export function escalateReasoningMode(
  current: ReasoningMode,
  signal: { failures?: number; rejectedCalls?: number; validationFailed?: boolean; stalled?: boolean },
): ReasoningMode {
  if (signal.validationFailed || signal.stalled || (signal.failures ?? 0) >= 2 || (signal.rejectedCalls ?? 0) >= 2) {
    return 'deep';
  }
  if (current === 'fast' && ((signal.failures ?? 0) > 0 || (signal.rejectedCalls ?? 0) > 0)) {
    return 'standard';
  }
  return current;
}

export function goalImpliesMutation(goal: string): boolean {
  return /\b(?:implement|edit|write|create|generate|render|produce|fix|update|replace|move|copy|refactor|migrate|install|distribute|merge|delete|remove|add|wire|upgrade)\b/i.test(goal);
}

export const ENGINEERING_MUTATION_TOOLS = new Set([
  'cad.execute',
  'bim.execute',
  'scene.render',
  'image.generate',
  'video.generate',
]);

export function isMutationTool(toolName: string): boolean {
  return (
    toolName === 'filesystem.write' ||
    toolName === 'filesystem.edit' ||
    toolName === 'filesystem.move' ||
    toolName === 'filesystem.copy' ||
    ENGINEERING_MUTATION_TOOLS.has(toolName)
  );
}

export function isValidationTool(toolName: string): boolean {
  return toolName === 'tests.run' || toolName === 'code.diagnostics' || toolName === 'engineering.artifact.inspect';
}

export function extractChangedPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (!isMutationTool(toolName)) return [];

  if (ENGINEERING_MUTATION_TOOLS.has(toolName)) {
    const expected = Array.isArray(args.expectedArtifacts)
      ? args.expectedArtifacts.filter((value): value is string => typeof value === 'string')
      : [];
    const output = typeof args.outputPath === 'string' ? [args.outputPath] : [];
    return [...new Set([...expected, ...output].map((value) => value.trim()).filter(Boolean))];
  }

  const candidates = [args.path, args.source, args.destination, args.from, args.to];
  return [...new Set(candidates.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

export function validationPassed(result: {
  success: boolean;
  output: string;
  evidence?: Array<{ kind: string; detail?: Record<string, unknown> }>;
}): boolean {
  if (!result.success) return false;

  const exitEvidence = result.evidence?.find((item) => item.kind === 'exit_code');
  if (exitEvidence && typeof exitEvidence.detail?.exitCode === 'number') {
    return exitEvidence.detail.exitCode === 0;
  }

  const validationEvidence = result.evidence?.find((item) => item.kind === 'validation_result');
  if (validationEvidence?.detail) {
    const checks = Object.values(validationEvidence.detail).filter((value): value is boolean => typeof value === 'boolean');
    if (checks.length) return checks.every(Boolean);
  }

  try {
    const parsed = JSON.parse(result.output) as { exitCode?: unknown; passed?: unknown; validation?: unknown };
    if (typeof parsed.exitCode === 'number') return parsed.exitCode === 0;
    if (typeof parsed.passed === 'boolean') return parsed.passed;
    if (parsed.validation && typeof parsed.validation === 'object') {
      const checks = Object.values(parsed.validation as Record<string, unknown>)
        .filter((value): value is boolean => typeof value === 'boolean');
      if (checks.length) return checks.every(Boolean);
    }
  } catch {
    // Some tools return plain text. A successful tool without exit evidence is
    // still useful, but it is not strong enough to prove validation passed.
  }

  return false;
}

function messageLine(message: CompletionMessage): string | undefined {
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;

  if (message.role === 'tool') {
    const prefix = message.toolName ? `TOOL ${message.toolName}` : 'TOOL';
    return `${prefix}: ${text.slice(0, 420)}`;
  }

  if (message.role === 'assistant') {
    if (/^TASK COMPLETION CHECK:/i.test(text)) return undefined;
    return `ASSISTANT: ${text.slice(0, 360)}`;
  }

  if (/^(TASK COMPLETION CHECK|TASK-ALIGNMENT CHECK):/i.test(text)) return undefined;
  return `USER: ${text.slice(0, 360)}`;
}

export function summarizeMessages(messages: CompletionMessage[], maxChars = 6000): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const message of messages) {
    const line = messageLine(message);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  const half = Math.max(500, Math.floor((maxChars - 80) / 2));
  return `${joined.slice(0, half)}\n… [older context compacted] …\n${joined.slice(-half)}`;
}

export function compactMessagesForRequest(input: {
  messages: CompletionMessage[];
  systemPrompt: string;
  maxContextTokens: number;
  reserveTokens?: number;
  priorRollingSummary?: string;
}): CompactedMessages {
  const reserveTokens = input.reserveTokens ?? Math.max(4096, Math.floor(input.maxContextTokens * 0.2));
  const messageBudgetTokens = Math.max(
    2500,
    input.maxContextTokens - reserveTokens - estimateTokens(input.systemPrompt),
  );

  const total = input.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0);
  if (total <= messageBudgetTokens) {
    return {
      messages: input.messages.map((message) => ({ ...message })),
      compacted: false,
      estimatedTokens: total + estimateTokens(input.systemPrompt),
      rollingSummary: input.priorRollingSummary,
    };
  }

  const tailBudget = Math.max(1800, Math.floor(messageBudgetTokens * 0.58));
  const tail: CompletionMessage[] = [];
  let tailTokens = 0;
  let splitIndex = input.messages.length;

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    const cost = estimateTokens(message.content) + 8;
    if (tail.length > 0 && tailTokens + cost > tailBudget) break;
    tail.unshift({ ...message });
    tailTokens += cost;
    splitIndex = index;
  }

  const older = input.messages.slice(0, splitIndex);
  const summaryParts = [input.priorRollingSummary, summarizeMessages(older)].filter(Boolean);
  const summary = summaryParts.join('\n').slice(-6500);

  const summaryMessage: CompletionMessage = {
    role: 'user',
    content: [
      'CONTEXT COMPACTION — PRIOR OBSERVATIONS:',
      'This is a deterministic summary of older turns. The original goal in the system prompt remains authoritative.',
      summary || '(No older observations retained.)',
    ].join('\n'),
  };

  const compacted = [summaryMessage, ...tail];
  const estimatedTokens =
    estimateTokens(input.systemPrompt) +
    compacted.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0);

  return {
    messages: compacted,
    compacted: true,
    estimatedTokens,
    rollingSummary: summary,
  };
}

export function buildWorkingStateContext(snapshot: AgentLoopContextSnapshot): string {
  const lines = [
    'RUNTIME WORKING STATE:',
    `Turn: ${snapshot.turn}`,
    `Reasoning mode: ${snapshot.reasoningMode.toUpperCase()}`,
    `Current goal: ${snapshot.goal}`,
  ];

  if (snapshot.plan) lines.push(`Plan / checklist:\n${snapshot.plan}`);
  if (snapshot.changedFiles.length) lines.push(`Changed files:\n${snapshot.changedFiles.map((path) => `- ${path}`).join('\n')}`);
  if (snapshot.validationResults.length) lines.push(`Validation evidence:\n${snapshot.validationResults.map((item) => `- ${item}`).join('\n')}`);
  if (snapshot.recentFailures.length) lines.push(`Recent failures:\n${snapshot.recentFailures.slice(-8).map((item) => `- ${item}`).join('\n')}`);
  if (snapshot.succeededTools.length) lines.push(`Successful tools: ${snapshot.succeededTools.join(', ')}`);
  if (snapshot.knownPaths.length) {
    lines.push(
      `Known exact paths (authoritative observations; reuse these instead of guessing):\n${snapshot.knownPaths
        .slice(-80)
        .map((path) => `- ${path}`)
        .join('\n')}`,
    );
  }
  if (snapshot.rollingSummary) lines.push(`Rolling summary:\n${snapshot.rollingSummary}`);

  lines.push(
    'Do not treat this state as permission to execute anything. Tool authorization remains external and authoritative.',
  );

  return lines.join('\n\n');
}
