import {
  withModelRequestSlot,
} from '@dacai-local-agent/providers';

type ChatCapable = {
  chat: (...args: unknown[]) => Promise<unknown>;
};

export function limitModelProvider<T extends object>(
  provider: T,
): T {
  const candidate = provider as T & ChatCapable;

  if (typeof candidate.chat !== 'function') {
    return provider;
  }

  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === 'chat') {
        return (...args: unknown[]) =>
          withModelRequestSlot(() =>
            candidate.chat(...args),
          );
      }

      const value = Reflect.get(
        target,
        property,
        receiver,
      );

      return typeof value === 'function'
        ? value.bind(target)
        : value;
    },
  });
}
