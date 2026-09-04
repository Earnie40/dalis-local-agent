import { createId, getPool } from '@dacai-local-agent/shared';

/**
 * The metric engine.
 *
 * One property defines this module: **there is no code path here that accepts a
 * number from a language model.** Every value is read from instrumentation the
 * platform already writes — `usage_events`, `schema_migrations`, `evidence_anchors`,
 * a test run, a benchmark record. A metric that cannot be read is recorded as
 * NEEDS_MEASUREMENT with a null value and a suggested way to measure it.
 *
 * That asymmetry is deliberate. A missing number costs a sentence in a draft. A
 * fabricated number, published, costs the company its credibility with exactly
 * the technical audience it is trying to reach — and it is unrecoverable,
 * because the correction never travels as far as the claim.
 */

export type MetricStatus = 'MEASURED' | 'NEEDS_MEASUREMENT' | 'STALE';

export interface MetricRecord {
  id: string;
  slug: string;
  label: string;
  unit?: string;
  status: MetricStatus;
  value?: number;
  valueText?: string;
  measurementSource?: string;
  measuredAt?: string;
  capabilityId?: string;
}

/**
 * Metrics this system knows how to measure, and how.
 *
 * `measure` returns undefined when the instrumentation has nothing to say,
 * which becomes NEEDS_MEASUREMENT rather than a zero. Zero and "not measured"
 * are different claims and must not collapse into each other.
 */
interface MetricDefinition {
  slug: string;
  label: string;
  unit?: string;
  /** How an operator would obtain this if it is not automatically available. */
  howToMeasure: string;
  measure(): Promise<{ value?: number; valueText?: string; source: string } | undefined>;
}

async function scalar(sql: string, params: unknown[] = []): Promise<number | undefined> {
  try {
    const { rows } = await getPool().query<{ value: string | number | null }>(sql, params);
    const raw = rows[0]?.value;
    if (raw === null || raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    // A missing table is a real, reportable absence of instrumentation.
    return undefined;
  }
}

const DEFINITIONS: readonly MetricDefinition[] = [
  {
    slug: 'inference-requests-total',
    label: 'Model inference requests recorded',
    unit: 'requests',
    howToMeasure: 'Counted from usage_events, written on every provider call.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM usage_events');
      return value === undefined ? undefined : { value, source: 'usage_events' };
    },
  },
  {
    slug: 'inference-p50-latency-ms',
    label: 'Median model inference latency',
    unit: 'ms',
    howToMeasure: 'Median duration_ms across usage_events with a recorded duration.',
    async measure() {
      const value = await scalar(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::text AS value
           FROM usage_events WHERE duration_ms > 0`,
      );
      return value === undefined ? undefined : { value: Math.round(value), source: 'usage_events.duration_ms' };
    },
  },
  {
    slug: 'inference-p95-latency-ms',
    label: '95th-percentile model inference latency',
    unit: 'ms',
    howToMeasure: '95th percentile of duration_ms across usage_events.',
    async measure() {
      const value = await scalar(
        `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS value
           FROM usage_events WHERE duration_ms > 0`,
      );
      return value === undefined ? undefined : { value: Math.round(value), source: 'usage_events.duration_ms' };
    },
  },
  {
    slug: 'local-inference-share',
    label: 'Share of inference served locally',
    unit: '%',
    howToMeasure: 'Ratio of LOCAL_OLLAMA usage_events to all usage_events.',
    async measure() {
      const value = await scalar(
        `SELECT (100.0 * count(*) FILTER (WHERE usage_class = 'LOCAL_OLLAMA') / NULLIF(count(*), 0))::text AS value
           FROM usage_events`,
      );
      return value === undefined ? undefined : { value: Number(value.toFixed(1)), source: 'usage_events.usage_class' };
    },
  },
  {
    slug: 'inference-cost-total',
    label: 'Recorded inference cost',
    unit: 'USD',
    howToMeasure: 'Sum of estimated_cost across usage_events. Local inference records zero.',
    async measure() {
      const value = await scalar('SELECT coalesce(sum(estimated_cost), 0)::text AS value FROM usage_events');
      return value === undefined ? undefined : { value: Number(value.toFixed(4)), source: 'usage_events.estimated_cost' };
    },
  },
  {
    slug: 'schema-migrations-applied',
    label: 'Database migrations applied',
    unit: 'migrations',
    howToMeasure: 'Row count in schema_migrations.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM schema_migrations');
      return value === undefined ? undefined : { value, source: 'schema_migrations' };
    },
  },
  {
    slug: 'evidence-records-total',
    label: 'Evidence records generated',
    unit: 'records',
    howToMeasure: 'Row count in dacais_evidence.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM dacais_evidence');
      return value === undefined ? undefined : { value, source: 'dacais_evidence' };
    },
  },
  {
    slug: 'evidence-anchors-total',
    label: 'Evidence Registry anchors recorded',
    unit: 'anchors',
    howToMeasure: 'Row count in evidence_anchors (migration 012).',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM evidence_anchors');
      return value === undefined ? undefined : { value, source: 'evidence_anchors' };
    },
  },
  {
    slug: 'indexed-code-symbols',
    label: 'Code symbols indexed',
    unit: 'symbols',
    howToMeasure: 'Row count in code_symbols, populated by the repository indexer.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM code_symbols');
      return value === undefined ? undefined : { value, source: 'code_symbols' };
    },
  },
  {
    slug: 'knowledge-chunks-embedded',
    label: 'Knowledge chunks embedded',
    unit: 'chunks',
    howToMeasure: 'Row count in knowledge_chunks — the pgvector retrieval corpus.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM knowledge_chunks');
      return value === undefined ? undefined : { value, source: 'knowledge_chunks' };
    },
  },
  {
    slug: 'public-signals-collected',
    label: 'Public signals collected',
    unit: 'signals',
    howToMeasure: 'Row count in intelligence_signals.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM intelligence_signals');
      return value === undefined ? undefined : { value, source: 'intelligence_signals' };
    },
  },
  {
    slug: 'agent-tool-calls-total',
    label: 'Agent tool calls executed',
    unit: 'calls',
    howToMeasure: 'Sum of tool_calls across usage_events.',
    async measure() {
      const value = await scalar('SELECT coalesce(sum(tool_calls), 0)::text AS value FROM usage_events');
      return value === undefined ? undefined : { value, source: 'usage_events.tool_calls' };
    },
  },
  {
    slug: 'permission-decisions-audited',
    label: 'Permission decisions audited',
    unit: 'decisions',
    howToMeasure: 'Row count in permission_audit.',
    async measure() {
      const value = await scalar('SELECT count(*)::text AS value FROM permission_audit');
      return value === undefined ? undefined : { value, source: 'permission_audit' };
    },
  },
  // Deliberately declared without an automatic measurement. These are the
  // numbers an investor asks for and this platform cannot yet produce; naming
  // them as gaps is more useful than omitting them.
  {
    slug: 'test-suite-passing',
    label: 'Automated tests passing',
    unit: 'tests',
    howToMeasure: 'Run `pnpm test` and record the reported pass count. Not yet captured automatically.',
    async measure() {
      return undefined;
    },
  },
  {
    slug: 'test-coverage',
    label: 'Test coverage',
    unit: '%',
    howToMeasure: 'Run `pnpm test -- --coverage` and record the summary. Not yet captured automatically.',
    async measure() {
      return undefined;
    },
  },
  {
    slug: 'service-uptime',
    label: 'Service uptime',
    unit: '%',
    howToMeasure: 'Requires an uptime monitor. No such instrumentation exists in this platform.',
    async measure() {
      return undefined;
    },
  },
  {
    slug: 'tokens-per-second',
    label: 'Generation throughput',
    unit: 'tokens/s',
    howToMeasure:
      'Requires output_tokens and duration_ms on the same usage_events rows. Ollama reports token counts ' +
      'inconsistently across models, so this is only measurable once the provider records them reliably.',
    async measure() {
      const value = await scalar(
        `SELECT (1000.0 * sum(output_tokens) / NULLIF(sum(duration_ms), 0))::text AS value
           FROM usage_events WHERE output_tokens > 0 AND duration_ms > 0`,
      );
      return value === undefined ? undefined : { value: Number(value.toFixed(1)), source: 'usage_events' };
    },
  },
];

export class MetricEngine {
  /** Every metric this system knows about, measured where possible. */
  async refreshAll(): Promise<MetricRecord[]> {
    const results: MetricRecord[] = [];
    for (const definition of DEFINITIONS) {
      results.push(await this.refresh(definition));
    }
    return results;
  }

  private async refresh(definition: MetricDefinition): Promise<MetricRecord> {
    let measured: { value?: number; valueText?: string; source: string } | undefined;
    try {
      measured = await definition.measure();
    } catch {
      measured = undefined;
    }

    const hasValue = measured !== undefined && (measured.value !== undefined || measured.valueText !== undefined);
    const status: MetricStatus = hasValue ? 'MEASURED' : 'NEEDS_MEASUREMENT';

    const { rows } = await getPool().query(
      `INSERT INTO metric_registry (id, slug, label, unit, status, value_numeric, value_text, measurement_source, measured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET
         label = EXCLUDED.label,
         unit = EXCLUDED.unit,
         status = EXCLUDED.status,
         value_numeric = EXCLUDED.value_numeric,
         value_text = EXCLUDED.value_text,
         measurement_source = EXCLUDED.measurement_source,
         measured_at = EXCLUDED.measured_at
       RETURNING *`,
      [
        createId('met'),
        definition.slug,
        definition.label,
        definition.unit ?? null,
        status,
        hasValue ? (measured!.value ?? null) : null,
        hasValue ? (measured!.valueText ?? null) : null,
        // The constraint requires both source and timestamp on a MEASURED row;
        // for an unmeasured one the how-to is stored as the value_text-free hint.
        hasValue ? measured!.source : null,
        hasValue ? new Date() : null,
      ],
    );

    return toMetric(rows[0], definition.howToMeasure);
  }

  async list(): Promise<MetricRecord[]> {
    const { rows } = await getPool().query('SELECT * FROM metric_registry ORDER BY status, slug');
    return rows.map((row) => toMetric(row, howToFor(String(row.slug))));
  }

  async measured(): Promise<MetricRecord[]> {
    return (await this.list()).filter((metric) => metric.status === 'MEASURED');
  }

  /**
   * Metrics that would strengthen content but have no measurement.
   *
   * Rendered as `STATUS: NEEDS MEASUREMENT` wherever a number would otherwise
   * go, together with how to obtain it — which turns a gap into a task instead
   * of a temptation.
   */
  async gaps(): Promise<Array<MetricRecord & { howToMeasure: string }>> {
    return (await this.list())
      .filter((metric) => metric.status !== 'MEASURED')
      .map((metric) => ({ ...metric, howToMeasure: howToFor(metric.slug) }));
  }
}

function howToFor(slug: string): string {
  return DEFINITIONS.find((definition) => definition.slug === slug)?.howToMeasure ?? 'No measurement procedure is defined.';
}

function toMetric(row: Record<string, unknown>, _howToMeasure: string): MetricRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    label: String(row.label),
    unit: (row.unit as string | null) ?? undefined,
    status: String(row.status) as MetricStatus,
    value: row.value_numeric === null || row.value_numeric === undefined ? undefined : Number(row.value_numeric),
    valueText: (row.value_text as string | null) ?? undefined,
    measurementSource: (row.measurement_source as string | null) ?? undefined,
    measuredAt: (row.measured_at as Date | null)?.toISOString(),
    capabilityId: (row.capability_id as string | null) ?? undefined,
  };
}

/** Render for a draft or a brief. Unmeasured metrics say so, loudly. */
export function renderMetric(metric: MetricRecord): string {
  if (metric.status !== 'MEASURED') {
    return `${metric.label}: STATUS: NEEDS MEASUREMENT`;
  }
  const value = metric.valueText ?? String(metric.value);
  return `${metric.label}: ${value}${metric.unit ? ` ${metric.unit}` : ''}`;
}
