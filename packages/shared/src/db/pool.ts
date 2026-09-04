import pg from 'pg';

export type { PoolClient } from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

export class DatabaseConfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * Strips credentials so a connection target can appear in logs and error
 * messages without leaking the password.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    parsed.username = parsed.username ? `${parsed.username}:***` : '';
    return parsed.toString().replace(':***@', ':***@');
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

export function getPool(connectionString?: string): pg.Pool {
  if (pool) return pool;

  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new DatabaseConfigurationError(
      'DATABASE_URL is not set. PostgreSQL is required. Run scripts/provision-db.mjs and add the printed DATABASE_URL to .env.',
    );
  }

  pool = new Pool({ connectionString: url, max: 10 });
  return pool;
}

export async function verifyConnection(connectionString?: string): Promise<void> {
  const url = connectionString ?? process.env.DATABASE_URL;
  try {
    await getPool(connectionString).query('SELECT 1');
  } catch (error) {
    throw new DatabaseConfigurationError(
      `Could not connect to PostgreSQL at ${redactDatabaseUrl(url ?? '')}. Confirm the service is running and DATABASE_URL is correct.`,
      { cause: error },
    );
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
