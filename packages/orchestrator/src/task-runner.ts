import { createId, getPool } from '@dacai-local-agent/shared';

/**
 * Task lifecycle and bounded concurrency for delegated work.
 *
 * Delegation exists so a supervising session can hand off token-heavy work and
 * poll for a result, which means tasks must survive the request that created
 * them: every state transition is written to Postgres, and cancellation is a
 * durable fact rather than a dropped connection.
 */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'waiting_for_user'
  | 'interrupted';

export type TaskTerminalStatus = Extract<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'blocked' | 'waiting_for_user'>;

export interface TaskRecord {
  id: string;
  parentId?: string;
  workspaceId?: string;
  agentId: string;
  /** Requested routing intent, re-resolved when durable queued work starts. */
  modelAlias?: string;
  providerInstanceId: string;
  model: string;
  objective: string;
  status: TaskStatus;
  depth: number;
  source: 'ui' | 'mcp' | 'internal';
  scheduleId?: string;
  result?: string;
  evidence: unknown[];
  errors: unknown[];
  usage: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskLimits {
  maxLocalWorkers: number;
  maxTaskDepth: number;
  /**
   * A running task whose owner has not checked in for this long is treated as
   * abandoned. Must exceed the heartbeat period by a wide margin so a busy
   * event loop is never mistaken for a dead process.
   */
  staleAfterMs?: number;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_AFTER_MS = 90_000;

interface Row {
  id: string;
  parent_id: string | null;
  workspace_id: string | null;
  agent_id: string;
  model_alias: string | null;
  provider_instance_id: string;
  model: string;
  objective: string;
  status: TaskStatus;
  depth: number;
  source: 'ui' | 'mcp' | 'internal';
  schedule_id: string | null;
  result: string | null;
  evidence: unknown[];
  errors: unknown[];
  usage: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function toTask(row: Row): TaskRecord {
  return {
    id: row.id,
    parentId: row.parent_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    agentId: row.agent_id,
    modelAlias: row.model_alias ?? undefined,
    providerInstanceId: row.provider_instance_id,
    model: row.model,
    objective: row.objective,
    status: row.status,
    depth: row.depth,
    source: row.source,
    scheduleId: row.schedule_id ?? undefined,
    result: row.result ?? undefined,
    evidence: row.evidence ?? [],
    errors: row.errors ?? [],
    usage: row.usage ?? {},
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

export class TaskDepthError extends Error {
  constructor(depth: number, max: number) {
    super(`Task depth ${depth} exceeds the maximum of ${max}. A worker cannot delegate this deep.`);
    this.name = 'TaskDepthError';
  }
}

export interface DelegateInput {
  objective: string;
  agentId: string;
  modelAlias?: string;
  providerInstanceId: string;
  model: string;
  workspaceId?: string;
  parentId?: string;
  depth?: number;
  source?: 'ui' | 'mcp' | 'internal';
  scheduleId?: string;
}

/**
 * Runs delegated tasks with a concurrency cap. Work beyond the cap queues
 * rather than being rejected — a supervisor that fires five tasks at once
 * should get five results, just not five simultaneous model requests competing
 * for the same local hardware.
 */
export class TaskRunner {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly cancellations = new Map<string, AbortController>();
  /** Identifies this process so a row can name the worker that owns it. */
  readonly runnerId = createId('runner');

  constructor(private readonly limits: TaskLimits) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get freeSlots(): number {
    return Math.max(0, this.limits.maxLocalWorkers - this.active);
  }

  async create(input: DelegateInput): Promise<TaskRecord> {
    const depth = input.depth ?? 0;
    if (depth > this.limits.maxTaskDepth) {
      throw new TaskDepthError(depth, this.limits.maxTaskDepth);
    }

    const { rows } = await getPool().query<Row>(
      `INSERT INTO tasks
         (id, parent_id, workspace_id, agent_id, model_alias, provider_instance_id, model,
          objective, status, depth, source, schedule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11) RETURNING *`,
      [
        createId('task'),
        input.parentId ?? null,
        input.workspaceId ?? null,
        input.agentId,
        input.modelAlias ?? null,
        input.providerInstanceId,
        input.model,
        input.objective,
        depth,
        input.source ?? 'internal',
        input.scheduleId ?? null,
      ],
    );

    return toTask(rows[0]);
  }

  /**
   * Releases work abandoned by a process that no longer exists.
   *
   * Called at startup and periodically. A row is only reclaimed when it is not
   * ours *and* its heartbeat has gone quiet, so two servers sharing a database
   * cannot steal each other's live work. Running rows become 'interrupted'
   * rather than requeued: the agent may already have edited files, so silently
   * re-running it could repeat a side effect. Queued rows never started, so
   * they are safe to hand back by clearing their claim.
   */
  async reconcile(): Promise<{ interrupted: number; released: number }> {
    const staleAfter = this.limits.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const interval = `${Math.max(1, Math.round(staleAfter / 1000))} seconds`;

    const { rowCount: interrupted } = await getPool().query(
      `UPDATE tasks
          SET status = 'interrupted',
              completed_at = now(),
              runner_id = NULL,
              errors = errors || $2::jsonb
        WHERE status = 'running'
          AND (runner_id IS NULL OR runner_id <> $1)
          AND (heartbeat_at IS NULL OR heartbeat_at < now() - $3::interval)`,
      [
        this.runnerId,
        JSON.stringify([{ kind: 'interrupted', message: 'Worker process ended before the task finished.' }]),
        interval,
      ],
    );

    const { rowCount: released } = await getPool().query(
      `UPDATE tasks
          SET runner_id = NULL, heartbeat_at = NULL
        WHERE status = 'queued'
          AND runner_id IS NOT NULL
          AND runner_id <> $1`,
      [this.runnerId],
    );

    return { interrupted: interrupted ?? 0, released: released ?? 0 };
  }

  /**
   * Atomically takes ownership of the oldest unclaimed queued task.
   *
   * SKIP LOCKED is what makes this safe to call from more than one worker (or
   * more than one server) at a time: a row being claimed elsewhere is passed
   * over instead of blocking.
   */
  async claimNext(): Promise<TaskRecord | undefined> {
    const { rows } = await getPool().query<Row>(
      `UPDATE tasks SET runner_id = $1, heartbeat_at = now()
        WHERE id = (
          SELECT id FROM tasks
           WHERE status = 'queued' AND runner_id IS NULL
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING *`,
      [this.runnerId],
    );
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const { rows } = await getPool().query<Row>('SELECT * FROM tasks WHERE id = $1', [id]);
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  /** Records the concrete provider selected from a durable task's alias at execution time. */
  async recordResolution(id: string, providerInstanceId: string, model: string): Promise<TaskRecord | undefined> {
    const { rows } = await getPool().query<Row>(
      `UPDATE tasks
          SET provider_instance_id = $2, model = $3
        WHERE id = $1
        RETURNING *`,
      [id, providerInstanceId, model],
    );
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  async list(limit = 50): Promise<TaskRecord[]> {
    const { rows } = await getPool().query<Row>(
      'SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(toTask);
  }

  /**
   * Cancellation is durable: the row is marked immediately so a poller sees it
   * even if the worker takes a moment to notice its abort signal.
   */
  async cancel(id: string): Promise<boolean> {
    const controller = this.cancellations.get(id);
    controller?.abort();

    const { rowCount } = await getPool().query(
      `UPDATE tasks
          SET status = 'cancelled', completed_at = now()
        WHERE id = $1 AND status IN ('queued','running')`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Waits for a free worker slot, respecting maxLocalWorkers. */
  private async acquire(): Promise<void> {
    if (this.active < this.limits.maxLocalWorkers) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }

  /**
   * Executes a task, recording every transition. The worker receives an
   * AbortSignal so cancellation reaches the model request, not just the loop.
   */
  async run(
    task: TaskRecord,
    worker: (signal: AbortSignal) => Promise<{
      result: string;
      evidence?: unknown[];
      usage?: Record<string, unknown>;
      /** A non-successful, but fully reported, agent outcome. */
      status?: TaskTerminalStatus;
    }>,
  ): Promise<TaskRecord> {
    await this.acquire();

    const controller = new AbortController();
    this.cancellations.set(task.id, controller);
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      // A task cancelled while queued must not start.
      const current = await this.get(task.id);
      if (current?.status === 'cancelled') return current;

      await getPool().query(
        `UPDATE tasks SET status = 'running', started_at = now(),
                         runner_id = $2, heartbeat_at = now()
          WHERE id = $1`,
        [task.id, this.runnerId],
      );
      heartbeat = this.startHeartbeat(task.id);

      const outcome = await worker(controller.signal);

      const { rows } = await getPool().query<Row>(
        `UPDATE tasks
            SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE $5 END,
                result = $2,
                evidence = $3::jsonb,
                usage = $4::jsonb,
                completed_at = now()
          WHERE id = $1
          RETURNING *`,
        [
          task.id,
          outcome.result,
          JSON.stringify(outcome.evidence ?? []),
          JSON.stringify(outcome.usage ?? {}),
          outcome.status ?? 'completed',
        ],
      );

      return toTask(rows[0]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted;

      const { rows } = await getPool().query<Row>(
        `UPDATE tasks
            SET status = $2,
                errors = $3::jsonb,
                completed_at = now()
          WHERE id = $1
          RETURNING *`,
        [task.id, cancelled ? 'cancelled' : 'failed', JSON.stringify([{ message }])],
      );

      return toTask(rows[0]);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.cancellations.delete(task.id);
      this.release();
    }
  }

  /**
   * Marks the task as still owned while the worker runs. Unref'd so a live
   * heartbeat never holds the process open on shutdown, and failures are
   * swallowed: a dropped beat is recoverable, but throwing here would abort an
   * otherwise healthy task.
   */
  private startHeartbeat(taskId: string): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void getPool()
        .query('UPDATE tasks SET heartbeat_at = now() WHERE id = $1 AND runner_id = $2', [taskId, this.runnerId])
        .catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }
}
