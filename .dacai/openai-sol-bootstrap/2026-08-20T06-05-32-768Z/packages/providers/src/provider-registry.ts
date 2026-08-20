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
  /**
   * Tool-driven work requires verified tool calling. Advisory work (analysis,
   * summarization, review commentary) does not.
   */
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

/**
 * The only place base URLs are read and provider instances are constructed.
 *
 * Three rules are enforced here rather than left to callers:
 *   1. A local request is never silently promoted to a remote or paid provider.
 *   2. A failed remote request may only degrade to a LOCAL_OLLAMA instance.
 *   3. Only a model with *verified* tool calling enters the tool-driven loop.
 */
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

  /**
   * Enforces the routing policy. Note what is absent: there is no branch that
   * upgrades a local request to a remote instance. Remote is only ever reached
   * because a caller or an alias named it.
   */
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

  /**
   * Capability is established, not inherited from configuration. Results are
   * cached; a probe runs lazily on first use and never on the boot path.
   */
  async getCapabilities(instanceId: string, model: string, signal?: AbortSignal): Promise<ProviderCapabilities> {
    const cached = await this.capabilityStore.read(instanceId, model);
    if (cached) return cached;

    const key = `${instanceId}::${model}`;
    const inflight = this.inflightProbes.get(key);
    if (inflight) return inflight;

    const probe = (async () => {
      const provider = this.getProvider(instanceId);

      // Populate declared capabilities first so the probe knows whether there
      // is anything worth verifying.
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

  /** Clears cached probe results, backing the "re-probe" action in Settings. */
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
      // Only a disabled REMOTE instance may degrade, and only to local.
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

  /**
   * A fallback target must be a LOCAL_OLLAMA instance. A remote instance never
   * substitutes for another remote or paid one, however it is configured.
   */
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

  /** Visible fallback history — a degraded request is never silent. */
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

  /** Live inventory across every enabled instance. */
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
    default:
      throw new ProviderResolutionError(
        `Unsupported provider kind for instance "${instance.id}".`,
        'unsupported-kind',
      );
  }
}
