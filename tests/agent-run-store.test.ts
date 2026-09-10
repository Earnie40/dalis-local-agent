import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../packages/shared/src/db/pool', () => ({
  getPool: () => database,
  queryDatabaseRead: (text: string, params?: unknown[]) => database.query(text, params),
}));

import { AgentRunStore, deriveRunTitle } from '../packages/shared/src/db/agent-run-store';

const ROW = {
  id: 'run_1',
  workspace_id: 'ws_1',
  session_id: 'sess_1',
  title: 'Locate the metamask account',
  objective: 'Locate the metamask account',
  alias: 'agent',
  model: 'qwen3:8b',
  provider_instance_id: 'remote_gpu_ollama',
  role: 'coding',
  run_mode: 'interactive',
  status: 'running' as const,
  answer: null,
  error: null,
  started_at: new Date('2026-09-09T02:08:36.000Z'),
  ended_at: null,
  event_count: '15',
};

describe('deriveRunTitle', () => {
  it('uses the first line so a multi-line prompt stays recognisable', () => {
    expect(deriveRunTitle('Fix the tunnel\nthen restart the pod')).toBe('Fix the tunnel');
  });

  it('truncates a long single line rather than overflowing the sidebar', () => {
    const title = deriveRunTitle('x'.repeat(200));
    expect(title).toHaveLength(78);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back rather than producing an empty label', () => {
    expect(deriveRunTitle('   \n  ')).toBe('Agent run');
  });
});

describe('AgentRunStore', () => {
  beforeEach(() => {
    database.query.mockReset();
  });

  it('maps a row to camelCase with ISO timestamps and a numeric event count', async () => {
    database.query.mockResolvedValueOnce({ rows: [ROW] });

    const run = await new AgentRunStore().get('run_1');

    expect(run).toMatchObject({
      id: 'run_1',
      workspaceId: 'ws_1',
      sessionId: 'sess_1',
      providerInstanceId: 'remote_gpu_ollama',
      runMode: 'interactive',
      status: 'running',
      startedAt: '2026-09-09T02:08:36.000Z',
      eventCount: 15,
    });
    expect(run?.endedAt).toBeUndefined();
    expect(run?.answer).toBeUndefined();
  });

  it('returns undefined for an unknown run instead of throwing', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(new AgentRunStore().get('run_missing')).resolves.toBeUndefined();
  });

  it('caps the page so a long-lived install cannot stream every run into the sidebar', async () => {
    database.query.mockResolvedValue({ rows: [] });
    const store = new AgentRunStore();

    await store.list({ limit: 5000 });
    expect(database.query.mock.calls[0][1]).toEqual([200]);

    await store.list({ limit: 0 });
    expect(database.query.mock.calls[1][1]).toEqual([1]);
  });

  it('numbers filter placeholders in order when both filters are supplied', async () => {
    database.query.mockResolvedValueOnce({ rows: [] });

    await new AgentRunStore().list({ workspaceId: 'ws_1', sessionId: 'sess_1', limit: 10 });

    const [sql, params] = database.query.mock.calls[0];
    expect(sql).toContain('r.workspace_id = $1');
    expect(sql).toContain('r.session_id = $2');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['ws_1', 'sess_1', 10]);
  });

  it('records a run as running before any work happens', async () => {
    database.query.mockResolvedValueOnce({ rows: [ROW] });

    await new AgentRunStore().start({
      id: 'run_1',
      workspaceId: 'ws_1',
      objective: 'Locate the metamask account\nand open it',
    });

    const [sql, params] = database.query.mock.calls[0];
    expect(sql).toContain("'running'");
    // Title is the first line; the full prompt is kept as the objective.
    expect(params[3]).toBe('Locate the metamask account');
    expect(params[4]).toBe('Locate the metamask account\nand open it');
  });

  it('updates rather than duplicating when a resumed run reuses its id', async () => {
    database.query.mockResolvedValueOnce({ rows: [ROW] });

    await new AgentRunStore().start({ id: 'run_1', workspaceId: 'ws_1', objective: 'go' });

    expect(database.query.mock.calls[0][0]).toContain('ON CONFLICT (id) DO UPDATE');
  });

  it('only finishes a run that is still running, so a recorded failure is never overwritten', async () => {
    database.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await new AgentRunStore().finish('run_1', { status: 'completed', answer: 'done' });

    const [sql, params] = database.query.mock.calls[0];
    expect(sql).toContain("AND status = 'running'");
    expect(params[1]).toBe('completed');
    expect(params[2]).toBe('done');
  });

  it('reconciles interrupted runs so none claim to be in progress forever', async () => {
    database.query.mockResolvedValueOnce({ rowCount: 3 });

    await expect(new AgentRunStore().failStaleRuns(30)).resolves.toBe(3);

    const [sql, params] = database.query.mock.calls[0];
    expect(sql).toContain("SET status   = 'failed'");
    // Only sweeps runs still marked running, and only ones old enough to be dead.
    expect(sql).toContain("WHERE status = 'running'");
    expect(sql).toContain('started_at < now()');
    expect(params).toEqual(['30']);
  });

  it('never builds an interval from an unsanitised value', async () => {
    database.query.mockResolvedValue({ rowCount: 0 });
    const store = new AgentRunStore();

    await store.failStaleRuns(-5);
    expect(database.query.mock.calls[0][1]).toEqual(['1']);

    await store.failStaleRuns(12.9);
    expect(database.query.mock.calls[1][1]).toEqual(['12']);
  });
});
