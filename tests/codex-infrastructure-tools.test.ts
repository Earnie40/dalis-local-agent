import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexServerTools } from '../apps/server/src/codex-tools';

afterEach(() => vi.unstubAllGlobals());

describe('agent infrastructure tools', () => {
  it('exposes live RunPod status, preflight, GPU routing and reconnect tools', () => {
    const tools = createCodexServerTools(3001);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'infrastructure.runpod.status',
      'infrastructure.runpod.preflight',
      'infrastructure.gpu-routing',
      'infrastructure.runpod.reconnect',
    ]));
    expect(tools.find((tool) => tool.name === 'infrastructure.runpod.reconnect'))
      .toMatchObject({ permissionTier: 'mutation', requiresNetwork: true });
    for (const tool of tools.filter((candidate) => candidate.name.startsWith('infrastructure.'))) {
      expect(tool.evidenceSources?.({ connected: true }, {})).toEqual([
        expect.objectContaining({ provenance: 'production_data' }),
      ]);
    }
  });

  it('uses only loopback server routes and preserves reconnect as POST', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connected: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const tools = createCodexServerTools(4321);
    const context = { workspaceRoot: process.cwd(), workspaceId: 'ws-test' };

    for (const name of [
      'infrastructure.runpod.status',
      'infrastructure.runpod.preflight',
      'infrastructure.gpu-routing',
      'infrastructure.runpod.reconnect',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing ${name}`);
      await tool.execute({}, context);
    }

    const statusTool = tools.find((candidate) => candidate.name === 'infrastructure.runpod.status');
    const statusResult = await statusTool?.execute({}, context);
    expect(statusResult).toMatchObject({
      statusSummary: 'The configured RunPod is connected; its inference tunnel is not healthy.',
      connected: true,
    });
    expect(statusTool?.evidenceSources?.(statusResult, {})[0]?.content).toContain(
      '"statusSummary": "The configured RunPod is connected; its inference tunnel is not healthy."',
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4321/api/infrastructure/runpod/status',
      'http://127.0.0.1:4321/api/infrastructure/runpod/preflight',
      'http://127.0.0.1:4321/api/infrastructure/gpu-routing?refresh=1',
      'http://127.0.0.1:4321/api/infrastructure/runpod/reconnect',
      'http://127.0.0.1:4321/api/infrastructure/runpod/status',
    ]);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'POST' });
  });
});
