import { getPool } from './pool';

/**
 * Writes the usage ledger. Every inference call lands here stamped with its
 * provider instance and usage class, which is what later proves a delegated MCP
 * task ran entirely on local inference and cost nothing.
 */

export type UsageClassName =
  | 'LOCAL_OLLAMA'
  | 'REMOTE_GPU_OLLAMA'
  | 'HUGGING_FACE_REMOTE'
  | 'FUTURE_PAID_PROVIDER';

export interface UsageEventInput {
  conversationId?: string;
  taskId?: string;
  workspaceId?: string;
  providerInstanceId: string;
  usageClass: UsageClassName;
  model: string;
  modelDigest?: string;
  source: 'ui' | 'mcp' | 'internal';
  workerRole?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  estimatedCost?: number;
  fallbackFromInstanceId?: string;
  rateLimited?: boolean;
  providerError?: string;
}

export interface UsageSummaryRow {
  usageClass: UsageClassName;
  source: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export class UsageStore {
  /**
   * Never throws into the caller's path: a telemetry write must not be able to
   * fail a chat turn or an agent task.
   */
  async record(event: UsageEventInput): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO usage_events
           (conversation_id, task_id, workspace_id, provider_instance_id, usage_class, model,
            model_digest, source, worker_role, input_tokens, output_tokens, tool_calls,
            duration_ms, estimated_cost, fallback_from_instance_id, rate_limited, provider_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          event.conversationId ?? null,
          event.taskId ?? null,
          event.workspaceId ?? null,
          event.providerInstanceId,
          event.usageClass,
          event.model,
          event.modelDigest ?? null,
          event.source,
          event.workerRole ?? null,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          event.toolCalls ?? 0,
          event.durationMs ?? 0,
          // Local inference is free, but no usage class is hard-coded as
          // permanently free — the cost is recorded as measured.
          event.estimatedCost ?? 0,
          event.fallbackFromInstanceId ?? null,
          event.rateLimited ?? false,
          event.providerError ?? null,
        ],
      );
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  /** Split by usage class and source — never collapsed into a single total. */
  async summary(): Promise<UsageSummaryRow[]> {
    const { rows } = await getPool().query<{
      usage_class: UsageClassName;
      source: string;
      requests: string;
      input_tokens: string;
      output_tokens: string;
      estimated_cost: string;
    }>(
      `SELECT usage_class, source,
              count(*)              AS requests,
              sum(input_tokens)     AS input_tokens,
              sum(output_tokens)    AS output_tokens,
              sum(estimated_cost)   AS estimated_cost
         FROM usage_events
        GROUP BY usage_class, source
        ORDER BY usage_class, source`,
    );

    return rows.map((row) => ({
      usageClass: row.usage_class,
      source: row.source,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      estimatedCost: Number(row.estimated_cost ?? 0),
    }));
  }
}
