class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active += 1;

    let released = false;

    return () => {
      if (released) return;
      released = true;

      this.active -= 1;
      this.queue.shift()?.();
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();

    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const configuredMaximum = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_MODEL_REQUESTS ?? 2),
);

export const modelRequestSemaphore =
  new AsyncSemaphore(configuredMaximum);

export function withModelRequestSlot<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return modelRequestSemaphore.run(operation);
}
