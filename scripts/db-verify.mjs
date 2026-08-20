/**
 * Applies pending migrations and round-trips a row through every table the
 * platform depends on, then removes what it wrote.
 *
 *   node --import tsx scripts/db-verify.mjs
 *
 * Connects only as the dedicated least-privileged role from DATABASE_URL;
 * superuser credentials are never used or retained here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePool, createId, getPool, runMigrations, verifyConnection } from '../packages/shared/src/index.ts';

// Read .env directly rather than pulling dotenv into the repo root.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

await verifyConnection();

const { applied, alreadyCurrent } = await runMigrations();
console.log(`migrations applied: ${applied.length ? applied.join(', ') : '(none)'}`);
console.log(`already current:    ${alreadyCurrent.length}`);

const pool = getPool();
const wsId = createId('ws');
const taskId = createId('task');
const traceId = createId('tr');

try {
  await pool.query(
    `INSERT INTO workspaces (id, display_name, root_path, read_access, write_access)
     VALUES ($1, $2, $3, TRUE, FALSE)`,
    [wsId, 'db-verify', `C:/tmp/db-verify-${wsId}`],
  );

  const workspace = await pool.query(
    'SELECT display_name, training_trace_capture, training_export_allowed FROM workspaces WHERE id = $1',
    [wsId],
  );
  console.log('workspace:', workspace.rows[0]);

  await pool.query(
    `INSERT INTO tasks (id, workspace_id, agent_id, provider_instance_id, model, objective, status, source)
     VALUES ($1, $2, 'coder', 'local_ollama', 'qwen2.5-coder:latest', 'db-verify', 'completed', 'mcp')`,
    [taskId, wsId],
  );

  await pool.query(
    `INSERT INTO usage_events (task_id, workspace_id, provider_instance_id, usage_class, model, source, worker_role)
     VALUES ($1, $2, 'local_ollama', 'LOCAL_OLLAMA', 'qwen2.5-coder:latest', 'mcp', 'coder')`,
    [taskId, wsId],
  );

  const usage = await pool.query(
    'SELECT usage_class, source, provider_instance_id FROM usage_events WHERE task_id = $1',
    [taskId],
  );
  console.log('usage_event:', usage.rows[0]);

  await pool.query(
    `INSERT INTO training_traces
       (trace_id, task_id, workspace_id, agent_role, task_type, objective,
        provider_instance_id, usage_class, model, model_digest, classification,
        sanitization_passed, eligible_for_training, source, supervisor_disposition)
     VALUES ($1, $2, $3, 'coder', 'code_task', 'db-verify', 'local_ollama', 'LOCAL_OLLAMA',
             'qwen2.5-coder:latest', 'sha256-60e05f21', 'successful', TRUE, TRUE, 'mcp', 'accepted')`,
    [traceId, taskId, wsId],
  );

  await pool.query(
    `INSERT INTO training_trace_steps (trace_id, sequence, step_type, tool_name, result_summary, evidence)
     VALUES ($1, 1, 'verification', 'shell.run', 'pnpm test exited 0', $2::jsonb)`,
    [traceId, JSON.stringify([{ kind: 'exit_code', summary: 'pnpm test exited 0' }])],
  );

  await pool.query(
    `INSERT INTO training_feedback (trace_id, rating, comment) VALUES ($1, 'good', 'db-verify')`,
    [traceId],
  );

  const trace = await pool.query(
    `SELECT t.classification, t.eligible_for_training, t.usage_class, t.model_digest,
            t.supervisor_disposition, count(s.id)::int AS steps, max(f.rating) AS rating
       FROM training_traces t
       LEFT JOIN training_trace_steps s ON s.trace_id = t.trace_id
       LEFT JOIN training_feedback f ON f.trace_id = t.trace_id
      WHERE t.trace_id = $1
      GROUP BY t.trace_id`,
    [traceId],
  );
  console.log('training_trace:', trace.rows[0]);

  // The usage-class CHECK is what keeps telemetry honest; prove it rejects.
  let rejected = false;
  try {
    await pool.query(
      `INSERT INTO usage_events (provider_instance_id, usage_class, model) VALUES ('x', 'FREE_LUNCH', 'm')`,
    );
  } catch {
    rejected = true;
  }
  console.log(`usage_class CHECK rejects unknown values: ${rejected ? 'yes' : 'NO — constraint missing'}`);
  if (!rejected) process.exitCode = 1;
} finally {
  await pool.query('DELETE FROM training_traces WHERE trace_id = $1', [traceId]);
  // Verification rows must never survive into the usage ledger — a stray 'mcp'
  // row would read as a delegation that never happened.
  await pool.query('DELETE FROM usage_events WHERE task_id = $1', [taskId]);
  await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [wsId]);
  await closePool();
  console.log('cleanup: done');
}
