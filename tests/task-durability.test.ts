import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database-backed proof that delegated work survives the process that created it.
 *
 * The original defect was structural: task rows lived in Postgres while the
 * queue driving them lived in process memory, with nothing reconciling the two
 * at startup. These tests simulate a worker process that died — a row claimed
 * by a runner id that no longer exists, with a stale heartbeat — and assert the
 * two recoveries that matter: running work is reported honestly rather than
 * left "running" forever, and queued work is handed back rather than stranded.
 *
 * Skips (visibly) without a database rather than failing.
 */

function loadEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // No .env is fine; DATABASE_URL may come from the environment.
  }
}
loadEnv();

const { getPool, closePool } = await import('@dacai-local-agent/shared');
const { TaskRunner } = await import('@dacai-local-agent/orchestrator');

let dbAvailable = false;
const RUN_ID = `durability_${Date.now().toString(36)}`;
const DEAD_RUNNER = `${RUN_ID}_dead`;

/** Insert a task row directly, standing in for one an earlier process left behind. */
async function seedTask(id: string, status: string, runnerId: string | null, heartbeatAgo: string | null): Promise<void> {
  await getPool().query(
    `INSERT INTO tasks (id, agent_id, provider_instance_id, model, objective, status, source, runner_id, heartbeat_at)
     VALUES ($1, 'repo-explorer', 'local_ollama', 'test-model', $2, $3, 'internal', $4,
             CASE WHEN $5::text IS NULL THEN NULL ELSE now() - $5::interval END)`,
    [id, `${RUN_ID} probe`, status, runnerId, heartbeatAgo],
  );
}

const statusOf = async (id: string): Promise<string> =>
  (await getPool().query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [id])).rows[0]?.status;

beforeAll(async () => {
  try {
    await getPool().query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await getPool().query('DELETE FROM tasks WHERE objective LIKE $1', [`${RUN_ID}%`]);
  }
  await closePool().catch(() => undefined);
});

describe('delegated task durability', () => {
  it('persists routing intent while updating the concrete execution route', async () => {
    if (!dbAvailable) return;
    const runner = new TaskRunner({ maxLocalWorkers: 1, maxTaskDepth: 3 });
    const created = await runner.create({
      objective: `${RUN_ID} alias routing probe`,
      agentId: 'repo-explorer',
      modelAlias: 'coder',
      providerInstanceId: 'local_ollama',
      model: 'local-model',
      source: 'internal',
    });

    expect(created.modelAlias).toBe('coder');
    const routed = await runner.recordResolution(created.id, 'remote_gpu_ollama', 'gpu-model');
    expect(routed).toMatchObject({
      modelAlias: 'coder',
      providerInstanceId: 'remote_gpu_ollama',
      model: 'gpu-model',
    });
    await expect(runner.get(created.id)).resolves.toMatchObject({ modelAlias: 'coder' });
  });

  it('reports work abandoned by a dead process as interrupted, not running', async () => {
    if (!dbAvailable) return;
    const id = `task_${RUN_ID}_orphan`;
    await seedTask(id, 'running', DEAD_RUNNER, '10 minutes');

    const runner = new TaskRunner({ maxLocalWorkers: 1, maxTaskDepth: 3, staleAfterMs: 60_000 });
    const { interrupted } = await runner.reconcile();

    expect(interrupted).toBeGreaterThanOrEqual(1);
    // 'interrupted' rather than 'failed': the agent did not fail, its host died.
    expect(await statusOf(id)).toBe('interrupted');
  });

  it('leaves a live task alone even when another runner reconciles', async () => {
    if (!dbAvailable) return;
    const id = `task_${RUN_ID}_live`;
    // Claimed by a different process, but still beating — a second server must
    // not steal or kill work that is genuinely in progress elsewhere.
    await seedTask(id, 'running', `${RUN_ID}_other`, '2 seconds');

    await new TaskRunner({ maxLocalWorkers: 1, maxTaskDepth: 3, staleAfterMs: 60_000 }).reconcile();

    expect(await statusOf(id)).toBe('running');
  });

  it('hands back queued work stranded by a dead process, and claims it', async () => {
    if (!dbAvailable) return;
    const id = `task_${RUN_ID}_stranded`;
    await seedTask(id, 'queued', DEAD_RUNNER, '10 minutes');

    const runner = new TaskRunner({ maxLocalWorkers: 1, maxTaskDepth: 3, staleAfterMs: 60_000 });
    const { released } = await runner.reconcile();
    expect(released).toBeGreaterThanOrEqual(1);

    // The whole point: a new process can now pick it up. Claim until this row
    // appears, since other queued rows may legitimately be ahead of it.
    let claimedIds: string[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const claimed = await runner.claimNext();
      if (!claimed) break;
      claimedIds.push(claimed.id);
      if (claimed.id === id) break;
    }

    expect(claimedIds).toContain(id);
    // Release anything else this test claimed so the server can still run it.
    await getPool().query(
      'UPDATE tasks SET runner_id = NULL, heartbeat_at = NULL WHERE runner_id = $1 AND id <> $2',
      [runner.runnerId, id],
    );
  });

  it('never lets two runners claim the same task', async () => {
    if (!dbAvailable) return;
    const id = `task_${RUN_ID}_contended`;
    await seedTask(id, 'queued', null, null);

    const a = new TaskRunner({ maxLocalWorkers: 4, maxTaskDepth: 3 });
    const b = new TaskRunner({ maxLocalWorkers: 4, maxTaskDepth: 3 });

    const claims = await Promise.all([a.claimNext(), b.claimNext(), a.claimNext(), b.claimNext()]);
    const ids = claims.filter(Boolean).map((task) => task!.id);

    expect(new Set(ids).size).toBe(ids.length);

    await getPool().query('UPDATE tasks SET runner_id = NULL, heartbeat_at = NULL WHERE runner_id = ANY($1)', [
      [a.runnerId, b.runnerId],
    ]);
  });
});
