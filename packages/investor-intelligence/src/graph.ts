import { createId, getPool } from '@dacai-local-agent/shared';
import { makeClaim, sha256Hex, type AssertionClass, type Claim } from '@dacai-local-agent/domain-knowledge';
import type { CapabilityStatus } from './capabilities.js';

/**
 * The ecosystem relationship graph.
 *
 * Four kinds of statement live in this graph and must never be readable as the
 * same kind of thing:
 *
 *   PUBLIC FACT               a firm publicly announced an investment.
 *   INFERENCE                 the platform concluded a firm is interested in a theme.
 *   DACAIS INTERNAL CLAIM     DACAIS states it has a capability.
 *   PROPOSED FUTURE CAPABILITY  DACAIS states an intended direction.
 *
 * Rather than a convention about how to write them down, each is a distinct
 * constructor that produces a differently-classified edge, and the only way to
 * build an edge is through one of them. The existing `Claim<T>`/`AssertionClass`
 * machinery from packages/domain-knowledge does the enforcement — an inference
 * without confidence throws, and `asFact()` refuses to read one as fact.
 */

export type StatementKind =
  | 'PUBLIC_FACT'
  | 'DERIVED_FACT'
  | 'INFERENCE'
  | 'DACAIS_INTERNAL_CLAIM'
  | 'PROPOSED_FUTURE_CAPABILITY';

export type RelationshipType =
  | 'invested_in'
  | 'partner_at'
  | 'led'
  | 'participated_in'
  | 'funded'
  | 'raised'
  | 'co_invested_with'
  | 'operates_in'
  | 'uses_technology'
  | 'worked_at'
  | 'board_member_of'
  | 'founded'
  | 'advises'
  | 'discussed'
  | 'published'
  | 'spoke_at'
  | 'interested_in'
  | 'competes_with'
  | 'collaborates_with'
  | 'capability_of'
  | 'developing'
  | 'horizon_for'
  | 'demonstrates';

export type RelationshipBasis =
  | 'source_fact'
  | 'derived_fact'
  | 'inference'
  | 'internal_claim'
  | 'proposed_capability';

export interface GraphEdge {
  id?: string;
  fromEntityId: string;
  toEntityId?: string;
  toTopicId?: string;
  toSectorId?: string;
  relationship: RelationshipType;
  statementKind: StatementKind;
  relationshipBasis: RelationshipBasis;
  assertionClass: AssertionClass;
  confidence?: number;
  sourceCount: number;
  rationale?: string;
  effectiveAt?: string;
  validFrom?: string;
  validTo?: string;
  firstObservedAt?: string;
  lastObservedAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  /** Signal ids that support this edge. Required for a public fact. */
  supportingSignalIds: readonly string[];
  /** Optional exact source spans, keyed by signal id. */
  evidenceBySignalId?: Readonly<Record<string, string>>;
}

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * A publicly documented relationship: an announced investment, a listed
 * partner, a talk on a published agenda.
 *
 * Requires at least one supporting signal. There is no way to build a public
 * fact without one, because a public fact whose source cannot be produced is
 * indistinguishable from something the system made up.
 */
export function publicFact(input: {
  fromEntityId: string;
  toEntityId?: string;
  toTopicId?: string;
  toSectorId?: string;
  relationship: RelationshipType;
  supportingSignalIds: readonly string[];
  rationale?: string;
  effectiveAt?: string;
  validFrom?: string;
  validTo?: string;
  firstObservedAt?: string;
  lastObservedAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  evidenceBySignalId?: Readonly<Record<string, string>>;
}): GraphEdge {
  if (!input.supportingSignalIds.length) {
    throw new GraphError(
      `Refusing to record "${input.relationship}" as a public fact with no supporting signal. ` +
        'A fact that cannot cite a source is an inference.',
    );
  }
  assertOneTarget(input.toEntityId, input.toTopicId, input.toSectorId, input.relationship);

  return {
    ...input,
    statementKind: 'PUBLIC_FACT',
    relationshipBasis: 'source_fact',
    assertionClass: 'observed',
    sourceCount: input.supportingSignalIds.length,
  };
}

/**
 * A deterministic projection of sourced facts, such as two firms sharing a
 * verified round.  It is neither a directly published statement nor an LLM
 * inference; downstream readers can therefore label it honestly.
 */
export function derivedFact(input: {
  fromEntityId: string;
  toEntityId?: string;
  toTopicId?: string;
  toSectorId?: string;
  relationship: RelationshipType;
  supportingSignalIds: readonly string[];
  rationale: string;
  effectiveAt?: string;
  firstObservedAt?: string;
  lastObservedAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  evidenceBySignalId?: Readonly<Record<string, string>>;
}): GraphEdge {
  if (!input.supportingSignalIds.length) {
    throw new GraphError(`Refusing to derive "${input.relationship}" without any sourced facts.`);
  }
  if (!input.rationale.trim()) throw new GraphError('A derived fact must explain its deterministic derivation.');
  assertOneTarget(input.toEntityId, input.toTopicId, input.toSectorId, input.relationship);
  return {
    ...input,
    statementKind: 'DERIVED_FACT',
    relationshipBasis: 'derived_fact',
    assertionClass: 'observed',
    sourceCount: input.supportingSignalIds.length,
  };
}

/**
 * The platform's own reading of the evidence.
 *
 * Confidence is mandatory. An inference presented without one reads as a fact
 * to every downstream consumer, which is exactly the failure this graph exists
 * to prevent.
 */
export function inference(input: {
  fromEntityId: string;
  toEntityId?: string;
  toTopicId?: string;
  toSectorId?: string;
  relationship: RelationshipType;
  confidence: number;
  supportingSignalIds?: readonly string[];
  rationale: string;
  effectiveAt?: string;
  validFrom?: string;
  validTo?: string;
  firstObservedAt?: string;
  lastObservedAt?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): GraphEdge {
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    throw new GraphError(`Inference confidence must be within 0..1, received ${input.confidence}.`);
  }
  if (!input.rationale?.trim()) {
    throw new GraphError('An inference must carry a rationale explaining what it was derived from.');
  }
  assertOneTarget(input.toEntityId, input.toTopicId, input.toSectorId, input.relationship);

  return {
    ...input,
    statementKind: 'INFERENCE',
    relationshipBasis: 'inference',
    assertionClass: 'inferred',
    sourceCount: input.supportingSignalIds?.length ?? 0,
    supportingSignalIds: input.supportingSignalIds ?? [],
  };
}

/**
 * Something DACAIS says about itself.
 *
 * Classified `stated`, never `observed`: that DACAIS asserts a capability is a
 * different kind of statement from an independent party observing it. Whether
 * the assertion is true is settled by evidence, elsewhere.
 */
export function internalClaim(input: {
  dacaisEntityId: string;
  toTopicId?: string;
  toEntityId?: string;
  toSectorId?: string;
  relationship: RelationshipType;
  capabilityStatus: CapabilityStatus;
  rationale: string;
}): GraphEdge {
  assertOneTarget(input.toEntityId, input.toTopicId, input.toSectorId, input.relationship);

  const isFuture =
    input.capabilityStatus !== 'PRODUCTION' && input.capabilityStatus !== 'WORKING_PROTOTYPE';

  return {
    fromEntityId: input.dacaisEntityId,
    toEntityId: input.toEntityId,
    toTopicId: input.toTopicId,
    toSectorId: input.toSectorId,
    // A future capability is recorded with a relationship that says so, so the
    // distinction survives even if someone reads only the relationship column.
    relationship: isFuture
      ? (input.capabilityStatus === 'HORIZON' ? 'horizon_for' : 'developing')
      : input.relationship,
    statementKind: isFuture ? 'PROPOSED_FUTURE_CAPABILITY' : 'DACAIS_INTERNAL_CLAIM',
    relationshipBasis: isFuture ? 'proposed_capability' : 'internal_claim',
    assertionClass: 'stated',
    sourceCount: 1,
    rationale: input.rationale,
    supportingSignalIds: [],
  };
}

function assertOneTarget(
  toEntityId: string | undefined,
  toTopicId: string | undefined,
  toSectorId: string | undefined,
  relationship: string,
): void {
  const targets = [toEntityId, toTopicId, toSectorId].filter(Boolean).length;
  if (targets !== 1) {
    throw new GraphError(
      `Relationship "${relationship}" must target exactly one entity, topic, or sector; received ${targets}.`,
    );
  }
}

/** The edge as a provenance-carrying claim, for prompts and reports. */
export function edgeAsClaim(edge: GraphEdge, label: string): Claim<string> {
  return makeClaim({
    value: label,
    assertionClass: edge.assertionClass,
    confidence: edge.assertionClass === 'inferred' ? (edge.confidence ?? 0.5) : undefined,
    sources: edge.supportingSignalIds.map((id) => ({ kind: 'intelligence_signal', locator: id })),
    rationale: edge.rationale,
  });
}

export class GraphStore {
  async upsert(edge: GraphEdge): Promise<string> {
    // The table repeats these checks; validating here produces a message that
    // names the modelling mistake rather than a constraint name.
    if ((edge.assertionClass === 'observed' || edge.assertionClass === 'stated') && edge.sourceCount < 1) {
      throw new GraphError('An observed or stated edge must cite at least one source.');
    }
    if (edge.assertionClass === 'inferred' && edge.confidence === undefined) {
      throw new GraphError('An inferred edge must carry a confidence.');
    }

    const id = edge.id ?? createId('rel');
    const idempotencyKey = edge.idempotencyKey ?? relationshipKey(edge);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO entity_relationships
           (id, from_entity_id, to_entity_id, to_topic_id, to_sector_id, relationship,
            assertion_class, relationship_basis, confidence, source_count, rationale,
            effective_at, valid_from, valid_to, first_observed_at, last_observed_at,
            idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 COALESCE($15::timestamptz, now()),COALESCE($16::timestamptz, now()),$17,$18)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
           confidence = CASE
             WHEN entity_relationships.confidence IS NULL THEN EXCLUDED.confidence
             WHEN EXCLUDED.confidence IS NULL THEN entity_relationships.confidence
             ELSE GREATEST(entity_relationships.confidence, EXCLUDED.confidence)
           END,
           source_count = GREATEST(entity_relationships.source_count, EXCLUDED.source_count),
           rationale = COALESCE(EXCLUDED.rationale, entity_relationships.rationale),
           effective_at = COALESCE(entity_relationships.effective_at, EXCLUDED.effective_at),
           valid_from = COALESCE(entity_relationships.valid_from, EXCLUDED.valid_from),
           valid_to = COALESCE(EXCLUDED.valid_to, entity_relationships.valid_to),
           first_observed_at = LEAST(entity_relationships.first_observed_at, EXCLUDED.first_observed_at),
           last_observed_at = GREATEST(entity_relationships.last_observed_at, EXCLUDED.last_observed_at),
           metadata = entity_relationships.metadata || EXCLUDED.metadata,
           updated_at = now()
         RETURNING id`,
        [
          id,
          edge.fromEntityId,
          edge.toEntityId ?? null,
          edge.toTopicId ?? null,
          edge.toSectorId ?? null,
          edge.relationship,
          edge.assertionClass,
          edge.relationshipBasis,
          edge.confidence ?? null,
          edge.sourceCount,
          edge.rationale ?? null,
          edge.effectiveAt ?? null,
          edge.validFrom ?? null,
          edge.validTo ?? null,
          edge.firstObservedAt ?? null,
          edge.lastObservedAt ?? null,
          idempotencyKey,
          JSON.stringify(edge.metadata ?? {}),
        ],
      );
      for (const signalId of edge.supportingSignalIds) {
        await client.query(
          `INSERT INTO relationship_sources (relationship_id, signal_id, evidence_text)
           VALUES ($1,$2,$3)
           ON CONFLICT (relationship_id, signal_id) DO UPDATE SET
             evidence_text = COALESCE(EXCLUDED.evidence_text, relationship_sources.evidence_text)`,
          [rows[0].id, signalId, edge.evidenceBySignalId?.[signalId] ?? null],
        );
      }
      await client.query(
        `UPDATE entity_relationships r
            SET source_count = GREATEST(
                  r.source_count,
                  (SELECT count(*) FROM relationship_sources rs WHERE rs.relationship_id = r.id)
                ),
                updated_at = now()
          WHERE r.id = $1`,
        [rows[0].id],
      );
      await client.query('COMMIT');
      return rows[0].id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async edgesFor(entityId: string): Promise<Array<GraphEdge & { id: string; targetLabel?: string }>> {
    const { rows } = await getPool().query(
      `SELECT r.*,
              COALESCE(te.display_name, tt.label, ts.label) AS target_label,
              (SELECT array_agg(rs.signal_id) FROM relationship_sources rs WHERE rs.relationship_id = r.id) AS signal_ids
         FROM entity_relationships r
         LEFT JOIN intelligence_entities te ON te.id = r.to_entity_id
         LEFT JOIN intelligence_topics tt ON tt.id = r.to_topic_id
         LEFT JOIN intelligence_sectors ts ON ts.id = r.to_sector_id
        WHERE r.from_entity_id = $1
        ORDER BY r.assertion_class, r.confidence DESC NULLS LAST`,
      [entityId],
    );

    return rows.map((row) => ({
      id: String(row.id),
      fromEntityId: String(row.from_entity_id),
      toEntityId: (row.to_entity_id as string | null) ?? undefined,
      toTopicId: (row.to_topic_id as string | null) ?? undefined,
      toSectorId: (row.to_sector_id as string | null) ?? undefined,
      relationship: String(row.relationship) as RelationshipType,
      statementKind: statementKindFor(
        String(row.assertion_class),
        String(row.relationship),
        String(row.relationship_basis ?? ''),
      ),
      relationshipBasis: String(row.relationship_basis ?? 'source_fact') as RelationshipBasis,
      assertionClass: String(row.assertion_class) as AssertionClass,
      confidence: (row.confidence as number | null) ?? undefined,
      sourceCount: Number(row.source_count),
      rationale: (row.rationale as string | null) ?? undefined,
      effectiveAt: isoValue(row.effective_at),
      validFrom: isoValue(row.valid_from),
      validTo: isoValue(row.valid_to),
      firstObservedAt: isoValue(row.first_observed_at),
      lastObservedAt: isoValue(row.last_observed_at),
      idempotencyKey: (row.idempotency_key as string | null) ?? undefined,
      metadata: (row.metadata as Record<string, unknown> | null) ?? {},
      supportingSignalIds: (row.signal_ids as string[] | null) ?? [],
      targetLabel: (row.target_label as string | null) ?? undefined,
    }));
  }

  /**
   * Legacy bilateral compatibility writer. Canonical production ingestion uses
   * InvestmentGraphStore and first-class funding rounds; this remains for
   * callers that only possess a sourced company-membership fact.
   */
  async recordPortfolio(input: {
    investorEntityId: string;
    companyEntityId: string;
    stage?: string;
    announcedAt?: string;
    sourceUrl?: string;
    sourceCount: number;
  }): Promise<void> {
    if (input.sourceCount < 1) {
      throw new GraphError('A portfolio relationship must cite at least one public announcement.');
    }
    await getPool().query(
      `INSERT INTO portfolio_relationships
         (id, investor_entity_id, company_entity_id, stage, announced_at, assertion_class,
          source_count, source_url, first_invested_at, last_invested_at, round_count,
          metadata)
       VALUES ($1,$2,$3,$4,$5,'observed',$6,$7,$5,$5,1,$8)
       ON CONFLICT (investor_entity_id, company_entity_id) DO UPDATE SET
         stage = COALESCE(EXCLUDED.stage, portfolio_relationships.stage),
         announced_at = COALESCE(EXCLUDED.announced_at, portfolio_relationships.announced_at),
         first_invested_at = LEAST(
           COALESCE(portfolio_relationships.first_invested_at, EXCLUDED.first_invested_at),
           COALESCE(EXCLUDED.first_invested_at, portfolio_relationships.first_invested_at)
         ),
         last_invested_at = GREATEST(
           COALESCE(portfolio_relationships.last_invested_at, EXCLUDED.last_invested_at),
           COALESCE(EXCLUDED.last_invested_at, portfolio_relationships.last_invested_at)
         ),
         round_count = GREATEST(portfolio_relationships.round_count, 1),
         source_count = GREATEST(portfolio_relationships.source_count, EXCLUDED.source_count),
         metadata = portfolio_relationships.metadata || EXCLUDED.metadata,
         updated_at = now()`,
      [
        createId('pf'),
        input.investorEntityId,
        input.companyEntityId,
        input.stage ?? null,
        input.announcedAt ?? null,
        input.sourceCount,
        input.sourceUrl ?? null,
        JSON.stringify({ canonicalSource: 'legacy_bilateral_fact' }),
      ],
    );
  }
}

function statementKindFor(assertionClass: string, relationship: string, basis?: string): StatementKind {
  if (basis === 'derived_fact') return 'DERIVED_FACT';
  if (relationship === 'horizon_for' || relationship === 'developing') return 'PROPOSED_FUTURE_CAPABILITY';
  if (assertionClass === 'stated') return 'DACAIS_INTERNAL_CLAIM';
  if (assertionClass === 'observed') return 'PUBLIC_FACT';
  return 'INFERENCE';
}

function isoValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  return undefined;
}

/** Stable across reprocessing of the same semantic relationship. */
export function relationshipKey(edge: Pick<
  GraphEdge,
  | 'fromEntityId'
  | 'toEntityId'
  | 'toTopicId'
  | 'toSectorId'
  | 'relationship'
  | 'relationshipBasis'
  | 'validFrom'
  | 'validTo'
>): string {
  return `rel:${sha256Hex([
    edge.fromEntityId,
    edge.toEntityId ?? '',
    edge.toTopicId ?? '',
    edge.toSectorId ?? '',
    edge.relationship,
    edge.relationshipBasis,
    edge.validFrom ?? '',
    edge.validTo ?? '',
  ].join('\u0000'))}`;
}

/**
 * Renders edges with their statement kind always visible.
 *
 * This is the shape used in prompts, so a model is never handed an inference
 * formatted identically to a public fact.
 */
export function describeEdges(
  edges: ReadonlyArray<GraphEdge & { targetLabel?: string }>,
  fromLabel: string,
): string {
  const groups: Record<StatementKind, string[]> = {
    PUBLIC_FACT: [],
    DERIVED_FACT: [],
    INFERENCE: [],
    DACAIS_INTERNAL_CLAIM: [],
    PROPOSED_FUTURE_CAPABILITY: [],
  };

  for (const edge of edges) {
    const confidence = edge.confidence === undefined ? '' : ` (confidence ${edge.confidence.toFixed(2)})`;
    const sources = edge.sourceCount ? ` [${edge.sourceCount} source(s)]` : '';
    groups[edge.statementKind].push(
      `${fromLabel} --${edge.relationship}--> ${edge.targetLabel ?? '(unnamed)'}${confidence}${sources}`,
    );
  }

  return (Object.entries(groups) as Array<[StatementKind, string[]]>)
    .filter(([, lines]) => lines.length)
    .map(([kind, lines]) => `${kind}:\n${lines.map((line) => `  - ${line}`).join('\n')}`)
    .join('\n\n');
}
