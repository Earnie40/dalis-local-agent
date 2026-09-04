import { describe, expect, it, vi } from 'vitest';
import { ProviderInstanceSchema } from '../packages/shared/src/config';
import { GpuAvailabilityProbe, podServesModel } from '../packages/providers/src/gpu-availability';
import { normalizePods, resolveRunpodPodPresence } from '../apps/server/src/infrastructure/runpod-pod-status';

const GPU_INSTANCE = ProviderInstanceSchema.parse({
  id: 'remote_gpu_ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11435',
  enabled: true,
  usageClass: 'REMOTE_GPU_OLLAMA',
  transport: 'ssh-tunnel',
});

function tagsResponse(models: Array<{ name?: unknown; model?: unknown }>): Response {
  return new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GPU availability', () => {
  it('keeps inference local when the RunPod account has no prepaid balance', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const probe = new GpuAvailabilityProbe({
      instance: GPU_INSTANCE,
      fetchImpl: fetchMock,
      podPresence: async () => ({
        clientBalanceUsd: 0,
        funded: false,
        pods: [{ id: 'running-1', status: 'RUNNING' }],
      }),
    });

    await expect(probe.evaluate()).resolves.toMatchObject({
      usable: false,
      reason: 'account-unfunded',
      account: { balanceUsd: 0, funded: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers models from Ollama tags and coalesces concurrent probes into one request', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => pending);
    const probe = new GpuAvailabilityProbe({
      instance: GPU_INSTANCE,
      fetchImpl: fetchMock as unknown as typeof fetch,
      ttlMs: 30_000,
    });

    const first = probe.evaluate();
    const second = probe.evaluate();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11435/api/tags');

    release(tagsResponse([
      { name: 'qwen3:8b' },
      { model: 'huihui_ai/qwen3-abliterated:8b' },
      { name: 42 },
    ]));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({
      usable: true,
      instanceId: 'remote_gpu_ollama',
      models: ['qwen3:8b', 'huihui_ai/qwen3-abliterated:8b'],
    });
    expect(secondResult).toBe(firstResult);

    await expect(probe.evaluate()).resolves.toBe(firstResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invokes the recovery callback and retries a running endpoint once', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw new Error('temporary tunnel failure');
      return tagsResponse([{ name: 'qwen3:8b' }]);
    });
    const recoverEndpoint = vi.fn(async () => undefined);
    const probe = new GpuAvailabilityProbe({
      instance: GPU_INSTANCE,
      fetchImpl: fetchMock as unknown as typeof fetch,
      podPresence: async () => ({ pods: [{ id: 'running-1', status: 'RUNNING' }] }),
      recoverEndpoint,
    });

    await expect(probe.evaluate()).resolves.toMatchObject({
      usable: true,
      models: ['qwen3:8b'],
    });
    expect(recoverEndpoint).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not invoke recovery when the only discovered pod is stopped', async () => {
    const recoverEndpoint = vi.fn(async () => undefined);
    const probe = new GpuAvailabilityProbe({
      instance: GPU_INSTANCE,
      fetchImpl: vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      podPresence: async () => ({ pods: [{ id: 'stopped-1', status: 'EXITED' }] }),
      recoverEndpoint,
    });

    await expect(probe.evaluate()).resolves.toMatchObject({
      usable: false,
      reason: 'pod-not-running',
    });
    expect(recoverEndpoint).not.toHaveBeenCalled();
  });

  it('explains whether an unavailable endpoint has no pod, a stopped pod, or a running-but-unreachable pod', async () => {
    const unavailableProbe = (pods: Array<{ id: string; name?: string; status: string }>) =>
      new GpuAvailabilityProbe({
        instance: GPU_INSTANCE,
        fetchImpl: vi.fn(async () => { throw new Error('tunnel unavailable'); }) as unknown as typeof fetch,
        podPresence: async () => ({ pods }),
      });

    await expect(unavailableProbe([]).evaluate()).resolves.toMatchObject({
      usable: false,
      reason: 'no-pod',
      detail: expect.stringContaining('No RunPod pod exists'),
    });
    await expect(unavailableProbe([{ id: 'stopped-1', name: 'Idle GPU', status: 'EXITED' }]).evaluate())
      .resolves.toMatchObject({
        usable: false,
        reason: 'pod-not-running',
        pod: { id: 'stopped-1', status: 'EXITED' },
        detail: expect.stringContaining('Idle GPU'),
      });
    await expect(unavailableProbe([{ id: 'running-1', name: 'Serving GPU', status: 'RUNNING' }]).evaluate())
      .resolves.toMatchObject({
        usable: false,
        reason: 'endpoint-unreachable',
        pod: { id: 'running-1', status: 'RUNNING' },
        detail: expect.stringContaining('RUNNING'),
      });
  });

  it('matches exact and tagged Ollama model names only when the pod is usable', () => {
    const availability = {
      usable: true,
      instanceId: 'remote_gpu_ollama',
      models: ['qwen3:8b', 'mistral:latest'],
      detail: 'reachable',
      checkedAt: '2026-09-03T00:00:00.000Z',
    };

    expect(podServesModel(availability, 'qwen3:8b')).toBe(true);
    expect(podServesModel(availability, 'qwen3')).toBe(true);
    expect(podServesModel(availability, 'mistral')).toBe(true);
    expect(podServesModel(availability, 'qwen3:latest')).toBe(false);
    expect(podServesModel({ ...availability, usable: false }, 'qwen3')).toBe(false);
  });
});

describe('RunPod pod presence', () => {
  it('normalizes valid pod records, drops invalid ones, and puts running pods first', () => {
    expect(normalizePods([
      {
        id: 'stopped-1',
        name: 'Idle GPU',
        desiredStatus: 'EXITED',
        costPerHr: '0.42',
        machine: { gpuDisplayName: 'NVIDIA L40S' },
      },
      {
        id: 'running-1',
        desiredStatus: 'RUNNING',
        costPerHr: 'not-a-number',
        machine: { gpuDisplayName: 42 },
      },
      { id: 42, desiredStatus: 'RUNNING' },
    ])).toEqual([
      { id: 'running-1', status: 'RUNNING', costPerHr: undefined, gpu: undefined },
      {
        id: 'stopped-1',
        name: 'Idle GPU',
        status: 'EXITED',
        costPerHr: 0.42,
        gpu: 'NVIDIA L40S',
      },
    ]);
  });

  it('uses its injected fetch implementation and returns the selected pod inventory', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body)).query).toContain('myself');
      return new Response(JSON.stringify({
        data: {
          myself: {
            pods: [
              { id: 'stopped-1', desiredStatus: 'EXITED' },
              { id: 'running-1', name: 'Serving GPU', desiredStatus: 'RUNNING' },
            ],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const presence = await resolveRunpodPodPresence({
      apiKey: 'test api key',
      podId: 'stopped-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.runpod.io/graphql?api_key=test%20api%20key');
    expect(presence).toEqual({
      preferredPodId: 'stopped-1',
      pods: [
        { id: 'running-1', name: 'Serving GPU', status: 'RUNNING' },
        { id: 'stopped-1', status: 'EXITED' },
      ],
    });
  });

  it('does not mistake a GraphQL error payload for an empty account', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      errors: [{ message: 'unauthorized' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(resolveRunpodPodPresence({
      apiKey: 'synthetic-key',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toBeUndefined();
  });
});
