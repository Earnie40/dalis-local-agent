import type { AppConfig, ProviderInstance, RoutingPolicy } from '@dacai-local-agent/shared';
import type {
  ModelDescriptor,
  ModelProvider,
  ProviderCapabilities,
  ProviderHealth,
} from '@dacai-local-agent/agent-core';
import { isAgentLoopCapable, UNKNOWN_CAPABILITIES } from '@dacai-local-agent/agent-core';
import { AnthropicProvider } from './anthropic-provider';
import { HuggingFaceProvider } from './huggingface-provider';
import { OllamaProvider } from './ollama-provider';
import { OpenAIResponsesProvider } from './openai-provider';
import { probeCapabilities } from './capability-probe';
import { podServesModel, type GpuAvailability, type GpuAvailabilityProbe } from './gpu-availability';
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
  /** Set when gpu-preferred routing moved a local alias onto the GPU pod. */
  promotedFromAlias?: string;
  /** Set when a GPU alias could not be served and its local counterpart ran instead. */
  fellBackFromAlias?: string;
  /** One sentence describing where this request ran and why. Safe to show a user. */
  routingNote?: string;
}

export interface ResolveOptions {
  /** Tool-driven work requires verified tool calling; advisory work does not. */
  requireToolCalling?: boolean;
  /** Set when the user explicitly named this instance for this request. */
  explicitInstanceRequest?: boolean;
  /** Opt out of gpu-preferred promotion for work that must stay on this machine. */
  preferLocal?: boolean;
  /**
   * Resolve configured provider metadata without contacting the text model.
   * Used only when another subsystem executes the request directly.
   */
  skipCapabilityProbe?: boolean;
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
  private gpuProbe?: GpuAvailabilityProbe;

  constructor(
    private readonly config: AppConfig,
    private readonly capabilityStore: CapabilityStore = new InMemoryCapabilityStore(),
  ) {}

  /**
   * Supplying the probe is what turns the gpu-preferred policy on in practice:
   * without a way to ask whether the pod is answering, "prefer the GPU" would
   * mean "route to a host that may be stopped", which is worse than local.
   */
  setGpuAvailabilityProbe(probe: GpuAvailabilityProbe | undefined): void {
    this.gpuProbe = probe;
  }

  /** True when a reachable pod would be preferred over local Ollama. */
  get gpuPreferred(): boolean {
    return this.config.routingPolicy === 'gpu-preferred' && Boolean(this.gpuProbe);
  }

  /** Current GPU availability, including the sentence explaining an unusable pod. */
  async gpuAvailability(force = false): Promise<GpuAvailability | undefined> {
    return this.gpuProbe?.evaluate(force);
  }

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

    // The point of gpu-preferred is that the pod needs no per-request consent;
    // paid providers still do, so preferring the GPU never becomes API spend.
    if (this.routingPolicy === 'gpu-preferred') {
      if (instance.usageClass === 'REMOTE_GPU_OLLAMA') return;
      if (!options.explicitInstanceRequest) {
        throw new ProviderResolutionError(
          `Routing policy is gpu-preferred; "${instance.id}" (${instance.usageClass}) requires an explicit selection.`,
          'policy-blocked',
        );
      }
      return;
    }

    if (this.routingPolicy === 'manual-provider-selection' && !options.explicitInstanceRequest) {
      throw new ProviderResolutionError(
        `Routing policy requires an explicit provider selection before using "${instance.id}".`,
        'policy-blocked',
      );
    }
  }

  /** Returns cached or provider-declared status without issuing an inference request. */
  async getKnownToolCallingStatus(instanceId: string, model: string): Promise<ProviderCapabilities['toolCalling']> {
    const cached = await this.capabilityStore.read(instanceId, model);
    if (cached) return cached.toolCalling;

    // Provider declarations are safe to inspect here because this path must not
    // turn the model-list endpoint into a paid or slow inference request.
    return this.getProvider(instanceId).supportsTools(model);
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

      // A large GPU model may need more than the generic 60-second probe
      // window for its first load. Reuse the provider's bounded request
      // timeout so a cold start is not cached as a false capability failure.
      const capabilities = await probeCapabilities(provider, model, {
        signal,
        timeoutMs: this.getInstance(instanceId).requestTimeoutMs,
      });
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
    const routed = await this.applyGpuPreference(alias, options);
    const modelConfig = this.config.models[routed.alias];
    if (!modelConfig) {
      throw new ProviderResolutionError(`Unknown model alias "${routed.alias}".`, 'unknown-alias');
    }
    if (!modelConfig.enabled) {
      throw new ProviderResolutionError(`Model alias "${routed.alias}" is disabled.`, 'instance-disabled');
    }

    try {
      const resolved = await this.resolve(modelConfig.providerInstanceId, modelConfig.model, options);
      return {
        ...resolved,
        alias: routed.alias,
        temperature: modelConfig.temperature,
        maxTokens: modelConfig.maxTokens,
        promotedFromAlias: routed.promotedFromAlias,
        fellBackFromAlias: routed.fellBackFromAlias,
        routingNote: routed.note,
      };
    } catch (error) {
      // Reachability alone does not make a model suitable for an autonomous
      // agent. If the GPU model cannot pass the tool-call gate, preserve the
      // standing local fallback instead of failing an otherwise runnable task.
      const instance = this.config.providerInstances[modelConfig.providerInstanceId];
      if (
        error instanceof ProviderResolutionError &&
        error.code === 'not-agent-capable' &&
        options.requireToolCalling &&
        instance?.usageClass === 'REMOTE_GPU_OLLAMA'
      ) {
        const localAlias = this.localCounterpartAlias(routed.alias) ?? routed.promotedFromAlias;
        const localModel = localAlias ? this.config.models[localAlias] : undefined;
        if (localAlias && localModel?.enabled) {
          const localResolved = await this.resolve(
            localModel.providerInstanceId,
            localModel.model,
            { ...options, preferLocal: true },
          );
          this.recordFallback(instance.id, localResolved.instance.id, 'GPU model is not agent-capable');
          return {
            ...localResolved,
            alias: localAlias,
            temperature: localModel.temperature,
            maxTokens: localModel.maxTokens,
            fellBackFromAlias: routed.alias,
            routingNote:
              `The GPU model "${modelConfig.model}" is reachable but is not verified for autonomous tool use. ` +
              `Serving "${localAlias}" locally instead.`,
          };
        }
      }
      throw error;
    }
  }

  /**
   * Choose between an alias and its counterpart on the other side of the
   * local/GPU boundary.
   *
   * Aliases pair by name -- `coder` and `gpu_coder`, `intelligence` and
   * `intelligence_local` -- so the pair always carries the model that actually
   * exists on that host. Promoting by instance alone would keep the local model
   * name and ask the pod for a model it does not serve.
   *
   * Every outcome carries a sentence: a run that stayed local because the pod
   * is stopped should say so rather than look like an ordinary local run.
   */
  private async applyGpuPreference(
    alias: string,
    options: ResolveOptions,
  ): Promise<{ alias: string; promotedFromAlias?: string; fellBackFromAlias?: string; note?: string }> {
    if (!this.gpuProbe || options.preferLocal) return { alias };
    const requested = this.config.models[alias];
    if (!requested?.enabled) return { alias };
    const usageClass = this.config.providerInstances[requested.providerInstanceId]?.usageClass;

    if (usageClass === 'LOCAL_OLLAMA') {
      if (this.routingPolicy !== 'gpu-preferred') return { alias };
      const gpuAlias = this.counterpartAlias(`gpu_${alias}`, 'REMOTE_GPU_OLLAMA');
      if (!gpuAlias) return { alias };

      const gpuModel = this.config.models[gpuAlias].model;
      const availability = await this.gpuProbe.evaluate();
      if (!podServesModel(availability, gpuModel)) {
        return { alias, note: this.describeUnusableGpu(availability, gpuModel, alias) };
      }
      return {
        alias: gpuAlias,
        promotedFromAlias: alias,
        note: `Running "${alias}" on the GPU pod as "${gpuAlias}" (${gpuModel}).`,
      };
    }

    if (usageClass === 'REMOTE_GPU_OLLAMA') {
      const availability = await this.gpuProbe.evaluate();
      if (podServesModel(availability, requested.model)) return { alias, note: availability.detail };

      const localAlias = this.localCounterpartAlias(alias);
      if (!localAlias) return { alias, note: this.describeUnusableGpu(availability, requested.model, alias) };

      this.recordFallback(
        requested.providerInstanceId,
        this.config.models[localAlias].providerInstanceId,
        availability.reason ?? 'gpu model unavailable',
      );
      return {
        alias: localAlias,
        fellBackFromAlias: alias,
        note: `${this.describeUnusableGpu(availability, requested.model, alias)} Serving "${localAlias}" locally instead.`,
      };
    }

    return { alias };
  }

  /** The alias exists, is enabled, and sits on an enabled instance of that class. */
  private counterpartAlias(candidate: string, usageClass: ProviderInstance['usageClass']): string | undefined {
    const model = this.config.models[candidate];
    if (!model?.enabled) return undefined;
    const instance = this.config.providerInstances[model.providerInstanceId];
    if (!instance?.enabled || instance.usageClass !== usageClass) return undefined;
    return candidate;
  }

  private localCounterpartAlias(alias: string): string | undefined {
    return this.counterpartAlias(
      alias.startsWith('gpu_') ? alias.slice('gpu_'.length) : `${alias}_local`,
      'LOCAL_OLLAMA',
    );
  }

  private describeUnusableGpu(availability: GpuAvailability, model: string, alias: string): string {
    if (!availability.usable) return availability.detail;
    const installed = availability.models.length ? availability.models.join(', ') : 'none';
    return (
      `The GPU pod is reachable but does not serve "${model}" for "${alias}" (installed: ${installed}). ` +
      `Pull it on the pod with: ollama pull ${model}`
    );
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
    const capabilities = options.skipCapabilityProbe
      ? { ...UNKNOWN_CAPABILITIES }
      : await this.getCapabilities(instanceId, model, options.signal);

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
