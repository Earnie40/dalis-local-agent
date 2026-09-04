import { createId, getPool } from '@dacai-local-agent/shared';
import { sanitizeText, scanForSecrets } from '@dacai-local-agent/security';
import { sha256Hex, type Claim, makeClaim } from '@dacai-local-agent/domain-knowledge';
import { KnowledgeIngestionService } from '@dacai-local-agent/rag';
import { admitSource, type PublicSourceKind } from './sources.js';
import type { FetchedDocument } from './research/provider.js';

/**
 * Signal ingestion.
 *
 * A signal is one retrieved public observation with its provenance attached.
 * Storage happens twice on purpose:
 *
 *   - `intelligence_signals` holds the structured row the graph and scoring
 *     engines read.
 *   - the existing `knowledge_documents`/`knowledge_chunks` corpus holds the
 *     embedded text, so semantic search over signals uses the same pgvector
 *     store as everything else in the platform.
 *
 * The corpus write goes through KnowledgeIngestionService rather than RagService
 * directly, which is what buys license enforcement, secret redaction, content
 * hashing, duplicate detection, and a `knowledge_ingestions` audit row for every
 * attempt — including the rejected ones.
 */

export const SIGNAL_DOMAIN = 'ecosystem-intelligence' as const;

export interface SignalInput {
  document: FetchedDocument;
  sourceKind: PublicSourceKind;
  license: string;
  entityIds: readonly string[];
  sourceId?: string;
  publisher?: string;
  /**
   * How the entity came to be attached: named directly in the text, or inferred
   * from context. Inference is recorded as inference, never as a naming.
   */
  attribution?: 'named' | 'inferred';
}

export interface StoredSignal {
  id: string;
  status: 'ingested' | 'duplicate' | 'rejected';
  url: string;
  title?: string;
  contentHash: string;
  knowledgeDocumentId?: string;
  secretsRedacted: number;
  rejectionReason?: string;
}

/** Text below this is a nav fragment or a cookie banner, not an observation. */
const MIN_USEFUL_CHARS = 180;
const MAX_EXCERPT_CHARS = 8_000;

export class SignalIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalIngestionError';
  }
}

export class SignalStore {
  constructor(private readonly knowledge = new KnowledgeIngestionService()) {}

  /**
   * Admits, redacts, hashes, embeds, and stores one retrieved document.
   *
   * Returns a status rather than throwing for the ordinary outcomes: a duplicate
   * and a too-thin page are normal results of research, not errors.
   */
  async ingest(input: SignalInput): Promise<StoredSignal> {
    const accepted = admitSource({
      url: input.document.url,
      kind: input.sourceKind,
      title: input.document.title,
      publisher: input.publisher,
      license: input.license,
    });

    // Redaction runs before hashing and before embedding, so a secret never
    // reaches the vector store, the content hash, or an inference request.
    const findings = scanForSecrets(input.document.text);
    const redacted = sanitizeText(input.document.text);
    const normalized = normalizeSignalText(redacted);

    if (normalized.length < MIN_USEFUL_CHARS) {
      return {
        id: '',
        status: 'rejected',
        url: accepted.url,
        contentHash: '',
        secretsRedacted: findings.length,
        rejectionReason: `Extracted text was ${normalized.length} characters, below the ${MIN_USEFUL_CHARS}-character usefulness threshold.`,
      };
    }

    const contentHash = sha256Hex(normalized);

    const existing = await getPool().query<{ id: string }>(
      'SELECT id FROM intelligence_signals WHERE content_hash = $1 LIMIT 1',
      [contentHash],
    );
    if (existing.rows.length) {
      // A duplicate document can be discovered while researching a different
      // entity (for example, a round announcement names both the company and
      // several investors).  The signal itself is content-addressed, but its
      // entity attachments are not: returning before linking them permanently
      // loses those newly resolved mentions.
      for (const entityId of new Set(input.entityIds)) {
        await getPool().query(
          `INSERT INTO signal_entities (signal_id, entity_id, attribution)
           VALUES ($1,$2,$3)
           ON CONFLICT (signal_id, entity_id) DO UPDATE SET
             attribution = CASE
               WHEN signal_entities.attribution = 'named' OR EXCLUDED.attribution = 'named' THEN 'named'
               ELSE 'inferred'
             END`,
          [existing.rows[0].id, entityId, input.attribution ?? 'named'],
        );
      }
      return {
        id: existing.rows[0].id,
        status: 'duplicate',
        url: accepted.url,
        title: input.document.title,
        contentHash,
        secretsRedacted: findings.length,
      };
    }

    // The corpus write may itself report a duplicate when the same text was
    // ingested through another path; that is fine and the document id is reused.
    const corpusResult = await this.knowledge.ingest({
      content: normalized,
      format: 'txt',
      source: accepted.url,
      title: input.document.title,
      license: accepted.license,
      domainId: SIGNAL_DOMAIN,
      tags: ['investor-intelligence', 'public-signal', accepted.kind],
      // Public pages are temporally sensitive: a thesis stated in 2024 is not
      // evidence of a position held today. availableAt lets historical queries
      // see only what was actually published by a given moment.
      availableAt: input.document.publishedAt,
      metadata: {
        provider: input.document.provider,
        sourceKind: accepted.kind,
        publisher: accepted.publisher,
        retrievedAt: input.document.retrievedAt,
      },
    });

    if (corpusResult.status === 'rejected') {
      return {
        id: '',
        status: 'rejected',
        url: accepted.url,
        contentHash,
        secretsRedacted: findings.length,
        rejectionReason: corpusResult.rejectionReason,
      };
    }

    const signalId = createId('sig');
    const excerpt = normalized.slice(0, MAX_EXCERPT_CHARS);

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO intelligence_signals (
           id, source_id, knowledge_document_id, source_url, source_kind, title,
           excerpt, published_at, retrieved_at, content_hash, assertion_class,
           source_count, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'observed',1,$11)`,
        [
          signalId,
          input.sourceId ?? null,
          corpusResult.documentId ?? null,
          accepted.url,
          accepted.kind,
          input.document.title ?? null,
          excerpt,
          input.document.publishedAt ?? null,
          input.document.retrievedAt,
          contentHash,
          JSON.stringify({
            provider: input.document.provider,
            publisher: accepted.publisher,
            secretsRedacted: findings.length,
            truncated: normalized.length > MAX_EXCERPT_CHARS,
          }),
        ],
      );

      for (const entityId of new Set(input.entityIds)) {
        await client.query(
          `INSERT INTO signal_entities (signal_id, entity_id, attribution)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [signalId, entityId, input.attribution ?? 'named'],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return {
      id: signalId,
      status: 'ingested',
      url: accepted.url,
      title: input.document.title,
      contentHash,
      knowledgeDocumentId: corpusResult.documentId,
      secretsRedacted: findings.length,
    };
  }

  async recentForEntity(entityId: string, sinceDays: number, limit = 50): Promise<SignalRow[]> {
    const { rows } = await getPool().query(
      `SELECT s.* FROM intelligence_signals s
         JOIN signal_entities se ON se.signal_id = s.id
        WHERE se.entity_id = $1
          AND coalesce(s.published_at, s.retrieved_at) >= now() - ($2 || ' days')::interval
        ORDER BY coalesce(s.published_at, s.retrieved_at) DESC
        LIMIT $3`,
      [entityId, String(Math.max(1, Math.min(sinceDays, 3650))), Math.max(1, Math.min(limit, 500))],
    );
    return rows.map(toSignalRow);
  }

  async byIds(ids: readonly string[]): Promise<SignalRow[]> {
    if (!ids.length) return [];
    const { rows } = await getPool().query(
      'SELECT * FROM intelligence_signals WHERE id = ANY($1::text[])',
      [[...ids]],
    );
    return rows.map(toSignalRow);
  }
}

export interface SignalRow {
  id: string;
  sourceUrl: string;
  sourceKind: string;
  title?: string;
  excerpt: string;
  summary?: string;
  publishedAt?: string;
  retrievedAt: string;
  contentHash: string;
  assertionClass: string;
  confidence?: number;
  sourceCount: number;
}

function toSignalRow(row: Record<string, unknown>): SignalRow {
  return {
    id: String(row.id),
    sourceUrl: String(row.source_url),
    sourceKind: String(row.source_kind),
    title: (row.title as string | null) ?? undefined,
    excerpt: String(row.excerpt),
    summary: (row.summary as string | null) ?? undefined,
    publishedAt: (row.published_at as Date | null)?.toISOString(),
    retrievedAt: (row.retrieved_at as Date).toISOString(),
    contentHash: String(row.content_hash),
    assertionClass: String(row.assertion_class),
    confidence: (row.confidence as number | null) ?? undefined,
    sourceCount: Number(row.source_count ?? 0),
  };
}

/**
 * Collapses the whitespace and boilerplate that survives text extraction.
 *
 * Stable normalization matters more than prettiness: the content hash is what
 * detects a page already collected, so the same page fetched twice must produce
 * byte-identical text or duplicate detection quietly stops working.
 */
export function normalizeSignalText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').trim())
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A signal rendered as a provenance-carrying claim.
 *
 * Everything downstream that reasons about a signal takes it in this form, so a
 * retrieved statement is never handed to a model or a report without its
 * assertion class and source attached.
 */
export function signalAsClaim(signal: SignalRow): Claim<string> {
  return makeClaim({
    value: signal.summary ?? signal.excerpt.slice(0, 1_000),
    // The source published this. That it was published is observed fact; what
    // it asserts about the world is not promoted here.
    assertionClass: 'observed',
    sources: [
      {
        kind: signal.sourceKind,
        locator: signal.sourceUrl,
        sha256: signal.contentHash,
        retrievedAt: signal.retrievedAt,
      },
    ],
  });
}
