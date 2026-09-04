import { createId, getPool, type PoolClient } from '@dacai-local-agent/shared';
import { sanitizeText } from '@dacai-local-agent/security';
import {
  INVESTMENT_EXTRACTION_SCHEMA_VERSION,
  InvestmentFactExtractor,
  isCalendarDate,
  normalizeEvidenceText,
  stageExtractionClaims,
  type ExtractionClaimStage,
  type ExtractedEntityMention,
  type ExtractedInvestmentFact,
  type InvestmentExtraction,
  type InvestmentExtractionResult,
} from './investment-extraction.js';
import {
  normalizeEntityIdentifier,
  normalizeEntityName,
  resolveEntityMentions,
  stageEntityResolutionAudit,
  type EntityResolutionContext,
  type EntityResolutionDecision,
  type ResolutionAliasRecord,
  type ResolutionEntityRecord,
  type ResolutionIdentifierRecord,
} from './entity-resolution.js';
import { slugify } from './entities.js';
import {
  InvestmentGraphStore,
  type InvestmentPersistenceResult,
  type ResolvedEntityRelationship,
  type ResolvedFundingRound,
  type ResolvedInvestmentFacts,
  type ResolvedSectorAssignment,
} from './investment-store.js';

export const INVESTMENT_PIPELINE_STALE_AFTER_SECONDS = 15 * 60;

export type InvestmentSignalExtractionStatus =
  | 'pending'
  | 'validated'
  | 'ambiguous'
  | 'rejected'
  | 'persisted'
  | 'no_facts'
  | 'failed';

interface PipelineSignal {
  id: string;
  sourceUrl: string;
  title?: string;
  excerpt: string;
  publishedAt?: string;
}

interface SignalClaim {
  acquired: boolean;
  status: InvestmentSignalExtractionStatus;
  startedAt?: string;
}

export interface InvestmentSignalPipelineResult {
  signalId: string;
  schemaVersion: string;
  status: InvestmentSignalExtractionStatus;
  skipped: boolean;
  attemptStartedAt?: string;
  claimCount: number;
  persistedCount: number;
  resolution?: {
    matched: number;
    proposed: number;
    ambiguous: number;
    rejected: number;
  };
  persistence?: InvestmentPersistenceResult;
  error?: string;
}

export interface InvestmentBatchResult {
  entityId: string;
  schemaVersion: string;
  considered: number;
  processed: number;
  persisted: number;
  noFacts: number;
  ambiguous: number;
  rejected: number;
  failed: number;
  skipped: number;
  results: InvestmentSignalPipelineResult[];
}

export interface InvestmentPipelineOptions {
  staleAfterSeconds?: number;
}

class PipelineResolutionAmbiguity extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineResolutionAmbiguity';
  }
}

/**
 * Durable orchestration for one versioned extraction contract.
 *
 * Model work happens outside a database transaction. The short final
 * transaction stages claims, resolves/creates only referenced entities, writes
 * all canonical facts through InvestmentGraphStore, and advances the durable
 * signal boundary atomically. A stale-attempt token prevents an older worker
 * from completing over a newer retry.
 */
export class InvestmentPipeline {
  private readonly pool: ReturnType<typeof getPool>;
  private readonly staleAfterSeconds: number;

  constructor(
    private readonly extractor: InvestmentFactExtractor,
    private readonly store = new InvestmentGraphStore(),
    options: InvestmentPipelineOptions = {},
    pool: ReturnType<typeof getPool> = getPool(),
  ) {
    this.pool = pool;
    this.staleAfterSeconds = Math.max(60, Math.min(options.staleAfterSeconds ?? INVESTMENT_PIPELINE_STALE_AFTER_SECONDS, 86_400));
  }

  async processSignal(signalId: string, options: { signal?: AbortSignal } = {}): Promise<InvestmentSignalPipelineResult> {
    const claim = await this.claimSignal(signalId);
    if (!claim.acquired || !claim.startedAt) {
      return {
        signalId,
        schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
        status: claim.status,
        skipped: true,
        claimCount: 0,
        persistedCount: 0,
      };
    }

    try {
      const signal = await this.loadSignal(signalId);
      const extraction = await this.extractor.extract(signal, { signal: options.signal });
      return await this.finalize(signal, claim.startedAt, extraction);
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.markFailed(signalId, claim.startedAt, message);
      return {
        signalId,
        schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
        status: 'failed',
        skipped: false,
        attemptStartedAt: claim.startedAt,
        claimCount: 0,
        persistedCount: 0,
        error: message,
      };
    }
  }

  /** Process only missing/retryable signals attached to one tracked entity. */
  async processUnprocessedEntitySignals(input: {
    entityId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<InvestmentBatchResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT s.id
         FROM intelligence_signals s
         JOIN signal_entities se ON se.signal_id = s.id
         LEFT JOIN intelligence_signal_extractions extraction
           ON extraction.signal_id = s.id
          AND extraction.schema_version = $2
        WHERE se.entity_id = $1
          AND (
            extraction.signal_id IS NULL
            OR extraction.status IN ('failed', 'validated')
            OR (
              extraction.status = 'pending'
              AND extraction.started_at < now() - ($3 || ' seconds')::interval
            )
          )
        ORDER BY coalesce(s.published_at, s.retrieved_at), s.id
        LIMIT $4`,
      [input.entityId, INVESTMENT_EXTRACTION_SCHEMA_VERSION, String(this.staleAfterSeconds), limit],
    );

    const results: InvestmentSignalPipelineResult[] = [];
    for (const row of rows) {
      if (input.signal?.aborted) break;
      results.push(await this.processSignal(row.id, { signal: input.signal }));
    }

    return {
      entityId: input.entityId,
      schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
      considered: rows.length,
      processed: results.filter((result) => !result.skipped).length,
      persisted: results.filter((result) => result.status === 'persisted').length,
      noFacts: results.filter((result) => result.status === 'no_facts').length,
      ambiguous: results.filter((result) => result.status === 'ambiguous').length,
      rejected: results.filter((result) => result.status === 'rejected').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.skipped).length,
      results,
    };
  }

  private async claimSignal(signalId: string): Promise<SignalClaim> {
    const inserted = await this.pool.query<{ status: InvestmentSignalExtractionStatus; started_at: Date }>(
      `INSERT INTO intelligence_signal_extractions (
         signal_id, schema_version, status, attempt_count, started_at
       ) VALUES ($1,$2,'pending',1,date_trunc('milliseconds', now()))
       ON CONFLICT (signal_id, schema_version) DO NOTHING
       RETURNING status, started_at`,
      [signalId, INVESTMENT_EXTRACTION_SCHEMA_VERSION],
    );
    if (inserted.rows[0]) {
      return { acquired: true, status: 'pending', startedAt: inserted.rows[0].started_at.toISOString() };
    }

    const retried = await this.pool.query<{ status: InvestmentSignalExtractionStatus; started_at: Date }>(
      `UPDATE intelligence_signal_extractions
          SET status = 'pending',
              attempt_count = attempt_count + 1,
              claim_count = 0,
              persisted_count = 0,
              error = NULL,
              extractor_model = NULL,
              provider_instance_id = NULL,
              started_at = date_trunc('milliseconds', now()),
              completed_at = NULL,
              updated_at = now(),
              metadata = metadata || jsonb_build_object('retry', true)
        WHERE signal_id = $1
          AND schema_version = $2
          AND (
            status IN ('failed', 'validated')
            OR (status = 'pending' AND started_at < now() - ($3 || ' seconds')::interval)
          )
       RETURNING status, started_at`,
      [signalId, INVESTMENT_EXTRACTION_SCHEMA_VERSION, String(this.staleAfterSeconds)],
    );
    if (retried.rows[0]) {
      return { acquired: true, status: 'pending', startedAt: retried.rows[0].started_at.toISOString() };
    }

    const current = await this.pool.query<{ status: InvestmentSignalExtractionStatus }>(
      `SELECT status FROM intelligence_signal_extractions WHERE signal_id = $1 AND schema_version = $2`,
      [signalId, INVESTMENT_EXTRACTION_SCHEMA_VERSION],
    );
    return { acquired: false, status: current.rows[0]?.status ?? 'failed' };
  }

  private async loadSignal(signalId: string): Promise<PipelineSignal> {
    const { rows } = await this.pool.query<{
      id: string;
      source_url: string;
      title: string | null;
      excerpt: string;
      published_at: Date | null;
    }>(
      `SELECT id, source_url, title, excerpt, published_at
         FROM intelligence_signals
        WHERE id = $1`,
      [signalId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Unknown intelligence signal "${signalId}".`);
    return {
      id: row.id,
      sourceUrl: row.source_url,
      title: row.title ?? undefined,
      excerpt: row.excerpt,
      publishedAt: row.published_at?.toISOString(),
    };
  }

  private async finalize(
    signal: PipelineSignal,
    startedAt: string,
    extractionResult: InvestmentExtractionResult,
  ): Promise<InvestmentSignalPipelineResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ status: InvestmentSignalExtractionStatus; started_at: Date }>(
        `SELECT status, started_at
           FROM intelligence_signal_extractions
          WHERE signal_id = $1 AND schema_version = $2
          FOR UPDATE`,
        [signal.id, INVESTMENT_EXTRACTION_SCHEMA_VERSION],
      );
      const row = current.rows[0];
      if (!row || row.status !== 'pending' || row.started_at.toISOString() !== startedAt) {
        await client.query('ROLLBACK');
        return {
          signalId: signal.id,
          schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
          status: row?.status ?? 'failed',
          skipped: true,
          claimCount: 0,
          persistedCount: 0,
        };
      }

      // A retry can replace only non-persisted audit rows for the same schema.
      await client.query(
        `DELETE FROM intelligence_extraction_claims
          WHERE signal_id = $1 AND schema_version = $2 AND validation_status <> 'persisted'`,
        [signal.id, INVESTMENT_EXTRACTION_SCHEMA_VERSION],
      );

      if (!extractionResult.validation.valid) {
        const rejectedStages = extractionResult.stagedClaims;
        await insertClaimStages(client, rejectedStages, 'rejected');
        const reason = extractionResult.validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ');
        await completeExtraction(client, {
          signalId: signal.id,
          startedAt,
          status: 'rejected',
          model: extractionResult.model,
          providerInstanceId: extractionResult.providerInstanceId,
          claimCount: rejectedStages.length,
          persistedCount: 0,
          metadata: { validationIssues: extractionResult.validation.issues },
        });
        await client.query('COMMIT');
        return pipelineTerminalResult(signal.id, startedAt, 'rejected', rejectedStages.length, 0, reason);
      }

      const usedEntityRefs = collectUsedEntityRefs(extractionResult.extraction);
      const usedSectorRefs = collectUsedSectorRefs(extractionResult.extraction);
      const relevantStages = filterRelevantStages(extractionResult.stagedClaims, usedEntityRefs, usedSectorRefs);

      if (!extractionResult.extraction.fundingRounds.length && !extractionResult.extraction.facts.length) {
        await completeExtraction(client, {
          signalId: signal.id,
          startedAt,
          status: 'no_facts',
          model: extractionResult.model,
          providerInstanceId: extractionResult.providerInstanceId,
          claimCount: 0,
          persistedCount: 0,
          metadata: { noFactsReason: extractionResult.extraction.noFactsReason ?? 'No persistable investment facts.' },
        });
        await client.query('COMMIT');
        return pipelineTerminalResult(signal.id, startedAt, 'no_facts', 0, 0);
      }

      const participantConflict = conflictingRoundParticipantReason(extractionResult.extraction);
      if (participantConflict) {
        await insertClaimStages(client, relevantStages, 'rejected', participantConflict);
        await completeExtraction(client, {
          signalId: signal.id,
          startedAt,
          status: 'rejected',
          model: extractionResult.model,
          providerInstanceId: extractionResult.providerInstanceId,
          claimCount: relevantStages.length,
          persistedCount: 0,
          metadata: { validationReason: participantConflict },
        });
        await client.query('COMMIT');
        return pipelineTerminalResult(signal.id, startedAt, 'rejected', relevantStages.length, 0, participantConflict);
      }

      const claimIds = await insertClaimStages(client, relevantStages, 'validated');
      const usedMentions = extractionResult.extraction.entities
        .filter((mention) => usedEntityRefs.has(mention.ref))
        .map((mention) => withOnlyStrongIdentifiers(mention, signal));
      const resolutionContext = await loadResolutionContext(client, usedMentions);
      const publicProfessionalPersonRefs = collectPublicProfessionalPersonRefs(extractionResult.extraction);
      const resolution = resolveUsedEntityMentions(
        usedMentions,
        resolutionContext,
        publicProfessionalPersonRefs,
      );
      const audits = usedMentions.map((mention) =>
        stageEntityResolutionAudit(mention, resolution.decisions.get(mention.ref)!),
      );
      const weakIdentifierCollision = findUnverifiedIdentifierCollision(
        usedMentions,
        resolution.decisions,
        resolutionContext.identifiers ?? [],
      );

      if (!resolution.complete || weakIdentifierCollision) {
        const status: InvestmentSignalExtractionStatus =
          resolution.ambiguous > 0 || weakIdentifierCollision ? 'ambiguous' : 'rejected';
        const reason = weakIdentifierCollision ?? audits
          .filter((audit) => audit.decisionStatus === 'ambiguous' || audit.decisionStatus === 'rejected')
          .map((audit) => `${audit.mentionRef}: ${audit.reason}`)
          .join('; ');
        await updateClaimsStatus(client, [...claimIds.values()], status, reason);
        await completeExtraction(client, {
          signalId: signal.id,
          startedAt,
          status,
          model: extractionResult.model,
          providerInstanceId: extractionResult.providerInstanceId,
          claimCount: relevantStages.length,
          persistedCount: 0,
          metadata: { resolution: audits },
        });
        await client.query('COMMIT');
        return {
          ...pipelineTerminalResult(signal.id, startedAt, status, relevantStages.length, 0, reason),
          resolution: summarizeResolution(resolution),
        };
      }

      await client.query('SAVEPOINT canonical_changes');
      try {
        const entityIds = await materializeResolvedEntities(
          client,
          usedMentions,
          resolution.decisions,
          signal,
        );
        const facts = await buildResolvedFacts(
          client,
          extractionResult.extraction,
          signal,
          entityIds,
          relevantStages,
          claimIds,
        );
        const persistence = await this.store.persist(facts, client);
        await updateClaimsStatus(client, [...claimIds.values()], 'persisted');
        await completeExtraction(client, {
          signalId: signal.id,
          startedAt,
          status: 'persisted',
          model: extractionResult.model,
          providerInstanceId: extractionResult.providerInstanceId,
          claimCount: relevantStages.length,
          persistedCount: relevantStages.length,
          metadata: { resolution: audits, persistence },
        });
        await client.query('RELEASE SAVEPOINT canonical_changes');
        await client.query('COMMIT');
        return {
          signalId: signal.id,
          schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
          status: 'persisted',
          skipped: false,
          attemptStartedAt: startedAt,
          claimCount: relevantStages.length,
          persistedCount: relevantStages.length,
          resolution: summarizeResolution(resolution),
          persistence,
        };
      } catch (error) {
        if (!(error instanceof PipelineResolutionAmbiguity)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT canonical_changes');
        const reason = safeErrorMessage(error);
        await updateClaimsStatus(client, [...claimIds.values()], 'ambiguous', reason);
        await completeExtraction(client, {
          signalId: signal.id,
          startedAt,
          status: 'ambiguous',
          model: extractionResult.model,
          providerInstanceId: extractionResult.providerInstanceId,
          claimCount: relevantStages.length,
          persistedCount: 0,
          metadata: { resolution: audits, materializationAmbiguity: reason },
        });
        await client.query('COMMIT');
        return {
          ...pipelineTerminalResult(signal.id, startedAt, 'ambiguous', relevantStages.length, 0, reason),
          resolution: summarizeResolution(resolution),
        };
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async markFailed(signalId: string, startedAt: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE intelligence_signal_extractions
          SET status = 'failed', error = $4, completed_at = now(), updated_at = now()
        WHERE signal_id = $1 AND schema_version = $2 AND status = 'pending' AND started_at = $3`,
      [signalId, INVESTMENT_EXTRACTION_SCHEMA_VERSION, startedAt, message],
    );
  }
}

interface CompletionInput {
  signalId: string;
  startedAt: string;
  status: Exclude<InvestmentSignalExtractionStatus, 'pending'>;
  model: string;
  providerInstanceId: string;
  claimCount: number;
  persistedCount: number;
  metadata: Record<string, unknown>;
}

async function completeExtraction(client: PoolClient, input: CompletionInput): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE intelligence_signal_extractions
        SET status = $4,
            extractor_model = $5,
            provider_instance_id = $6,
            claim_count = $7,
            persisted_count = $8,
            error = NULL,
            completed_at = now(),
            updated_at = now(),
            metadata = metadata || $9::jsonb
      WHERE signal_id = $1 AND schema_version = $2 AND status = 'pending' AND started_at = $3`,
    [
      input.signalId,
      INVESTMENT_EXTRACTION_SCHEMA_VERSION,
      input.startedAt,
      input.status,
      input.model,
      input.providerInstanceId,
      input.claimCount,
      input.persistedCount,
      JSON.stringify(input.metadata),
    ],
  );
  if (rowCount !== 1) throw new Error('The extraction attempt lost ownership before completion.');
}

async function insertClaimStages(
  client: PoolClient,
  stages: readonly ExtractionClaimStage[],
  status: 'validated' | 'rejected',
  reason?: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const stage of stages) {
    const validationReason = reason ?? stage.validationReason;
    const { rows } = await client.query<{ id: string; claim_fingerprint: string }>(
      `INSERT INTO intelligence_extraction_claims (
         id, signal_id, schema_version, claim_kind, claim_fingerprint, payload,
         evidence_text, extraction_confidence, validation_status,
         validation_reason, extractor_model, provider_instance_id, validated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (signal_id, schema_version, claim_fingerprint) DO UPDATE SET
         payload = EXCLUDED.payload,
         evidence_text = EXCLUDED.evidence_text,
         extraction_confidence = EXCLUDED.extraction_confidence,
         validation_status = EXCLUDED.validation_status,
         validation_reason = EXCLUDED.validation_reason,
         extractor_model = EXCLUDED.extractor_model,
         provider_instance_id = EXCLUDED.provider_instance_id,
         validated_at = now(),
         persisted_at = NULL
       RETURNING id, claim_fingerprint`,
      [
        createId('xcl'),
        stage.signalId,
        INVESTMENT_EXTRACTION_SCHEMA_VERSION,
        stage.claimKind,
        stage.claimFingerprint,
        JSON.stringify(stage.payload),
        stage.evidenceText,
        status === 'validated' ? 1 : 0,
        status,
        validationReason ?? null,
        stage.extractorModel,
        stage.providerInstanceId,
      ],
    );
    ids.set(rows[0].claim_fingerprint, rows[0].id);
  }
  return ids;
}

async function updateClaimsStatus(
  client: PoolClient,
  claimIds: readonly string[],
  status: 'ambiguous' | 'rejected' | 'persisted',
  reason?: string,
): Promise<void> {
  if (!claimIds.length) return;
  await client.query(
    `UPDATE intelligence_extraction_claims
        SET validation_status = $2,
            validation_reason = $3,
            validated_at = COALESCE(validated_at, now()),
            persisted_at = CASE WHEN $2 = 'persisted' THEN now() ELSE NULL END
      WHERE id = ANY($1::text[])`,
    [[...claimIds], status, reason ?? null],
  );
}

function collectUsedEntityRefs(extraction: InvestmentExtraction): Set<string> {
  const refs = new Set(extraction.fundingRounds.map((round) => round.companyRef));
  for (const fact of extraction.facts) {
    switch (fact.kind) {
      case 'round_participant': refs.add(fact.participantRef); break;
      case 'partner_at': refs.add(fact.personRef); refs.add(fact.firmRef); break;
      case 'worked_at': refs.add(fact.personRef); refs.add(fact.organizationRef); break;
      case 'founded': refs.add(fact.founderRef); refs.add(fact.companyRef); break;
      case 'invested_in': refs.add(fact.investorRef); refs.add(fact.companyRef); break;
      case 'board_member_of': refs.add(fact.personRef); refs.add(fact.organizationRef); break;
      case 'operates_in':
      case 'uses_technology':
      case 'interested_in': refs.add(fact.entityRef); break;
    }
  }
  return refs;
}

function collectUsedSectorRefs(extraction: InvestmentExtraction): Set<string> {
  return new Set(extraction.facts.flatMap((fact) =>
    fact.kind === 'operates_in' || fact.kind === 'uses_technology' || fact.kind === 'interested_in'
      ? [fact.sectorRef]
      : [],
  ));
}

function filterRelevantStages(
  stages: readonly ExtractionClaimStage[],
  usedEntityRefs: ReadonlySet<string>,
  usedSectorRefs: ReadonlySet<string>,
): ExtractionClaimStage[] {
  return stages.filter((stage) => {
    if (stage.claimKind === 'entity_mention') return usedEntityRefs.has(String(stage.payload.ref));
    if (stage.claimKind === 'sector_mention') return usedSectorRefs.has(String(stage.payload.ref));
    return true;
  });
}

function withOnlyStrongIdentifiers(mention: ExtractedEntityMention, signal: PipelineSignal): ExtractedEntityMention {
  const normalizedEvidence = normalizeEvidenceText(mention.evidenceQuote);
  let sourceUrl: string | undefined;
  let sourceDomain: string | undefined;
  let sourceHostNamesMention = false;
  let sourcePathNamesMention = false;
  try {
    sourceUrl = normalizeEntityIdentifier('website_url', signal.sourceUrl);
    const parsedSource = new URL(signal.sourceUrl);
    sourceDomain = normalizeEntityIdentifier('domain', parsedSource.hostname);
    sourceHostNamesMention = urlHostNamesMention(parsedSource, mention.displayName);
    sourcePathNamesMention = urlHasExactNamedPath(parsedSource, mention.displayName);
  } catch {
    // Source admission already requires a URL; refusing promotion is safer if a legacy row is malformed.
  }

  return {
    ...mention,
    identifiers: mention.identifiers.filter((identifier) => {
      const normalized = normalizeEntityIdentifier(identifier.kind, identifier.value);
      if (!normalized) return false;
      const explicitlyPrinted = normalizedEvidence.includes(normalizeEvidenceText(identifier.value));
      const exactOwnUrl = identifier.kind === 'website_url'
        && normalized === sourceUrl
        && (sourceHostNamesMention || sourcePathNamesMention);
      const exactOwnLinkedIn = identifier.kind === 'linkedin_url'
        && normalized === normalizeEntityIdentifier('linkedin_url', signal.sourceUrl)
        && sourcePathNamesMention;
      // A named profile path can establish a person's exact profile URL, but
      // never ownership of the employer/publisher's entire domain.
      const exactOwnDomain = identifier.kind === 'domain'
        && normalized === sourceDomain
        && sourceHostNamesMention;
      return explicitlyPrinted || exactOwnUrl || exactOwnLinkedIn || exactOwnDomain;
    }),
  };
}

const ENTITY_NAME_SUFFIXES = new Set([
  'co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'llp',
  'lp', 'ltd', 'limited', 'plc',
]);

function identifyingNameTokens(displayName: string): string[] {
  const tokens = normalizeEntityName(displayName).split(' ').filter(Boolean);
  const withoutSuffixes = tokens.filter((token) => !ENTITY_NAME_SUFFIXES.has(token));
  return withoutSuffixes.length ? withoutSuffixes : tokens;
}

function urlHostNamesMention(url: URL, displayName: string): boolean {
  const nameTokens = identifyingNameTokens(displayName);
  if (!nameTokens.length) return false;
  const host = url.hostname.toLocaleLowerCase('en-US').replace(/^www\./, '');
  const compactHost = host.replace(/[^a-z0-9]/g, '');
  const compactName = nameTokens.join('');
  return compactName.length >= 3 && compactHost.includes(compactName);
}

function urlHasExactNamedPath(url: URL, displayName: string): boolean {
  const nameTokens = identifyingNameTokens(displayName);
  if (!nameTokens.length) return false;
  const compactName = nameTokens.join('');
  let segments: string[];
  try {
    segments = decodeURIComponent(url.pathname).split('/');
  } catch {
    segments = url.pathname.split('/');
  }
  return segments.some((segment) => {
    const compactSegment = normalizeEntityName(segment).replace(/ /g, '');
    return compactSegment.length >= 3 && compactSegment === compactName;
  });
}

function collectPublicProfessionalPersonRefs(extraction: InvestmentExtraction): Set<string> {
  const refs = new Set<string>();
  for (const fact of extraction.facts) {
    switch (fact.kind) {
      case 'round_participant':
        if (fact.participantType === 'person') refs.add(fact.participantRef);
        break;
      case 'partner_at': refs.add(fact.personRef); break;
      case 'worked_at': refs.add(fact.personRef); break;
      case 'founded': refs.add(fact.founderRef); break;
      case 'invested_in': refs.add(fact.investorRef); break;
      case 'board_member_of': refs.add(fact.personRef); break;
      case 'interested_in': refs.add(fact.entityRef); break;
      case 'operates_in':
      case 'uses_technology':
        break;
    }
  }
  return refs;
}

function resolveUsedEntityMentions(
  mentions: readonly ExtractedEntityMention[],
  context: EntityResolutionContext,
  publicProfessionalPersonRefs: ReadonlySet<string>,
): ReturnType<typeof resolveEntityMentions> {
  const decisions = new Map<string, EntityResolutionDecision>();
  let matched = 0;
  let proposed = 0;
  let ambiguous = 0;
  let rejected = 0;

  for (const mention of mentions) {
    const one = resolveEntityMentions([mention], {
      ...context,
      isPublicProfessionalSubject: mention.entityType === 'person'
        && publicProfessionalPersonRefs.has(mention.ref),
    });
    const decision = one.decisions.get(mention.ref);
    if (!decision) throw new Error(`Entity resolver returned no decision for local ref "${mention.ref}".`);
    decisions.set(mention.ref, decision);
    matched += one.matched;
    proposed += one.proposed;
    ambiguous += one.ambiguous;
    rejected += one.rejected;
  }

  return {
    decisions,
    matched,
    proposed,
    ambiguous,
    rejected,
    complete: ambiguous === 0 && rejected === 0,
  };
}

async function loadResolutionContext(
  client: PoolClient,
  mentions: readonly ExtractedEntityMention[],
): Promise<EntityResolutionContext> {
  const names = [...new Set(mentions.map((mention) => normalizeEntityName(mention.displayName)))];
  const normalizedIdentifiers = mentions.flatMap((mention) => mention.identifiers.flatMap((identifier) => {
    const normalized = normalizeEntityIdentifier(identifier.kind, identifier.value);
    return normalized ? [{ kind: identifier.kind, value: normalized }] : [];
  }));
  const kinds = [...new Set(normalizedIdentifiers.map((identifier) => identifier.kind))];
  const values = [...new Set(normalizedIdentifiers.map((identifier) => identifier.value))];

  const aliases = await client.query<{
    entity_id: string;
    alias: string;
    normalized_alias: string;
    verified: boolean;
  }>(
    `SELECT entity_id, alias, normalized_alias, verified
       FROM intelligence_entity_aliases
      WHERE normalized_alias = ANY($1::text[])`,
    [names],
  );
  const identifiers = kinds.length && values.length
    ? await client.query<{
        entity_id: string;
        identifier_kind: ResolutionIdentifierRecord['identifierKind'];
        raw_value: string;
        normalized_value: string;
        verified: boolean;
      }>(
        `SELECT entity_id, identifier_kind, raw_value, normalized_value, verified
           FROM intelligence_entity_identifiers
          WHERE identifier_kind = ANY($1::text[]) AND normalized_value = ANY($2::text[])`,
        [kinds, values],
      )
    : { rows: [] };
  const referencedIds = [...new Set([
    ...aliases.rows.map((row) => row.entity_id),
    ...identifiers.rows.map((row) => row.entity_id),
  ])];
  const entities = await client.query<{
    id: string;
    entity_type: ResolutionEntityRecord['entityType'];
    display_name: string;
    normalized_name: string;
  }>(
    `SELECT id, entity_type, display_name, normalized_name
       FROM intelligence_entities
      WHERE normalized_name = ANY($1::text[]) OR id = ANY($2::text[])`,
    [names, referencedIds],
  );

  return {
    entities: entities.rows.map((row): ResolutionEntityRecord => ({
      id: row.id,
      entityType: row.entity_type,
      displayName: row.display_name,
      normalizedName: row.normalized_name,
    })),
    aliases: aliases.rows.map((row): ResolutionAliasRecord => ({
      entityId: row.entity_id,
      alias: row.alias,
      normalizedAlias: row.normalized_alias,
      verified: row.verified,
    })),
    identifiers: identifiers.rows.map((row): ResolutionIdentifierRecord => ({
      entityId: row.entity_id,
      identifierKind: row.identifier_kind,
      rawValue: row.raw_value,
      normalizedValue: row.normalized_value,
      verified: row.verified,
    })),
  };
}

function findUnverifiedIdentifierCollision(
  mentions: readonly ExtractedEntityMention[],
  decisions: ReadonlyMap<string, EntityResolutionDecision>,
  identifiers: readonly ResolutionIdentifierRecord[],
): string | undefined {
  for (const mention of mentions) {
    const decision = decisions.get(mention.ref)!;
    for (const candidate of mention.identifiers) {
      const normalized = normalizeEntityIdentifier(candidate.kind, candidate.value);
      const collisions = identifiers.filter((stored) =>
        !stored.verified && stored.identifierKind === candidate.kind && stored.normalizedValue === normalized,
      );
      for (const collision of collisions) {
        if (decision.status !== 'matched' || decision.entityId !== collision.entityId) {
          return `Unverified exact ${candidate.kind} identifier already belongs to candidate entity ${collision.entityId}; manual resolution is required.`;
        }
      }
    }
  }
  return undefined;
}

async function materializeResolvedEntities(
  client: PoolClient,
  mentions: readonly ExtractedEntityMention[],
  decisions: ReadonlyMap<string, EntityResolutionDecision>,
  signal: PipelineSignal,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const mention of mentions) {
    const decision = decisions.get(mention.ref)!;
    let entityId: string;
    if (decision.status === 'matched') {
      entityId = decision.entityId;
    } else if (decision.status === 'create') {
      entityId = await createEntity(client, decision.proposal, signal.id);
    } else {
      throw new PipelineResolutionAmbiguity(`Cannot materialize ${mention.ref}: ${decision.status}.`);
    }
    ids.set(mention.ref, entityId);
    await upsertObservedAlias(client, entityId, mention, signal.id, decision.status === 'create' ? 'canonical' : 'common');
    for (const identifier of mention.identifiers) {
      await upsertStrongIdentifier(client, entityId, identifier.kind, identifier.value, signal.id);
    }
    await client.query(
      `INSERT INTO signal_entities (signal_id, entity_id, attribution)
       VALUES ($1,$2,'named')
       ON CONFLICT (signal_id, entity_id) DO UPDATE SET attribution = 'named'`,
      [signal.id, entityId],
    );
  }
  return ids;
}

async function createEntity(
  client: PoolClient,
  proposal: Extract<EntityResolutionDecision, { status: 'create' }>['proposal'],
  signalId: string,
): Promise<string> {
  const slug = slugify(proposal.canonicalName);
  const website = proposal.identifiers.find((identifier) => identifier.identifierKind === 'website_url')?.normalizedValue;
  const domain = proposal.identifiers.find((identifier) => identifier.identifierKind === 'domain')?.normalizedValue;
  const linkedin = proposal.identifiers.find((identifier) => identifier.identifierKind === 'linkedin_url')?.normalizedValue;
  const externalSlug = proposal.identifiers.find((identifier) => identifier.identifierKind === 'external_slug')?.normalizedValue;
  const id = createId('ent');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO intelligence_entities (
       id, entity_type, display_name, slug, canonical_name, normalized_name,
       primary_url, domain, linkedin_url, external_slug,
       is_public_professional, watch_enabled, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false,$11)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [
      id,
      proposal.entityType,
      proposal.canonicalName,
      slug,
      proposal.canonicalName,
      proposal.normalizedName,
      website ?? null,
      domain ?? null,
      linkedin ?? null,
      externalSlug ?? null,
      JSON.stringify({ createdBy: 'investment-pipeline', sourceSignalId: signalId }),
    ],
  );
  if (rows[0]) return rows[0].id;

  const existing = await client.query<{ id: string; entity_type: string; normalized_name: string }>(
    'SELECT id, entity_type, normalized_name FROM intelligence_entities WHERE slug = $1',
    [slug],
  );
  const row = existing.rows[0];
  if (row && row.entity_type === proposal.entityType && row.normalized_name === proposal.normalizedName) return row.id;
  throw new PipelineResolutionAmbiguity(`Entity slug "${slug}" collides with a different canonical entity.`);
}

async function upsertObservedAlias(
  client: PoolClient,
  entityId: string,
  mention: ExtractedEntityMention,
  signalId: string,
  aliasKind: 'canonical' | 'common',
): Promise<void> {
  const normalized = normalizeEntityName(mention.displayName);
  await client.query(
    `INSERT INTO intelligence_entity_aliases (
       id, entity_id, alias, normalized_alias, alias_kind, source_signal_id,
       confidence, verified, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,1,true,$7)
     ON CONFLICT (entity_id, normalized_alias) DO UPDATE SET
       source_signal_id = COALESCE(intelligence_entity_aliases.source_signal_id, EXCLUDED.source_signal_id),
       confidence = GREATEST(COALESCE(intelligence_entity_aliases.confidence, 0), 1),
       verified = true,
       last_observed_at = now(),
       metadata = intelligence_entity_aliases.metadata || EXCLUDED.metadata`,
    [
      createId('alias'), entityId, mention.displayName, normalized, aliasKind, signalId,
      JSON.stringify({ evidenceQuote: mention.evidenceQuote, resolver: 'exact-v1' }),
    ],
  );
}

async function upsertStrongIdentifier(
  client: PoolClient,
  entityId: string,
  kind: ExtractedEntityMention['identifiers'][number]['kind'],
  rawValue: string,
  signalId: string,
): Promise<void> {
  const normalized = normalizeEntityIdentifier(kind, rawValue);
  if (!normalized) return;
  const { rows } = await client.query<{ entity_id: string }>(
    `INSERT INTO intelligence_entity_identifiers (
       id, entity_id, identifier_kind, raw_value, normalized_value,
       source_signal_id, confidence, verified, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,1,true,$7)
     ON CONFLICT (identifier_kind, normalized_value) DO UPDATE SET
       source_signal_id = COALESCE(intelligence_entity_identifiers.source_signal_id, EXCLUDED.source_signal_id),
       confidence = GREATEST(COALESCE(intelligence_entity_identifiers.confidence, 0), 1),
       verified = true,
       last_observed_at = now(),
       metadata = intelligence_entity_identifiers.metadata || EXCLUDED.metadata
     WHERE intelligence_entity_identifiers.entity_id = EXCLUDED.entity_id
     RETURNING entity_id`,
    [
      createId('eid'), entityId, kind, rawValue, normalized, signalId,
      JSON.stringify({ resolver: 'exact-v1' }),
    ],
  );
  if (!rows[0]) {
    throw new PipelineResolutionAmbiguity(`Strong exact ${kind} identifier is already assigned to another entity.`);
  }
}

async function buildResolvedFacts(
  client: PoolClient,
  extraction: InvestmentExtraction,
  signal: PipelineSignal,
  entityIds: ReadonlyMap<string, string>,
  stages: readonly ExtractionClaimStage[],
  claimIds: ReadonlyMap<string, string>,
): Promise<ResolvedInvestmentFacts> {
  const roundStages = stages.filter((stage) => stage.claimKind === 'funding_round');
  const factStages = stages.filter((stage) => !['entity_mention', 'sector_mention', 'funding_round'].includes(stage.claimKind));
  const provenanceFor = (stage: ExtractionClaimStage, evidenceText: string) => ({
    signalId: signal.id,
    evidenceText,
    extractionClaimId: claimIds.get(stage.claimFingerprint),
  });

  const rounds: ResolvedFundingRound[] = extraction.fundingRounds.map((round, index) => {
    const stage = roundStages[index];
    if (!stage) throw new Error(`Missing staged funding-round claim for ${round.ref}.`);
    const evidenceAnnouncedOn = round.announcedOn === undefined
      ? parseExplicitRoundDateFromEvidence(round.evidenceQuote)
      : undefined;
    const announcedOn = round.announcedOn ?? evidenceAnnouncedOn;
    const participants = extraction.facts.flatMap((fact, factIndex) => {
      if (fact.kind !== 'round_participant' || fact.roundRef !== round.ref) return [];
      const factStage = factStages[factIndex];
      if (!factStage) throw new Error(`Missing staged participant claim for ${fact.participantRef}.`);
      return [{
        entityId: requireResolvedEntity(entityIds, fact.participantRef),
        participantType: fact.participantType,
        role: fact.role,
        leadStatus: fact.leadStatus,
        assertionClass: 'observed' as const,
        provenance: provenanceFor(factStage, fact.evidenceQuote),
        metadata: { localRef: fact.participantRef, schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION },
      }];
    });
    return {
      companyEntityId: requireResolvedEntity(entityIds, round.companyRef),
      claimFingerprint: stage.claimFingerprint,
      roundType: round.roundType,
      announcedAt: announcedOn ? calendarDateToInstant(announcedOn) : undefined,
      amount: round.money ? parseSafeMoney(round.money.amount) : undefined,
      currency: round.money?.currency,
      assertionClass: 'observed',
      provenance: provenanceFor(stage, round.evidenceQuote),
      participants,
      metadata: {
        localRef: round.ref,
        sourceLabel: round.sourceLabel,
        amountSourceText: round.money?.sourceText,
        announcedOnSource: round.announcedOn
          ? 'extracted'
          : evidenceAnnouncedOn
            ? 'evidence_quote_parser'
            : undefined,
        schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
      },
    };
  });

  extraction.facts.forEach((fact, index) => {
    if (fact.kind !== 'invested_in') return;
    const stage = factStages[index];
    if (!stage) throw new Error(`Missing staged direct-investment claim for ${fact.investorRef}.`);
    const investor = extraction.entities.find((entity) => entity.ref === fact.investorRef)!;
    rounds.push({
      companyEntityId: requireResolvedEntity(entityIds, fact.companyRef),
      claimFingerprint: stage.claimFingerprint,
      roundType: fact.roundType ?? 'unknown',
      announcedAt: fact.announcedOn ? calendarDateToInstant(fact.announcedOn) : undefined,
      assertionClass: 'observed',
      provenance: provenanceFor(stage, fact.evidenceQuote),
      participants: [{
        entityId: requireResolvedEntity(entityIds, fact.investorRef),
        participantType: investor.entityType as 'investment_firm' | 'person',
        role: 'unknown',
        leadStatus: 'unknown',
        assertionClass: 'observed',
        provenance: provenanceFor(stage, fact.evidenceQuote),
        metadata: { syntheticFromDirectInvestment: true },
      }],
      metadata: {
        syntheticFromDirectInvestment: true,
        schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
      },
    });
  });

  const relationships: ResolvedEntityRelationship[] = [];
  const sectors: ResolvedSectorAssignment[] = [];
  for (const [index, fact] of extraction.facts.entries()) {
    const stage = factStages[index];
    if (!stage) throw new Error(`Missing staged claim for fact ${index}.`);
    const provenance = provenanceFor(stage, fact.evidenceQuote);
    switch (fact.kind) {
      case 'partner_at':
        relationships.push({
          fromEntityId: requireResolvedEntity(entityIds, fact.personRef),
          toEntityId: requireResolvedEntity(entityIds, fact.firmRef),
          relationship: 'partner_at', assertionClass: 'observed',
          validFrom: fact.startedOn, validTo: fact.endedOn,
          rationale: 'Explicit public professional affiliation.', provenance,
          metadata: { title: fact.title },
        });
        break;
      case 'worked_at':
        relationships.push({
          fromEntityId: requireResolvedEntity(entityIds, fact.personRef),
          toEntityId: requireResolvedEntity(entityIds, fact.organizationRef),
          relationship: 'worked_at', assertionClass: 'observed',
          validFrom: fact.startedOn, validTo: fact.endedOn,
          rationale: 'Explicit public professional employment history.', provenance,
          metadata: { title: fact.title, employmentStatus: fact.employmentStatus },
        });
        break;
      case 'founded':
        relationships.push({
          fromEntityId: requireResolvedEntity(entityIds, fact.founderRef),
          toEntityId: requireResolvedEntity(entityIds, fact.companyRef),
          relationship: 'founded', assertionClass: 'observed',
          effectiveAt: fact.foundedOn ? calendarDateToInstant(fact.foundedOn) : undefined,
          rationale: 'Explicit public founding relationship.', provenance,
        });
        break;
      case 'board_member_of':
        relationships.push({
          fromEntityId: requireResolvedEntity(entityIds, fact.personRef),
          toEntityId: requireResolvedEntity(entityIds, fact.organizationRef),
          relationship: 'board_member_of', assertionClass: 'observed',
          validFrom: fact.startedOn, validTo: fact.endedOn,
          rationale: 'Explicit public board membership.', provenance,
        });
        break;
      case 'operates_in': {
        const sector = requireSector(extraction, fact.sectorRef);
        sectors.push({
          entityId: requireResolvedEntity(entityIds, fact.entityRef),
          sectorSlug: slugify(sector.label),
          sectorLabel: sector.label,
          sectorDescription: sector.description,
          assertionClass: 'observed',
          provenance,
          metadata: { sourceKind: sector.kind, schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION },
        });
        break;
      }
      case 'uses_technology':
      case 'interested_in': {
        const topic = requireSector(extraction, fact.sectorRef);
        const topicId = await upsertFreeFormTopic(client, signal.id, topic.label, topic.description);
        // InvestmentGraphStore's current narrow relationship input omits the
        // already-declared graph relationship interested_in. The pipeline
        // supplies only this explicit whitelisted value; arbitrary strings are
        // never accepted from model output.
        relationships.push({
          fromEntityId: requireResolvedEntity(entityIds, fact.entityRef),
          toTopicId: topicId,
          relationship: fact.kind as ResolvedEntityRelationship['relationship'],
          assertionClass: 'observed',
          rationale: fact.kind === 'uses_technology'
            ? 'Explicit source-supported technology usage.'
            : 'Explicit source-supported investment thesis or sector interest.',
          provenance,
          metadata: { sourceKind: topic.kind, schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION },
        });
        break;
      }
      case 'round_participant':
      case 'invested_in':
        break;
    }
  }

  return { rounds, relationships, sectors };
}

async function upsertFreeFormTopic(
  client: PoolClient,
  signalId: string,
  label: string,
  description?: string,
): Promise<string> {
  const slug = slugify(label);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO intelligence_topics (id, slug, label, description)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (slug) DO UPDATE SET
       description = COALESCE(intelligence_topics.description, EXCLUDED.description),
       updated_at = now()
     RETURNING id`,
    [createId('top'), slug, label, description ?? null],
  );
  await client.query(
    `INSERT INTO signal_topics (signal_id, topic_id, relevance, origins)
     VALUES ($1,$2,1,ARRAY['investment_fact']::text[])
     ON CONFLICT (signal_id, topic_id) DO UPDATE SET
       relevance = GREATEST(signal_topics.relevance, 1),
       origins = CASE
         WHEN 'investment_fact' = ANY(signal_topics.origins) THEN signal_topics.origins
         ELSE array_append(signal_topics.origins, 'investment_fact')
       END`,
    [signalId, rows[0].id],
  );
  return rows[0].id;
}

function requireResolvedEntity(ids: ReadonlyMap<string, string>, ref: string): string {
  const id = ids.get(ref);
  if (!id) throw new Error(`Local entity reference "${ref}" was not materialized.`);
  return id;
}

function requireSector(extraction: InvestmentExtraction, ref: string) {
  const sector = extraction.sectors.find((candidate) => candidate.ref === ref);
  if (!sector) throw new Error(`Local sector reference "${ref}" was not declared.`);
  return sector;
}

function conflictingRoundParticipantReason(extraction: InvestmentExtraction): string | undefined {
  const seen = new Map<string, Extract<ExtractedInvestmentFact, { kind: 'round_participant' }>>();
  for (const fact of extraction.facts) {
    if (fact.kind !== 'round_participant') continue;
    const key = `${fact.roundRef}\u0000${fact.participantRef}`;
    const previous = seen.get(key);
    if (previous && (previous.role !== fact.role || previous.leadStatus !== fact.leadStatus)) {
      return `Conflicting participation roles for ${fact.participantRef} in ${fact.roundRef}.`;
    }
    seen.set(key, fact);
  }
  return undefined;
}

function parseSafeMoney(value: string): number {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > 2) {
    throw new Error(`Disclosed amount "${value}" has precision smaller than the canonical currency unit.`);
  }
  const minorUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Disclosed amount "${value}" exceeds safe deterministic numeric precision.`);
  }
  return Number(minorUnits) / 100;
}

const ENGLISH_MONTH_NUMBERS: Readonly<Record<string, string>> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

/**
 * Recover a round date only from one explicit date token in that round's exact
 * evidence quote. Date-like but invalid tokens count as candidates, so a valid
 * date beside an invalid or second date is deliberately treated as ambiguous.
 */
export function parseExplicitRoundDateFromEvidence(evidenceQuote: string): string | undefined {
  const candidates: string[] = [];
  const isoPattern = /(?<![A-Za-z0-9_-])(\d{4}-\d{2}-\d{2})(?![A-Za-z0-9_-])/g;
  const englishPattern = /(?<![A-Za-z0-9_])(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})(?![A-Za-z0-9_])/gi;

  for (const match of evidenceQuote.matchAll(isoPattern)) {
    candidates.push(match[1]);
  }
  for (const match of evidenceQuote.matchAll(englishPattern)) {
    const month = ENGLISH_MONTH_NUMBERS[match[1].toLocaleLowerCase('en-US')];
    candidates.push(`${match[3]}-${month}-${match[2].padStart(2, '0')}`);
  }

  if (candidates.length !== 1) return undefined;
  return isCalendarDate(candidates[0]) ? candidates[0] : undefined;
}

function calendarDateToInstant(value: string): string {
  return `${value}T00:00:00.000Z`;
}

function summarizeResolution(resolution: ReturnType<typeof resolveEntityMentions>) {
  return {
    matched: resolution.matched,
    proposed: resolution.proposed,
    ambiguous: resolution.ambiguous,
    rejected: resolution.rejected,
  };
}

function pipelineTerminalResult(
  signalId: string,
  startedAt: string,
  status: InvestmentSignalExtractionStatus,
  claimCount: number,
  persistedCount: number,
  error?: string,
): InvestmentSignalPipelineResult {
  return {
    signalId,
    schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
    status,
    skipped: false,
    attemptStartedAt: startedAt,
    claimCount,
    persistedCount,
    error,
  };
}

function safeErrorMessage(error: unknown): string {
  const detail = error && typeof error === 'object' && 'detail' in error
    ? (error as { detail?: { issues?: unknown } }).detail
    : undefined;
  const issues = typeof detail?.issues === 'string' ? ` Validation: ${detail.issues}` : '';
  const raw = `${error instanceof Error ? error.message : String(error)}${issues}`;
  return sanitizeText(raw).replace(/\s+/g, ' ').trim().slice(0, 2_000) || 'Unknown investment pipeline failure.';
}
