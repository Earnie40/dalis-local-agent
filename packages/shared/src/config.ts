import { resolve } from 'node:path';
import { z } from 'zod';
import { loadModelAliases } from './model-aliases';

/** Wire protocol/provider family; distinct from a configured instance. */
export const ProviderKindSchema = z.enum(['ollama', 'huggingface', 'anthropic', 'openai']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** Accounting class stamped on provider usage. */
export const UsageClassSchema = z.enum([
  'LOCAL_OLLAMA',
  'REMOTE_GPU_OLLAMA',
  'HUGGING_FACE_REMOTE',
  'FUTURE_PAID_PROVIDER',
]);
export type UsageClass = z.infer<typeof UsageClassSchema>;

export const TransportSchema = z.enum(['loopback', 'vpn', 'ssh-tunnel', 'tls-proxy', 'https-api']);
export type Transport = z.infer<typeof TransportSchema>;

export const RoutingPolicySchema = z.enum([
  'local-only',
  'local-preferred',
  'manual-provider-selection',
  'configured-fallback',
  // GPU-first: a reachable REMOTE_GPU_OLLAMA pod serves agent work without an
  // explicit per-request selection, and local Ollama is the fallback. Paid
  // providers still require an explicit selection, so preferring the pod never
  // turns into unattended paid-API spend.
  'gpu-preferred',
]);
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const EscalationModeSchema = z.enum(['never', 'ask', 'automatic', 'budgeted']);
export type EscalationMode = z.infer<typeof EscalationModeSchema>;

/** Execution depth is independent from provider routing and tool authority. */
export const AgentRunModeSchema = z.enum(['interactive', 'coding', 'repository_audit', 'deep_research']);
export type AgentRunMode = z.infer<typeof AgentRunModeSchema>;

export const AgentRunBudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  /** Turns reserved for evidence consolidation, synthesis, and verification. */
  synthesisReserveTurns: z.number().int().nonnegative().default(0),
});
export type AgentRunBudget = z.infer<typeof AgentRunBudgetSchema>;

export const DEFAULT_AGENT_RUN_BUDGETS: Record<AgentRunMode, AgentRunBudget> = {
  interactive: { maxTurns: 16, maxToolCalls: 32, synthesisReserveTurns: 0 },
  coding: { maxTurns: 40, maxToolCalls: 96, synthesisReserveTurns: 6 },
  repository_audit: { maxTurns: 80, maxToolCalls: 160, synthesisReserveTurns: 20 },
  deep_research: { maxTurns: 100, maxToolCalls: 200, synthesisReserveTurns: 25 },
};

/** Environment variable names only; never secret values. */
const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable NAME (e.g. HF_TOKEN), never a secret value');

export const ProviderInstanceSchema = z
  .object({
    id: z.string().min(1),
    kind: ProviderKindSchema,
    baseUrl: z.string().url().optional(),
    enabled: z.boolean().default(false),
    usageClass: UsageClassSchema,
    transport: TransportSchema.default('loopback'),
    proxyUrl: z.string().url().optional(),
    proxyRequired: z.boolean().default(false),
    authTokenEnvVar: EnvVarNameSchema.optional(),
    requestTimeoutMs: z.number().int().positive().default(120_000),
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

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

export const ModelAliasSchema = z.enum([
  'agent',
  'planner',
  'fast',
  'chat',
  'qwen_uncensored',
  'coder',
  'reasoner',
  'reviewer',
  'research',
  'structured_agent',
  'large_coder',
  'hf_reasoner',
  'sol',
  'claude',
  'intelligence',
  'intelligence_local',
  'gpu_agent',
  'gpu_planner',
  'gpu_reasoner',
  'gpu_coder',
  'gpu_structured_agent',
  'gpu_reviewer',
  'gpu_chat',
  'gpu_qwen_uncensored',
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
        maxAgentTurns: z.number().int().positive().default(100),
        runBudgets: z.object({
          interactive: AgentRunBudgetSchema.default(DEFAULT_AGENT_RUN_BUDGETS.interactive),
          coding: AgentRunBudgetSchema.default(DEFAULT_AGENT_RUN_BUDGETS.coding),
          repository_audit: AgentRunBudgetSchema.default(DEFAULT_AGENT_RUN_BUDGETS.repository_audit),
          deep_research: AgentRunBudgetSchema.default(DEFAULT_AGENT_RUN_BUDGETS.deep_research),
        }).default(DEFAULT_AGENT_RUN_BUDGETS),
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

/** Build all provider instances without ever storing credential values. */
export function buildProviderInstances(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const hfTokenVar = env.HF_TOKEN ? 'HF_TOKEN' : env.HUGGINGFACE_API_KEY ? 'HUGGINGFACE_API_KEY' : undefined;
  // A valid API key is enough to discover a running pod and its current SSH
  // endpoint. RUNPOD_CONNECTION remains useful as a warm/statically supplied
  // path, but it must not be required for GPU-first routing after a pod restart.
  const runpodConfigured = Boolean(
    env.RUNPOD_CONNECTION?.trim() || env.RUNPOD_API_KEY?.trim(),
  );
  const runpodLocalPort = Number(env.RUNPOD_LOCAL_OLLAMA_PORT ?? 11435);

  return {
    local_ollama: {
      id: 'local_ollama',
      kind: 'ollama',
      requestTimeoutMs: Number(env.OLLAMA_REQUEST_TIMEOUT_MS ?? 300_000),
      baseUrl: env.OLLAMA_LOCAL_BASE_URL ?? env.OLLAMA_BASE_URL ?? DEFAULT_LOCAL_OLLAMA_URL,
      enabled: true,
      usageClass: 'LOCAL_OLLAMA',
      transport: 'loopback',
    },
    remote_gpu_ollama: {
      id: 'remote_gpu_ollama',
      kind: 'ollama',
      baseUrl:
        env.OLLAMA_REMOTE_BASE_URL ||
        (runpodConfigured ? `http://127.0.0.1:${runpodLocalPort}` : undefined),
      enabled: truthy(env.OLLAMA_REMOTE_ENABLED) || runpodConfigured,
      usageClass: 'REMOTE_GPU_OLLAMA',
      transport: env.OLLAMA_REMOTE_TRANSPORT ?? 'ssh-tunnel',
      proxyUrl: env.OLLAMA_REMOTE_SOCKS5_PROXY || env.OUTBOUND_SOCKS5_PROXY || undefined,
      proxyRequired: truthy(env.OUTBOUND_PROXY_REQUIRED),
      authTokenEnvVar: env.OLLAMA_REMOTE_AUTH_TOKEN ? 'OLLAMA_REMOTE_AUTH_TOKEN' : undefined,
      requestTimeoutMs: Number(env.RUNPOD_OLLAMA_REQUEST_TIMEOUT_MS ?? env.OLLAMA_REQUEST_TIMEOUT_MS ?? 300_000),
      // A stopped or unreachable pod must degrade to local inference rather
      // than failing the run outright.
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
      baseUrl: 'https://api.anthropic.com/v1',
      enabled: Boolean(env.ANTHROPIC_API_KEY),
      usageClass: 'FUTURE_PAID_PROVIDER',
      transport: 'https-api',
      authTokenEnvVar: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : undefined,
    },
    openai_sol: {
      id: 'openai_sol',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      enabled: Boolean(env.OPENAI_API_KEY),
      usageClass: 'FUTURE_PAID_PROVIDER',
      transport: 'https-api',
      authTokenEnvVar: 'OPENAI_API_KEY',
      requestTimeoutMs: Number(env.OPENAI_REQUEST_TIMEOUT_MS ?? 120_000),
    },
  };
}

/**
 * An alias is only as available as the provider behind it. Deriving this keeps
 * a switch like HF_PROVIDER_ENABLED authoritative in one place: without it,
 * every alias on a disabled provider still reaches the UI model picker, where
 * routing then rejects the request instead of the alias simply not being
 * offered. Aliases on an *enabled* provider are left alone even when the far
 * side is unreachable, so a stopped RunPod stays a runtime condition rather
 * than becoming a config change.
 */
function disableAliasesOnInactiveProviders(config: AppConfig, warnings: string[]): void {
  const disabled: string[] = [];

  for (const [alias, model] of Object.entries(config.models)) {
    if (!model.enabled) continue;
    if (config.providerInstances[model.providerInstanceId]?.enabled) continue;
    config.models[alias] = { ...model, enabled: false };
    disabled.push(`${alias} (${model.providerInstanceId})`);
  }

  if (disabled.length > 0) {
    warnings.push(`Model aliases disabled because their provider is not active: ${disabled.join(', ')}.`);
  }
}

export interface LoadAppConfigOptions {
  modelAliasPath?: string;
  skipModelAliases?: boolean;
}

export interface AppConfigLoadResult {
  config: AppConfig;
  warnings: string[];
}

export function loadAppConfigResult(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadAppConfigOptions = {},
): AppConfigLoadResult {
  const warnings: string[] = [];
  let models: Record<string, ModelConfig> = {};

  if (!options.skipModelAliases) {
    const aliasPath = options.modelAliasPath ?? env.MODEL_ALIAS_CONFIG ?? resolve(process.cwd(), 'config/models/default.yaml');
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
      maxAgentTurns: Number(env.MAX_AGENT_TURNS ?? 100),
      runBudgets: {
        interactive: {
          maxTurns: Number(env.AGENT_INTERACTIVE_MAX_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.interactive.maxTurns),
          maxToolCalls: Number(env.AGENT_INTERACTIVE_MAX_TOOL_CALLS ?? DEFAULT_AGENT_RUN_BUDGETS.interactive.maxToolCalls),
          synthesisReserveTurns: DEFAULT_AGENT_RUN_BUDGETS.interactive.synthesisReserveTurns,
        },
        coding: {
          maxTurns: Number(env.AGENT_CODING_MAX_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.coding.maxTurns),
          maxToolCalls: Number(env.AGENT_CODING_MAX_TOOL_CALLS ?? DEFAULT_AGENT_RUN_BUDGETS.coding.maxToolCalls),
          synthesisReserveTurns: Number(env.AGENT_CODING_SYNTHESIS_RESERVE_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.coding.synthesisReserveTurns),
        },
        repository_audit: {
          maxTurns: Number(env.AGENT_REPOSITORY_AUDIT_MAX_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.repository_audit.maxTurns),
          maxToolCalls: Number(env.AGENT_REPOSITORY_AUDIT_MAX_TOOL_CALLS ?? DEFAULT_AGENT_RUN_BUDGETS.repository_audit.maxToolCalls),
          synthesisReserveTurns: Number(env.AGENT_REPOSITORY_AUDIT_SYNTHESIS_RESERVE_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.repository_audit.synthesisReserveTurns),
        },
        deep_research: {
          maxTurns: Number(env.AGENT_DEEP_RESEARCH_MAX_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.deep_research.maxTurns),
          maxToolCalls: Number(env.AGENT_DEEP_RESEARCH_MAX_TOOL_CALLS ?? DEFAULT_AGENT_RUN_BUDGETS.deep_research.maxToolCalls),
          synthesisReserveTurns: Number(env.AGENT_DEEP_RESEARCH_SYNTHESIS_RESERVE_TURNS ?? DEFAULT_AGENT_RUN_BUDGETS.deep_research.synthesisReserveTurns),
        },
      },
      maxTaskDepth: Number(env.MAX_TASK_DEPTH ?? 3),
      maxConcurrentModelRequests: Number(env.MAX_CONCURRENT_MODEL_REQUESTS ?? 2),
    },
  });
  disableAliasesOnInactiveProviders(config, warnings);
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
      maxAgentTurns: Number(env.MAX_AGENT_TURNS ?? 100),
      runBudgets: {
        interactive: DEFAULT_AGENT_RUN_BUDGETS.interactive,
        coding: DEFAULT_AGENT_RUN_BUDGETS.coding,
        repository_audit: DEFAULT_AGENT_RUN_BUDGETS.repository_audit,
        deep_research: DEFAULT_AGENT_RUN_BUDGETS.deep_research,
      },
      maxTaskDepth: Number(env.MAX_TASK_DEPTH ?? 3),
      maxConcurrentModelRequests: Number(env.MAX_CONCURRENT_MODEL_REQUESTS ?? 2),
    },
  });
}
