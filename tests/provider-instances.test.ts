import { describe, expect, it } from 'vitest';
import { AppConfigSchema, buildProviderInstances, isLoopbackUrl, loadAppConfig } from '../packages/shared/src/config';

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5433/db',
};

describe('provider instances', () => {
  it('defaults to local Ollama with every remote provider disabled', () => {
    const config = loadAppConfig(BASE_ENV);

    expect(config.routingPolicy).toBe('local-preferred');
    expect(config.providerInstances.local_ollama.enabled).toBe(true);
    expect(config.providerInstances.local_ollama.usageClass).toBe('LOCAL_OLLAMA');
    expect(config.providerInstances.remote_gpu_ollama.enabled).toBe(false);
    expect(config.providerInstances.huggingface.enabled).toBe(false);
    expect(config.providerInstances.anthropic.enabled).toBe(false);
  });

  it('still honours the deprecated OLLAMA_BASE_URL name', () => {
    const config = loadAppConfig({ ...BASE_ENV, OLLAMA_BASE_URL: 'http://127.0.0.1:9999' });
    expect(config.providerInstances.local_ollama.baseUrl).toBe('http://127.0.0.1:9999');
  });

  it('rejects a non-loopback host declaring loopback transport', () => {
    const result = AppConfigSchema.safeParse({
      databaseUrl: 'postgresql://user:pw@localhost:5433/db',
      providerInstances: {
        remote_gpu_ollama: {
          id: 'remote_gpu_ollama',
          kind: 'ollama',
          baseUrl: 'http://203.0.113.10:11434',
          enabled: true,
          usageClass: 'REMOTE_GPU_OLLAMA',
          transport: 'loopback',
        },
      },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('never exposed off-machine');
  });

  it('accepts a tunnelled remote instance bound to a loopback port', () => {
    const result = AppConfigSchema.safeParse({
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
          enabled: true,
          usageClass: 'REMOTE_GPU_OLLAMA',
          transport: 'ssh-tunnel',
          fallbackInstanceId: 'local_ollama',
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('refuses a fallback that is not local inference', () => {
    const result = AppConfigSchema.safeParse({
      databaseUrl: 'postgresql://user:pw@localhost:5433/db',
      providerInstances: {
        huggingface: {
          id: 'huggingface',
          kind: 'huggingface',
          enabled: true,
          usageClass: 'HUGGING_FACE_REMOTE',
          transport: 'https-api',
          authTokenEnvVar: 'HF_TOKEN',
          fallbackInstanceId: 'anthropic',
        },
        anthropic: {
          id: 'anthropic',
          kind: 'anthropic',
          enabled: true,
          usageClass: 'FUTURE_PAID_PROVIDER',
          transport: 'https-api',
          authTokenEnvVar: 'ANTHROPIC_API_KEY',
        },
      },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('only LOCAL_OLLAMA instances may be a fallback');
  });

  it('stores an env var NAME for credentials, never a secret value', () => {
    const instances = buildProviderInstances({
      ...BASE_ENV,
      HF_PROVIDER_ENABLED: 'true',
      HF_TOKEN: 'hf_exampleexampleexample123456',
    }) as Record<string, { authTokenEnvVar?: string }>;

    expect(instances.huggingface.authTokenEnvVar).toBe('HF_TOKEN');

    const rejected = AppConfigSchema.safeParse({
      databaseUrl: 'postgresql://user:pw@localhost:5433/db',
      providerInstances: {
        huggingface: {
          id: 'huggingface',
          kind: 'huggingface',
          enabled: true,
          usageClass: 'HUGGING_FACE_REMOTE',
          transport: 'https-api',
          authTokenEnvVar: 'hf_exampleexampleexample123456',
        },
      },
    });
    expect(rejected.success).toBe(false);
  });

  it('enables Hugging Face only when a token is actually present', () => {
    const withoutToken = buildProviderInstances({ ...BASE_ENV, HF_PROVIDER_ENABLED: 'true' }) as Record<
      string,
      { enabled: boolean }
    >;
    expect(withoutToken.huggingface.enabled).toBe(false);

    const withLegacyName = buildProviderInstances({
      ...BASE_ENV,
      HF_PROVIDER_ENABLED: 'true',
      HUGGINGFACE_API_KEY: 'hf_exampleexampleexample123456',
    }) as Record<string, { enabled: boolean; authTokenEnvVar?: string }>;
    expect(withLegacyName.huggingface.enabled).toBe(true);
    expect(withLegacyName.huggingface.authTokenEnvVar).toBe('HUGGINGFACE_API_KEY');
  });

  it('rejects a model alias pointing at an unknown provider instance', () => {
    const result = AppConfigSchema.safeParse({
      databaseUrl: 'postgresql://user:pw@localhost:5433/db',
      providerInstances: {},
      models: { coder: { providerInstanceId: 'nope', model: 'qwen2.5-coder:latest' } },
    });

    expect(result.success).toBe(false);
  });

  it('recognises loopback hosts, including tunnels and IPv6', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:11434')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:11434')).toBe(true);
    expect(isLoopbackUrl('http://10.0.0.4:11434')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});
