import { resolve } from 'node:path';
import { z } from 'zod';
import { loadModelAliases } from './model-aliases';

/**
 * The wire protocol a provider speaks. Distinct from a provider *instance*:
 * two Ollama instances (local CPU, remote GPU VM) share one kind.
 */
export const ProviderKindSchema = z.enum(['ollama', 'huggingface', 'anthropic']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/**
 * How usage of an instance is accounted. Stamped on every usage_events row and
 * telemetry event so local, remote-GPU, and remote-API activity stay
 * distinguishable. No class is treated as permanently free — a provider with a
 * free tier today is still remote usage.
 */
export const UsageClassSchema = z.enum([
  'LOCAL_OLLAMA',
  'REMOTE_GPU_OLLAMA',
  'HUGGING_FACE_REMOTE',
  'FUTURE_PAID_PROVIDER',
]);
export type UsageClass = z.infer<typeof UsageClassSchema>;

/** How traffic reaches the instance. Governs the remote-exposure guardrail. */
export const TransportSchema = z.enum(['loopback', 'vpn', 'ssh-tunnel', 'tls-proxy', 'https-api']);
export type Transport = z.infer<typeof TransportSchema>;

/**
 * local-only                — remote instances are disabled outright
 * local-preferred           — local first; remote only when explicitly requested
 * manual-provider-selection — every request names its instance
 * configured-fallback       — a failed remote request may fall back to local
 *
 * No policy ever silently promotes a local request to a remote provider.
 */
export const RoutingPolicySchema = z.enum([
  'local-only',
  'local-preferred',
  'manual-provider-selection',
  'configured-fallback',
]);
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const EscalationModeSchema = z.enum(['never', 'ask', 'automatic', 'budgeted']);
export type EscalationMode = z.infer<typeof EscalationModeSchema>;

/** Env var NAMES only — never a secret value. */
const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable NAME (e.g. HF_TOKEN), never a secret value');

export const ProviderInstanceSchema = z
  .object({
    /** Stable instance id, e.g. 'local_ollama' | 'remote_gpu_ollama' | 'huggingface'. */
    id: z.string().min(1),
    kind: ProviderKindSchema,
    /** Omitted when the official SDK owns endpoint resolution (e.g. Hugging Face). */
    baseUrl: z.string().url().optional(),
    enabled: z.boolean().default(false),
    usageClass: UsageClassSchema,
    transport: TransportSchema.default('loopback'),
    /** Optional SOCKS5/SOCKS5H proxy for outbound provider traffic. */
    proxyUrl: z.string().url().optional(),
    /** If true, direct outbound traffic is rejected when proxyUrl is absent. */
    proxyRequired: z.boolean().default(false),
    authTokenEnvVar: EnvVarNameSchema.optional(),
    requestTimeoutMs: z.number().int().positive().default(120_000),
    /** Validated in AppConfigSchema: may only reference a LOCAL_OLLAMA instance. */
    fallbackInstanceId: z.string().optional(),
  })
  .superRefine((instance, ctx) => {
    if (!instance.enabled) return;

    if (instance.kind === 'ollama' && !instance.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: `Provider instance "${instance.id}" is enabled but has no baseUrl.`,
      });
      return;
    }

    if (instance.baseUrl && instance.transport === 'loopback' && !isLoopbackUrl(instance.baseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transport'],
        message:
          `Provider instance "${instance.id}" targets a non-loopback host with transport "loopback". ` +
          'An unauthenticated inference port is never exposed off-machine — use ssh-tunnel, vpn, or tls-proxy.',
      });
    }

    if (instance.transport === 'https-api' && !instance.authTokenEnvVar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authTokenEnvVar'],
        message: `Provider instance "${instance.id}" uses https-api transport and must name an auth token env var.`,
      });
    }
  });

export type ProviderInstance = z.infer<typeof ProviderInstanceSchema>;

/** Hosts that are genuinely on this machine. An SSH tunnel endpoint is loopback too. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Role aliases decouple agent configuration from physical model tags. An alias
 * selects a provider *instance* as well as a model.
 */
export const ModelAliasSchema = z.enum([
  'fast',
  /** Plain conversation: fast single-turn model, not for tool work. */
  'chat',
  'coder',
  'reasoner',
  'reviewer',
  'research',
  /** Available agent-capable model on the structured tool-call channel. */
  'structured_agent',
  'large_coder',
  'hf_reasoner',
]);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ModelConfigSchema = z.object({
  providerInstanceId: z.string().min(1),
  model: z.string().min(1),
  enabled: z.boolean().default(true),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const AgentRoleSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string()).default([]),
  permissions: z.object({
    filesystem: z.enum(['read-only', 'read-write']).default('read-only'),
    network: z.enum(['restricted', 'normal']).default('restricted'),
    shell: z.enum(['none', 'read-only', 'normal']).default('none'),
  }),
  temperature: z.number().min(0).max(2).default(0.2),
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AppConfigSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
    port: z.number().int().positive().default(3001),
    webPort: z.number().int().positive().default(5173),
    providerInstances: z.record(z.string(), ProviderInstanceSchema).default({}),
    routingPolicy: RoutingPolicySchema.default('local-preferred'),
    anthropicModel: z.string().optional(),
    databaseUrl: z.string().min(1),
    defaultEscalationMode: EscalationModeSchema.default('ask'),
    models: z.record(z.string(), ModelConfigSchema).default({}),
    agents: z.record(z.string(), AgentRoleSchema).default({}),
    limits: z
      .object({
        maxLocalWorkers: z.number().int().positive().default(3),
        maxAgentTurns: z.number().int().positive().default(50),
        maxTaskDepth: z.number().int().positive().default(3),
        maxConcurrentModelRequests: z.number().int().positive().default(2),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    for (const [id, instance] of Object.entries(config.providerInstances)) {
      if (!instance.fallbackInstanceId) continue;

      const target = config.providerInstances[instance.fallbackInstanceId];
      if (!target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerInstances', id, 'fallbackInstanceId'],
          message: `Unknown fallback instance "${instance.fallbackInstanceId}".`,
        });
        continue;
      }

      // A failed remote call may only degrade to local inference — never to
      // another remote or cost-incurring provider.
      if (target.usageClass !== 'LOCAL_OLLAMA') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerInstances', id, 'fallbackInstanceId'],
          message: `Fallback "${instance.fallbackInstanceId}" is ${target.usageClass}; only LOCAL_OLLAMA instances may be a fallback.`,
        });
      }
    }

    for (const [alias, model] of Object.entries(config.models)) {
      if (!config.providerInstances[model.providerInstanceId]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', alias, 'providerInstanceId'],
          message: `Model alias "${alias}" references unknown provider instance "${model.providerInstanceId}".`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;

const DEFAULT_LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434';

function truthy(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true' || value === '1';
}

/**
 * Builds the provider instance registry from the environment. Every instance is
 * declared whether or not it is enabled, so the UI can report "not configured"
 * rather than pretending the provider does not exist.
 */
export function buildProviderInstances(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  // HF_TOKEN is canonical; HUGGINGFACE_API_KEY is accepted for continuity.
  const hfTokenVar = env.HF_TOKEN ? 'HF_TOKEN' : env.HUGGINGFACE_API_KEY ? 'HUGGINGFACE_API_KEY' : undefined;

  return {
    local_ollama: {
      id: 'local_ollama',
      kind: 'ollama',
      // Reasoning models on CPU can spend minutes on a single turn with a
      // large context; the default is too tight for agent work.
      requestTimeoutMs: Number(env.OLLAMA_REQUEST_TIMEOUT_MS ?? 300_000),
      // OLLAMA_BASE_URL is the deprecated pre-instance name, still honoured.
      baseUrl: env.OLLAMA_LOCAL_BASE_URL ?? env.OLLAMA_BASE_URL ?? DEFAULT_LOCAL_OLLAMA_URL,
      enabled: true,
      usageClass: 'LOCAL_OLLAMA',
      transport: 'loopback',
    },
    remote_gpu_ollama: {
      id: 'remote_gpu_ollama',
      kind: 'ollama',
      baseUrl: env.OLLAMA_REMOTE_BASE_URL || undefined,
      enabled: truthy(env.OLLAMA_REMOTE_ENABLED),
      usageClass: 'REMOTE_GPU_OLLAMA',
      transport: env.OLLAMA_REMOTE_TRANSPORT ?? 'ssh-tunnel',
      proxyUrl: env.OLLAMA_REMOTE_SOCKS5_PROXY || env.OUTBOUND_SOCKS5_PROXY || undefined,
      proxyRequired: truthy(env.OUTBOUND_PROXY_REQUIRED),
      authTokenEnvVar: env.OLLAMA_REMOTE_AUTH_TOKEN ? 'OLLAMA_REMOTE_AUTH_TOKEN' : undefined,
      fallbackInstanceId: 'local_ollama',
    },
    huggingface: {
      id: 'huggingface',
      kind: 'huggingface',
      baseUrl: env.HF_INFERENCE_BASE_URL || undefined,
      enabled: truthy(env.HF_PROVIDER_ENABLED) && Boolean(hfTokenVar),
      usageClass: 'HUGGING_FACE_REMOTE',
      transport: 'https-api',
      authTokenEnvVar: hfTokenVar,
      fallbackInstanceId: 'local_ollama',
    },
    anthropic: {
      id: 'anthropic',
      kind: 'anthropic',
      enabled: Boolean(env.ANTHROPIC_API_KEY),
      usageClass: 'FUTURE_PAID_PROVIDER',
      transport: 'https-api',
      authTokenEnvVar: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : undefined,
      // Deliberately no fallback: a paid provider never substitutes for, or is
      // substituted by, anything automatically.
    },
  };
}

export interface LoadAppConfigOptions {
  /** Path to the role-alias YAML. Defaults to config/models/default.yaml. */
  modelAliasPath?: string;
  /** Skips reading the alias file — used by tests that supply models directly. */
  skipModelAliases?: boolean;
}

export interface AppConfigLoadResult {
  config: AppConfig;
  /** Non-fatal problems, e.g. an alias whose ${VAR} placeholder is unset. */
  warnings: string[];
}

/**
 * Loads configuration and role aliases together, so alias → provider instance
 * references are validated at startup rather than at first use.
 */
export function loadAppConfigResult(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadAppConfigOptions = {},
): AppConfigLoadResult {
  const warnings: string[] = [];
  let models: Record<string, ModelConfig> = {};

  if (!options.skipModelAliases) {
    const aliasPath =
      options.modelAliasPath ?? env.MODEL_ALIAS_CONFIG ?? resolve(process.cwd(), 'config/models/default.yaml');
    const loaded = loadModelAliases(aliasPath, env);
    models = loaded.models;
    warnings.push(...loaded.warnings);
  }

  const config = AppConfigSchema.parse({
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3001),
    webPort: Number(env.WEB_PORT ?? 5173),
    providerInstances: buildProviderInstances(env),
    routingPolicy: env.ROUTING_POLICY ?? 'local-preferred',
    anthropicModel: env.ANTHROPIC_MODEL || undefined,
    databaseUrl: env.DATABASE_URL ?? '',
    defaultEscalationMode: env.DEFAULT_ESCALATION_MODE ?? 'ask',
    models,
    limits: {
      maxLocalWorkers: Number(env.MAX_LOCAL_WORKERS ?? 3),
      maxAgentTurns: Number(env.MAX_AGENT_TURNS ?? 50),
      maxTaskDepth: Number(env.MAX_TASK_DEPTH ?? 3),
      maxConcurrentModelRequests: Number(env.MAX_CONCURRENT_MODEL_REQUESTS ?? 2),
    },
  });

  return { config, warnings };
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return AppConfigSchema.parse({
    nodeEnv: env.NODE_ENV ?? 'development',
    port: Number(env.PORT ?? 3001),
    webPort: Number(env.WEB_PORT ?? 5173),
    providerInstances: buildProviderInstances(env),
    routingPolicy: env.ROUTING_POLICY ?? 'local-preferred',
    anthropicModel: env.ANTHROPIC_MODEL || undefined,
    databaseUrl: env.DATABASE_URL ?? '',
    defaultEscalationMode: env.DEFAULT_ESCALATION_MODE ?? 'ask',
    limits: {
      maxLocalWorkers: Number(env.MAX_LOCAL_WORKERS ?? 3),
      maxAgentTurns: Number(env.MAX_AGENT_TURNS ?? 50),
      maxTaskDepth: Number(env.MAX_TASK_DEPTH ?? 3),
      maxConcurrentModelRequests: Number(env.MAX_CONCURRENT_MODEL_REQUESTS ?? 2),
    },
  });
}
