/** Context management types and interfaces. */

export type ContextPriority =
  | 'critical'
  | 'goal'
  | 'plan'
  | 'state'
  | 'knowledge'
  | 'memory'
  | 'history';

export interface ContextSection {
  priority: ContextPriority;
  label: string;
  content: string;
  source?: string;
  tokenEstimate?: number;
  compressible?: boolean;
}

export interface RetrievalScope {
  workspaceId?: string;
  engagementId?: string;
  agentId?: string;
}

export interface ContextManagerOptions {
  maxContextTokens?: number;
  reserveOutputTokens?: number;
  priorityBudgets?: Partial<Record<ContextPriority, number>>;
  enableSkills?: boolean;
  enableRag?: boolean;
  enableRepositoryRag?: boolean;
  enableMemory?: boolean;
  skillLimit?: number;
  ragLimit?: number;
  repositoryRagLimit?: number;
  memoryLimit?: number;
}

export interface BuildContextInput {
  goal: string;
  scope: RetrievalScope;
  planContext?: string;
  currentStateContext?: string;
  rollingSummary?: string;
  knownPaths?: string[];
  recentObservations?: string[];
  conversationHistory?: Array<{ role: string; content: string }>;
  options?: ContextManagerOptions;
}

export interface BuiltContext {
  sections: ContextSection[];
  totalTokens: number;
  truncated: boolean;
  reasoning: string;
}
