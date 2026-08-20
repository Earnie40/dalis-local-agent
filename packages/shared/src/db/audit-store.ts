import { getPool } from './pool';

/**
 * The permission audit trail. Every authorization decision is recorded —
 * allowed, denied, and the human's answer to an approval request — so what the
 * agent was permitted to do is reconstructable after the fact.
 */

export type AuditDecision = 'allowed' | 'denied' | 'approval-required' | 'approved' | 'rejected';

export interface PermissionAuditInput {
  workspaceId?: string;
  taskId?: string;
  toolName: string;
  operation?: string;
  tier: 'safe' | 'mutation' | 'high-impact';
  decision: AuditDecision;
  reason: string;
  /** Already redacted by the caller; this store never sees raw secrets. */
  input?: Record<string, unknown>;
}

export interface PermissionAuditRow {
  id: number;
  toolName: string;
  tier: string;
  decision: string;
  reason: string;
  createdAt: string;
}

export class PermissionAuditStore {
  /**
   * Never throws into the caller's path: failing to write an audit row must not
   * fail the tool call that produced it, or the loop would break on a database
   * hiccup. The write is best-effort and errors are swallowed deliberately.
   */
  async record(entry: PermissionAuditInput): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO permission_audit
           (workspace_id, task_id, tool_name, operation, tier, decision, reason, input)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entry.workspaceId ?? null,
          entry.taskId ?? null,
          entry.toolName,
          entry.operation ?? null,
          entry.tier,
          entry.decision,
          entry.reason,
          JSON.stringify(entry.input ?? {}),
        ],
      );
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  async recent(limit = 100): Promise<PermissionAuditRow[]> {
    const { rows } = await getPool().query<{
      id: string;
      tool_name: string;
      tier: string;
      decision: string;
      reason: string;
      created_at: Date;
    }>(
      `SELECT id, tool_name, tier, decision, reason, created_at
         FROM permission_audit
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      toolName: row.tool_name,
      tier: row.tier,
      decision: row.decision,
      reason: row.reason,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
