import { describe, expect, it, vi } from 'vitest';
import { mediaWorkflowAvailability, RunpodMediaManager, startRunpodPod } from '../apps/server/src/infrastructure/runpod-media-manager';

const ENDPOINT = { podId: 'pod-test-123', name: 'media-pod', host: '203.0.113.10', port: 22022 };

function healthResponse(): Response {
  return new Response(JSON.stringify({ backdropModel: 'sdxl', backdropVideoModel: 'svd-xt', anatomyVideoModel: 'wan2.2-ti2v-5b' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

describe('Runpod media supervisor', () => {
  it('distinguishes SVD animation from Wan generation and Qwen precision workflows', () => {
    expect(mediaWorkflowAvailability({ backdropModel: 'sdxl', backdropVideoModel: 'svd-xt' })).toEqual({
      imageGeneration: true, imageEditing: false, anatomyGeneration: false, anatomyEditing: false,
      videoGeneration: false, imageAnimation: true, narratedVideo: false,
    });
    expect(mediaWorkflowAvailability({
      anatomyGenerationModel: 'qwen-image', anatomyEditModel: 'qwen-image-edit', anatomyVideoModel: 'wan2.2-ti2v-5b',
    })).toEqual({
      imageGeneration: false, imageEditing: false, anatomyGeneration: true, anatomyEditing: true,
      videoGeneration: true, imageAnimation: false, narratedVideo: false,
    });
  });

  it.each([undefined, null, '', ' \t\n ', true, false, 1, {}])('does not advertise workflows for invalid model values (%j)', (value) => {
    const body = Object.fromEntries([
      'backdropModel', 'instructEditModel', 'anatomyGenerationModel', 'anatomyEditModel',
      'anatomyVideoModel', 'backdropVideoModel', 'ttsModel', 'avatarModel',
    ].map((key) => [key, value]));
    expect(Object.values(mediaWorkflowAvailability(body))).toEqual(Array(7).fill(false));
  });

  it.each(['ttsModel', 'avatarModel', 'backdropModel'])('requires %s for narrated video', (missingModel) => {
    const body = { ttsModel: 'tts', avatarModel: 'avatar', backdropModel: 'sdxl' };
    expect(mediaWorkflowAvailability(body).narratedVideo).toBe(true);
    expect(mediaWorkflowAvailability({ ...body, [missingModel]: '' }).narratedVideo).toBe(false);
  });

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

  it('blocks raw media SSH in Tor-only mode before endpoint discovery', async () => {
    const runCommand = vi.fn();
    const resolveEndpoint = vi.fn(async () => ENDPOINT);
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'ssh-tunnel',
        DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:18090',
        TOR_SOCKS_PROXY: 'socks5h://127.0.0.1:9050',
      },
      runCommand,
      resolveEndpoint,
    });

    expect(await manager.initialize()).toMatchObject({
      ready: false,
      phase: 'error',
      error: expect.stringContaining('disabled by Tor-only mode'),
    });
    expect(resolveEndpoint).not.toHaveBeenCalled();
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

  it('auto-provisions missing image weights on an explicitly auto-started managed pod', async () => {
    let provisioned = false;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(
      provisioned ? { backdropModel: 'image-model' } : {},
    ), { status: 200 }));
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const remote = args.at(-1) ?? '';
      if (remote === 'printf DACAIS_MEDIA_SSH_READY') {
        return { code: 0, stdout: 'DACAIS_MEDIA_SSH_READY', stderr: '' };
      }
      if (remote.includes('download_sdxl_model.py')) provisioned = true;
      return { code: 0, stdout: '', stderr: '' };
    });
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'ssh-tunnel', DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:18090',
        DACAI_MEDIA_AUTOSTART: 'true', RUNPOD_ID: ENDPOINT.podId,
      },
      fetchImpl: fetchMock as typeof fetch,
      runCommand,
      resolveEndpoint: async () => ENDPOINT,
      sleep: async () => undefined,
      startupAttempts: 1,
    });

    expect(await manager.ensureImageReady()).toMatchObject({
      ready: true,
      autoProvisionModels: true,
      service: { imageModel: true, videoModel: false },
    });
    const remoteCommands = runCommand.mock.calls.map((call) => String(call[1].at(-1)));
    expect(remoteCommands.some((command) => command.includes('download_sdxl_model.py'))).toBe(true);
    expect(remoteCommands.some((command) => command.includes('download_svd_model.py'))).toBe(false);
    manager.stop();
  });

  it('keeps model provisioning independently disableable without claiming a permission denial', async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => ({
      code: 0,
      stdout: args.at(-1) === 'printf DACAIS_MEDIA_SSH_READY' ? 'DACAIS_MEDIA_SSH_READY' : '',
      stderr: '',
    }));
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'ssh-tunnel', DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:18090',
        DACAI_MEDIA_AUTOSTART: 'true', DACAI_MEDIA_AUTOPROVISION_MODELS: 'false',
        RUNPOD_ID: ENDPOINT.podId,
      },
      fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch,
      runCommand,
      resolveEndpoint: async () => ENDPOINT,
      sleep: async () => undefined,
      startupAttempts: 1,
    });

    const status = await manager.ensureImageReady();
    expect(status).toMatchObject({ ready: false, phase: 'error', autoProvisionModels: false });
    expect(status.error).toContain('DACAI_MEDIA_AUTOPROVISION_MODELS=true');
    expect(runCommand.mock.calls.some((call) => String(call[1].at(-1)).includes('download_sdxl_model.py'))).toBe(false);
    manager.stop();
  });

  it('does not admit a video generation job when only SVD animation is available', async () => {
    const manager = new RunpodMediaManager({
      env: {
        DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media',
        DACAI_MEDIA_TRANSPORT: 'loopback', DACAI_MEDIA_BASE_URL: 'http://127.0.0.1:8090',
      },
      fetchImpl: (async () => new Response(JSON.stringify({ backdropModel: 'sdxl', backdropVideoModel: 'svd-xt' }), { status: 200 })) as typeof fetch,
      startupAttempts: 1,
      sleep: async () => undefined,
    });

    expect(await manager.ensureVideoReady()).toMatchObject({
      ready: false,
      service: { healthy: true, imageModel: true, videoModel: false, workflows: { imageAnimation: true, videoGeneration: false } },
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
