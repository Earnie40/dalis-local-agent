import { createId, getPool } from '@dacai-local-agent/shared';

/**
 * Task lifecycle and bounded concurrency for delegated work.
 *
 * Delegation exists so a supervising session can hand off token-heavy work and
 * poll for a result, which means tasks must survive the request that created
 * them: every state transition is written to Postgres, and cancellation is a
 * durable fact rather than a dropped connection.
 */

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  parentId?: string;
  workspaceId?: string;
  agentId: string;
  providerInstanceId: string;
  model: string;
  objective: string;
  status: TaskStatus;
  depth: number;
  source: 'ui' | 'mcp' | 'internal';
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
}

interface Row {
  id: string;
  parent_id: string | null;
  workspace_id: string | null;
  agent_id: string;
  provider_instance_id: string;
  model: string;
  objective: string;
  status: TaskStatus;
  depth: number;
  source: 'ui' | 'mcp' | 'internal';
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
    providerInstanceId: row.provider_instance_id,
    model: row.model,
    objective: row.objective,
    status: row.status,
    depth: row.depth,
    source: row.source,
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
  providerInstanceId: string;
  model: string;
  workspaceId?: string;
  parentId?: string;
  depth?: number;
  source?: 'ui' | 'mcp' | 'internal';
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

  constructor(private readonly limits: TaskLimits) {}

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  async create(input: DelegateInput): Promise<TaskRecord> {
    const depth = input.depth ?? 0;
    if (depth > this.limits.maxTaskDepth) {
      throw new TaskDepthError(depth, this.limits.maxTaskDepth);
    }

    const { rows } = await getPool().query<Row>(
      `INSERT INTO tasks
         (id, parent_id, workspace_id, agent_id, provider_instance_id, model, objective,
          status, depth, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9) RETURNING *`,
      [
        createId('task'),
        input.parentId ?? null,
        input.workspaceId ?? null,
        input.agentId,
        input.providerInstanceId,
        input.model,
        input.objective,
        depth,
        input.source ?? 'internal',
      ],
    );

    return toTask(rows[0]);
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    const { rows } = await getPool().query<Row>('SELECT * FROM tasks WHERE id = $1', [id]);
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
    }>,
  ): Promise<TaskRecord> {
    await this.acquire();

    const controller = new AbortController();
    this.cancellations.set(task.id, controller);

    try {
      // A task cancelled while queued must not start.
      const current = await this.get(task.id);
      if (current?.status === 'cancelled') return current;

      await getPool().query(
        `UPDATE tasks SET status = 'running', started_at = now() WHERE id = $1`,
        [task.id],
      );

      const outcome = await worker(controller.signal);

      const { rows } = await getPool().query<Row>(
        `UPDATE tasks
            SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'completed' END,
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
      this.cancellations.delete(task.id);
      this.release();
    }
  }
}
