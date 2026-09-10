import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@dacai-local-agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dacai-local-agent/shared')>();
  return {
    ...actual,
    getPool: () => database,
  };
});

import { PostgresCapabilityStore } from '../packages/providers/src/capability-store';

describe('PostgresCapabilityStore connection recovery', () => {
  beforeEach(() => {
    database.query.mockReset();
  });

  it('retries an idempotent cache read after a transient disconnect', async () => {
    database.query
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({ rows: [] });

    const store = new PostgresCapabilityStore();

    await expect(store.read('local_ollama', 'qwen3:8b')).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transport database failure', async () => {
    const error = Object.assign(new Error('relation provider_capabilities does not exist'), {
      code: '42P01',
    });
    database.query.mockRejectedValue(error);

    const store = new PostgresCapabilityStore();

    await expect(store.read('local_ollama', 'qwen3:8b')).rejects.toBe(error);
    expect(database.query).toHaveBeenCalledOnce();
  });
});
