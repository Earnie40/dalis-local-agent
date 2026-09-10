import pg from 'pg';

export type { PoolClient } from 'pg';

const { Pool } = pg;

const DATABASE_POOL_MAX = 1;
const DATABASE_CONNECT_ATTEMPTS = 3;
const DATABASE_READ_ATTEMPTS = 3;
const DATABASE_HEARTBEAT_INTERVAL_MS = 5_000;

let pool: pg.Pool | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

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

  pool = new Pool({
    connectionString: url,
    /*
     * PostgreSQL on Windows starts a backend process for each physical
     * connection. On this workstation, opening a second backend during a cold
     * request burst reproducibly resets one connection. Keep one warm database
     * client and queue concurrent local persistence calls in-process.
     */
    max: DATABASE_POOL_MAX,
    min: 1,
    /*
     * Idle pooled connections were being dropped underneath us, which surfaced
     * as "Connection terminated unexpectedly" on the next borrow. Keepalive
     * makes the drop visible to TCP instead of on first use.
    */
    keepAlive: true,
    keepAliveInitialDelayMillis: DATABASE_HEARTBEAT_INTERVAL_MS,
    idleTimeoutMillis: 300_000,
    /*
     * A Windows PostgreSQL backend can take longer than ten seconds to spawn
     * while the workstation is busy. A ten-second client timer was aborting a
     * connection that the server was still accepting, producing the server's
     * "forcibly closed by the remote host" log entry. Keep startup bounded,
     * but leave enough time for that backend process to become ready.
     */
    connectionTimeoutMillis: 30_000,
  });

  /*
   * A pooled client can emit 'error' while idle, long after the query that
   * borrowed it settled. EventEmitter rethrows an unhandled 'error', so without
   * this listener a recoverable database blip terminates the whole process.
   * Discarding the client is the correct recovery: the pool replaces it.
   */
  pool.on('error', (error) => {
    console.error('[db] idle client error (connection discarded):', error.message);
  });

  /*
   * pg-pool detaches its own idle 'error' listener while a client is checked
   * out (_acquireClient) and only reattaches it on release. If the connection
   * dies inside that window with no in-flight query to absorb the failure, the
   * Client emits an 'error' nobody listens for, and EventEmitter rethrows it as
   * an uncaught exception that kills the server. The pool-level handler above
   * never sees it, because that one only fires for clients sitting idle.
   *
   * Attaching a listener at connect time closes the gap: pg-pool removes only
   * its own idleListener by reference, so this one survives every checkout and
   * release for the life of the client. The pool still discards the broken
   * connection on its own; this just stops the failure from being fatal.
   */
  pool.on('connect', (client) => {
    client.on('error', (error: Error) => {
      console.error('[db] client error (connection discarded):', error.message);
    });
  });

  /*
   * The local Windows service was dropping an otherwise idle loopback client
   * after roughly nineteen seconds. One coalesced SELECT keeps the sole pooled
   * connection active and also makes the pool begin replacing it before a UI
   * request arrives. This is read-only and never overlaps with itself.
   */
  const databasePool = pool;
  let heartbeatInFlight = false;
  heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void databasePool.query('SELECT 1')
      .catch((error: Error) => {
        console.error('[db] heartbeat failed; pool will replace the connection:', error.message);
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, DATABASE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  return pool;
}

export function isTransientDatabaseConnectionError(error: unknown): boolean {
  const messages: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);

    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);

    current = current.cause;
  }

  return (
    codes.some((code) => /^08/.test(code) || /^(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED)$/.test(code)) ||
    /connection terminated|connection timeout|timeout exceeded when trying to connect|server closed the connection unexpectedly|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i
      .test(messages.join(' '))
  );
}

/**
 * Retry only caller-declared read-only SQL after a transport failure. Mutating
 * queries intentionally continue to use the pool directly because replaying a
 * write after an ambiguous disconnect could duplicate the mutation.
 */
export async function queryDatabaseRead<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<Row>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DATABASE_READ_ATTEMPTS; attempt += 1) {
    try {
      return await getPool().query<Row>(text, values);
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseConnectionError(error) || attempt === DATABASE_READ_ATTEMPTS) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function acquireVerifiedClient(databasePool: pg.Pool): Promise<pg.PoolClient> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DATABASE_CONNECT_ATTEMPTS; attempt += 1) {
    let client: pg.PoolClient | undefined;
    try {
      client = await databasePool.connect();
      await client.query('SELECT 1');
      return client;
    } catch (error) {
      lastError = error;
      client?.release(error instanceof Error ? error : new Error(String(error)));
      if (!isTransientDatabaseConnectionError(error) || attempt === DATABASE_CONNECT_ATTEMPTS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function verifyConnection(connectionString?: string): Promise<void> {
  const url = connectionString ?? process.env.DATABASE_URL;
  const databasePool = getPool(connectionString);
  const clients: pg.PoolClient[] = [];
  try {
    // Hold each verified client while acquiring the next so the configured
    // physical connections are established sequentially before traffic starts.
    for (let index = 0; index < DATABASE_POOL_MAX; index += 1) {
      clients.push(await acquireVerifiedClient(databasePool));
    }
  } catch (error) {
    throw new DatabaseConfigurationError(
      `Could not connect to PostgreSQL at ${redactDatabaseUrl(url ?? '')}. Confirm the service is running and DATABASE_URL is correct.`,
      { cause: error },
    );
  } finally {
    for (const client of clients) client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  await pool.end();
  pool = undefined;
}
