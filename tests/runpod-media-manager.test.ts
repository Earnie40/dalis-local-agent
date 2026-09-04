import { describe, expect, it, vi } from 'vitest';
import { RunpodMediaManager, startRunpodPod } from '../apps/server/src/infrastructure/runpod-media-manager';

const ENDPOINT = { podId: 'pod-test-123', name: 'media-pod', host: '203.0.113.10', port: 22022 };

function healthResponse(): Response {
  return new Response(JSON.stringify({ backdropModel: 'sdxl', backdropVideoModel: 'svd-xt' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

describe('Runpod media supervisor', () => {
  it('uses REST v2 to start an explicitly configured pod', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ action: 'start' });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-api-key');
      return new Response('{}', { status: 200 });
    });
    await startRunpodPod({ apiKey: 'test-api-key', podId: 'pod-test-123', fetchImpl: fetchMock as typeof fetch });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.runpod.io/v2/pods/pod-test-123/action', expect.any(Object),
    );
  });

  it('auto-starts, rediscovers SSH, restores media, and reports model readiness', async () => {
    let discoveryCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/action') ? new Response('{}', { status: 200 }) : healthResponse());
    const runCommand = vi.fn(async (_command: string, args: string[]) => ({
      code: 0,
      stdout: args.at(-1) === 'printf DACAIS_MEDIA_SSH_READY' ? 'DACAIS_MEDIA_SSH_READY' : '',
      stderr: '',
    }));
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'ssh-tunnel', DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:18090',
        DACAI_MEDIA_AUTOSTART: 'true', RUNPOD_API_KEY: 'test-api-key', RUNPOD_ID: ENDPOINT.podId,
      },
      fetchImpl: fetchMock as typeof fetch,
      runCommand,
      resolveEndpoint: async () => (++discoveryCalls === 1 ? undefined : ENDPOINT),
      sleep: async () => undefined,
      startupAttempts: 2,
    });

    const status = await manager.initialize();
    expect(status).toMatchObject({
      configured: true, ready: true, phase: 'ready', transport: 'ssh-tunnel',
      pod: { id: ENDPOINT.podId, connected: true },
      service: { healthy: true, imageModel: true, videoModel: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.runpod.io/v2/pods/${ENDPOINT.podId}/action`, expect.any(Object),
    );
    expect(runCommand).toHaveBeenCalledWith('ssh', expect.arrayContaining(['root@203.0.113.10']), expect.any(Number));
    manager.stop();
  });

  it('supports authenticated production HTTPS without SSH', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer media-token');
      return healthResponse();
    });
    const runCommand = vi.fn();
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'https',
        DACAI_MEDIA_BASE_URL: 'https://media.example.com', DACAI_MEDIA_TOKEN: 'media-token',
      },
      fetchImpl: fetchMock as typeof fetch,
      runCommand,
    });
    expect(await manager.initialize()).toMatchObject({ ready: true, phase: 'ready', transport: 'https' });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('uses a healthy same-host loopback endpoint without RunPod discovery or SSH', async () => {
    const fetchMock = vi.fn(async () => healthResponse());
    const runCommand = vi.fn();
    const resolveEndpoint = vi.fn();
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'loopback', DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:8090',
      },
      fetchImpl: fetchMock as typeof fetch,
      runCommand,
      resolveEndpoint,
    });

    expect(await manager.initialize()).toMatchObject({
      ready: true, phase: 'ready', transport: 'loopback',
      service: { healthy: true, imageModel: true, videoModel: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8090/v1/health', expect.objectContaining({ method: 'GET' }),
    );
    expect(resolveEndpoint).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('waits for the configured image model after the media process becomes healthy', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ backdropModel: 'sdxl' }), { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'loopback',
        DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:8090',
      },
      fetchImpl: fetchMock as typeof fetch,
      sleep,
      startupAttempts: 3,
    });

    expect(await manager.initialize()).toMatchObject({
      ready: true, phase: 'ready', service: { healthy: true, imageModel: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('lets image generation proceed while an unrelated video model is still warming up', async () => {
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'loopback', DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:8090',
      },
      fetchImpl: (async () => new Response(JSON.stringify({ backdropModel: 'sdxl' }), { status: 200 })) as typeof fetch,
      startupAttempts: 1,
      sleep: async () => undefined,
    });

    expect(await manager.ensureImageReady()).toMatchObject({
      ready: true,
      service: { healthy: true, imageModel: true, videoModel: false },
    });
  });

  it('fails closed when production HTTPS has no token', async () => {
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'https',
        DACAI_MEDIA_BASE_URL: 'https://media.example.com',
      },
    });
    expect(await manager.initialize()).toMatchObject({ ready: false, phase: 'error' });
    expect(manager.status().error).toContain('DACAI_MEDIA_TOKEN');
  });
});
