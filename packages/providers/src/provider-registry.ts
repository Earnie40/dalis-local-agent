import type { AppConfig, ProviderInstance, RoutingPolicy } from '@dacai-local-agent/shared';
import type {
  ModelDescriptor,
  ModelProvider,
  ProviderCapabilities,
  ProviderHealth,
} from '@dacai-local-agent/agent-core';
import { isAgentLoopCapable } from '@dacai-local-agent/agent-core';
import { AnthropicProvider } from './anthropic-provider';
import { HuggingFaceProvider } from './huggingface-provider';
import { OllamaProvider } from './ollama-provider';
import { OpenAIResponsesProvider } from './openai-provider';
import { probeCapabilities } from './capability-probe';
import { InMemoryCapabilityStore, type CapabilityStore } from './capability-store';

export class ProviderResolutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unknown-alias'
      | 'unknown-instance'
      | 'instance-disabled'
      | 'policy-blocked'
      | 'not-agent-capable'
      | 'unsupported-kind',
  ) {
    super(message);
    this.name = 'ProviderResolutionError';
  }
}

export interface ResolvedModel {
  alias?: string;
  instance: ProviderInstance;
  provider: ModelProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  capabilities: ProviderCapabilities;
  /** Set when a remote instance failed and a LOCAL instance served instead. */
  fallbackFromInstanceId?: string;
}

export interface ResolveOptions {
  /** Tool-driven work requires verified tool calling; advisory work does not. */
  requireToolCalling?: boolean;
  /** Set when the user explicitly named this instance for this request. */
  explicitInstanceRequest?: boolean;
  signal?: AbortSignal;
}

export interface FallbackEvent {
  fromInstanceId: string;
  toInstanceId: string;
  reason: string;
}

/** Registry and routing-policy boundary for all physical provider instances. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly inflightProbes = new Map<string, Promise<ProviderCapabilities>>();
  private readonly fallbackEvents: FallbackEvent[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly capabilityStore: CapabilityStore = new InMemoryCapabilityStore(),
  ) {}

  get routingPolicy(): RoutingPolicy {
    return this.config.routingPolicy;
  }

  listInstances(): ProviderInstance[] {
    return Object.values(this.config.providerInstances);
  }

  getInstance(instanceId: string): ProviderInstance {
    const instance = this.config.providerInstances[instanceId];
    if (!instance) {
      throw new ProviderResolutionError(`Unknown provider instance "${instanceId}".`, 'unknown-instance');
    }
    return instance;
  }

  /** Providers are constructed once per instance and reused. */
  getProvider(instanceId: string): ModelProvider {
    const existing = this.providers.get(instanceId);
    if (existing) return existing;

    const instance = this.getInstance(instanceId);
    const provider = createProvider(instance);
    this.providers.set(instanceId, provider);
    return provider;
  }

  /** A local request is never silently promoted to a remote or paid provider. */
  private assertPolicyAllows(instance: ProviderInstance, options: ResolveOptions): void {
    const isLocal = instance.usageClass === 'LOCAL_OLLAMA';
    if (isLocal) return;

    if (this.routingPolicy === 'local-only') {
      throw new ProviderResolutionError(
        `Routing policy is local-only; instance "${instance.id}" (${instance.usageClass}) is not available.`,
        'policy-blocked',
      );
    }

    if (this.routingPolicy === 'manual-provider-selection' && !options.explicitInstanceRequest) {
      throw new ProviderResolutionError(
        `Routing policy requires an explicit provider selection before using "${instance.id}".`,
        'policy-blocked',
      );
    }
  }

  /** Capability results are cached; provider probes never run on the boot path. */
  async getCapabilities(instanceId: string, model: string, signal?: AbortSignal): Promise<ProviderCapabilities> {
    const cached = await this.capabilityStore.read(instanceId, model);
    if (cached) return cached;

    const provider = this.getProvider(instanceId);

    // This adapter/model path has a provider-native function-call contract and
    // complete call_id round-tripping. Record that verified structured channel
    // directly rather than spending a paid inference request on every fresh
    // capability cache.
    if (provider instanceof OpenAIResponsesProvider) {
      const capabilities = provider.capabilities(model);
      if (capabilities) {
        await this.capabilityStore.write(instanceId, model, capabilities).catch(() => undefined);
        return capabilities;
      }
    }

    const key = `${instanceId}::${model}`;
    const inflight = this.inflightProbes.get(key);
    if (inflight) return inflight;

    const probe = (async () => {
      if (provider instanceof OllamaProvider) {
        await provider.showModel(model).catch(() => undefined);
      }

      const capabilities = await probeCapabilities(provider, model, { signal });
      await this.capabilityStore.write(instanceId, model, capabilities).catch(() => undefined);
      return capabilities;
    })().finally(() => this.inflightProbes.delete(key));

    this.inflightProbes.set(key, probe);
    return probe;
  }

  async reprobe(instanceId: string, model?: string): Promise<void> {
    await this.capabilityStore.clear(instanceId, model);
  }

  async resolveAlias(alias: string, options: ResolveOptions = {}): Promise<ResolvedModel> {
    const modelConfig = this.config.models[alias];
    if (!modelConfig) {
      throw new ProviderResolutionError(`Unknown model alias "${alias}".`, 'unknown-alias');
    }
    if (!modelConfig.enabled) {
      throw new ProviderResolutionError(`Model alias "${alias}" is disabled.`, 'instance-disabled');
    }

    const resolved = await this.resolve(modelConfig.providerInstanceId, modelConfig.model, options);
    return {
      ...resolved,
      alias,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
    };
  }

  async resolve(instanceId: string, model: string, options: ResolveOptions = {}): Promise<ResolvedModel> {
    const instance = this.getInstance(instanceId);
    this.assertPolicyAllows(instance, options);

    if (!instance.enabled) {
      const fallback = this.resolveFallbackTarget(instance);
      if (!fallback) {
        throw new ProviderResolutionError(
          `Provider instance "${instanceId}" is not configured.`,
          'instance-disabled',
        );
      }

      this.recordFallback(instance.id, fallback.id, 'instance not configured');
      const resolved = await this.resolve(fallback.id, model, options);
      return { ...resolved, fallbackFromInstanceId: instance.id };
    }

    const provider = this.getProvider(instanceId);
    const capabilities = await this.getCapabilities(instanceId, model, options.signal);

    if (options.requireToolCalling && !isAgentLoopCapable(capabilities)) {
      throw new ProviderResolutionError(
        `Model "${model}" on "${instanceId}" has tool calling "${capabilities.toolCalling}", not "verified". ` +
          'It is advisory-class: usable for analysis, summarization and review commentary, but not admitted ' +
          'to the tool-driven agent loop.',
        'not-agent-capable',
      );
    }

    return { instance, provider, model, capabilities };
  }

  /** Remote fallback can target only an enabled LOCAL_OLLAMA instance. */
  private resolveFallbackTarget(instance: ProviderInstance): ProviderInstance | undefined {
    if (this.routingPolicy === 'manual-provider-selection') return undefined;
    if (!instance.fallbackInstanceId) return undefined;

    const target = this.config.providerInstances[instance.fallbackInstanceId];
    if (!target || target.usageClass !== 'LOCAL_OLLAMA' || !target.enabled) return undefined;
    return target;
  }

  private recordFallback(fromInstanceId: string, toInstanceId: string, reason: string): void {
    this.fallbackEvents.push({ fromInstanceId, toInstanceId, reason });
  }

  drainFallbackEvents(): FallbackEvent[] {
    return this.fallbackEvents.splice(0, this.fallbackEvents.length);
  }

  async health(): Promise<ProviderHealth[]> {
    return Promise.all(
      this.listInstances().map(async (instance) => {
        try {
          return await this.getProvider(instance.id).health();
        } catch {
          return {
            status: 'not configured' as const,
            instanceId: instance.id,
            usageClass: instance.usageClass,
            location: instance.usageClass === 'LOCAL_OLLAMA' ? ('Local' as const) : ('Remote' as const),
          };
        }
      }),
    );
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const enabled = this.listInstances().filter((instance) => instance.enabled);
    const results = await Promise.all(
      enabled.map(async (instance) => {
        try {
          return await this.getProvider(instance.id).listModels();
        } catch {
          return [] as ModelDescriptor[];
        }
      }),
    );
    return results.flat();
  }
}

function createProvider(instance: ProviderInstance): ModelProvider {
  switch (instance.kind) {
    case 'ollama':
      return new OllamaProvider(instance);
    case 'anthropic':
      return new AnthropicProvider(instance);
    case 'huggingface':
      return new HuggingFaceProvider(instance, process.env.HF_DEFAULT_MODEL);
    case 'openai':
      return new OpenAIResponsesProvider(instance);
    default:
      throw new ProviderResolutionError(
        `Unsupported provider kind for instance "${instance.id}".`,
        'unsupported-kind',
      );
  }
}
