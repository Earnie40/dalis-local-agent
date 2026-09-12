import { describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry, ResolvedModel } from '@dacai-local-agent/providers';
import {
  assertSwarmQwenResolution,
  resolveSwarmQwenModel,
  SWARM_QWEN_ALIAS,
  SwarmModelRoutingError,
} from '../apps/server/src/swarm-model';

function resolution(kind: 'ollama' | 'openai' | 'anthropic' | 'huggingface', model: string): ResolvedModel {
  const usageClass = kind === 'ollama' ? 'LOCAL_OLLAMA' : 'FUTURE_PAID_PROVIDER';
  return {
    alias: SWARM_QWEN_ALIAS,
    instance: {
      id: `${kind}_instance`,
      kind,
      enabled: true,
      usageClass,
      transport: kind === 'ollama' ? 'loopback' : 'https-api',
      requestTimeoutMs: 120_000,
    },
    provider: {} as ResolvedModel['provider'],
    model,
    capabilities: {} as ResolvedModel['capabilities'],
  } as ResolvedModel;
}

describe('Tomahawk1 swarm model routing', () => {
  it('accepts only Ollama-hosted Qwen resolutions', () => {
    expect(assertSwarmQwenResolution(resolution('ollama', 'qwen3:8b')).model).toBe('qwen3:8b');
    expect(assertSwarmQwenResolution(resolution('ollama', 'Qwen/Qwen3-8B')).model).toBe('Qwen/Qwen3-8B');
  });

  it.each([
    ['openai', 'gpt-5.6-sol'],
    ['anthropic', 'claude-opus-4'],
    ['huggingface', 'Qwen/Qwen3-8B'],
    ['ollama', 'llama3:8b'],
  ] as const)('rejects %s/%s for swarm inference', (kind, model) => {
    expect(() => assertSwarmQwenResolution(resolution(kind, model))).toThrow(SwarmModelRoutingError);
  });

  it('requests only the dedicated tool-capable swarm alias', async () => {
    const resolved = resolution('ollama', 'qwen3:8b');
    const resolveAlias = vi.fn().mockResolvedValue(resolved);

    await expect(resolveSwarmQwenModel({ resolveAlias } as unknown as ProviderRegistry)).resolves.toBe(resolved);
    expect(resolveAlias).toHaveBeenCalledWith(SWARM_QWEN_ALIAS, { requireToolCalling: true });
  });
});
