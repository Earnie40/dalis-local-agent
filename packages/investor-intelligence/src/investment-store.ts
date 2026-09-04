import { createId, getPool, type PoolClient } from '@dacai-local-agent/shared';
import { sha256Hex } from '@dacai-local-agent/domain-knowledge';
import { relationshipKey, type RelationshipType } from './graph.js';
import type { EntityType } from './entities.js';

export const FUNDING_ROUND_TYPES = [
  'pre_seed',
  'seed',
  'series_a',
  'series_b',
  'series_c',
  'growth',
  'strategic',
  'venture',
  'unknown',
] as const;

export type FundingRoundInputType = (typeof FUNDING_ROUND_TYPES)[number];
export type ObservedAssertion = 'observed' | 'stated';
export type PersistedParticipantRole = 'lead' | 'participant' | 'associated_partner' | 'unknown';
export type PersistedLeadStatus = 'confirmed_lead' | 'confirmed_not_lead' | 'unknown';

export interface FactProvenance {
  signalId: string;
  /** Exact source text; deterministic validation verifies it against the signal. */
  evidenceText: string;
  extractionClaimId?: string;
}

export interface ResolvedFundingRound {
  companyEntityId: string;
  /** Optional only for callers; a conservative deterministic key is generated. */
  roundKey?: string;
  /** Stable per-extraction reference, used to keep all-unknown rounds distinct. */
  claimFingerprint: string;
  roundType: FundingRoundInputType;
  announcedAt?: string;
  amount?: number;
  currency?: string;
  preMoneyValuation?: number;
  postMoneyValuation?: number;
  assertionClass: ObservedAssertion;
  confidence?: number;
  provenance: FactProvenance;
  metadata?: Record<string, unknown>;
  participants: ResolvedRoundParticipant[];
}

export interface ResolvedRoundParticipant {
  entityId: string;
  participantType: 'investment_firm' | 'person';
  role: PersistedParticipantRole;
  leadStatus: PersistedLeadStatus;
  assertionClass: ObservedAssertion;
  confidence?: number;
  provenance: FactProvenance;
  metadata?: Record<string, unknown>;
}

export interface ResolvedEntityRelationship {
  fromEntityId: string;
  toEntityId?: string;
  toTopicId?: string;
  toSectorId?: string;
  relationship: Extract<
    RelationshipType,
    | 'partner_at'
    | 'founded'
    | 'worked_at'
    | 'board_member_of'
    | 'advises'
    | 'uses_technology'
    | 'operates_in'
  >;
  assertionClass: ObservedAssertion;
  confidence?: number;
  effectiveAt?: string;
  validFrom?: string;
  validTo?: string;
  rationale?: string;
  provenance: FactProvenance;
  metadata?: Record<string, unknown>;
}

export interface ResolvedSectorAssignment {
  entityId: string;
  sectorSlug: string;
  sectorLabel: string;
  sectorDescription?: string;
  parentSectorSlug?: string;
  assertionClass: ObservedAssertion;
  confidence?: number;
  provenance: FactProvenance;
  metadata?: Record<string, unknown>;
}

export interface ResolvedInvestmentFacts {
  rounds: readonly ResolvedFundingRound[];
  relationships: readonly ResolvedEntityRelationship[];
  sectors: readonly ResolvedSectorAssignment[];
}

export interface InvestmentPersistenceResult {
  fundingRoundIds: string[];
  participantIds: string[];
  relationshipIds: string[];
  sectorAssignmentIds: string[];
  portfolioRelationshipsRefreshed: number;
}

export class InvestmentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvestmentPersistenceError';
  }
}

/**
 * Validated investment facts enter PostgreSQL through this single transaction.
 * The extractor never receives a database handle and cannot invent an edge
 * type or bypass endpoint/type/provenance checks.
 */
export class InvestmentGraphStore {
  async persist(facts: ResolvedInvestmentFacts, transactionClient?: PoolClient): Promise<InvestmentPersistenceResult> {
    validateFactShapes(facts);
    const client = transactionClient ?? await getPool().connect();
    const ownsTransaction = transactionClient === undefined;
    const result: InvestmentPersistenceResult = {
      fundingRoundIds: [],
      participantIds: [],
      relationshipIds: [],
      sectorAssignmentIds: [],
      portfolioRelationshipsRefreshed: 0,
    };

    try {
      if (ownsTransaction) await client.query('BEGIN');
      await validateEvidence(client, facts);
      await validateEndpointTypes(client, facts);

      for (const round of facts.rounds) {
        const roundId = await upsertRound(client, round);
        result.fundingRoundIds.push(roundId);

        const investorIds = new Set<string>();
        for (const participant of round.participants) {
          const participantId = await upsertParticipant(client, roundId, participant);
          result.participantIds.push(participantId);
          if (participant.participantType === 'investment_firm') investorIds.add(participant.entityId);
        }

        for (const investorId of investorIds) {
          await refreshPortfolioAggregate(client, investorId, round.companyEntityId);
          const relationshipId = await upsertDerivedInvestmentEdge(
            client,
            investorId,
            round.companyEntityId,
          );
          result.relationshipIds.push(relationshipId);
          result.portfolioRelationshipsRefreshed += 1;
        }
      }

      for (const relationship of facts.relationships) {
        result.relationshipIds.push(await upsertRelationship(client, relationship));
      }

      for (const sector of facts.sectors) {
        const { assignmentId, relationshipId } = await upsertSectorAssignment(client, sector);
        result.sectorAssignmentIds.push(assignmentId);
        result.relationshipIds.push(relationshipId);
      }

      const persistedClaimIds = unique([
        ...facts.rounds.flatMap((round) => [
          round.provenance.extractionClaimId,
          ...round.participants.map((participant) => participant.provenance.extractionClaimId),
        ]),
        ...facts.relationships.map((relationship) => relationship.provenance.extractionClaimId),
        ...facts.sectors.map((sector) => sector.provenance.extractionClaimId),
      ].filter((id): id is string => Boolean(id)));
      if (persistedClaimIds.length) {
        await client.query(
          `UPDATE intelligence_extraction_claims
              SET validation_status = 'persisted',
                  validated_at = COALESCE(validated_at, now()),
                  persisted_at = now()
            WHERE id = ANY($1::text[])`,
          [persistedClaimIds],
        );
      }

      if (ownsTransaction) await client.query('COMMIT');
      return {
        ...result,
        fundingRoundIds: unique(result.fundingRoundIds),
        participantIds: unique(result.participantIds),
        relationshipIds: unique(result.relationshipIds),
        sectorAssignmentIds: unique(result.sectorAssignmentIds),
      };
    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      if (error instanceof InvestmentPersistenceError) throw error;
      throw new InvestmentPersistenceError(
        `Investment fact transaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (ownsTransaction) client.release();
    }
  }
}

export function buildFundingRoundKey(input: Pick<
  ResolvedFundingRound,
  'companyEntityId' | 'roundType' | 'announcedAt' | 'amount' | 'currency' | 'claimFingerprint' | 'provenance'
>): string {
  const date = input.announcedAt?.slice(0, 10);
  const establishedIdentity = Boolean(date && (input.roundType !== 'unknown' || input.amount !== undefined));
  const parts = establishedIdentity
    ? [input.companyEntityId, input.roundType, date!, input.amount?.toString() ?? '', input.currency ?? '']
    : [input.companyEntityId, 'source-claim', input.provenance.signalId, input.claimFingerprint];
  return `round:${sha256Hex(parts.join('\u0000'))}`;
}

async function upsertRound(client: PoolClient, input: ResolvedFundingRound): Promise<string> {
  const explicitRoundKey = input.roundKey?.trim();
  const roundKey = explicitRoundKey || buildFundingRoundKey(input);
  const announcedDate = input.announcedAt?.slice(0, 10) ?? null;
  const currency = input.currency?.toUpperCase() ?? null;

  // Candidate locks do not protect an empty result set. Serialize round
  // identity decisions per company so two observations cannot both conclude
  // that no compatible round exists and insert duplicates concurrently.
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtext('vc-funding-round-reconciliation'),
       hashtext($1)
     )`,
    [input.companyEntityId],
  );

  const exact = await client.query<{ id: string; company_entity_id: string }>(
    `SELECT id, company_entity_id
       FROM funding_rounds
      WHERE round_key = $1
      FOR UPDATE`,
    [roundKey],
  );
  if (exact.rows[0] && exact.rows[0].company_entity_id !== input.companyEntityId) {
    throw new InvestmentPersistenceError(
      `Funding-round key collision: "${roundKey}" already belongs to another company.`,
    );
  }

  let reconciledId = exact.rows[0]?.id;
  if (!reconciledId && !explicitRoundKey) {
    const candidates = await client.query<{ id: string }>(
      `SELECT id
         FROM funding_rounds
        WHERE company_entity_id = $1
          AND round_type = $2
          AND (
            (
              $3::date IS NOT NULL
              AND announced_at IS NOT NULL
              AND announced_at::date = $3::date
              AND (amount IS NULL OR $4::numeric IS NULL OR amount = $4::numeric)
              AND (currency IS NULL OR $5::text IS NULL OR currency = $5::text)
            )
            OR
            (
              (
                ($3::date IS NULL AND announced_at IS NOT NULL)
                OR ($3::date IS NOT NULL AND announced_at IS NULL)
              )
              AND $4::numeric IS NOT NULL
              AND amount = $4::numeric
              AND currency IS NOT DISTINCT FROM $5::text
            )
          )
        ORDER BY id
        LIMIT 2
        FOR UPDATE`,
      [input.companyEntityId, input.roundType, announcedDate, input.amount ?? null, currency],
    );
    // More than one compatible row is genuinely ambiguous. Preserve it as a
    // distinct observation rather than guessing which existing round it is.
    if (candidates.rows.length === 1) reconciledId = candidates.rows[0].id;
  }

  if (reconciledId) {
    await enrichRound(client, reconciledId, input, currency);
    await upsertRoundSource(client, reconciledId, input);
    return reconciledId;
  }

  const id = createId('rnd');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO funding_rounds (
       id, company_entity_id, round_key, round_type, announced_at, amount, currency,
       pre_money_valuation, post_money_valuation, assertion_class, confidence,
       primary_signal_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (round_key) DO UPDATE SET
       round_type = CASE
         WHEN funding_rounds.round_type = 'unknown' THEN EXCLUDED.round_type
         ELSE funding_rounds.round_type
       END,
       announced_at = COALESCE(funding_rounds.announced_at, EXCLUDED.announced_at),
       amount = COALESCE(funding_rounds.amount, EXCLUDED.amount),
       currency = COALESCE(funding_rounds.currency, EXCLUDED.currency),
       pre_money_valuation = COALESCE(funding_rounds.pre_money_valuation, EXCLUDED.pre_money_valuation),
       post_money_valuation = COALESCE(funding_rounds.post_money_valuation, EXCLUDED.post_money_valuation),
       confidence = CASE
         WHEN funding_rounds.confidence IS NULL THEN EXCLUDED.confidence
         WHEN EXCLUDED.confidence IS NULL THEN funding_rounds.confidence
         ELSE GREATEST(funding_rounds.confidence, EXCLUDED.confidence)
       END,
       last_observed_at = now(),
       metadata = funding_rounds.metadata || EXCLUDED.metadata,
       updated_at = now()
     WHERE funding_rounds.company_entity_id = EXCLUDED.company_entity_id
     RETURNING id`,
    [
      id,
      input.companyEntityId,
      roundKey,
      input.roundType,
      input.announcedAt ?? null,
      input.amount ?? null,
      currency,
      input.preMoneyValuation ?? null,
      input.postMoneyValuation ?? null,
      input.assertionClass,
      input.confidence ?? null,
      input.provenance.signalId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!rows[0]) {
    throw new InvestmentPersistenceError(
      `Funding-round key collision: "${roundKey}" already belongs to another company.`,
    );
  }
  await upsertRoundSource(client, rows[0].id, input);
  return rows[0].id;
}

async function enrichRound(
  client: PoolClient,
  roundId: string,
  input: ResolvedFundingRound,
  currency: string | null,
): Promise<void> {
  await client.query(
    `UPDATE funding_rounds
        SET round_type = CASE
              WHEN round_type = 'unknown' THEN $2
              ELSE round_type
            END,
            announced_at = COALESCE(announced_at, $3),
            amount = COALESCE(amount, $4),
            currency = COALESCE(currency, $5),
            pre_money_valuation = COALESCE(pre_money_valuation, $6),
            post_money_valuation = COALESCE(post_money_valuation, $7),
            confidence = CASE
              WHEN confidence IS NULL THEN $8::double precision
              WHEN $8::double precision IS NULL THEN confidence
              ELSE GREATEST(confidence, $8::double precision)
            END,
            last_observed_at = now(),
            metadata = metadata || $9::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [
      roundId,
      input.roundType,
      input.announcedAt ?? null,
      input.amount ?? null,
      currency,
      input.preMoneyValuation ?? null,
      input.postMoneyValuation ?? null,
      input.confidence ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

async function upsertRoundSource(
  client: PoolClient,
  roundId: string,
  input: ResolvedFundingRound,
): Promise<void> {
  await client.query(
    `INSERT INTO funding_round_sources
       (funding_round_id, signal_id, extraction_claim_id, evidence_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (funding_round_id, signal_id) DO UPDATE SET
       extraction_claim_id = COALESCE(EXCLUDED.extraction_claim_id, funding_round_sources.extraction_claim_id),
       evidence_text = EXCLUDED.evidence_text`,
    [roundId, input.provenance.signalId, input.provenance.extractionClaimId ?? null, input.provenance.evidenceText],
  );
}

async function upsertParticipant(
  client: PoolClient,
  roundId: string,
  input: ResolvedRoundParticipant,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO funding_round_participants (
       id, funding_round_id, entity_id, participant_type, role, lead_status,
       assertion_class, confidence, primary_signal_id, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (funding_round_id, entity_id) DO UPDATE SET
       participant_type = EXCLUDED.participant_type,
       role = CASE
         WHEN funding_round_participants.role = 'lead' OR EXCLUDED.role = 'lead' THEN 'lead'
         WHEN funding_round_participants.role = 'associated_partner' OR EXCLUDED.role = 'associated_partner'
           THEN 'associated_partner'
         WHEN funding_round_participants.role = 'participant' OR EXCLUDED.role = 'participant' THEN 'participant'
         ELSE 'unknown'
       END,
       lead_status = CASE
         WHEN funding_round_participants.lead_status = 'confirmed_lead'
           OR EXCLUDED.lead_status = 'confirmed_lead' THEN 'confirmed_lead'
         WHEN funding_round_participants.lead_status = 'confirmed_not_lead'
           OR EXCLUDED.lead_status = 'confirmed_not_lead' THEN 'confirmed_not_lead'
         ELSE 'unknown'
       END,
       confidence = CASE
         WHEN funding_round_participants.confidence IS NULL THEN EXCLUDED.confidence
         WHEN EXCLUDED.confidence IS NULL THEN funding_round_participants.confidence
         ELSE GREATEST(funding_round_participants.confidence, EXCLUDED.confidence)
       END,
       last_observed_at = now(),
       metadata = funding_round_participants.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id`,
    [
      createId('part'),
      roundId,
      input.entityId,
      input.participantType,
      input.role,
      input.leadStatus,
      input.assertionClass,
      input.confidence ?? null,
      input.provenance.signalId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await client.query(
    `INSERT INTO funding_round_participant_sources
       (participant_id, signal_id, extraction_claim_id, evidence_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (participant_id, signal_id) DO UPDATE SET
       extraction_claim_id = COALESCE(
         EXCLUDED.extraction_claim_id,
         funding_round_participant_sources.extraction_claim_id
       ),
       evidence_text = EXCLUDED.evidence_text`,
    [rows[0].id, input.provenance.signalId, input.provenance.extractionClaimId ?? null, input.provenance.evidenceText],
  );
  return rows[0].id;
}

async function upsertRelationship(client: PoolClient, input: ResolvedEntityRelationship): Promise<string> {
  const key = relationshipKey({
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    toTopicId: input.toTopicId,
    toSectorId: input.toSectorId,
    relationship: input.relationship,
    relationshipBasis: 'source_fact',
    validFrom: input.validFrom,
    validTo: input.validTo,
  });
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO entity_relationships (
       id, from_entity_id, to_entity_id, to_topic_id, to_sector_id, relationship,
       assertion_class, relationship_basis, confidence, source_count, rationale,
       effective_at, valid_from, valid_to, idempotency_key, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'source_fact',$8,1,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
       confidence = CASE
         WHEN entity_relationships.confidence IS NULL THEN EXCLUDED.confidence
         WHEN EXCLUDED.confidence IS NULL THEN entity_relationships.confidence
         ELSE GREATEST(entity_relationships.confidence, EXCLUDED.confidence)
       END,
       source_count = GREATEST(entity_relationships.source_count, EXCLUDED.source_count),
       rationale = COALESCE(EXCLUDED.rationale, entity_relationships.rationale),
       first_observed_at = LEAST(entity_relationships.first_observed_at, now()),
       last_observed_at = now(),
       metadata = entity_relationships.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id`,
    [
      createId('rel'),
      input.fromEntityId,
      input.toEntityId ?? null,
      input.toTopicId ?? null,
      input.toSectorId ?? null,
      input.relationship,
      input.assertionClass,
      input.confidence ?? null,
      input.rationale ?? null,
      input.effectiveAt ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
      key,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await upsertRelationshipSource(client, rows[0].id, input.provenance);
  return rows[0].id;
}

async function upsertDerivedInvestmentEdge(
  client: PoolClient,
  investorEntityId: string,
  companyEntityId: string,
): Promise<string> {
  const provenance = await client.query<{ signal_id: string; evidence_text: string; announced_at: Date | null }>(
    `SELECT DISTINCT fps.signal_id, fps.evidence_text, fr.announced_at
       FROM funding_round_participants participant
       JOIN funding_rounds fr ON fr.id = participant.funding_round_id
       JOIN funding_round_participant_sources fps ON fps.participant_id = participant.id
      WHERE participant.entity_id = $1
        AND fr.company_entity_id = $2
        AND participant.participant_type = 'investment_firm'`,
    [investorEntityId, companyEntityId],
  );
  if (!provenance.rows.length) {
    throw new InvestmentPersistenceError('Cannot derive invested_in without a sourced round participant.');
  }
  const key = relationshipKey({
    fromEntityId: investorEntityId,
    toEntityId: companyEntityId,
    relationship: 'invested_in',
    relationshipBasis: 'derived_fact',
  });
  const dates = provenance.rows.flatMap((row) => row.announced_at ? [row.announced_at] : []);
  const first = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : undefined;
  const last = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : undefined;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO entity_relationships (
       id, from_entity_id, to_entity_id, relationship, assertion_class,
       relationship_basis, source_count, rationale, effective_at, idempotency_key, metadata
     ) VALUES ($1,$2,$3,'invested_in','observed','derived_fact',$4,$5,$6,$7,$8)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
       source_count = GREATEST(entity_relationships.source_count, EXCLUDED.source_count),
       effective_at = COALESCE(entity_relationships.effective_at, EXCLUDED.effective_at),
       last_observed_at = now(),
       metadata = entity_relationships.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id`,
    [
      createId('rel'),
      investorEntityId,
      companyEntityId,
      provenance.rows.length,
      'Derived deterministically from evidence-backed funding-round participation.',
      first?.toISOString() ?? null,
      key,
      JSON.stringify({
        derivation: 'verified_funding_round_participation',
        firstInvestmentAt: first?.toISOString(),
        lastInvestmentAt: last?.toISOString(),
      }),
    ],
  );
  for (const source of provenance.rows) {
    await upsertRelationshipSource(client, rows[0].id, {
      signalId: source.signal_id,
      evidenceText: source.evidence_text,
    });
  }
  return rows[0].id;
}

async function upsertRelationshipSource(
  client: PoolClient,
  relationshipId: string,
  provenance: FactProvenance,
): Promise<void> {
  await client.query(
    `INSERT INTO relationship_sources
       (relationship_id, signal_id, extraction_claim_id, evidence_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (relationship_id, signal_id) DO UPDATE SET
       extraction_claim_id = COALESCE(EXCLUDED.extraction_claim_id, relationship_sources.extraction_claim_id),
       evidence_text = EXCLUDED.evidence_text`,
    [relationshipId, provenance.signalId, provenance.extractionClaimId ?? null, provenance.evidenceText],
  );
  await client.query(
    `UPDATE entity_relationships r
        SET source_count = (SELECT count(*) FROM relationship_sources rs WHERE rs.relationship_id = r.id),
            updated_at = now()
      WHERE r.id = $1`,
    [relationshipId],
  );
}

async function upsertSectorAssignment(
  client: PoolClient,
  input: ResolvedSectorAssignment,
): Promise<{ assignmentId: string; relationshipId: string }> {
  let parentSectorId: string | null = null;
  if (input.parentSectorSlug) {
    const parent = await client.query<{ id: string }>(
      'SELECT id FROM intelligence_sectors WHERE slug = $1 AND active',
      [input.parentSectorSlug],
    );
    parentSectorId = parent.rows[0]?.id ?? null;
  }
  const sector = await client.query<{ id: string }>(
    `INSERT INTO intelligence_sectors (id, slug, label, description, parent_sector_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET
       label = EXCLUDED.label,
       description = COALESCE(EXCLUDED.description, intelligence_sectors.description),
       parent_sector_id = COALESCE(EXCLUDED.parent_sector_id, intelligence_sectors.parent_sector_id),
       active = true,
       updated_at = now()
     RETURNING id`,
    [
      createId('sec'),
      input.sectorSlug,
      input.sectorLabel,
      input.sectorDescription ?? null,
      parentSectorId,
    ],
  );
  const assignment = await client.query<{ id: string }>(
    `INSERT INTO entity_sector_assignments (
       id, entity_id, sector_id, assignment_basis, assertion_class, confidence,
       primary_signal_id, metadata
     ) VALUES ($1,$2,$3,'source_fact',$4,$5,$6,$7)
     ON CONFLICT (entity_id, sector_id, assignment_basis) DO UPDATE SET
       confidence = CASE
         WHEN entity_sector_assignments.confidence IS NULL THEN EXCLUDED.confidence
         WHEN EXCLUDED.confidence IS NULL THEN entity_sector_assignments.confidence
         ELSE GREATEST(entity_sector_assignments.confidence, EXCLUDED.confidence)
       END,
       last_observed_at = now(),
       computed_at = now(),
       metadata = entity_sector_assignments.metadata || EXCLUDED.metadata
     RETURNING id`,
    [
      createId('esa'),
      input.entityId,
      sector.rows[0].id,
      input.assertionClass,
      input.confidence ?? null,
      input.provenance.signalId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await client.query(
    `INSERT INTO sector_assignment_sources
       (assignment_id, signal_id, extraction_claim_id, evidence_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (assignment_id, signal_id) DO UPDATE SET
       extraction_claim_id = COALESCE(EXCLUDED.extraction_claim_id, sector_assignment_sources.extraction_claim_id),
       evidence_text = EXCLUDED.evidence_text`,
    [assignment.rows[0].id, input.provenance.signalId, input.provenance.extractionClaimId ?? null, input.provenance.evidenceText],
  );
  const relationshipId = await upsertRelationship(client, {
    fromEntityId: input.entityId,
    toSectorId: sector.rows[0].id,
    relationship: 'operates_in',
    assertionClass: input.assertionClass,
    confidence: input.confidence,
    rationale: `Source-supported normalized sector assignment: ${input.sectorLabel}.`,
    provenance: input.provenance,
    metadata: { ...input.metadata, semanticProjection: 'operates_in' },
  });
  return { assignmentId: assignment.rows[0].id, relationshipId };
}

async function refreshPortfolioAggregate(
  client: PoolClient,
  investorEntityId: string,
  companyEntityId: string,
): Promise<void> {
  const { rows } = await client.query<{
    first_at: Date | null;
    last_at: Date | null;
    round_count: number;
    latest_round_id: string;
    latest_round_type: string;
    source_count: number;
    source_url: string | null;
    amounts: Record<string, number>;
  }>(
    `WITH matching AS (
       SELECT DISTINCT fr.*
         FROM funding_round_participants p
         JOIN funding_rounds fr ON fr.id = p.funding_round_id
        WHERE p.entity_id = $1
          AND p.participant_type = 'investment_firm'
          AND fr.company_entity_id = $2
     ), latest AS (
       SELECT id, round_type, primary_signal_id
         FROM matching
        ORDER BY announced_at DESC NULLS LAST, created_at DESC, id
        LIMIT 1
     ), amounts AS (
       SELECT COALESCE(jsonb_object_agg(currency, total), '{}'::jsonb) AS value
         FROM (
           SELECT currency, sum(amount)::DOUBLE PRECISION AS total
             FROM matching
            WHERE amount IS NOT NULL AND currency IS NOT NULL
            GROUP BY currency
         ) grouped
     )
     SELECT min(m.announced_at) AS first_at,
            max(m.announced_at) AS last_at,
            count(*)::INTEGER AS round_count,
            latest.id AS latest_round_id,
            latest.round_type AS latest_round_type,
            (SELECT count(DISTINCT source.signal_id)::INTEGER
               FROM matching mr
               JOIN funding_round_sources source ON source.funding_round_id = mr.id) AS source_count,
            signal.source_url,
            amounts.value AS amounts
       FROM matching m
       CROSS JOIN latest
       CROSS JOIN amounts
       JOIN intelligence_signals signal ON signal.id = latest.primary_signal_id
      GROUP BY latest.id, latest.round_type, signal.source_url, amounts.value`,
    [investorEntityId, companyEntityId],
  );
  const aggregate = rows[0];
  if (!aggregate || aggregate.source_count < 1) {
    throw new InvestmentPersistenceError('Portfolio aggregate has no supporting round source.');
  }
  await client.query(
    `INSERT INTO portfolio_relationships (
       id, investor_entity_id, company_entity_id, stage, announced_at,
       assertion_class, source_count, source_url, first_invested_at,
       last_invested_at, round_count, latest_round_id,
       disclosed_amounts_by_currency, metadata
     ) VALUES ($1,$2,$3,$4,$5,'observed',$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (investor_entity_id, company_entity_id) DO UPDATE SET
       stage = EXCLUDED.stage,
       announced_at = EXCLUDED.announced_at,
       source_count = EXCLUDED.source_count,
       source_url = EXCLUDED.source_url,
       first_invested_at = EXCLUDED.first_invested_at,
       last_invested_at = EXCLUDED.last_invested_at,
       round_count = EXCLUDED.round_count,
       latest_round_id = EXCLUDED.latest_round_id,
       disclosed_amounts_by_currency = EXCLUDED.disclosed_amounts_by_currency,
       metadata = portfolio_relationships.metadata || EXCLUDED.metadata,
       updated_at = now()`,
    [
      createId('pf'),
      investorEntityId,
      companyEntityId,
      aggregate.latest_round_type,
      aggregate.last_at,
      aggregate.source_count,
      aggregate.source_url,
      aggregate.first_at,
      aggregate.last_at,
      aggregate.round_count,
      aggregate.latest_round_id,
      JSON.stringify(aggregate.amounts ?? {}),
      JSON.stringify({ canonicalSource: 'funding_round_participants' }),
    ],
  );
}

async function validateEvidence(client: PoolClient, facts: ResolvedInvestmentFacts): Promise<void> {
  const provenances = [
    ...facts.rounds.flatMap((round) => [round.provenance, ...round.participants.map((item) => item.provenance)]),
    ...facts.relationships.map((item) => item.provenance),
    ...facts.sectors.map((item) => item.provenance),
  ];
  const ids = unique(provenances.map((item) => item.signalId));
  if (!ids.length && (facts.rounds.length || facts.relationships.length || facts.sectors.length)) {
    throw new InvestmentPersistenceError('Every persisted fact requires signal provenance.');
  }
  const { rows } = await client.query<{ id: string; excerpt: string }>(
    'SELECT id, excerpt FROM intelligence_signals WHERE id = ANY($1::text[])',
    [ids],
  );
  const signals = new Map(rows.map((row) => [row.id, row.excerpt]));
  for (const provenance of provenances) {
    const excerpt = signals.get(provenance.signalId);
    if (!excerpt) throw new InvestmentPersistenceError(`Unknown provenance signal "${provenance.signalId}".`);
    if (!containsEvidence(excerpt, provenance.evidenceText)) {
      throw new InvestmentPersistenceError(
        `Evidence text for signal "${provenance.signalId}" does not occur in the stored excerpt.`,
      );
    }
  }
}

async function validateEndpointTypes(client: PoolClient, facts: ResolvedInvestmentFacts): Promise<void> {
  const entityIds = unique([
    ...facts.rounds.flatMap((round) => [round.companyEntityId, ...round.participants.map((item) => item.entityId)]),
    ...facts.relationships.flatMap((relationship) => [
      relationship.fromEntityId,
      ...(relationship.toEntityId ? [relationship.toEntityId] : []),
    ]),
    ...facts.sectors.map((sector) => sector.entityId),
  ]);
  const { rows } = await client.query<{ id: string; entity_type: EntityType }>(
    'SELECT id, entity_type FROM intelligence_entities WHERE id = ANY($1::text[])',
    [entityIds],
  );
  const types = new Map(rows.map((row) => [row.id, row.entity_type]));
  for (const id of entityIds) {
    if (!types.has(id)) throw new InvestmentPersistenceError(`Unknown resolved entity "${id}".`);
  }
  for (const round of facts.rounds) {
    if (!['portfolio_company', 'strategic_company', 'organization'].includes(types.get(round.companyEntityId)!)) {
      throw new InvestmentPersistenceError('A funding round must fund a company entity.');
    }
    for (const participant of round.participants) {
      if (types.get(participant.entityId) !== participant.participantType) {
        throw new InvestmentPersistenceError(
          `Participant "${participant.entityId}" is ${types.get(participant.entityId)}, not ${participant.participantType}.`,
        );
      }
    }
  }
  for (const relationship of facts.relationships) {
    const from = types.get(relationship.fromEntityId)!;
    const to = relationship.toEntityId ? types.get(relationship.toEntityId) : undefined;
    if (['partner_at', 'founded', 'worked_at', 'board_member_of'].includes(relationship.relationship) && from !== 'person') {
      throw new InvestmentPersistenceError(`${relationship.relationship} must originate from a person.`);
    }
    if (relationship.relationship === 'partner_at' && to !== 'investment_firm') {
      throw new InvestmentPersistenceError('partner_at must target an investment firm.');
    }
    if (relationship.relationship === 'founded' && !['portfolio_company', 'strategic_company', 'organization'].includes(to ?? '')) {
      throw new InvestmentPersistenceError('founded must target a company.');
    }
    if (relationship.relationship === 'worked_at' && (to === 'person' || to === undefined)) {
      throw new InvestmentPersistenceError('worked_at must target a professional organization.');
    }
    if (relationship.relationship === 'board_member_of' && ![
      'portfolio_company', 'strategic_company', 'organization', 'investment_firm',
    ].includes(to ?? '')) {
      throw new InvestmentPersistenceError('board_member_of must target an organization.');
    }
    if (relationship.relationship === 'uses_technology' && !relationship.toTopicId) {
      throw new InvestmentPersistenceError('uses_technology must target a free-form technology topic.');
    }
    if (relationship.relationship === 'operates_in' && !relationship.toSectorId) {
      throw new InvestmentPersistenceError('operates_in must target a normalized sector.');
    }
  }
}

function validateFactShapes(facts: ResolvedInvestmentFacts): void {
  for (const round of facts.rounds) {
    if (!FUNDING_ROUND_TYPES.includes(round.roundType)) {
      throw new InvestmentPersistenceError(`Unsupported round type "${round.roundType}".`);
    }
    assertDate(round.announcedAt, 'announcedAt');
    assertMoney(round.amount, 'amount');
    assertMoney(round.preMoneyValuation, 'preMoneyValuation');
    assertMoney(round.postMoneyValuation, 'postMoneyValuation');
    if (round.currency && !/^[A-Z]{3}$/i.test(round.currency)) {
      throw new InvestmentPersistenceError(`Currency "${round.currency}" must be a three-letter ISO code.`);
    }
    assertConfidence(round.confidence);
    for (const participant of round.participants) assertConfidence(participant.confidence);
  }
  for (const relationship of facts.relationships) {
    const targets = [relationship.toEntityId, relationship.toTopicId, relationship.toSectorId].filter(Boolean);
    if (targets.length !== 1) throw new InvestmentPersistenceError('A relationship must have exactly one target.');
    assertDate(relationship.effectiveAt, 'effectiveAt');
    assertDate(relationship.validFrom, 'validFrom');
    assertDate(relationship.validTo, 'validTo');
    if (relationship.validFrom && relationship.validTo && relationship.validTo < relationship.validFrom) {
      throw new InvestmentPersistenceError('Relationship validTo cannot precede validFrom.');
    }
    assertConfidence(relationship.confidence);
  }
  for (const sector of facts.sectors) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sector.sectorSlug)) {
      throw new InvestmentPersistenceError(`Invalid normalized sector slug "${sector.sectorSlug}".`);
    }
    assertConfidence(sector.confidence);
  }
}

function containsEvidence(haystack: string, needle: string): boolean {
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const evidence = normalize(needle);
  return evidence.length >= 3 && normalize(haystack).includes(evidence);
}

function assertDate(value: string | undefined, label: string): void {
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new InvestmentPersistenceError(`${label} must be an ISO-compatible date.`);
  }
}

function assertMoney(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new InvestmentPersistenceError(`${label} must be a non-negative finite number.`);
  }
}

function assertConfidence(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw new InvestmentPersistenceError('Confidence must be within 0..1 when supplied.');
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
