import { z } from 'zod';
import { createId, getPool } from '@dacai-local-agent/shared';
import type { StructuredGenerator } from '@dacai-local-agent/providers';
import { INTELLIGENCE_ALIAS, INTELLIGENCE_FALLBACK_ALIAS } from './model-routing.js';
import { slugify } from './entities.js';
import type { SignalRow } from './signals.js';

/**
 * Theme extraction.
 *
 * The division of labour here is the important part:
 *
 *   - **The model proposes labels.** Reading a page and saying "this is about
 *     physical AI" is a language judgement and it is what Qwen is for.
 *   - **Code produces every number.** Importance, time decay, and thematic
 *     strength are computed from signal count, recency, and source diversity.
 *
 * A model asked to score its own extractions will produce confident-looking
 * numbers with nothing behind them. Themes discovered from three blog posts by
 * the same author would score identically to themes seen across twenty
 * independent sources, and the resulting ranking would be fiction.
 *
 * Themes are also never assumed. There is no seeded list of frontier-tech
 * buzzwords in this file: whatever the corpus actually discusses is what gets
 * recorded, and every theme keeps the signals that produced it.
 */

const ExtractedThemeSchema = z.object({
  /** Short noun phrase, e.g. "physical AI", "deep-tech de-risking". */
  label: z.string().min(2).max(80),
  /** One sentence on what the theme covers, in the sources' own terms. */
  description: z.string().min(4).max(400).optional(),
  /**
   * How central the theme is to THIS signal, 0..1. Used as a per-signal weight,
   * never as the theme's overall importance — that is computed across signals.
   */
  relevance: z.number().min(0).max(1),
  /** Short quote or phrase from the text that supports the label. */
  evidencePhrase: z.string().max(300).optional(),
});

export const ThemeExtractionSchema = z.object({
  themes: z.array(ExtractedThemeSchema).max(8).default([]),
  /** Set when the text genuinely carries no identifiable theme. */
  noThemesReason: z.string().max(300).optional(),
});

export type ExtractedTheme = z.infer<typeof ExtractedThemeSchema>;
export type ThemeExtraction = z.infer<typeof ThemeExtractionSchema>;

const THEME_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          relevance: { type: 'number' },
          evidencePhrase: { type: 'string' },
        },
        required: ['label', 'relevance'],
      },
    },
    noThemesReason: { type: 'string' },
  },
  required: ['themes'],
};

const SYSTEM_PROMPT = [
  'You extract technology and investment THEMES from a single public document.',
  '',
  'A theme is a subject the document is genuinely about — a technology area, an investment',
  'thesis, a technical approach, or a market condition. Use the vocabulary the document itself',
  'uses. Do not map everything onto a fixed list of fashionable terms, and do not invent themes',
  'that would merely be plausible for this kind of source.',
  '',
  'Rules:',
  '  - Extract at most 8 themes. Three well-supported themes beat eight speculative ones.',
  '  - relevance is how central the theme is to THIS document, from 0 to 1.',
  '  - evidencePhrase must be a phrase that actually appears in the text. If you cannot quote',
  '    the document, do not emit the theme.',
  '  - Returning an empty themes array is a correct answer for a page that is navigation,',
  '    boilerplate, or otherwise carries no subject matter. Set noThemesReason when you do.',
  '  - Do NOT infer a person or firm\'s opinions, intentions, or private circumstances.',
  '    Report what the document discusses, not what you imagine anyone believes.',
  '',
  'Return ONLY a JSON object: {"themes":[{"label":string,"description":string,',
  '"relevance":number,"evidencePhrase":string}],"noThemesReason":string}',
].join('\n');

export interface ThemeExtractionResult {
  signalId: string;
  themes: ExtractedTheme[];
  noThemesReason?: string;
  model: string;
  providerInstanceId: string;
  fellBackFrom?: string;
}

export class ThemeExtractor {
  constructor(private readonly generator: StructuredGenerator) {}

  async extract(signal: SignalRow, options: { signal?: AbortSignal } = {}): Promise<ThemeExtractionResult> {
    const body = signal.excerpt.slice(0, 6_000);
    const result = await this.generator.generate({
      alias: INTELLIGENCE_ALIAS,
      fallbackAlias: INTELLIGENCE_FALLBACK_ALIAS,
      schema: ThemeExtractionSchema,
      jsonSchema: THEME_JSON_SCHEMA,
      system: SYSTEM_PROMPT,
      workerRole: 'intelligence:theme-extraction',
      signal: options.signal,
      user: [
        `SOURCE: ${signal.sourceUrl}`,
        signal.title ? `TITLE: ${signal.title}` : '',
        signal.publishedAt ? `PUBLISHED: ${signal.publishedAt}` : 'PUBLISHED: (not declared)',
        '',
        'DOCUMENT TEXT:',
        body,
      ].filter(Boolean).join('\n'),
    });

    // Themes whose quoted phrase does not appear in the source are dropped.
    // This is the cheapest available check against a fluent hallucination, and
    // it runs in code rather than being requested in the prompt.
    const haystack = signal.excerpt.toLowerCase();
    const verified = result.value.themes.filter((theme) => {
      if (!theme.evidencePhrase) return true;
      return haystack.includes(theme.evidencePhrase.toLowerCase().slice(0, 60));
    });

    return {
      signalId: signal.id,
      themes: verified,
      noThemesReason: result.value.noThemesReason,
      model: result.model,
      providerInstanceId: result.providerInstanceId,
      fellBackFrom: result.fellBackFrom,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic scoring
// ---------------------------------------------------------------------------

/**
 * Half-life for signal recency, in days.
 *
 * 45 days means a signal is worth half as much after roughly six weeks. Investor
 * attention moves faster than a product cycle but slower than a news cycle, and
 * this is the knob that encodes that judgement.
 */
export const DEFAULT_HALF_LIFE_DAYS = 45;

/** Exponential decay on a signal's age. Pure function of time, nothing else. */
export function timeDecay(
  publishedAt: string | undefined,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (!publishedAt) {
    // An undeclared date is not treated as "today" — that would let undated
    // pages dominate. It gets one half-life of penalty, which is the honest
    // reading of "we do not know when this was published".
    return 0.5;
  }
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return 0.5;

  const ageDays = Math.max(0, (now.getTime() - published) / 86_400_000);
  return Number(Math.pow(0.5, ageDays / Math.max(1, halfLifeDays)).toFixed(6));
}

export interface ThemeStrengthInput {
  /** One entry per signal that carried this theme. */
  signals: ReadonlyArray<{
    publishedAt?: string;
    relevance: number;
    /** Host of the source, used to measure independence. */
    sourceHost: string;
  }>;
  now?: Date;
  halfLifeDays?: number;
}

export interface ThemeStrength {
  importance: number;
  /** Weighted average decay across contributing signals. */
  timeDecay: number;
  signalCount: number;
  sourceCount: number;
  newestSignal?: string;
}

/**
 * Thematic strength for one entity/theme pair.
 *
 * Three factors, multiplied rather than averaged, because each is a necessary
 * condition and a near-zero in any one of them should dominate:
 *
 *   volume       — how much was said (saturating; the 9th post adds little)
 *   recency      — decay-weighted, so a dormant theme fades
 *   independence — how many distinct publishers said it
 *
 * The independence term is what stops one prolific blog from manufacturing a
 * "strong theme" on its own.
 */
export function computeThemeStrength(input: ThemeStrengthInput): ThemeStrength {
  const now = input.now ?? new Date();
  const signals = input.signals;
  if (!signals.length) {
    return { importance: 0, timeDecay: 0, signalCount: 0, sourceCount: 0 };
  }

  const decays = signals.map((s) => timeDecay(s.publishedAt, now, input.halfLifeDays));
  const weights = signals.map((s, i) => clamp01(s.relevance) * decays[i]);
  const weightSum = weights.reduce((total, value) => total + value, 0);

  // Saturating volume: 1 signal ~0.30, 3 ~0.60, 8 ~0.85, 20 ~0.96.
  const volume = 1 - Math.exp(-weightSum / 2.5);

  const hosts = new Set(signals.map((s) => s.sourceHost.toLowerCase()).filter(Boolean));
  // 1 source 0.55, 2 ~0.72, 3 ~0.82, 5 ~0.93. A single source is never treated
  // as corroboration, but it is also not treated as worthless.
  const independence = 1 - 0.45 * Math.exp(-(hosts.size - 1) / 2.2);

  const weightedDecay = weightSum > 0
    ? decays.reduce((total, decay, i) => total + decay * weights[i], 0) / weightSum
    : 0;

  const newest = signals
    .map((s) => s.publishedAt)
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!)))
    .sort()
    .at(-1);

  return {
    importance: round3(clamp01(volume * independence * (0.4 + 0.6 * weightedDecay))),
    timeDecay: round3(clamp01(weightedDecay)),
    signalCount: signals.length,
    sourceCount: hosts.size,
    newestSignal: newest,
  };
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

export interface TopicRecord {
  id: string;
  slug: string;
  label: string;
  description?: string;
}

export class TopicStore {
  /**
   * Themes arrive as free text from a model, so near-duplicate labels are
   * expected ("physical AI", "Physical AI", "physical-ai"). Slugging is the
   * canonical form; it merges those without a similarity model.
   */
  async upsertTopic(label: string, description?: string): Promise<TopicRecord> {
    const slug = slugify(label);
    const { rows } = await getPool().query(
      `INSERT INTO intelligence_topics (id, slug, label, description)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO UPDATE SET
         description = COALESCE(intelligence_topics.description, EXCLUDED.description),
         updated_at = now()
       RETURNING id, slug, label, description`,
      [createId('top'), slug, label.trim(), description?.trim() ?? null],
    );
    return {
      id: rows[0].id,
      slug: rows[0].slug,
      label: rows[0].label,
      description: rows[0].description ?? undefined,
    };
  }

  async linkSignal(signalId: string, topicId: string, relevance: number): Promise<void> {
    await getPool().query(
      `INSERT INTO signal_topics (signal_id, topic_id, relevance, origins)
       VALUES ($1,$2,$3,ARRAY['theme_extraction']::TEXT[])
       ON CONFLICT (signal_id, topic_id) DO UPDATE SET
         relevance = GREATEST(signal_topics.relevance, EXCLUDED.relevance),
         origins = CASE
           WHEN 'theme_extraction' = ANY(signal_topics.origins) THEN signal_topics.origins
           ELSE array_append(signal_topics.origins, 'theme_extraction')
         END`,
      [signalId, topicId, clamp01(relevance)],
    );
  }

  /**
   * Recomputes every theme strength for one entity from the signals on record.
   *
   * A full recompute rather than an incremental update: decay means yesterday's
   * numbers are already stale, so there is nothing to preserve.
   */
  async recomputeStrengths(entityId: string, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT st.topic_id,
              s.published_at,
              s.retrieved_at,
              st.relevance,
              s.source_url
         FROM signal_topics st
         JOIN intelligence_signals s ON s.id = st.signal_id
         JOIN signal_entities se ON se.signal_id = s.id
        WHERE se.entity_id = $1`,
      [entityId],
    );

    const byTopic = new Map<string, ThemeStrengthInput['signals'][number][]>();
    for (const row of rows) {
      const list = byTopic.get(row.topic_id) ?? [];
      list.push({
        publishedAt: (row.published_at as Date | null)?.toISOString(),
        relevance: Number(row.relevance),
        sourceHost: hostOf(String(row.source_url)),
      });
      byTopic.set(row.topic_id, list);
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM entity_topic_strength WHERE entity_id = $1', [entityId]);
      for (const [topicId, signals] of byTopic) {
        const strength = computeThemeStrength({ signals, halfLifeDays });
        // The table refuses a strength row with no signals behind it; this
        // matches that constraint rather than relying on it to catch a bug.
        if (strength.signalCount === 0) continue;
        await client.query(
          `INSERT INTO entity_topic_strength
             (entity_id, topic_id, importance, time_decay, signal_count, source_count, newest_signal)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            entityId, topicId, strength.importance, strength.timeDecay,
            strength.signalCount, strength.sourceCount, strength.newestSignal ?? null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return byTopic.size;
  }

  async strengthsFor(entityId: string, limit = 25): Promise<Array<TopicRecord & ThemeStrength>> {
    const { rows } = await getPool().query(
      `SELECT t.id, t.slug, t.label, t.description,
              e.importance, e.time_decay, e.signal_count, e.source_count, e.newest_signal
         FROM entity_topic_strength e
         JOIN intelligence_topics t ON t.id = e.topic_id
        WHERE e.entity_id = $1
        ORDER BY e.importance DESC
        LIMIT $2`,
      [entityId, Math.max(1, Math.min(limit, 200))],
    );
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      label: row.label,
      description: row.description ?? undefined,
      importance: Number(row.importance),
      timeDecay: Number(row.time_decay),
      signalCount: Number(row.signal_count),
      sourceCount: Number(row.source_count),
      newestSignal: (row.newest_signal as Date | null)?.toISOString(),
    }));
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
