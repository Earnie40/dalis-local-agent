import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationResult {
  applied: string[];
  alreadyCurrent: string[];
}

export async function runMigrations(): Promise<MigrationResult> {
  const pool = getPool();
  const client = await pool.connect();

  // A local watch server, a worker, and the main API may all start together.
  // Hold a database-scoped lock for the entire check/apply sequence so two
  // instances cannot both decide that the same migration is pending.
  await client.query('SELECT pg_advisory_lock($1)', [4_276_221]);
  try {

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  const alreadyCurrent: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      alreadyCurrent.push(file);
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  return { applied, alreadyCurrent };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4_276_221]).catch(() => undefined);
    client.release();
  }
}
