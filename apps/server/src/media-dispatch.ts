export type MediaDispatchKind = 'image' | 'video';

export interface MediaReadinessStatus {
  ready: boolean;
  error?: string;
}

export interface MediaReadinessSupervisor {
  ensureImageReady(): Promise<MediaReadinessStatus>;
  ensureVideoReady(): Promise<MediaReadinessStatus>;
}

/** Start recovery without placing its cold-start polling window in the request path. */
export function startMediaRecovery(
  kind: MediaDispatchKind,
  media: MediaReadinessSupervisor | undefined,
  onUnavailable?: (status: MediaReadinessStatus) => void | Promise<void>,
): void {
  if (!media) return;
  const readiness = kind === 'image' ? media.ensureImageReady() : media.ensureVideoReady();
  void readiness.then((status) => {
    if (!status.ready) return onUnavailable?.(status);
    return undefined;
  }).catch(() => undefined);
}

/** Wait for the managed transport/model to be ready, then dispatch once. */
export async function dispatchWithMediaRecovery<T>(options: {
  kind: MediaDispatchKind;
  media?: MediaReadinessSupervisor;
  execute: () => Promise<T>;
  onUnavailable?: (status: MediaReadinessStatus) => void | Promise<void>;
}): Promise<T> {
  if (options.media) {
    const status = options.kind === 'image'
      ? await options.media.ensureImageReady()
      : await options.media.ensureVideoReady();
    if (!status.ready) {
      await options.onUnavailable?.(status);
      throw new Error(status.error ?? `The ${options.kind} backend is not ready.`);
    }
  }
  return options.execute();
}
