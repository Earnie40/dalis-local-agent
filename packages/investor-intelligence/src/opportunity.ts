import { createId, getPool } from '@dacai-local-agent/shared';
import { allowsPresentTense, type Capability } from './capabilities.js';
import { timeDecay } from './themes.js';

/**
 * Content opportunity scoring.
 *
 * Every number here is computed. The model contributes the qualitative parts —
 * why a theme matters, how DACAIS intersects it — and never contributes a
 * score, a weight, or a ranking.
 *
 * The reason is practical rather than ideological. This score decides what a
 * founder spends a week writing. If it came out of a generation call it could
 * not be reproduced, defended, or debugged: the same inputs would produce
 * different rankings on different days, and there would be no way to answer
 * "why is this one first?" beyond re-reading the model's prose.
 *
 * Weights are configurable because the right balance is a judgement call that
 * belongs to the operator, not to this file.
 */

export interface ScoringWeights {
  themeRelevance: number;
  evidenceStrength: number;
  timeliness: number;
  differentiation: number;
  audienceFit: number;
  demonstrability: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  themeRelevance: 0.25,
  evidenceStrength: 0.25,
  timeliness: 0.15,
  differentiation: 0.15,
  audienceFit: 0.1,
  demonstrability: 0.1,
};

export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringError';
  }
}

export function validateWeights(weights: ScoringWeights): ScoringWeights {
  const entries = Object.entries(weights);
  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new ScoringError(`Weight "${key}" must be within 0..1, received ${value}.`);
    }
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  // Tolerance rather than exact equality: 0.25+0.25+0.15+0.15+0.1+0.1 is not
  // exactly 1 in floating point.
  if (Math.abs(total - 1) > 0.001) {
    throw new ScoringError(`Weights must sum to 1.0, received ${total.toFixed(4)}.`);
  }
  return weights;
}

export interface OpportunityInput {
  /** Thematic importance for the entity, from entity_topic_strength. */
  themeImportance: number;
  /** Distinct evidence records available for the intersecting capabilities. */
  evidenceCount: number;
  /** Distinct kinds of evidence — code plus a test is stronger than two files. */
  evidenceKinds: number;
  /** Publication dates of the signals behind this opportunity. */
  signalDates: readonly (string | undefined)[];
  /** Distinct publishers among those signals. */
  distinctSources: number;
  /** Capabilities that intersect the theme. */
  capabilities: readonly Capability[];
  /**
   * How many content assets DACAIS has already published on this topic. More
   * prior coverage means less marginal value, not more.
   */
  existingContentCount: number;
  /**
   * Whether the channel audience is technical. Technical audiences reward
   * architecture depth; a general audience does not.
   */
  audienceIsTechnical: boolean;
  now?: Date;
}

export interface ScoreComponents {
  themeRelevance: number;
  evidenceStrength: number;
  timeliness: number;
  differentiation: number;
  audienceFit: number;
  demonstrability: number;
}

export interface OpportunityScore {
  score: number;
  components: ScoreComponents;
  weighted: ScoreComponents;
  confidence: number;
  /** Plain-language account of what drove the score, for the UI and the brief. */
  explanation: string[];
}

/**
 * Scores one opportunity.
 *
 * Confidence is deliberately separate from score. A high-scoring opportunity
 * resting on one undated blog post should rank well and be flagged as
 * uncertain — collapsing the two would hide exactly the case worth checking.
 */
export function scoreOpportunity(
  input: OpportunityInput,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): OpportunityScore {
  validateWeights(weights);
  const now = input.now ?? new Date();

  const themeRelevance = clamp01(input.themeImportance);

  // Evidence: volume saturates quickly, variety matters more. Four pieces of
  // one kind is weaker than two pieces of two kinds.
  const volume = 1 - Math.exp(-input.evidenceCount / 3);
  const variety = 1 - Math.exp(-input.evidenceKinds / 1.5);
  const evidenceStrength = clamp01(0.45 * volume + 0.55 * variety);

  // Timeliness is the strongest signal's decay, not the average: one very
  // recent item makes a topic timely even alongside older context.
  const decays = input.signalDates.map((date) => timeDecay(date, now));
  const timeliness = decays.length ? clamp01(Math.max(...decays)) : 0;

  // Differentiation falls as prior coverage accumulates, and rises with how
  // much genuinely demonstrable capability sits behind it.
  const saturation = 1 / (1 + input.existingContentCount);
  const demonstrableCount = input.capabilities.filter((capability) => capability.demonstrable).length;
  const substance = 1 - Math.exp(-demonstrableCount / 1.5);
  const differentiation = clamp01(0.6 * saturation + 0.4 * substance);

  // Audience fit: technical audiences reward architectural depth, which is
  // what real evidence provides.
  const audienceFit = clamp01(
    input.audienceIsTechnical ? 0.55 + 0.45 * evidenceStrength : 0.45 + 0.25 * evidenceStrength,
  );

  // Demonstrability: can any of this actually be shown working today?
  const shippable = input.capabilities.filter((capability) => allowsPresentTense(capability.status));
  const demonstrability = clamp01(
    input.capabilities.length === 0
      ? 0
      : (0.5 * shippable.length + 0.5 * demonstrableCount) / input.capabilities.length,
  );

  const components: ScoreComponents = {
    themeRelevance: round3(themeRelevance),
    evidenceStrength: round3(evidenceStrength),
    timeliness: round3(timeliness),
    differentiation: round3(differentiation),
    audienceFit: round3(audienceFit),
    demonstrability: round3(demonstrability),
  };

  const weighted: ScoreComponents = {
    themeRelevance: round3(components.themeRelevance * weights.themeRelevance),
    evidenceStrength: round3(components.evidenceStrength * weights.evidenceStrength),
    timeliness: round3(components.timeliness * weights.timeliness),
    differentiation: round3(components.differentiation * weights.differentiation),
    audienceFit: round3(components.audienceFit * weights.audienceFit),
    demonstrability: round3(components.demonstrability * weights.demonstrability),
  };

  const score = round3(
    Object.values(weighted).reduce((total, value) => total + value, 0),
  );

  // Confidence is about the inputs, not the output: how much corroboration,
  // how much evidence, and whether the signals are dated at all.
  const corroboration = 1 - Math.exp(-(input.distinctSources) / 2);
  const dated = input.signalDates.filter(Boolean).length / Math.max(1, input.signalDates.length);
  const confidence = round3(clamp01(0.45 * corroboration + 0.35 * evidenceStrength + 0.2 * dated));

  return {
    score,
    components,
    weighted,
    confidence,
    explanation: explain(components, input, confidence),
  };
}

function explain(components: ScoreComponents, input: OpportunityInput, confidence: number): string[] {
  const lines: string[] = [];

  lines.push(
    `Theme relevance ${components.themeRelevance.toFixed(2)} — derived from ${input.signalDates.length} ` +
      `signal(s) across ${input.distinctSources} distinct publisher(s).`,
  );
  lines.push(
    `Evidence strength ${components.evidenceStrength.toFixed(2)} — ${input.evidenceCount} evidence record(s) ` +
      `spanning ${input.evidenceKinds} kind(s).`,
  );
  lines.push(
    `Timeliness ${components.timeliness.toFixed(2)} — based on the most recent signal's age.`,
  );
  lines.push(
    `Differentiation ${components.differentiation.toFixed(2)} — ${input.existingContentCount} existing asset(s) ` +
      'already cover this topic.',
  );

  if (components.demonstrability < 0.3) {
    lines.push(
      `Demonstrability ${components.demonstrability.toFixed(2)} — little of this can be shown working today, ` +
        'so the content must be framed as architecture and direction rather than as capability.',
    );
  }
  if (confidence < 0.5) {
    lines.push(
      `Confidence ${confidence.toFixed(2)} is low: thin corroboration or undated sources. ` +
        'Verify the underlying signals before acting on this.',
    );
  }
  if (input.distinctSources <= 1) {
    lines.push(
      'Only one publisher is behind this theme. A single source is not corroboration, and the theme may not be real.',
    );
  }

  return lines;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type AssetType =
  | 'linkedin_founder_post'
  | 'linkedin_company_post'
  | 'technical_essay'
  | 'short_technical_update'
  | 'demo_description'
  | 'video_script'
  | 'github_project_description'
  | 'architecture_explainer'
  | 'visual_caption'
  | 'founder_essay'
  | 'faq'
  | 'press_note';

export const ASSET_TYPES: readonly AssetType[] = [
  'linkedin_founder_post',
  'linkedin_company_post',
  'technical_essay',
  'short_technical_update',
  'demo_description',
  'video_script',
  'github_project_description',
  'architecture_explainer',
  'visual_caption',
  'founder_essay',
  'faq',
  'press_note',
];

export type VisualKind =
  | 'actual_screenshot'
  | 'architecture_diagram'
  | 'concept_visualization'
  | 'future_state_visualization'
  | 'benchmark_chart'
  | 'timeline'
  | 'control_loop_diagram'
  | 'system_topology'
  | 'agent_execution_path'
  | 'before_after_workflow'
  | 'demo_recording';

export interface OpportunityRecord {
  id: string;
  entityId?: string;
  topicId?: string;
  headline: string;
  signalSummary: string;
  whyItMatters: string;
  dacaisIntersection: string;
  missingEvidence?: string;
  recommendedAssetType: AssetType;
  suggestedVisualKind?: VisualKind;
  suggestedVisual?: string;
  suggestedMetricId?: string;
  risks?: string;
  reasoning: string;
  score: number;
  scoreComponents: Record<string, number>;
  confidence: number;
  status: string;
  createdAt: string;
}

export class OpportunityStore {
  async create(input: Omit<OpportunityRecord, 'id' | 'status' | 'createdAt'> & {
    signalIds?: readonly string[];
    evidenceIds?: readonly string[];
  }): Promise<OpportunityRecord> {
    const id = createId('opp');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content_opportunities
           (id, entity_id, topic_id, headline, signal_summary, why_it_matters, dacais_intersection,
            missing_evidence, recommended_asset_type, suggested_visual_kind, suggested_visual,
            suggested_metric_id, risks, reasoning, score, score_components, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          id, input.entityId ?? null, input.topicId ?? null, input.headline,
          input.signalSummary, input.whyItMatters, input.dacaisIntersection,
          input.missingEvidence ?? null, input.recommendedAssetType,
          input.suggestedVisualKind ?? null, input.suggestedVisual ?? null,
          input.suggestedMetricId ?? null, input.risks ?? null, input.reasoning,
          input.score, JSON.stringify(input.scoreComponents), input.confidence,
        ],
      );
      for (const signalId of input.signalIds ?? []) {
        await client.query(
          'INSERT INTO opportunity_signals (opportunity_id, signal_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, signalId],
        );
      }
      for (const evidenceId of input.evidenceIds ?? []) {
        await client.query(
          'INSERT INTO opportunity_evidence (opportunity_id, evidence_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, evidenceId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { ...input, id, status: 'OPEN', createdAt: new Date().toISOString() };
  }

  async top(limit = 5, minConfidence = 0): Promise<OpportunityRecord[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM content_opportunities
        WHERE status = 'OPEN' AND confidence >= $2
        ORDER BY score DESC, confidence DESC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 50)), minConfidence],
    );
    return rows.map(toOpportunity);
  }

  async forEntity(entityId: string, limit = 20): Promise<OpportunityRecord[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM content_opportunities WHERE entity_id = $1 ORDER BY score DESC LIMIT $2`,
      [entityId, Math.max(1, Math.min(limit, 100))],
    );
    return rows.map(toOpportunity);
  }

  async byId(id: string): Promise<OpportunityRecord | undefined> {
    const { rows } = await getPool().query('SELECT * FROM content_opportunities WHERE id = $1', [id]);
    return rows[0] ? toOpportunity(rows[0]) : undefined;
  }

  async signalIdsFor(opportunityId: string): Promise<string[]> {
    const { rows } = await getPool().query(
      'SELECT signal_id FROM opportunity_signals WHERE opportunity_id = $1',
      [opportunityId],
    );
    return rows.map((row) => String(row.signal_id));
  }

  async evidenceIdsFor(opportunityId: string): Promise<string[]> {
    const { rows } = await getPool().query(
      'SELECT evidence_id FROM opportunity_evidence WHERE opportunity_id = $1',
      [opportunityId],
    );
    return rows.map((row) => String(row.evidence_id));
  }
}

function toOpportunity(row: Record<string, unknown>): OpportunityRecord {
  return {
    id: String(row.id),
    entityId: (row.entity_id as string | null) ?? undefined,
    topicId: (row.topic_id as string | null) ?? undefined,
    headline: String(row.headline),
    signalSummary: String(row.signal_summary),
    whyItMatters: String(row.why_it_matters),
    dacaisIntersection: String(row.dacais_intersection),
    missingEvidence: (row.missing_evidence as string | null) ?? undefined,
    recommendedAssetType: String(row.recommended_asset_type) as AssetType,
    suggestedVisualKind: (row.suggested_visual_kind as VisualKind | null) ?? undefined,
    suggestedVisual: (row.suggested_visual as string | null) ?? undefined,
    suggestedMetricId: (row.suggested_metric_id as string | null) ?? undefined,
    risks: (row.risks as string | null) ?? undefined,
    reasoning: String(row.reasoning),
    score: Number(row.score),
    scoreComponents: (row.score_components as Record<string, number> | null) ?? {},
    confidence: Number(row.confidence),
    status: String(row.status),
    createdAt: (row.created_at as Date).toISOString(),
  };
}
