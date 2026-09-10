import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closePool, getPool, queryDatabaseRead, verifyConnection } from '@dacai-local-agent/shared';

const TEST_URL = 'postgresql://user:pw@127.0.0.1:5433/does_not_connect';

afterEach(async () => {
  vi.restoreAllMocks();
  await closePool();
});

describe('getPool client error handling', () => {
  /*
   * pg-pool removes its own idle 'error' listener for as long as a client is
   * checked out. A connection that dies in that window with no in-flight query
   * used to emit an 'error' nobody listened for, which EventEmitter rethrows as
   * an uncaught exception that killed the server.
   */
  it('keeps an error listener on a client that pg-pool has detached its own from', () => {
    const pool = getPool(TEST_URL);
    const client = new EventEmitter();
    const poolIdleListener = () => {};
    client.on('error', poolIdleListener);

    pool.emit('connect', client as never);
    // _acquireClient drops only pg-pool's own listener, by reference.
    client.removeListener('error', poolIdleListener);

    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });

  it('does not throw when a checked-out client dies', () => {
    const pool = getPool(TEST_URL);
    const client = new EventEmitter();

    pool.emit('connect', client as never);

    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
  });

  it('retries a transient cold connection and warms the pool client', async () => {
    const pool = getPool(TEST_URL);
    const firstClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
      release: vi.fn(),
    };
    const connect = vi.spyOn(pool, 'connect')
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValueOnce(firstClient as never);

    await verifyConnection(TEST_URL);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstClient.query).toHaveBeenCalledWith('SELECT 1');
    expect(firstClient.release).toHaveBeenCalledOnce();
  });

  it('retries caller-declared read-only SQL after pool acquisition times out', async () => {
    const pool = getPool(TEST_URL);
    const query = vi.spyOn(pool, 'query')
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValueOnce({ rows: [{ id: 'conv_1' }] } as never);

    await expect(queryDatabaseRead<{ id: string }>('SELECT id FROM conversations'))
      .resolves.toMatchObject({ rows: [{ id: 'conv_1' }] });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
