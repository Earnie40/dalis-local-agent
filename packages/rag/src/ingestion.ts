import { createId, getPool } from '@dacai-local-agent/shared';
import { sanitizeText, scanForSecrets } from '@dacai-local-agent/security';
import { hashArtifact, isDomainId, listDomains, sha256Hex, type DomainId } from '@dacai-local-agent/domain-knowledge';
import { RagService, RetrievalScopeError, type KnowledgeDoc } from './index.js';
import { validateLicenseStatement } from './license-policy.js';
import { isStrictIsoTimestamp } from './time-policy.js';
export { validateLicenseStatement } from './license-policy.js';
export type { LicenseValidation } from './license-policy.js';

/**
 * Domain knowledge ingestion.
 *
 * source -> validation -> secret redaction -> normalization -> hashing ->
 * provenance -> domain assignment -> chunking -> embedding -> storage
 *
 * Every attempt writes a row to knowledge_ingestions, including rejected ones:
 * a corpus whose origin cannot be explained is not auditable, and a silently
 * dropped ingestion is indistinguishable from one that never happened.
 *
 * This is a pull-from-explicit-source path. There is no crawler and no
 * unrestricted scraping.
 */

export type IngestFormat = 'txt' | 'md' | 'json' | 'code';

export type ClassificationMethod = 'explicit' | 'classified' | 'human-corrected';

export interface IngestRequest {
  /** Raw document text. Binary formats are not supported. */
  content: string;
  format: IngestFormat;
  /** Human-readable origin, e.g. a file path or document title. */
  source: string;
  title?: string;
  /**
   * Required. Ingesting material whose licence or permission is unknown is
   * refused — "unknown" is not the same as "permitted".
   */
  license: string;
  domainId?: DomainId;
  organizationId?: string;
  workspaceId?: string;
  engagementId?: string;
  agentId?: string;
  tags?: string[];
  /** Set only where the knowledge is temporally sensitive. */
  availableAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  status: 'ingested' | 'rejected' | 'duplicate';
  ingestionId: string;
  documentId?: string;
  domainId?: DomainId;
  assignedDomain?: DomainId;
  classificationMethod: ClassificationMethod;
  classificationConfidence?: number;
  contentHash?: string;
  chunkCount?: number;
  secretsRedacted: number;
  rejectionReason?: string;
}

const MAX_BYTES = 2 * 1024 * 1024;

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionError';
  }
}

export interface KnowledgeIngestionDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Normalization is format-aware so hashing is stable: the same document
 * ingested twice with different line endings must produce the same hash, or
 * duplicate detection silently stops working.
 */
export function normalizeContent(content: string, format: IngestFormat): string {
  const unified = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (format === 'json') {
    try {
      // Canonical form so key order does not change the hash.
      return hashableJson(JSON.parse(unified));
    } catch {
      throw new IngestionError('Content was declared as JSON but does not parse.');
    }
  }
  if (format === 'code') {
    // Trailing whitespace only; indentation is meaningful in source.
    return unified.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').trim();
  }
  return unified.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hashableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  }, 2);
}

/**
 * Keyword-based domain suggestion. Deliberately conservative and low-confidence:
 * it exists so an un-tagged document is not silently dropped, not so the system
 * can pretend to classify reliably. An explicit domainId always wins, and the
 * result is stored with its method and confidence so a human can correct it.
 */
export function suggestDomain(content: string): { domainId: DomainId; confidence: number } | undefined {
  const haystack = content.toLowerCase();
  const scored = listDomains().flatMap((domain) => {
    const terms = [...new Set(domain.classificationHints ?? [])];
    if (!terms.length) return [];
    return [{
      domainId: domain.id,
      hits: terms.filter((term) => haystack.includes(term.toLowerCase())).length,
      total: terms.length,
    }];
  }).filter((score) => score.hits > 0).sort((a, b) => b.hits - a.hits || a.domainId.localeCompare(b.domainId));

  const best = scored[0];
  if (!best || best.hits < 2) return undefined;
  // Keyword matching is weak evidence. Equal top scores are deliberately left
  // unclassified for a human rather than resolved by registry order.
  if (scored[1]?.hits === best.hits) return undefined;
  // Capped: keyword matching is weak evidence and must never look authoritative.
  return { domainId: best.domainId, confidence: Math.min(0.6, best.hits / best.total) };
}

export class KnowledgeIngestionService {
  constructor(
    private readonly rag = new RagService(),
    private readonly db: KnowledgeIngestionDb = getPool(),
  ) {}

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const ingestionId = createId('ing');
    const licenseValidation = validateLicenseStatement(request.license);
    const acceptedLicense = licenseValidation.normalized;

    const reject = async (reason: string): Promise<IngestResult> => {
      await this.audit({
        ingestionId, status: 'rejected', rejectionReason: reason,
        sourceKind: request.format, sourceLocator: request.source,
        license: request.license, classificationMethod: 'explicit', secretsRedacted: 0,
      });
      return { status: 'rejected', ingestionId, classificationMethod: 'explicit', secretsRedacted: 0, rejectionReason: reason };
    };

    // --- validation -------------------------------------------------------
    if (typeof request.content !== 'string' || !request.content.trim()) return reject('Content is empty.');
    if (typeof request.source !== 'string' || !request.source.trim()) return reject('A source locator is required.');
    if (!(['txt', 'md', 'json', 'code'] as const).includes(request.format)) {
      return reject(`Unsupported format "${String(request.format)}".`);
    }
    if (!licenseValidation.accepted || !acceptedLicense) {
      return reject(`${licenseValidation.reason ?? 'Invalid license statement'} Unknown provenance is not permitted.`);
    }
    if (Buffer.byteLength(request.content, 'utf8') > MAX_BYTES) {
      return reject(`Content exceeds the ${MAX_BYTES} byte ingestion limit.`);
    }
    if (request.domainId !== undefined && !isDomainId(request.domainId)) {
      return reject(`Unknown domain "${request.domainId}".`);
    }
    if (request.availableAt && !isStrictIsoTimestamp(request.availableAt)) {
      return reject('availableAt must be a full RFC 3339 timestamp.');
    }

    // --- secret redaction -------------------------------------------------
    // Runs before hashing and embedding so a secret never reaches the vector
    // store, the content hash, or an embedding request.
    const findings = scanForSecrets(request.content);
    const redacted = sanitizeText(request.content);

    // --- normalization + hashing -----------------------------------------
    let normalized: string;
    try {
      normalized = normalizeContent(redacted, request.format);
    } catch (error) {
      return reject(error instanceof Error ? error.message : 'Normalization failed.');
    }
    if (!normalized.trim()) return reject('Content was empty after normalization.');

    const contentHash = sha256Hex(normalized);

    // --- domain assignment ------------------------------------------------
    let domainId = request.domainId;
    let classificationMethod: ClassificationMethod = 'explicit';
    let classificationConfidence: number | undefined;

    if (!domainId) {
      const suggestion = suggestDomain(normalized);
      if (suggestion) {
        domainId = suggestion.domainId;
        classificationMethod = 'classified';
        classificationConfidence = suggestion.confidence;
      }
    }

    const source = request.source.trim();
    const sourceId = hashArtifact({ source, format: request.format });

    // --- duplicate detection ---------------------------------------------
    // Dedupe only identical provenance in the same tenant scope. A global
    // content-hash lookup leaks cross-tenant existence and can silently attach
    // one tenant's document id or licence to another tenant's ingestion.
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM knowledge_documents
        WHERE content_hash = $1
          AND license = $2
          AND source_id = $3
          AND domain_id IS NOT DISTINCT FROM $4
          AND organization_id IS NOT DISTINCT FROM $5
          AND workspace_id IS NOT DISTINCT FROM $6
          AND engagement_id IS NOT DISTINCT FROM $7
          AND agent_id IS NOT DISTINCT FROM $8
          AND available_at IS NOT DISTINCT FROM $9::timestamptz
        LIMIT 1`,
      [
        contentHash, acceptedLicense, sourceId, domainId ?? null,
        request.organizationId ?? null, request.workspaceId ?? null,
        request.engagementId ?? null, request.agentId ?? null,
        request.availableAt ?? null,
      ],
    );
    if (existing.rows.length) {
      await this.audit({
        ingestionId, status: 'duplicate', documentId: existing.rows[0].id,
        domainId, assignedDomain: domainId,
        sourceKind: request.format, sourceLocator: source,
        license: acceptedLicense, contentHash, classificationMethod, classificationConfidence,
        secretsRedacted: findings.length, bytes: Buffer.byteLength(normalized, 'utf8'),
      });
      return {
        status: 'duplicate', ingestionId, documentId: existing.rows[0].id,
        domainId, assignedDomain: domainId, contentHash, classificationMethod,
        classificationConfidence, secretsRedacted: findings.length,
      };
    }

    // --- provenance + chunk + embed + store -------------------------------
    const doc: Omit<KnowledgeDoc, 'id'> = {
      source,
      title: request.title?.trim(),
      content: normalized,
      tags: request.tags ?? [],
      workspaceId: request.workspaceId,
      engagementId: request.engagementId,
      agentId: request.agentId,
      organizationId: request.organizationId,
      domainId,
      sourceId,
      license: acceptedLicense,
      contentHash,
      availableAt: request.availableAt,
      retrievalEligible: true,
      trainingEligible: false,
      metadata: request.metadata,
    };

    let stored;
    try {
      stored = await this.rag.ingest(doc);
    } catch (error) {
      if (error instanceof RetrievalScopeError) return reject(error.message);
      throw error;
    }

    const chunkCount = await this.chunkCount(stored.id);

    await this.audit({
      ingestionId, status: 'ingested', documentId: stored.id, domainId,
      assignedDomain: domainId, classificationMethod, classificationConfidence,
      sourceKind: request.format, sourceLocator: request.source, license: acceptedLicense,
      contentHash, bytes: Buffer.byteLength(normalized, 'utf8'), chunkCount,
      secretsRedacted: findings.length,
    });

    return {
      status: 'ingested', ingestionId, documentId: stored.id, domainId,
      assignedDomain: domainId, classificationMethod, classificationConfidence,
      contentHash, chunkCount, secretsRedacted: findings.length,
    };
  }

  /** Human correction of an automatic domain assignment. */
  async correctDomain(documentId: string, domainId: DomainId, correctedBy: string): Promise<void> {
    if (!isDomainId(domainId)) throw new IngestionError(`Unknown domain "${domainId}".`);
    if (!correctedBy.trim()) throw new IngestionError('A named corrector is required.');

    await this.db.query('UPDATE knowledge_documents SET domain_id = $2, updated_at = now() WHERE id = $1', [documentId, domainId]);
    await this.db.query('UPDATE knowledge_chunks SET domain_id = $2 WHERE document_id = $1', [documentId, domainId]);
    await this.db.query(
      `INSERT INTO knowledge_ingestions (id, document_id, domain_id, assigned_domain, classification_method,
         source_kind, source_locator, status, rejection_reason)
       VALUES ($1,$2,$3,$3,'human-corrected','correction',$4,'ingested',NULL)`,
      [createId('ing'), documentId, domainId, `corrected-by:${correctedBy}`],
    );
  }

  private async chunkCount(documentId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM knowledge_chunks WHERE document_id = $1',
      [documentId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async audit(entry: {
    ingestionId: string;
    status: 'ingested' | 'rejected' | 'duplicate';
    documentId?: string;
    domainId?: string;
    assignedDomain?: string;
    classificationMethod: ClassificationMethod;
    classificationConfidence?: number;
    sourceKind: string;
    sourceLocator: string;
    license?: string;
    contentHash?: string;
    bytes?: number;
    chunkCount?: number;
    secretsRedacted: number;
    rejectionReason?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_ingestions (
         id, document_id, domain_id, assigned_domain, classification_method, classification_confidence,
         source_kind, source_locator, license, content_hash, bytes, chunk_count, status,
         rejection_reason, secrets_redacted
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        entry.ingestionId, entry.documentId ?? null, entry.domainId ?? null, entry.assignedDomain ?? null,
        entry.classificationMethod, entry.classificationConfidence ?? null,
        entry.sourceKind, entry.sourceLocator, entry.license ?? null, entry.contentHash ?? null,
        entry.bytes ?? null, entry.chunkCount ?? null, entry.status,
        entry.rejectionReason ?? null, entry.secretsRedacted,
      ],
    );
  }
}
