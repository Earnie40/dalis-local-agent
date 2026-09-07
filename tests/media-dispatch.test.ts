import { describe, expect, it, vi } from 'vitest';
import { dispatchWithMediaRecovery } from '../apps/server/src/media-dispatch';

describe('direct media dispatch', () => {
  it('waits for image readiness before executing exactly once', async () => {
    let finishReadiness!: (status: { ready: boolean }) => void;
    const ensureImageReady = vi.fn(() => new Promise<{ ready: boolean }>((resolve) => {
      finishReadiness = resolve;
    }));
    const execute = vi.fn(async () => 'sent-to-media-backend');

    const pending = dispatchWithMediaRecovery({
      kind: 'image',
      media: { ensureImageReady, ensureVideoReady: vi.fn() },
      execute,
    });

    expect(ensureImageReady).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    finishReadiness({ ready: true });
    await expect(pending).resolves.toBe('sent-to-media-backend');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('surfaces readiness failure without dispatching to an unavailable backend', async () => {
    const onUnavailable = vi.fn();
    const execute = vi.fn(async () => 'request-dispatched');
    const pending = dispatchWithMediaRecovery({
      kind: 'video',
      media: {
        ensureImageReady: vi.fn(),
        ensureVideoReady: vi.fn(async () => ({ ready: false, error: 'warming' })),
      },
      execute,
      onUnavailable,
    });

    await expect(pending).rejects.toThrow('warming');
    expect(onUnavailable).toHaveBeenCalledWith({ ready: false, error: 'warming' });
    expect(execute).not.toHaveBeenCalled();
  });
});
