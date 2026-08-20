export type WorkspacePermission = 'read-only' | 'read-write' | 'restricted';

export type ToolPermissionLevel = 'none' | 'read-only' | 'normal' | 'elevated';

export type RelayStatus = 'idle' | 'running' | 'waiting' | 'error' | 'completed';

export interface UsageMetrics {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  localInferenceCount: number;
  claudeEscalations: number;
  toolCalls: number;
  durationMs: number;
  worker: string;
  workspace: string;
  session: string;
}

export interface Message { 
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallEvent {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'requested' | 'running' | 'succeeded' | 'failed';
  timestamp: string;
}

export interface SessionState {
  id: string;
  workspaceId: string;
  agentId: string;
  model: string;
  createdAt: string;
  status: RelayStatus;
}
