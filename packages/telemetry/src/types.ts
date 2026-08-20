import type { UsageClass } from '@dacai-local-agent/shared';

/**
 * Operational usage accounting. Keyed by provider *instance* and stamped with a
 * UsageClass so local, remote-GPU, remote-API and paid activity stay
 * distinguishable — this is what proves a delegated MCP task ran entirely on
 * local inference.
 */
export interface UsageRecord {
  providerInstanceId: string;
  usageClass: UsageClass;
  model: string;
  /** Weight digest where the provider exposes one; a tag alone is not an identity. */
  modelDigest?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  toolCalls: number;
  durationMs: number;
  /** Where the request originated: the web UI or a delegated MCP call. */
  source: 'ui' | 'mcp' | 'internal';
  worker: string;
  workspace: string;
  session: string;
  taskId?: string;
  startedAt: string;
  /** Set when a remote instance failed and a LOCAL fallback was used instead. */
  fallbackFromInstanceId?: string;
  rateLimited?: boolean;
  providerError?: string;
}

export interface UsageAggregate {
  totalCost: number;
  totalRequests: number;
  totalToolCalls: number;
  sessions: number;
  /** Request counts split by usage class — never collapsed into one number. */
  byUsageClass: Record<UsageClass, number>;
  fallbackEvents: number;
}
