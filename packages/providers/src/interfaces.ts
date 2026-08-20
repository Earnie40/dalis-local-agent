import type { ProviderInstance } from '@dacai-local-agent/shared';
import type { ModelChatRequest, ModelChatResponse, ModelProvider, ModelStreamEvent } from '@dacai-local-agent/agent-core';

/**
 * Providers are constructed per *instance*, not per kind: local_ollama and
 * remote_gpu_ollama are two instances of the same OllamaProvider class.
 */
export interface ModelProviderFactory {
  create(instance: ProviderInstance): ModelProvider;
}

export interface ProviderStreamResult {
  stream: AsyncIterable<ModelStreamEvent>;
  providerInstanceId: string;
}

export type ProviderChatFn = (input: ModelChatRequest) => Promise<ModelChatResponse>;
