import { beforeEach, describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../packages/shared/src/config';
import type { AppConfig } from '../packages/shared/src/config';
import type { ModelProvider, ProviderCapabilities } from '../packages/agent-core/src/types';
import { InMemoryCapabilityStore } from '../packages/providers/src/capability-store';
import { ProviderRegistry, ProviderResolutionError } from '../packages/providers/src/provider-registry';

function buildConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return AppConfigSchema.parse({
    databaseUrl: 'postgresql://user:pw@localhost:5433/db',
    providerInstances: {
      local_ollama: {
        id: 'local_ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        enabled: true,
        usageClass: 'LOCAL_OLLAMA',
        transport: 'loopback',
      },
      remote_gpu_ollama: {
        id: 'remote_gpu_ollama',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11435',
        enabled: false,
        usageClass: 'REMOTE_GPU_OLLAMA',
        transport: 'ssh-tunnel',
        fallbackInstanceId: 'local_ollama',
      },
      anthropic: {
        id: 'anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        enabled: true,
        usageClass: 'FUTURE_PAID_PROVIDER',
        transport: 'https-api',
        authTokenEnvVar: 'ANTHROPIC_API_KEY',
      },
      openai_sol: {
        id: 'openai_sol',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        enabled: true,
        usageClass: 'FUTURE_PAID_PROVIDER',
        transport: 'https-api',
        authTokenEnvVar: 'OPENAI_API_KEY',
      },
    },
    models: {
      coder: { providerInstanceId: 'local_ollama', model: 'qwen2.5-coder:latest' },
      claude: { providerInstanceId: 'anthropic', model: 'configured-claude' },
      sol: { providerInstanceId: 'openai_sol', model: 'gpt-5.6-sol' },
      large_coder: { providerInstanceId: 'remote_gpu_ollama', model: 'big-model' },
      disabled_alias: { providerInstanceId: 'local_ollama', model: 'x', enabled: false },
    },
    ...overrides,
  });
}

/** Seeds the capability cache so no test performs a real inference call. */
async function seed(
  store: InMemoryCapabilityStore,
  model: string,
  capabilities: Partial<ProviderCapabilities>,
  instanceId = 'local_ollama',
): Promise<void> {
  await store.write(instanceId, model, {
    toolCalling: 'unknown',
    streaming: 'verified',
    ...capabilities,
  });
}

describe('ProviderRegistry', () => {
  let store: InMemoryCapabilityStore;

  beforeEach(() => {
    store = new InMemoryCapabilityStore();
  });

  it('resolves an alias to a provider instance and model', async () => {
    await seed(store, 'qwen2.5-coder:latest', { toolCalling: 'verified' });
    const resolved = await new ProviderRegistry(buildConfig(), store).resolveAlias('coder');

    expect(resolved.instance.id).toBe('local_ollama');
    expect(resolved.model).toBe('qwen2.5-coder:latest');
    expect(resolved.provider.usageClass).toBe('LOCAL_OLLAMA');
  });

  it('rejects an unknown or disabled alias', async () => {
    const registry = new ProviderRegistry(buildConfig(), store);
    await expect(registry.resolveAlias('nope')).rejects.toThrow(ProviderResolutionError);
    await expect(registry.resolveAlias('disabled_alias')).rejects.toMatchObject({ code: 'instance-disabled' });
  });

  describe('capability gate', () => {
    it('admits a verified model to the tool-driven loop', async () => {
      await seed(store, 'qwen2.5-coder:latest', { toolCalling: 'verified', toolCallChannel: 'text-json' });
      const resolved = await new ProviderRegistry(buildConfig(), store).resolve(
        'local_ollama',
        'qwen2.5-coder:latest',
        { requireToolCalling: true },
      );

      expect(resolved.capabilities.toolCalling).toBe('verified');
      expect(resolved.capabilities.toolCallChannel).toBe('text-json');
    });

    it.each(['declared', 'unsupported', 'unknown'] as const)(
      'refuses a %s model as advisory-class',
      async (status) => {
        await seed(store, 'phi3:mini', { toolCalling: status });
        const registry = new ProviderRegistry(buildConfig(), store);

        await expect(
          registry.resolve('local_ollama', 'phi3:mini', { requireToolCalling: true }),
        ).rejects.toMatchObject({ code: 'not-agent-capable' });
      },
    );

    it('still allows an advisory-class model for non-tool work', async () => {
      await seed(store, 'phi3:mini', { toolCalling: 'unsupported' });
      const resolved = await new ProviderRegistry(buildConfig(), store).resolve('local_ollama', 'phi3:mini');

      expect(resolved.model).toBe('phi3:mini');
    });
  });

  describe('routing policy', () => {
    it('blocks any remote instance under local-only', async () => {
      const registry = new ProviderRegistry(buildConfig({ routingPolicy: 'local-only' }), store);
      await expect(registry.resolve('anthropic', 'claude-3-5-sonnet-20241022')).rejects.toMatchObject({
        code: 'policy-blocked',
      });
    });

    it('requires an explicit selection under manual-provider-selection', async () => {
      const registry = new ProviderRegistry(buildConfig({ routingPolicy: 'manual-provider-selection' }), store);

      await expect(registry.resolve('anthropic', 'claude-3-5-sonnet-20241022')).rejects.toMatchObject({
        code: 'policy-blocked',
      });
      await expect(
        registry.resolve('anthropic', 'claude-3-5-sonnet-20241022', { explicitInstanceRequest: true }),
      ).resolves.toBeDefined();
    });

    it('never blocks local inference', async () => {
      await seed(store, 'qwen2.5-coder:latest', { toolCalling: 'verified' });
      const registry = new ProviderRegistry(buildConfig({ routingPolicy: 'local-only' }), store);
      await expect(registry.resolve('local_ollama', 'qwen2.5-coder:latest')).resolves.toBeDefined();
    });

    it('admits only explicitly selected paid parallel participants without a paid fallback', async () => {
      await seed(store, 'qwen2.5-coder:latest', { toolCalling: 'verified' });
      await seed(store, 'configured-claude', { toolCalling: 'verified', toolCallChannel: 'structured' }, 'anthropic');
      const registry = new ProviderRegistry(buildConfig({ routingPolicy: 'manual-provider-selection' }), store);

      await expect(
        registry.resolveAlias('claude', { requireToolCalling: true }),
      ).rejects.toMatchObject({ code: 'policy-blocked' });
      await expect(
        registry.resolveAlias('sol', { requireToolCalling: true }),
      ).rejects.toMatchObject({ code: 'policy-blocked' });

      const [sol, claude, coder] = await Promise.all([
        registry.resolveAlias('sol', { requireToolCalling: true, explicitInstanceRequest: true }),
        registry.resolveAlias('claude', { requireToolCalling: true, explicitInstanceRequest: true }),
        registry.resolveAlias('coder', { requireToolCalling: true }),
      ]);

      expect(sol.instance.id).toBe('openai_sol');
      expect(claude.instance.id).toBe('anthropic');
      expect(coder.instance.id).toBe('local_ollama');
      expect(registry.drainFallbackEvents()).toEqual([]);
    });
  });

  describe('fallback', () => {
    it('degrades an unconfigured remote instance to local, visibly', async () => {
      await seed(store, 'big-model', { toolCalling: 'verified' });
      const registry = new ProviderRegistry(buildConfig(), store);

      const resolved = await registry.resolve('remote_gpu_ollama', 'big-model');

      expect(resolved.instance.id).toBe('local_ollama');
      expect(resolved.fallbackFromInstanceId).toBe('remote_gpu_ollama');
      expect(registry.drainFallbackEvents()).toEqual([
        { fromInstanceId: 'remote_gpu_ollama', toInstanceId: 'local_ollama', reason: 'instance not configured' },
      ]);
    });

    it('never falls back to a paid provider', async () => {
      const config = buildConfig();
      // Even if a paid instance is named as the fallback target, it is refused.
      config.providerInstances.remote_gpu_ollama.fallbackInstanceId = 'anthropic';
      const registry = new ProviderRegistry(config, store);

      await expect(registry.resolve('remote_gpu_ollama', 'big-model')).rejects.toMatchObject({
        code: 'instance-disabled',
      });
    });

    it('does not fall back under manual-provider-selection', async () => {
      const registry = new ProviderRegistry(
        buildConfig({ routingPolicy: 'manual-provider-selection' }),
        store,
      );

      await expect(
        registry.resolve('remote_gpu_ollama', 'big-model', { explicitInstanceRequest: true }),
      ).rejects.toMatchObject({ code: 'instance-disabled' });
    });
  });

  it('constructs the Hugging Face provider without pretending tool support', async () => {
    const config = buildConfig();
    config.providerInstances.huggingface = {
      id: 'huggingface',
      kind: 'huggingface',
      enabled: true,
      usageClass: 'HUGGING_FACE_REMOTE',
      transport: 'https-api',
      authTokenEnvVar: 'HF_TOKEN',
      requestTimeoutMs: 120_000,
    };

    const provider = new ProviderRegistry(config, store).getProvider('huggingface');
    expect(provider.kind).toBe('huggingface');
    expect(provider.supportsTools()).toBe('unsupported');
  });

  it('caches probe results so a second resolution costs no inference call', async () => {
    let probes = 0;
    const registry = new ProviderRegistry(buildConfig(), store);
    const fake: ModelProvider = {
      instanceId: 'local_ollama',
      kind: 'ollama',
      usageClass: 'LOCAL_OLLAMA',
      async chat() {
        probes += 1;
        return {
          content: '',
          toolCalls: [{ id: 'call_1', name: 'probe_echo', arguments: { word: 'ready' } }],
          model: 'm',
          providerInstanceId: 'local_ollama',
          usageClass: 'LOCAL_OLLAMA',
        };
      },
      supportsTools: () => 'declared',
      listModels: async () => [],
      health: async () => ({
        status: 'connected',
        instanceId: 'local_ollama',
        usageClass: 'LOCAL_OLLAMA',
        location: 'Local',
      }),
      getUsage: async () => ({}),
    };

    // @ts-expect-error — inject a fake provider without a live Ollama.
    registry.providers.set('local_ollama', fake);

    const first = await registry.getCapabilities('local_ollama', 'm');
    const second = await registry.getCapabilities('local_ollama', 'm');

    expect(first.toolCalling).toBe('verified');
    expect(second.toolCalling).toBe('verified');
    expect(probes).toBe(1);
  });
});
