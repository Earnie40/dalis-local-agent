import { describe, expect, it, vi } from 'vitest';
import { dispatchWithMediaRecovery } from '../apps/server/src/media-dispatch';

describe('direct media dispatch', () => {
  it('does not await a slow image readiness poll before executing', async () => {
    let finishReadiness!: (status: { ready: boolean }) => void;
    const ensureImageReady = vi.fn(() => new Promise<{ ready: boolean }>((resolve) => {
      finishReadiness = resolve;
    }));
    const execute = vi.fn(async () => 'sent-to-media-backend');

    const result = await dispatchWithMediaRecovery({
      kind: 'image',
      media: { ensureImageReady, ensureVideoReady: vi.fn() },
      execute,
    });

    expect(result).toBe('sent-to-media-backend');
    expect(ensureImageReady).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    finishReadiness({ ready: true });
  });

  it('reports background recovery failure without replacing the tool result', async () => {
    const onUnavailable = vi.fn();
    const result = await dispatchWithMediaRecovery({
      kind: 'video',
      media: {
        ensureImageReady: vi.fn(),
        ensureVideoReady: vi.fn(async () => ({ ready: false, error: 'warming' })),
      },
      execute: async () => 'request-dispatched',
      onUnavailable,
    });
    await Promise.resolve();

    expect(result).toBe('request-dispatched');
    expect(onUnavailable).toHaveBeenCalledWith({ ready: false, error: 'warming' });
  });
});
