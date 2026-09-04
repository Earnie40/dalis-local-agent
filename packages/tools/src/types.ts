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
  /**
   * Trusted tool definitions may opt a bounded mutation out of the interactive
   * approval pause. Workspace capability checks still run before execution.
   */
  autoApprove?: boolean;
  requiresRead?: boolean;
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
