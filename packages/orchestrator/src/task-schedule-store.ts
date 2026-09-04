import { createId, getPool } from '@dacai-local-agent/shared';

/**
 * Recurring and future-dated delegated work.
 *
 * Recurrence is deliberately three narrow shapes rather than a cron dialect.
 * Cron strings are easy to mistype and give no useful error until the run that
 * silently never happens; these can be validated completely up front and shown
 * back to the operator in plain language.
 */

export type ScheduleKind = 'once' | 'interval' | 'daily';

export interface ScheduleRecord {
  id: string;
  name: string;
  objective: string;
  role: string;
  workspaceId: string;
  alias?: string;
  runMode?: string;
  kind: ScheduleKind;
  intervalSeconds?: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastTaskId?: string;
  runCount: number;
  createdAt: string;
}

export interface CreateScheduleInput {
  name: string;
  objective: string;
  role: string;
  workspaceId: string;
  alias?: string;
  runMode?: string;
  kind: ScheduleKind;
  intervalSeconds?: number;
  firstRunAt: Date;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  name?: string;
  objective?: string;
  enabled?: boolean;
  intervalSeconds?: number;
  nextRunAt?: Date;
}

interface Row {
  id: string;
  name: string;
  objective: string;
  role: string;
  workspace_id: string;
  alias: string | null;
  run_mode: string | null;
  kind: ScheduleKind;
  interval_seconds: number | null;
  enabled: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  last_task_id: string | null;
  run_count: number;
  created_at: Date;
}

function toSchedule(row: Row): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    role: row.role,
    workspaceId: row.workspace_id,
    alias: row.alias ?? undefined,
    runMode: row.run_mode ?? undefined,
    kind: row.kind,
    intervalSeconds: row.interval_seconds ?? undefined,
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString(),
    lastTaskId: row.last_task_id ?? undefined,
    runCount: row.run_count,
    createdAt: row.created_at.toISOString(),
  };
}

export const MIN_INTERVAL_SECONDS = 60;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

/**
 * Advance a fired schedule to its next due time.
 *
 * Catch-up is deliberately skipped: if the server was down for a week, a daily
 * schedule should run once now and then resume its cadence, not fire seven
 * times in a row. The loop walks forward from the missed time rather than
 * adding a single period, so a long outage cannot leave `next_run_at`
 * permanently in the past.
 */
export function computeNextRun(schedule: Pick<ScheduleRecord, 'kind' | 'intervalSeconds' | 'nextRunAt'>, now = new Date()): Date | undefined {
  if (schedule.kind === 'once') return undefined;
  const periodMs = (schedule.kind === 'daily' ? 86_400 : schedule.intervalSeconds ?? MIN_INTERVAL_SECONDS) * 1000;

  let next = new Date(schedule.nextRunAt).getTime() + periodMs;
  if (next <= now.getTime()) {
    // The +1 matters when the gap is an exact multiple of the period: without
    // it the next run lands precisely on `now`, and the very next tick treats
    // the schedule as due again, firing it twice.
    const periodsBehind = Math.floor((now.getTime() - next) / periodMs) + 1;
    next += periodsBehind * periodMs;
  }
  return new Date(next);
}

export class ScheduleStore {
  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    if (!input.name.trim()) throw new ScheduleValidationError('name is required.');
    if (!input.objective.trim()) throw new ScheduleValidationError('objective is required.');
    if (input.kind === 'interval') {
      if (!input.intervalSeconds || input.intervalSeconds < MIN_INTERVAL_SECONDS) {
        throw new ScheduleValidationError(`interval schedules need intervalSeconds of at least ${MIN_INTERVAL_SECONDS}.`);
      }
    }
    if (Number.isNaN(input.firstRunAt.getTime())) {
      throw new ScheduleValidationError('firstRunAt is not a valid date.');
    }

    const { rows } = await getPool().query<Row>(
      `INSERT INTO task_schedules
         (id, name, objective, role, workspace_id, alias, run_mode, kind,
          interval_seconds, enabled, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        createId('sched'),
        input.name.trim(),
        input.objective.trim(),
        input.role,
        input.workspaceId,
        input.alias ?? null,
        input.runMode ?? null,
        input.kind,
        input.kind === 'interval' ? input.intervalSeconds : null,
        input.enabled ?? true,
        input.firstRunAt,
      ],
    );
    return toSchedule(rows[0]);
  }

  async list(): Promise<ScheduleRecord[]> {
    const { rows } = await getPool().query<Row>(
      'SELECT * FROM task_schedules ORDER BY enabled DESC, next_run_at ASC',
    );
    return rows.map(toSchedule);
  }

  async get(id: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await getPool().query<Row>('SELECT * FROM task_schedules WHERE id = $1', [id]);
    return rows[0] ? toSchedule(rows[0]) : undefined;
  }

  async update(id: string, patch: UpdateScheduleInput): Promise<ScheduleRecord | undefined> {
    const { rows } = await getPool().query<Row>(
      `UPDATE task_schedules
          SET name             = COALESCE($2, name),
              objective        = COALESCE($3, objective),
              enabled          = COALESCE($4, enabled),
              interval_seconds = COALESCE($5, interval_seconds),
              next_run_at      = COALESCE($6, next_run_at)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        patch.name?.trim() ?? null,
        patch.objective?.trim() ?? null,
        patch.enabled ?? null,
        patch.intervalSeconds ?? null,
        patch.nextRunAt ?? null,
      ],
    );
    return rows[0] ? toSchedule(rows[0]) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const { rowCount } = await getPool().query('DELETE FROM task_schedules WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Claim every schedule that is due, advancing each one in the same statement.
   *
   * Advancing at claim time rather than after the task finishes is what stops a
   * slow or crashed run from firing the same schedule repeatedly on the next
   * tick.
   */
  async claimDue(now = new Date()): Promise<ScheduleRecord[]> {
    const { rows } = await getPool().query<Row>(
      `SELECT * FROM task_schedules
        WHERE enabled AND next_run_at <= $1
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED`,
      [now],
    );

    const due = rows.map(toSchedule);
    for (const schedule of due) {
      const next = computeNextRun(schedule, now);
      await getPool().query(
        `UPDATE task_schedules
            SET next_run_at = COALESCE($2, next_run_at),
                enabled     = $3,
                last_run_at = now(),
                run_count   = run_count + 1
          WHERE id = $1`,
        [schedule.id, next ?? null, next !== undefined],
      );
    }
    return due;
  }

  /** Records which task a fired schedule produced, for its run history. */
  async recordRun(id: string, taskId: string): Promise<void> {
    await getPool().query('UPDATE task_schedules SET last_task_id = $2 WHERE id = $1', [id, taskId]);
  }
}
