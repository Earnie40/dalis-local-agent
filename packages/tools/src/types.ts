import type { PermissionTier } from '@dacai-local-agent/security';

export interface ToolExecutionContext {
  workspaceId?: string;
  workspaceRoot?: string;
  taskId?: string;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Static classification; shell-style tools may be escalated at call time. */
  permissionTier: PermissionTier;
  requiresWrite?: boolean;
  requiresShell?: boolean;
  requiresNetwork?: boolean;
  timeoutMs: number;
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolAuditRecord {
  name: string;
  status: 'requested' | 'running' | 'succeeded' | 'failed' | 'denied';
  timestamp: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
