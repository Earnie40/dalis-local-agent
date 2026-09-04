import { describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry, ResolvedModel } from '@dacai-local-agent/providers';
import { resolveTaskModel } from '../apps/server/src/task-model-routing';

function resolver(result: ResolvedModel) {
  return {
    resolveAlias: vi.fn().mockResolvedValue(result),
    resolve: vi.fn().mockResolvedValue(result),
  } as unknown as Pick<ProviderRegistry, 'resolveAlias' | 'resolve'>;
}

const resolved = { marker: 'resolved' } as unknown as ResolvedModel;

describe('durable task model routing', () => {
  it('re-resolves the requested alias when queued work starts', async () => {
    const registry = resolver(resolved);

    await expect(resolveTaskModel({
      modelAlias: 'coder',
      providerInstanceId: 'local_ollama',
      model: 'qwen2.5-coder:latest',
    }, registry)).resolves.toBe(resolved);

    expect(registry.resolveAlias).toHaveBeenCalledWith('coder', { requireToolCalling: true });
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('uses the stored physical route for legacy tasks without an alias', async () => {
    const registry = resolver(resolved);

    await expect(resolveTaskModel({
      providerInstanceId: 'local_ollama',
      model: 'legacy-model',
    }, registry)).resolves.toBe(resolved);

    expect(registry.resolve).toHaveBeenCalledWith('local_ollama', 'legacy-model', { requireToolCalling: true });
    expect(registry.resolveAlias).not.toHaveBeenCalled();
  });
});
