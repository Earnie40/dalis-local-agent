import { getPool, queryDatabaseRead } from './pool';

/**
 * Agent run history.
 *
 * The agent-side counterpart to `ConversationStore`. `agent_activity_events`
 * already held every event of every run, but only answered "what happened in
 * run X" for an id the caller already had — so the web client kept its session
 * list in browser localStorage, and history died with the browser profile.
 *
 * This store is the run-level index that makes that activity reachable from any
 * browser or machine.
 */

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';

export interface AgentRunRecord {
  id: string;
  workspaceId: string;
  sessionId?: string;
  title: string;
  objective?: string;
  alias?: string;
  model?: string;
  providerInstanceId?: string;
  role?: string;
  runMode?: string;
  status: AgentRunStatus;
  answer?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  eventCount?: number;
}

interface AgentRunRow {
  id: string;
  workspace_id: string;
  session_id: string | null;
  title: string;
  objective: string | null;
  alias: string | null;
  model: string | null;
  provider_instance_id: string | null;
  role: string | null;
  run_mode: string | null;
  status: AgentRunStatus;
  answer: string | null;
  error: string | null;
  started_at: Date;
  ended_at: Date | null;
  event_count?: string | number | null;
}

function toRun(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id ?? undefined,
    title: row.title,
    objective: row.objective ?? undefined,
    alias: row.alias ?? undefined,
    model: row.model ?? undefined,
    providerInstanceId: row.provider_instance_id ?? undefined,
    role: row.role ?? undefined,
    runMode: row.run_mode ?? undefined,
    status: row.status,
    answer: row.answer ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : undefined,
    eventCount: row.event_count === undefined || row.event_count === null ? undefined : Number(row.event_count),
  };
}

/** First line of the objective, so a run is recognisable in the list. */
export function deriveRunTitle(objective: string): string {
  const line = objective.trim().split('\n')[0] ?? '';
  const trimmed = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return trimmed || 'Agent run';
}

const SELECT_WITH_COUNT = `
  SELECT r.*, count(e.id) AS event_count
    FROM agent_runs r
    LEFT JOIN agent_activity_events e ON e.run_id = r.id
`;

export class AgentRunStore {
  async list(options: { limit?: number; workspaceId?: string; sessionId?: string } = {}): Promise<AgentRunRecord[]> {
    // Cap the page so a long-lived install cannot stream thousands of rows into
    // the sidebar on first paint.
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const filters: string[] = [];
    const params: unknown[] = [];

    if (options.workspaceId) {
      params.push(options.workspaceId);
      filters.push(`r.workspace_id = $${params.length}`);
    }
    if (options.sessionId) {
      params.push(options.sessionId);
      filters.push(`r.session_id = $${params.length}`);
    }

    params.push(limit);

    const { rows } = await queryDatabaseRead<AgentRunRow>(
      `${SELECT_WITH_COUNT}
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       GROUP BY r.id
       ORDER BY r.started_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(toRun);
  }

  async get(id: string): Promise<AgentRunRecord | undefined> {
    const { rows } = await queryDatabaseRead<AgentRunRow>(
      `${SELECT_WITH_COUNT} WHERE r.id = $1 GROUP BY r.id`,
      [id],
    );
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  /**
   * Records a run at its start so it is visible while still in flight, and is
   * still on record if the process dies before producing an answer.
   *
   * Re-running the same id updates the existing row rather than failing: a
   * resumed run keeps one history entry instead of forking into two.
   */
  async start(input: {
    id: string;
    workspaceId: string;
    sessionId?: string;
    objective: string;
    alias?: string;
    model?: string;
    providerInstanceId?: string;
    role?: string;
    runMode?: string;
  }): Promise<AgentRunRecord> {
    const { rows } = await getPool().query<AgentRunRow>(
      `INSERT INTO agent_runs (
         id, workspace_id, session_id, title, objective,
         alias, model, provider_instance_id, role, run_mode, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running')
       ON CONFLICT (id) DO UPDATE SET
         session_id           = COALESCE(EXCLUDED.session_id, agent_runs.session_id),
         alias                = COALESCE(EXCLUDED.alias, agent_runs.alias),
         model                = COALESCE(EXCLUDED.model, agent_runs.model),
         provider_instance_id = COALESCE(EXCLUDED.provider_instance_id, agent_runs.provider_instance_id),
         role                 = COALESCE(EXCLUDED.role, agent_runs.role),
         run_mode             = COALESCE(EXCLUDED.run_mode, agent_runs.run_mode)
       RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.sessionId ?? null,
        deriveRunTitle(input.objective),
        input.objective,
        input.alias ?? null,
        input.model ?? null,
        input.providerInstanceId ?? null,
        input.role ?? null,
        input.runMode ?? null,
      ],
    );
    return toRun(rows[0]);
  }

  /**
   * Marks a run terminal. Only ever advances a run that is still `running`, so
   * a late-arriving completion cannot overwrite a recorded failure or a
   * cancellation the operator already saw.
   */
  async finish(
    id: string,
    input: { status: AgentRunStatus; answer?: string; error?: string; model?: string; providerInstanceId?: string },
  ): Promise<void> {
    await getPool().query(
      `UPDATE agent_runs
          SET status               = $2,
              answer               = COALESCE($3, answer),
              error                = COALESCE($4, error),
              model                = COALESCE($5, model),
              provider_instance_id = COALESCE($6, provider_instance_id),
              ended_at             = now()
        WHERE id = $1
          AND status = 'running'`,
      [id, input.status, input.answer ?? null, input.error ?? null, input.model ?? null, input.providerInstanceId ?? null],
    );
  }

  async remove(id: string): Promise<void> {
    await getPool().query('DELETE FROM agent_runs WHERE id = $1', [id]);
  }

  /**
   * Reconciles runs left `running` by a process that died mid-flight. Without
   * this a killed server leaves rows that claim to be in progress forever.
   */
  async failStaleRuns(olderThanMinutes = 60): Promise<number> {
    const { rowCount } = await getPool().query(
      `UPDATE agent_runs
          SET status   = 'failed',
              error    = COALESCE(error, 'Run did not finish: the server stopped before it completed.'),
              ended_at = now()
        WHERE status = 'running'
          AND started_at < now() - ($1 || ' minutes')::interval`,
      [String(Math.max(1, Math.trunc(olderThanMinutes)))],
    );
    return rowCount ?? 0;
  }
}
