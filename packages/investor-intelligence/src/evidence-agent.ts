import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { createId, getPool } from '@dacai-local-agent/shared';
import { sanitizeText, scanForSecrets } from '@dacai-local-agent/security';
import { anchorFor, hashArtifact } from '@dacai-local-agent/domain-knowledge';
import { EvidenceStore as AnchorStore } from '@dacai-local-agent/domain-knowledge';
import { RagService } from '@dacai-local-agent/rag';
import type { Capability } from './capabilities.js';

/**
 * Internal evidence retrieval.
 *
 * The rule this module exists to enforce: **a DACAIS claim is only as strong as
 * an artifact someone can open.** Evidence here is always a pointer into
 * something real — a symbol at a line range, a named test, a document, a
 * measured number — never a summary the model produced about the codebase.
 *
 * Retrieval reuses the existing repository index (`code_symbols`,
 * `symbol_edges`) and knowledge corpus through RagService. It builds no second
 * index and runs no second embedding pipeline.
 *
 * Every excerpt is redacted before it is stored. Evidence is quoted in
 * generated content and shown in the UI, so a secret reaching this table would
 * be a secret on its way to being published.
 */

export type EvidenceKind =
  | 'source_symbol'
  | 'source_file'
  | 'test'
  | 'test_run'
  | 'documentation'
  | 'migration'
  | 'api_definition'
  | 'benchmark'
  | 'metric'
  | 'deployment_config'
  | 'security_scan'
  | 'screenshot'
  | 'demo';

export interface EvidenceRecord {
  id: string;
  capabilityId?: string;
  kind: EvidenceKind;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  symbolName?: string;
  testName?: string;
  excerpt?: string;
  locator?: string;
  contentHash?: string;
  collectedAt: string;
}

export interface EvidenceSearchHit {
  kind: EvidenceKind;
  filePath: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  excerpt: string;
  /** Vector distance where semantic retrieval produced the hit. */
  distance?: number;
}

const MAX_EXCERPT_CHARS = 2_000;

export class EvidenceAgent {
  constructor(
    private readonly rag = new RagService(),
    private readonly anchors = new AnchorStore(),
    private readonly workspaceRoot = process.cwd(),
  ) {}

  /**
   * Finds candidate evidence for a capability by searching the repository index
   * and the document corpus.
   *
   * Returns what was actually found. An empty result is a real and useful
   * answer — it is how the evidence-gap detector learns that a capability is
   * asserted but unsupported.
   */
  async search(query: string, limit = 8): Promise<EvidenceSearchHit[]> {
    const hits: EvidenceSearchHit[] = [];

    try {
      const symbols = await this.rag.searchRepository(query, {}, limit);
      for (const symbol of symbols) {
        const body = symbol.summary ?? symbol.content ?? symbol.signature ?? '';
        hits.push({
          kind: classifyPath(symbol.filePath),
          filePath: symbol.filePath,
          symbolName: symbol.symbolName,
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          excerpt: sanitizeText(body).slice(0, MAX_EXCERPT_CHARS),
          distance: symbol.distance,
        });
      }
    } catch {
      // The repository index may be unpopulated. That is a gap to report, not a
      // reason to fail the whole evidence search.
    }

    try {
      const documents = await this.rag.search(query, {}, Math.max(2, Math.floor(limit / 2)));
      for (const chunk of documents) {
        hits.push({
          kind: 'documentation',
          filePath: chunk.source,
          excerpt: sanitizeText(chunk.content).slice(0, MAX_EXCERPT_CHARS),
          distance: chunk.distance,
        });
      }
    } catch {
      // Same: corpus may be empty.
    }

    return hits;
  }

  /**
   * Records one piece of evidence against a capability.
   *
   * Refuses if the excerpt trips the secret scanner. A redaction pass runs
   * first, so reaching this throw means the scanner found something redaction
   * could not neutralize — which is exactly when a human should look.
   */
  async record(input: {
    capabilityId?: string;
    kind: EvidenceKind;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    symbolName?: string;
    testName?: string;
    excerpt?: string;
    locator?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EvidenceRecord> {
    const redacted = input.excerpt ? sanitizeText(input.excerpt).slice(0, MAX_EXCERPT_CHARS) : undefined;
    if (redacted && scanForSecrets(redacted).length) {
      throw new Error(
        'Refusing to record evidence whose excerpt still matches a secret pattern after redaction.',
      );
    }

    const contentHash = redacted ? hashArtifact({ file: input.filePath, excerpt: redacted }) : undefined;

    // Anchor the evidence in the existing Evidence Registry so what was cited
    // can later be shown to be what was actually there.
    let anchorId: string | undefined;
    if (contentHash) {
      anchorId = await this.anchors
        .record(anchorFor('sourceHash', { file: input.filePath, excerpt: redacted }, input.filePath))
        .catch(() => undefined);
    }

    const id = createId('ev');
    await getPool().query(
      `INSERT INTO dacais_evidence
         (id, capability_id, evidence_kind, file_path, start_line, end_line, symbol_name,
          test_name, excerpt, locator, content_hash, evidence_anchor_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        input.capabilityId ?? null,
        input.kind,
        input.filePath ? this.relativePath(input.filePath) : null,
        input.startLine ?? null,
        input.endLine ?? null,
        input.symbolName ?? null,
        input.testName ?? null,
        redacted ?? null,
        input.locator ?? null,
        contentHash ?? null,
        anchorId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return {
      id,
      capabilityId: input.capabilityId,
      kind: input.kind,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      symbolName: input.symbolName,
      testName: input.testName,
      excerpt: redacted,
      locator: input.locator,
      contentHash,
      collectedAt: new Date().toISOString(),
    };
  }

  async forCapability(capabilityId: string): Promise<EvidenceRecord[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM dacais_evidence WHERE capability_id = $1 ORDER BY collected_at DESC',
      [capabilityId],
    );
    return rows.map(toEvidence);
  }

  async byIds(ids: readonly string[]): Promise<EvidenceRecord[]> {
    if (!ids.length) return [];
    const { rows } = await getPool().query(
      'SELECT * FROM dacais_evidence WHERE id = ANY($1::text[])',
      [[...ids]],
    );
    return rows.map(toEvidence);
  }

  /**
   * Reads the actual lines an evidence record points at.
   *
   * This is what makes the evidence page trustworthy: the excerpt shown is read
   * from the file now, not replayed from what was stored when it was collected.
   * A drifted line range shows as drifted instead of silently displaying stale
   * text as current.
   */
  async readSource(record: EvidenceRecord): Promise<{ lines: string; drifted: boolean } | undefined> {
    if (!record.filePath || !record.startLine) return undefined;
    const target = resolve(this.workspaceRoot, record.filePath);
    // Containment: an evidence row must never be able to read outside the repo.
    if (!target.startsWith(resolve(this.workspaceRoot) + sep)) return undefined;

    let content: string;
    try {
      content = await readFile(target, 'utf8');
    } catch {
      return undefined;
    }

    const all = content.split(/\r?\n/);
    const from = Math.max(0, record.startLine - 1);
    const to = Math.min(all.length, record.endLine ?? record.startLine);
    const lines = sanitizeText(all.slice(from, to).join('\n')).slice(0, MAX_EXCERPT_CHARS);

    const drifted = Boolean(
      record.excerpt && record.excerpt.trim() && !lines.includes(record.excerpt.trim().split('\n')[0]),
    );
    return { lines, drifted };
  }

  private relativePath(path: string): string {
    const relativePath = relative(this.workspaceRoot, resolve(this.workspaceRoot, path));
    // Repository-relative. An absolute host path leaks machine layout into
    // content that may be published.
    return relativePath.replace(/\\/g, '/');
  }
}

function toEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id),
    capabilityId: (row.capability_id as string | null) ?? undefined,
    kind: String(row.evidence_kind) as EvidenceKind,
    filePath: (row.file_path as string | null) ?? undefined,
    startLine: (row.start_line as number | null) ?? undefined,
    endLine: (row.end_line as number | null) ?? undefined,
    symbolName: (row.symbol_name as string | null) ?? undefined,
    testName: (row.test_name as string | null) ?? undefined,
    excerpt: (row.excerpt as string | null) ?? undefined,
    locator: (row.locator as string | null) ?? undefined,
    contentHash: (row.content_hash as string | null) ?? undefined,
    collectedAt: (row.collected_at as Date).toISOString(),
  };
}

function classifyPath(path: string): EvidenceKind {
  const lower = path.toLowerCase();
  if (/(^|\/)tests?\//.test(lower) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return 'test';
  if (lower.endsWith('.sql')) return 'migration';
  if (lower.endsWith('.md')) return 'documentation';
  if (/(^|\/)(routes?|api)\//.test(lower)) return 'api_definition';
  if (/\.(ya?ml|toml|dockerfile)$/.test(lower) || lower.includes('dockerfile')) return 'deployment_config';
  return 'source_symbol';
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface ClaimRecord {
  id: string;
  capabilityId?: string;
  text: string;
  status: string;
  confidence?: number;
  supportingEvidenceCount: number;
  contradictingEvidenceCount: number;
}

export class ClaimStore {
  /**
   * Creates a claim and links its evidence in one transaction.
   *
   * A claim and its evidence are meaningless apart, so they are never written
   * separately — a crash between the two writes would leave an unsupported
   * claim on record that looks supported.
   */
  async create(input: {
    capabilityId?: string;
    text: string;
    status: string;
    confidence?: number;
    supportingEvidenceIds?: readonly string[];
    contradictingEvidenceIds?: readonly string[];
  }): Promise<ClaimRecord> {
    const id = createId('clm');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO dacais_claims (id, capability_id, claim_text, status, confidence, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          input.capabilityId ?? null,
          input.text,
          input.status,
          input.confidence ?? null,
          input.supportingEvidenceIds?.length ? new Date() : null,
        ],
      );
      for (const evidenceId of input.supportingEvidenceIds ?? []) {
        await client.query(
          'INSERT INTO claim_evidence (claim_id, evidence_id, supports) VALUES ($1,$2,true) ON CONFLICT DO NOTHING',
          [id, evidenceId],
        );
      }
      for (const evidenceId of input.contradictingEvidenceIds ?? []) {
        await client.query(
          'INSERT INTO claim_evidence (claim_id, evidence_id, supports) VALUES ($1,$2,false) ON CONFLICT DO NOTHING',
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

    return {
      id,
      capabilityId: input.capabilityId,
      text: input.text,
      status: input.status,
      confidence: input.confidence,
      supportingEvidenceCount: input.supportingEvidenceIds?.length ?? 0,
      contradictingEvidenceCount: input.contradictingEvidenceIds?.length ?? 0,
    };
  }

  async list(capabilityId?: string): Promise<ClaimRecord[]> {
    const { rows } = await getPool().query(
      `SELECT c.*,
              (SELECT count(*)::int FROM claim_evidence ce WHERE ce.claim_id = c.id AND ce.supports) AS supporting,
              (SELECT count(*)::int FROM claim_evidence ce WHERE ce.claim_id = c.id AND NOT ce.supports) AS contradicting
         FROM dacais_claims c
        ${capabilityId ? 'WHERE c.capability_id = $1' : ''}
        ORDER BY c.created_at DESC`,
      capabilityId ? [capabilityId] : [],
    );
    return rows.map((row) => ({
      id: row.id,
      capabilityId: row.capability_id ?? undefined,
      text: row.claim_text,
      status: row.status,
      confidence: row.confidence ?? undefined,
      supportingEvidenceCount: Number(row.supporting),
      contradictingEvidenceCount: Number(row.contradicting),
    }));
  }
}

// ---------------------------------------------------------------------------
// Evidence gaps
// ---------------------------------------------------------------------------

export interface EvidenceGap {
  capabilitySlug: string;
  capabilityName: string;
  status: string;
  reason: string;
  recommendedAction: string;
}

/**
 * Capabilities whose evidence does not support their claimed status.
 *
 * This is the diligence backlog: it is what an investor's technical partner
 * would find, produced before they find it.
 */
export function detectEvidenceGaps(
  capabilities: readonly Capability[],
  evidenceCounts: ReadonlyMap<string, number>,
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];

  for (const capability of capabilities) {
    const count = evidenceCounts.get(capability.id) ?? 0;

    if (count === 0) {
      gaps.push({
        capabilitySlug: capability.slug,
        capabilityName: capability.name,
        status: capability.status,
        reason: 'No evidence of any kind is attached.',
        recommendedAction:
          capability.operatorDeclared
            ? 'Point the evidence agent at the code, tests, or documents that demonstrate this, or retire the claim.'
            : 'Index the relevant source and re-run evidence collection.',
      });
      continue;
    }

    // A production claim resting on one artifact is thin. Two independent kinds
    // of evidence (code plus a test, or an implementation plus a benchmark) is
    // the minimum that survives a technical reviewer.
    if ((capability.status === 'PRODUCTION' || capability.status === 'WORKING_PROTOTYPE') && count < 2) {
      gaps.push({
        capabilitySlug: capability.slug,
        capabilityName: capability.name,
        status: capability.status,
        reason: `Claimed as ${capability.status} on a single piece of evidence.`,
        recommendedAction: 'Add a passing test or a measured benchmark so the claim rests on more than one artifact.',
      });
    }

    if (capability.demonstrable && capability.status !== 'PRODUCTION' && capability.status !== 'WORKING_PROTOTYPE') {
      gaps.push({
        capabilitySlug: capability.slug,
        capabilityName: capability.name,
        status: capability.status,
        reason: 'Marked demonstrable but not at working-prototype status.',
        recommendedAction: 'Either demonstrate it end to end and promote it, or clear the demonstrable flag.',
      });
    }
  }

  return gaps;
}
