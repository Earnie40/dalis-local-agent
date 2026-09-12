import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexServerTools } from '../apps/server/src/codex-tools';

afterEach(() => vi.unstubAllGlobals());

describe('agent swarm tools', () => {
  it('creates, reads, and cancels durable swarms through loopback APIs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ swarm: { id: 'swarm_1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tools = createCodexServerTools(4321);
    const context = { workspaceRoot: process.cwd(), workspaceId: 'ws_1' };

    const create = tools.find((tool) => tool.name === 'agent.swarm.create');
    const status = tools.find((tool) => tool.name === 'agent.swarm.status');
    const cancel = tools.find((tool) => tool.name === 'agent.swarm.cancel');
    expect([create, status, cancel]).not.toContain(undefined);
    expect(create).toMatchObject({ permissionTier: 'mutation' });
    expect(status).toMatchObject({ permissionTier: 'safe' });
    expect(cancel).toMatchObject({ permissionTier: 'mutation' });

    await create!.execute({ objective: 'Investigate', strategy: 'review', size: 4 }, context);
    await status!.execute({ swarmId: 'swarm_1' }, context);
    await cancel!.execute({ swarmId: 'swarm_1' }, context);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4321/api/swarms',
      'http://127.0.0.1:4321/api/swarms/swarm_1',
      'http://127.0.0.1:4321/api/swarms/swarm_1/cancel',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        objective: 'Investigate', workspaceId: 'ws_1', strategy: 'review', size: 4, source: 'internal',
      }),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'POST' });
    for (const tool of [create!, status!, cancel!]) {
      expect(tool.evidenceSources?.({ swarm: { id: 'swarm_1' } }, {})[0]).toMatchObject({
        id: 'agent-swarm', provenance: 'production_data',
      });
    }
  });

  it('requires an active registered workspace to create a swarm', async () => {
    const create = createCodexServerTools(4321).find((tool) => tool.name === 'agent.swarm.create')!;
    await expect(create.execute({ objective: 'Investigate' }, {})).rejects.toThrow(/active registered workspace/);
  });
});
