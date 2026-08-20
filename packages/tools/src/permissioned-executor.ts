import type { LoopToolResult, NormalizedToolCall, ToolExecutor, ToolSchema } from '@dacai-local-agent/agent-core';
import { PermissionEngine, redactDeep, sanitizeText } from '@dacai-local-agent/security';
import type { PermissionDecision, WorkspaceCapabilities } from '@dacai-local-agent/security';
import type { ToolDefinition, ToolExecutionContext } from './types';
import type { ToolRegistry } from './tool-registry';

export interface PermissionAuditSink {
  record(entry: {
    toolName: string;
    operation?: string;
    decision: PermissionDecision;
    input: Record<string, unknown>;
    workspaceId?: string;
    taskId?: string;
  }): Promise<void> | void;
}

export interface ApprovalGate {
  /** Resolves true when a human authorizes a mutation or high-impact call. */
  request(request: {
    toolName: string;
    decision: PermissionDecision;
    input: Record<string, unknown>;
  }): Promise<boolean>;
}

export interface PermissionedExecutorOptions {
  registry: ToolRegistry;
  engine?: PermissionEngine;
  capabilities: WorkspaceCapabilities;
  context: ToolExecutionContext;
  audit?: PermissionAuditSink;
  /** Absent means nothing above the auto-approved tier can run — fail closed. */
  approvals?: ApprovalGate;
}

/**
 * The single path from a model's tool call to actual execution.
 *
 * The agent loop deliberately cannot execute tools itself; it calls this. Every
 * call therefore passes the permission engine, an approval gate for anything
 * above the auto-approved tier, an audit write, and output redaction — there is
 * no route that reaches a tool without them.
 */
export class PermissionedToolExecutor implements ToolExecutor {
  private readonly engine: PermissionEngine;

  constructor(private readonly options: PermissionedExecutorOptions) {
    this.engine = options.engine ?? new PermissionEngine();
  }

  listTools(): ToolSchema[] {
    return this.options.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(call: NormalizedToolCall, signal?: AbortSignal): Promise<LoopToolResult> {
    const tool = this.options.registry.get(call.name);
    if (!tool) {
      return { output: `No tool named "${call.name}".`, success: false, error: 'unknown-tool' };
    }

    const decision = this.engine.authorizeTool({
      toolName: tool.name,
      tier: tool.permissionTier,
      capabilities: this.options.capabilities,
      command: typeof call.arguments.command === 'string' ? call.arguments.command : undefined,
      requiresWrite: tool.requiresWrite,
      requiresShell: tool.requiresShell,
      requiresNetwork: tool.requiresNetwork,
    });

    await this.record(tool.name, decision, call.arguments);

    if (decision.kind === 'denied') {
      // The model is told plainly, so it can choose another approach rather
      // than retrying the same forbidden call.
      return {
        output: `Denied: ${decision.reason} (tier: ${decision.tier}). Try a different approach.`,
        success: false,
        denied: true,
        error: 'denied',
      };
    }

    if (decision.kind === 'approval-required') {
      // Fail closed: with no approval gate wired, elevated work does not run.
      const approved = this.options.approvals
        ? await this.options.approvals.request({ toolName: tool.name, decision, input: call.arguments })
        : false;

      await this.record(tool.name, { ...decision, kind: approved ? 'allowed' : 'denied' }, call.arguments);

      if (!approved) {
        return {
          output:
            `Denied: "${tool.name}" is classified ${decision.tier} and requires explicit approval, ` +
            'which was not granted. Try a read-only approach instead.',
          success: false,
          denied: true,
          error: 'approval-denied',
        };
      }
    }

    return this.run(tool, call, signal);
  }

  private async run(
    tool: ToolDefinition,
    call: NormalizedToolCall,
    signal?: AbortSignal,
  ): Promise<LoopToolResult> {
    // A tool's own timeout bounds it even when the caller supplies no signal.
    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    try {
      const raw = await tool.execute(call.arguments, { ...this.options.context, signal: combined });
      const output = typeof raw === 'string' ? raw : JSON.stringify(redactDeep(raw), null, 2);

      return {
        output: sanitizeText(output),
        success: true,
        evidence: extractEvidence(tool.name, raw),
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        output: sanitizeText(`Error from ${tool.name}: ${message}`),
        success: false,
        error: timeout.aborted ? 'timeout' : 'tool-error',
      };
    }
  }

  private async record(
    toolName: string,
    decision: PermissionDecision,
    input: Record<string, unknown>,
  ): Promise<void> {
    // Arguments can carry secrets; the audit trail stores the redacted form.
    await this.options.audit?.record({
      toolName,
      decision,
      input: redactDeep(input),
      workspaceId: this.options.context.workspaceId,
      taskId: this.options.context.taskId,
    });
  }
}

/**
 * Pulls objective evidence out of a tool result for the training trace. Only
 * the tool layer can produce these — a model's claim can never become one.
 */
function extractEvidence(
  toolName: string,
  raw: unknown,
): Array<{ kind: string; summary: string; detail?: Record<string, unknown> }> {
  if (!raw || typeof raw !== 'object') return [];

  const record = raw as Record<string, unknown>;
  const evidence: Array<{ kind: string; summary: string; detail?: Record<string, unknown> }> = [];

  if (typeof record.exitCode === 'number') {
    evidence.push({
      kind: 'exit_code',
      summary: `${toolName} exited ${record.exitCode}`,
      detail: { exitCode: record.exitCode },
    });
  }

  if (typeof record.status === 'number') {
    evidence.push({ kind: 'http_status', summary: `${toolName} returned HTTP ${record.status}` });
  }

  return evidence;
}
