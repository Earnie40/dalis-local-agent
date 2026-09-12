import type { ProviderRegistry, ResolvedModel } from '@dacai-local-agent/providers';

/**
 * One model route for every Tomahawk1 swarm capability lane and coordinator.
 * The alias has local and GPU Ollama twins in config/models/default.yaml.
 */
export const SWARM_QWEN_ALIAS = 'swarm_qwen';

export class SwarmModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmModelRoutingError';
  }
}

/**
 * Configuration is checked again after provider fallback/promotion so a future
 * alias edit cannot silently associate swarm inference with a paid account.
 */
export function assertSwarmQwenResolution(resolved: ResolvedModel): ResolvedModel {
  const ollamaUsage = resolved.instance.usageClass === 'LOCAL_OLLAMA'
    || resolved.instance.usageClass === 'REMOTE_GPU_OLLAMA';
  const qwenModel = /(?:^|\/)qwen(?:[0-9._:-]|$)/i.test(resolved.model.trim());

  if (resolved.instance.kind !== 'ollama' || !ollamaUsage || !qwenModel) {
    throw new SwarmModelRoutingError(
      `AI swarms require an Ollama-hosted Qwen model; alias "${SWARM_QWEN_ALIAS}" resolved to ` +
      `provider kind "${resolved.instance.kind}", usage class "${resolved.instance.usageClass}", ` +
      `model "${resolved.model}".`,
    );
  }

  return resolved;
}

export async function resolveSwarmQwenModel(registry: ProviderRegistry): Promise<ResolvedModel> {
  const resolved = await registry.resolveAlias(SWARM_QWEN_ALIAS, { requireToolCalling: true });
  return assertSwarmQwenResolution(resolved);
}
