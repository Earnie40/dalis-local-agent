import { createId, getPool } from '@dacai-local-agent/shared';
import type { TaskStatus } from './task-runner';

export type SwarmStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'synthesizing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface SwarmTaskSummary {
  taskId: string;
  role: string;
  objective: string;
  ordinal: number;
  status: TaskStatus;
  result?: string;
  evidence: unknown[];
  errors: unknown[];
  model: string;
  providerInstanceId: string;
  createdAt: string;
  completedAt?: string;
}

export interface SwarmRecord {
  id: string;
  workspaceId: string;
  engagementId?: string;
  objective: string;
  strategy: string;
  status: SwarmStatus;
  members: SwarmTaskSummary[];
  coordinator?: SwarmTaskSummary;
  result?: string;
  progress: {
    total: number;
    terminal: number;
    completed: number;
    failed: number;
  };
  createdAt: string;
  cancelledAt?: string;
}

interface SwarmRow {
  id: string;
  workspace_id: string;
  engagement_id: string | null;
  objective: string;
  strategy: string;
  coordinator_task_id: string | null;
  synthesis_claimed_by: string | null;
  synthesis_claimed_at: Date | null;
  sealed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
}

interface MemberRow {
  task_id: string;
  role: string;
  member_objective: string;
  ordinal: number;
  status: TaskStatus;
  result: string | null;
  evidence: unknown[];
  errors: unknown[];
  model: string;
  provider_instance_id: string;
  created_at: Date;
  completed_at: Date | null;
}

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'waiting_for_user',
  'interrupted',
]);

export function deriveSwarmStatus(
  memberStatuses: readonly TaskStatus[],
  coordinatorStatus?: TaskStatus,
  cancelled = false,
): SwarmStatus {
  if (cancelled) return 'cancelled';

  if (coordinatorStatus) {
    if (coordinatorStatus === 'completed') return 'completed';
    if (coordinatorStatus === 'queued' || coordinatorStatus === 'running') return 'synthesizing';
    return memberStatuses.some((status) => status === 'completed') ? 'partial' : 'failed';
  }

  if (!memberStatuses.length) return 'failed';
  if (memberStatuses.some((status) => status === 'running')) return 'running';
  if (memberStatuses.some((status) => status === 'queued')) return 'queued';
  if (memberStatuses.every((status) => TERMINAL_TASK_STATUSES.has(status))) {
    return memberStatuses.some((status) => status === 'completed') ? 'ready' : 'failed';
  }
  return 'running';
}

function toTask(row: MemberRow): SwarmTaskSummary {
  return {
    taskId: row.task_id,
    role: row.role,
    objective: row.member_objective,
    ordinal: row.ordinal,
    status: row.status,
    result: row.result ?? undefined,
    evidence: row.evidence ?? [],
    errors: row.errors ?? [],
    model: row.model,
    providerInstanceId: row.provider_instance_id,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

function progressFor(members: readonly SwarmTaskSummary[]) {
  return {
    total: members.length,
    terminal: members.filter((member) => TERMINAL_TASK_STATUSES.has(member.status)).length,
    completed: members.filter((member) => member.status === 'completed').length,
    failed: members.filter((member) =>
      ['failed', 'blocked', 'waiting_for_user', 'interrupted'].includes(member.status),
    ).length,
  };
}

/**
 * Durable coordination metadata for a group of ordinary delegated tasks.
 * Execution stays in TaskRunner; this store only records membership and owns
 * the single-writer claim used to schedule final synthesis.
 */
export class SwarmStore {
  async create(input: {
    workspaceId: string;
    engagementId?: string;
    objective: string;
    strategy: string;
  }): Promise<string> {
    const id = createId('swarm');
    await getPool().query(
      `INSERT INTO agent_swarms (id, workspace_id, engagement_id, objective, strategy)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.workspaceId, input.engagementId ?? null, input.objective.trim(), input.strategy],
    );
    return id;
  }

  async addMember(
    swarmId: string,
    member: { taskId: string; role: string; objective: string; ordinal: number },
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO agent_swarm_members (swarm_id, task_id, role, objective, ordinal)
       VALUES ($1, $2, $3, $4, $5)`,
      [swarmId, member.taskId, member.role, member.objective, member.ordinal],
    );
  }

  async seal(id: string): Promise<void> {
    await getPool().query(
      'UPDATE agent_swarms SET sealed_at = now() WHERE id = $1 AND sealed_at IS NULL',
      [id],
    );
  }

  async get(id: string): Promise<SwarmRecord | undefined> {
    const { rows } = await getPool().query<SwarmRow>('SELECT * FROM agent_swarms WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) return undefined;

    const members = await this.tasksFor(
      `SELECT m.task_id, m.role, m.objective AS member_objective, m.ordinal,
              t.status, t.result, t.evidence, t.errors, t.model,
              t.provider_instance_id, t.created_at, t.completed_at
         FROM agent_swarm_members m
         JOIN tasks t ON t.id = m.task_id
        WHERE m.swarm_id = $1
        ORDER BY m.ordinal`,
      [id],
    );

    const coordinator = row.coordinator_task_id
      ? (await this.tasksFor(
          `SELECT t.id AS task_id, t.agent_id AS role, t.objective AS member_objective,
                  2147483647 AS ordinal, t.status, t.result, t.evidence, t.errors,
                  t.model, t.provider_instance_id, t.created_at, t.completed_at
             FROM tasks t WHERE t.id = $1`,
          [row.coordinator_task_id],
        ))[0]
      : undefined;

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      engagementId: row.engagement_id ?? undefined,
      objective: row.objective,
      strategy: row.strategy,
      status: deriveSwarmStatus(
        members.map((member) => member.status),
        coordinator?.status,
        Boolean(row.cancelled_at),
      ),
      members,
      coordinator,
      result: coordinator?.result,
      progress: progressFor(members),
      createdAt: row.created_at.toISOString(),
      cancelledAt: row.cancelled_at?.toISOString(),
    };
  }

  async list(limit = 25): Promise<SwarmRecord[]> {
    const { rows } = await getPool().query<{ id: string }>(
      'SELECT id FROM agent_swarms ORDER BY created_at DESC LIMIT $1',
      [Math.max(1, Math.min(100, Math.floor(limit)))],
    );
    const records: SwarmRecord[] = [];
    for (const row of rows) {
      const record = await this.get(row.id);
      if (record) records.push(record);
    }
    return records;
  }

  async cancel(id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE agent_swarms
          SET cancelled_at = COALESCE(cancelled_at, now()),
              synthesis_claimed_by = NULL,
              synthesis_claimed_at = NULL
        WHERE id = $1 AND cancelled_at IS NULL`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async remove(id: string): Promise<void> {
    await getPool().query('DELETE FROM agent_swarms WHERE id = $1', [id]);
  }

  /** Claim one finished swarm so multiple server processes cannot create two coordinators. */
  async claimReadyForSynthesis(runnerId: string): Promise<SwarmRecord | undefined> {
    const { rows } = await getPool().query<{ id: string }>(
      `WITH candidate AS (
         SELECT s.id
           FROM agent_swarms s
          WHERE s.coordinator_task_id IS NULL
            AND s.cancelled_at IS NULL
            AND s.sealed_at IS NOT NULL
            AND (s.synthesis_claimed_at IS NULL OR s.synthesis_claimed_at < now() - interval '90 seconds')
            AND EXISTS (SELECT 1 FROM agent_swarm_members m WHERE m.swarm_id = s.id)
            AND NOT EXISTS (
              SELECT 1
                FROM agent_swarm_members m
                JOIN tasks t ON t.id = m.task_id
               WHERE m.swarm_id = s.id
                 AND t.status NOT IN ('completed','failed','cancelled','blocked','waiting_for_user','interrupted')
            )
          ORDER BY s.created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE agent_swarms s
          SET synthesis_claimed_by = $1, synthesis_claimed_at = now()
         FROM candidate
        WHERE s.id = candidate.id
       RETURNING s.id`,
      [runnerId],
    );
    return rows[0] ? this.get(rows[0].id) : undefined;
  }

  async setCoordinator(id: string, taskId: string, runnerId: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `UPDATE agent_swarms
          SET coordinator_task_id = $2,
              synthesis_claimed_by = NULL,
              synthesis_claimed_at = NULL
        WHERE id = $1 AND synthesis_claimed_by = $3 AND coordinator_task_id IS NULL`,
      [id, taskId, runnerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async releaseSynthesisClaim(id: string, runnerId: string): Promise<void> {
    await getPool().query(
      `UPDATE agent_swarms
          SET synthesis_claimed_by = NULL, synthesis_claimed_at = NULL
        WHERE id = $1 AND synthesis_claimed_by = $2`,
      [id, runnerId],
    );
  }

  private async tasksFor(sql: string, params: unknown[]): Promise<SwarmTaskSummary[]> {
    const { rows } = await getPool().query<MemberRow>(sql, params);
    return rows.map(toTask);
  }
}
