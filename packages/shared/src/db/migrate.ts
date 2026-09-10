import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, isTransientDatabaseConnectionError } from './pool';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_LOCK_ID = 4_276_221;
const MIGRATION_ATTEMPTS = 5;

export interface MigrationResult {
  applied: string[];
  alreadyCurrent: string[];
}

async function runMigrationsOnce(): Promise<MigrationResult> {
  const pool = getPool();
  const client = await pool.connect();
  let lockAcquired = false;
  let releaseError: Error | undefined;

  try {
    // A local watch server, a worker, and the main API may all start together.
    // Hold a database-scoped lock for the entire check/apply sequence so two
    // instances cannot both decide that the same migration is pending.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((row) => row.name));

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
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }

    return { applied, alreadyCurrent };
  } catch (error) {
    if (isTransientDatabaseConnectionError(error)) {
      releaseError = error instanceof Error ? error : new Error(String(error));
    }
    throw error;
  } finally {
    if (lockAcquired && !releaseError) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } catch (error) {
        if (isTransientDatabaseConnectionError(error)) {
          releaseError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    client.release(releaseError);
  }
}

/**
 * Migration files and their ledger insert commit in the same transaction, so
 * repeating the complete check/apply sequence after a transport disconnect is
 * safe. Validation or SQL errors are never retried.
 */
export async function runMigrations(): Promise<MigrationResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MIGRATION_ATTEMPTS; attempt += 1) {
    try {
      return await runMigrationsOnce();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseConnectionError(error) || attempt === MIGRATION_ATTEMPTS) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
