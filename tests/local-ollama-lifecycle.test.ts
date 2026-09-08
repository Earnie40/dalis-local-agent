import { describe, expect, it, vi } from 'vitest';
import type { ProviderInstance } from '../packages/shared/src/config';
import { LocalOllamaLifecycle } from '../apps/server/src/infrastructure/local-ollama-lifecycle';

const LOCAL_INSTANCE: ProviderInstance = {
  id: 'local_ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
  usageClass: 'LOCAL_OLLAMA',
  transport: 'loopback',
  proxyRequired: false,
  requestTimeoutMs: 120_000,
};

describe('LocalOllamaLifecycle', () => {
  it('does not start another process when the endpoint is already ready', async () => {
    const startProcess = vi.fn(async () => undefined);
    const lifecycle = new LocalOllamaLifecycle({
      fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      startProcess,
    });

    await lifecycle.ensureReady(LOCAL_INSTANCE);

    expect(startProcess).not.toHaveBeenCalled();
  });

  it('starts Ollama and waits until the local tags route is ready', async () => {
    let probes = 0;
    const startProcess = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const lifecycle = new LocalOllamaLifecycle({
      env: { OLLAMA_EXECUTABLE: 'C:\\Program Files\\Ollama\\ollama.exe' },
      fetchImpl: vi.fn(async () => {
        probes += 1;
        if (probes < 3) throw new Error('connection refused');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      startProcess,
      sleep,
      startupTimeoutMs: 1_000,
      pollIntervalMs: 100,
    });

    await lifecycle.ensureReady(LOCAL_INSTANCE);

    expect(startProcess).toHaveBeenCalledWith(
      'C:\\Program Files\\Ollama\\ollama.exe',
      ['serve'],
      expect.objectContaining({ OLLAMA_HOST: '127.0.0.1:11434' }),
    );
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent recovery into one process start', async () => {
    let ready = false;
    let releaseStart: (() => void) | undefined;
    const startProcess = vi.fn(() => new Promise<void>((resolve) => {
      releaseStart = () => {
        ready = true;
        resolve();
      };
    }));
    const lifecycle = new LocalOllamaLifecycle({
      fetchImpl: vi.fn(async () => {
        if (!ready) throw new Error('connection refused');
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      startProcess,
      sleep: async () => undefined,
    });

    const first = lifecycle.ensureReady(LOCAL_INSTANCE);
    const second = lifecycle.ensureReady(LOCAL_INSTANCE);
    await vi.waitFor(() => expect(startProcess).toHaveBeenCalledTimes(1));
    releaseStart?.();
    await Promise.all([first, second]);

    expect(startProcess).toHaveBeenCalledTimes(1);
  });

  it('reports an actionable startup failure', async () => {
    const lifecycle = new LocalOllamaLifecycle({
      fetchImpl: vi.fn(async () => { throw new Error('connection refused'); }) as unknown as typeof fetch,
      startProcess: vi.fn(async () => { throw new Error('ENOENT'); }),
    });

    await expect(lifecycle.ensureReady(LOCAL_INSTANCE)).rejects.toThrow(
      '"ollama serve" could not be started: ENOENT',
    );
  });

  it('never starts a process for a non-loopback local endpoint', async () => {
    const startProcess = vi.fn(async () => undefined);
    const lifecycle = new LocalOllamaLifecycle({ startProcess });

    await expect(lifecycle.ensureReady({
      ...LOCAL_INSTANCE,
      baseUrl: 'https://ollama.example.com',
    })).rejects.toThrow('must use a loopback base URL');
    expect(startProcess).not.toHaveBeenCalled();
  });
});
