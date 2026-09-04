import type { AgentRunBudget, AgentRunMode, AppConfig } from '@dacai-local-agent/shared';

export type RepositoryAuditPhase =
  | 'Define target capability model'
  | 'Repository inventory'
  | 'Locate implementations'
  | 'Gather evidence'
  | 'Classify capability coverage'
  | 'Identify architectural gaps'
  | 'Challenge conclusions'
  | 'Architecture synthesis'
  | 'Verification';

export interface ResolvedRunMode {
  mode: AgentRunMode;
  budget: AgentRunBudget;
  explicitlyRequested: boolean;
}

const AUDIT_INTENT = /\b(?:repository[-\s]*(?:wide|architecture|technical)?\s*audit|architecture(?:\s+gap)?\s+analysis|repository\s+inventory|capability\s+matrix|gap\s+analysis)\b/i;
const RESEARCH_INTENT = /\b(?:deep\s+research|landscape\s+analysis|multi[-\s]source\s+research)\b/i;

/** Selects depth only. It never adds capabilities or weakens permission gates. */
export function resolveAgentRunMode(input: {
  requestedMode?: AgentRunMode;
  prompt: string;
  role?: string;
  config: AppConfig;
  maxTurns?: number;
  maxToolCalls?: number;
}): ResolvedRunMode {
  const mode = input.requestedMode
    ?? (AUDIT_INTENT.test(input.prompt) ? 'repository_audit'
      : RESEARCH_INTENT.test(input.prompt) ? 'deep_research'
        : input.role === 'coding' ? 'coding' : 'interactive');
  const configured = input.config.limits.runBudgets[mode];
  const maxTurns = Math.min(input.maxTurns ?? configured.maxTurns, input.config.limits.maxAgentTurns);
  const maxToolCalls = input.maxToolCalls ?? configured.maxToolCalls;
  return {
    mode,
    explicitlyRequested: input.requestedMode !== undefined,
    budget: {
      maxTurns,
      maxToolCalls,
      synthesisReserveTurns: Math.min(configured.synthesisReserveTurns, Math.max(0, maxTurns - 1)),
    },
  };
}

export function repositoryAuditInstructions(): string {
  return [
    'REPOSITORY AUDIT EXECUTION PROTOCOL:',
    'Follow these visible phases: Define target capability model → Repository inventory → Locate implementations → Gather evidence → Classify capability coverage → Identify architectural gaps → Challenge conclusions → Architecture synthesis → Verification.',
    'Start with code.architecture.context and code.symbol.search. Use filesystem.search for targeted confirmation, then read only the relevant source sections.',
    'Do not spend a turn per directory. Batch related concepts into high-information searches and do not reread files already reflected in the working context unless their contents changed.',
    'For each conclusion, retain paths, symbols, and observed evidence. Distinguish IMPLEMENTED, PARTIAL, FOUNDATIONAL, MISSING, and NOT ENOUGH EVIDENCE.',
    'Near the synthesis reserve, stop broad discovery. Consolidate evidence, test contradictions, produce the architecture matrix and gap analysis, then verify the report before TASK_COMPLETE.',
  ].join('\n');
}

/** Maps actual tool use to the next audit phase; it does not manufacture progress. */
export function phaseForAuditTool(toolName: string): RepositoryAuditPhase | undefined {
  if (toolName === 'code.architecture.context' || toolName === 'filesystem.list') return 'Repository inventory';
  if (toolName === 'code.symbol.search' || toolName.startsWith('code.symbol.') || toolName === 'code.path.trace') return 'Locate implementations';
  if (toolName === 'filesystem.search' || toolName === 'filesystem.read' || toolName === 'filesystem.stat') return 'Gather evidence';
  if (toolName === 'tests.run' || toolName === 'code.diagnostics') return 'Verification';
  return undefined;
}
