import { getPool } from '@dacai-local-agent/shared';

export type FundingRoundType =
  | 'pre_seed'
  | 'seed'
  | 'series_a'
  | 'series_b'
  | 'series_c'
  | 'growth'
  | 'strategic'
  | 'venture'
  | 'unknown';

export type RelationshipDirection = 'incoming' | 'outgoing' | 'both';
export type InvestmentStatementKind =
  | 'FACT'
  | 'DERIVED'
  | 'INFERENCE'
  | 'INTERNAL_CLAIM'
  | 'PROPOSED_CAPABILITY';

export interface TemporalFilter {
  /** Inclusive ISO-8601 instant, or an inclusive YYYY-MM-DD calendar day. */
  from?: string;
  /** Inclusive ISO-8601 instant, or an inclusive YYYY-MM-DD calendar day. */
  to?: string;
}

export interface BoundedTemporalQuery extends TemporalFilter {
  limit?: number;
}

export interface EntitySummary {
  id: string;
  slug: string;
  displayName: string;
  entityType: string;
  primaryUrl?: string;
}

export interface AnalyticsEvidence {
  signalId: string;
  sourceId?: string;
  sourceUrl: string;
  sourceKind: string;
  title?: string;
  excerpt?: string;
  publishedAt?: string;
  retrievedAt: string;
  extractionClaimId?: string;
  evidenceText?: string;
}

export interface RoundParticipation {
  id: string;
  entity: EntitySummary;
  participantType: string;
  role: string;
  leadStatus: string;
  assertionClass: string;
  confidence?: number;
  firstObservedAt: string;
  lastObservedAt: string;
  metadata: Record<string, unknown>;
  evidence: AnalyticsEvidence[];
}

export interface FundingRoundSummary {
  id: string;
  company: EntitySummary;
  roundType: FundingRoundType;
  announcedAt?: string;
  amount?: string;
  currency?: string;
  preMoneyValuation?: string;
  postMoneyValuation?: string;
  assertionClass: string;
  confidence?: number;
  firstObservedAt: string;
  lastObservedAt: string;
  participantCount: number;
  entityParticipation?: Omit<RoundParticipation, 'entity' | 'evidence' | 'metadata'>;
  evidence: AnalyticsEvidence[];
}

export interface FundingRoundDetail extends FundingRoundSummary {
  roundKey: string;
  primarySignalId: string;
  metadata: Record<string, unknown>;
  participants: RoundParticipation[];
}

export interface PortfolioEntry {
  company: EntitySummary;
  firstInvestmentAt?: string;
  lastInvestmentAt?: string;
  roundCount: number;
  rounds: FundingRoundSummary[];
  evidence: AnalyticsEvidence[];
}

export interface InvestorRoundParticipation {
  roundId: string;
  roundType: FundingRoundType;
  announcedAt?: string;
  amount?: string;
  currency?: string;
  role: string;
  leadStatus: string;
  evidence: AnalyticsEvidence[];
}

export interface CompanyInvestor {
  investor: EntitySummary;
  roundCount: number;
  firstInvestmentAt?: string;
  lastInvestmentAt?: string;
  hasLed: boolean;
  rounds: InvestorRoundParticipation[];
  evidence: AnalyticsEvidence[];
}

export interface CoInvestorSummary {
  firm: EntitySummary;
  sharedRoundCount: number;
  sharedCompanyCount: number;
  firstSharedRoundAt?: string;
  lastSharedRoundAt?: string;
  sharedRoundIds: string[];
  sharedCompanyIds: string[];
  evidence: AnalyticsEvidence[];
}

export interface ObservedSectorExposure {
  sectorId: string;
  slug: string;
  label: string;
  description?: string;
  investmentCount: number;
  companyCount: number;
  roundShare: number;
  firstInvestmentAt?: string;
  lastInvestmentAt?: string;
  assignmentBases: string[];
  assignmentConfidence?: number;
  evidence: AnalyticsEvidence[];
}

export interface PublicSignalAffinity {
  topicId: string;
  slug: string;
  label: string;
  affinityScore: number;
  signalCount: number;
  sourceCount: number;
  newestSignal?: string;
  evidence: AnalyticsEvidence[];
}

export interface SectorProfile {
  entityId: string;
  window: Readonly<TemporalFilter>;
  /** Derived only from evidence-backed funding-round participation. */
  observedInvestmentBehavior: ObservedSectorExposure[];
  /** Derived only from public signals mentioning the queried entity. */
  publicSignalAffinity: PublicSignalAffinity[];
}

export interface InvestmentTimelineEvent {
  id: string;
  kind: 'funding_round';
  occurredAt?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  company: EntitySummary;
  roundId: string;
  roundType: FundingRoundType;
  amount?: string;
  currency?: string;
  role?: string;
  leadStatus?: string;
  evidence: AnalyticsEvidence[];
}

export interface RichRelationship {
  id: string;
  direction: 'incoming' | 'outgoing';
  from: EntitySummary;
  toEntity?: EntitySummary;
  toTopic?: { id: string; slug: string; label: string };
  toSector?: { id: string; slug: string; label: string };
  relationship: string;
  relationshipBasis: string;
  statementKind: InvestmentStatementKind;
  assertionClass: string;
  confidence?: number;
  rationale?: string;
  effectiveAt?: string;
  validFrom?: string;
  validTo?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  metadata: Record<string, unknown>;
  evidence: AnalyticsEvidence[];
}

export interface RelationshipQuery extends BoundedTemporalQuery {
  direction?: RelationshipDirection;
  relationships?: readonly string[];
  assertionClasses?: readonly string[];
  relationshipBases?: readonly string[];
}

export type NeighborhoodNodeKind = 'entity' | 'topic' | 'sector' | 'funding_round';

export interface NeighborhoodNode {
  key: string;
  id: string;
  kind: NeighborhoodNodeKind;
  label: string;
  subtype?: string;
  depth: number;
  metadata: Record<string, unknown>;
}

export interface NeighborhoodEdge {
  id: string;
  sourceKey: string;
  targetKey: string;
  relationship: string;
  relationshipBasis: string;
  statementKind: InvestmentStatementKind;
  assertionClass: string;
  confidence?: number;
  effectiveAt?: string;
  virtual: boolean;
  evidence: AnalyticsEvidence[];
}

export interface NeighborhoodQuery {
  depth?: 1 | 2;
  limit?: number;
  relationships?: readonly string[];
}

export interface InvestmentNeighborhood {
  rootEntityId: string;
  depth: 1 | 2;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
  truncated: boolean;
}

export type FitComponentKey =
  | 'sectorFit'
  | 'stageFit'
  | 'recentActivityFit'
  | 'technologyFit'
  | 'networkFit';

export interface FitComponentEvidence {
  kind: 'sector' | 'round' | 'topic' | 'co_investor';
  label: string;
  entityId?: string;
  sectorId?: string;
  topicId?: string;
  roundId?: string;
  sourceUrls: string[];
}

export interface FitComponent {
  key: FitComponentKey;
  label: string;
  available: boolean;
  score?: number;
  weight: number;
  explanation: string;
  evidence: FitComponentEvidence[];
}

export interface InvestorFitScore {
  scoreKind: 'HEURISTIC';
  scoringVersion: 'vc-fit-v1';
  company: EntitySummary;
  investor: EntitySummary;
  overallScore?: number;
  components: Record<FitComponentKey, FitComponent>;
  evidence: FitComponentEvidence[];
  limitations: string[];
  evaluatedAt: string;
}

export interface InvestorFitOptions {
  asOf?: string;
}

export class InvestmentAnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvestmentAnalyticsError';
  }
}

export interface InvestmentAnalyticsQueryExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

const DEFAULT_RESULT_LIMIT = 100;
const MAX_RESULT_LIMIT = 250;
const DEFAULT_NEIGHBORHOOD_LIMIT = 50;
const MAX_NEIGHBORHOOD_LIMIT = 100;

const postgresExecutor: InvestmentAnalyticsQueryExecutor = {
  async query(sql, params = []) {
    const { rows } = await getPool().query(sql, [...params]);
    return rows as Record<string, unknown>[];
  },
};

interface NormalizedWindow {
  from?: string;
  to?: string;
}

interface EvidenceOwnerRow extends Record<string, unknown> {
  owner_id: string;
  signal_id: string;
  source_id: string | null;
  source_url: string;
  source_kind: string;
  title: string | null;
  excerpt: string | null;
  published_at: string | Date | null;
  retrieved_at: string | Date;
  extraction_claim_id: string | null;
  evidence_text: string | null;
}

function boundedLimit(value: number | undefined, fallback = DEFAULT_RESULT_LIMIT, maximum = MAX_RESULT_LIMIT): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new InvestmentAnalyticsError(`limit must be an integer within 1..${maximum}; received ${String(value)}.`);
  }
  return limit;
}

function normalizeWindow(input: TemporalFilter = {}): NormalizedWindow {
  const from = input.from === undefined ? undefined : normalizeFilterInstant(input.from, 'from', false);
  const to = input.to === undefined ? undefined : normalizeFilterInstant(input.to, 'to', true);
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw new InvestmentAnalyticsError(`from must not be later than to (${input.from} > ${input.to}).`);
  }
  return { from, to };
}

function normalizeFilterInstant(value: string, label: string, endOfDay: boolean): string {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const timestamp = Date.parse(`${trimmed}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== trimmed) {
      throw new InvestmentAnalyticsError(`${label} must be a real ISO-8601 date or instant.`);
    }
    return new Date(timestamp + (endOfDay ? 86_399_999 : 0)).toISOString();
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new InvestmentAnalyticsError(`${label} must be an ISO-8601 date or timezone-qualified instant.`);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new InvestmentAnalyticsError(`${label} must be a real ISO-8601 date or instant.`);
  }
  return new Date(timestamp).toISOString();
}

function addTemporalClauses(
  clauses: string[],
  params: unknown[],
  expression: string,
  window: NormalizedWindow,
): void {
  if (window.from) {
    params.push(window.from);
    clauses.push(`${expression} >= $${params.length}::timestamptz`);
  }
  if (window.to) {
    params.push(window.to);
    clauses.push(`${expression} <= $${params.length}::timestamptz`);
  }
}

function normalizeStringFilter(values: readonly string[] | undefined, label: string, maximum = 25): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!normalized.length || normalized.length > maximum) {
    throw new InvestmentAnalyticsError(`${label} must contain 1..${maximum} non-empty values.`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function iso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed legacy metadata is exposed as empty rather than breaking a read query.
    }
  }
  return {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distinctEvidence(records: readonly AnalyticsEvidence[]): AnalyticsEvidence[] {
  return [...new Map(records.map((record) => [record.signalId, record])).values()];
}

function entityFromRow(row: Record<string, unknown>, prefix = ''): EntitySummary {
  return {
    id: String(row[`${prefix}id`]),
    slug: String(row[`${prefix}slug`]),
    displayName: String(row[`${prefix}display_name`]),
    entityType: String(row[`${prefix}entity_type`]),
    primaryUrl: optionalString(row[`${prefix}primary_url`]),
  };
}

function statementKind(basis: unknown, assertionClass: unknown): InvestmentStatementKind {
  switch (String(basis)) {
    case 'derived_fact': return 'DERIVED';
    case 'inference': return 'INFERENCE';
    case 'internal_claim': return 'INTERNAL_CLAIM';
    case 'proposed_capability': return 'PROPOSED_CAPABILITY';
    default:
      return ['inferred', 'estimated', 'predicted'].includes(String(assertionClass)) ? 'INFERENCE' : 'FACT';
  }
}

function compareOptionalDatesDescending(left: string | undefined, right: string | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return Date.parse(right) - Date.parse(left);
}

function minDate(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

function maxDate(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

const NEIGHBORHOOD_GRAPH_CTE = `graph_edges AS (
  SELECT
    relationship.id AS edge_id,
    'entity:' || relationship.from_entity_id AS source_key,
    CASE
      WHEN relationship.to_entity_id IS NOT NULL THEN 'entity:' || relationship.to_entity_id
      WHEN relationship.to_topic_id IS NOT NULL THEN 'topic:' || relationship.to_topic_id
      ELSE 'sector:' || relationship.to_sector_id
    END AS target_key,
    relationship.relationship,
    relationship.relationship_basis,
    relationship.assertion_class,
    relationship.confidence,
    relationship.effective_at,
    'relationship'::TEXT AS source_ref_type,
    relationship.id AS source_ref_id,
    false AS virtual
  FROM entity_relationships relationship

  UNION ALL

  SELECT
    'round-participant:' || participant.id AS edge_id,
    'entity:' || participant.entity_id AS source_key,
    'round:' || participant.funding_round_id AS target_key,
    CASE WHEN participant.lead_status = 'confirmed_lead' THEN 'led' ELSE 'participated_in' END AS relationship,
    'source_fact'::TEXT AS relationship_basis,
    participant.assertion_class,
    participant.confidence,
    round.announced_at AS effective_at,
    'participant'::TEXT AS source_ref_type,
    participant.id AS source_ref_id,
    true AS virtual
  FROM funding_round_participants participant
  JOIN funding_rounds round ON round.id = participant.funding_round_id

  UNION ALL

  SELECT
    'round-company:' || round.id AS edge_id,
    'round:' || round.id AS source_key,
    'entity:' || round.company_entity_id AS target_key,
    'funded'::TEXT AS relationship,
    'source_fact'::TEXT AS relationship_basis,
    round.assertion_class,
    round.confidence,
    round.announced_at AS effective_at,
    'round'::TEXT AS source_ref_type,
    round.id AS source_ref_id,
    true AS virtual
  FROM funding_rounds round
)`;

export class InvestmentAnalyticsService {
  constructor(private readonly executor: InvestmentAnalyticsQueryExecutor = postgresExecutor) {}

  async getPortfolio(investorEntityId: string, query: BoundedTemporalQuery = {}): Promise<PortfolioEntry[]> {
    await this.requireEntity(investorEntityId);
    const rounds = await this.getFundingRoundsForEntity(investorEntityId, query);
    const grouped = new Map<string, PortfolioEntry>();

    for (const round of rounds) {
      if (!round.entityParticipation || round.company.id === investorEntityId) continue;
      const current = grouped.get(round.company.id) ?? {
        company: round.company,
        roundCount: 0,
        rounds: [],
        evidence: [],
      };
      current.rounds.push(round);
      current.roundCount += 1;
      current.evidence = distinctEvidence([...current.evidence, ...round.evidence]);
      grouped.set(round.company.id, current);
    }

    return [...grouped.values()]
      .map((entry) => ({
        ...entry,
        firstInvestmentAt: minDate(entry.rounds.map((round) => round.announcedAt)),
        lastInvestmentAt: maxDate(entry.rounds.map((round) => round.announcedAt)),
        rounds: entry.rounds.sort((left, right) => compareOptionalDatesDescending(left.announcedAt, right.announcedAt)),
      }))
      .sort((left, right) => compareOptionalDatesDescending(left.lastInvestmentAt, right.lastInvestmentAt));
  }

  async getFundingRoundsForEntity(
    entityId: string,
    query: BoundedTemporalQuery = {},
  ): Promise<FundingRoundSummary[]> {
    await this.requireEntity(entityId);
    const window = normalizeWindow(query);
    const limit = boundedLimit(query.limit);
    const params: unknown[] = [entityId];
    const clauses = ['(fr.company_entity_id = $1 OR self_participant.id IS NOT NULL)'];
    addTemporalClauses(clauses, params, 'fr.announced_at', window);
    params.push(limit);

    const rows = await this.rows<Record<string, unknown>>(
      `SELECT
         fr.*,
         company.id AS company_id,
         company.slug AS company_slug,
         company.display_name AS company_display_name,
         company.entity_type AS company_entity_type,
         company.primary_url AS company_primary_url,
         self_participant.id AS self_participant_id,
         self_participant.participant_type AS self_participant_type,
         self_participant.role AS self_role,
         self_participant.lead_status AS self_lead_status,
         self_participant.assertion_class AS self_assertion_class,
         self_participant.confidence AS self_confidence,
         self_participant.first_observed_at AS self_first_observed_at,
         self_participant.last_observed_at AS self_last_observed_at,
         (SELECT count(*)::INTEGER
            FROM funding_round_participants participant_count
           WHERE participant_count.funding_round_id = fr.id) AS participant_count
       FROM funding_rounds fr
       JOIN intelligence_entities company ON company.id = fr.company_entity_id
       LEFT JOIN funding_round_participants self_participant
         ON self_participant.funding_round_id = fr.id
        AND self_participant.entity_id = $1
      WHERE ${clauses.join(' AND ')}
      ORDER BY fr.announced_at DESC NULLS LAST, fr.last_observed_at DESC, fr.id
      LIMIT $${params.length}`,
      params,
    );

    const roundIds = rows.map((row) => String(row.id));
    const participantIds = rows
      .map((row) => optionalString(row.self_participant_id))
      .filter((id): id is string => Boolean(id));
    const [roundEvidence, participantEvidence] = await Promise.all([
      this.evidenceForOwners('round', roundIds),
      this.evidenceForOwners('participant', participantIds),
    ]);

    return rows.map((row) => this.roundSummaryFromRow(
      row,
      distinctEvidence([
        ...(roundEvidence.get(String(row.id)) ?? []),
        ...(participantEvidence.get(optionalString(row.self_participant_id) ?? '') ?? []),
      ]),
    ));
  }

  async getFundingRound(roundId: string): Promise<FundingRoundDetail | undefined> {
    const rows = await this.rows<Record<string, unknown>>(
      `SELECT
         fr.*,
         company.id AS company_id,
         company.slug AS company_slug,
         company.display_name AS company_display_name,
         company.entity_type AS company_entity_type,
         company.primary_url AS company_primary_url,
         (SELECT count(*)::INTEGER
            FROM funding_round_participants participant_count
           WHERE participant_count.funding_round_id = fr.id) AS participant_count
       FROM funding_rounds fr
       JOIN intelligence_entities company ON company.id = fr.company_entity_id
      WHERE fr.id = $1`,
      [roundId],
    );
    if (!rows[0]) return undefined;

    const participantRows = await this.rows<Record<string, unknown>>(
      `SELECT
         participant.*,
         entity.id AS entity_id,
         entity.slug AS entity_slug,
         entity.display_name AS entity_display_name,
         entity.entity_type AS entity_entity_type,
         entity.primary_url AS entity_primary_url
       FROM funding_round_participants participant
       JOIN intelligence_entities entity ON entity.id = participant.entity_id
      WHERE participant.funding_round_id = $1
      ORDER BY
        CASE participant.lead_status WHEN 'confirmed_lead' THEN 0 ELSE 1 END,
        entity.display_name,
        participant.id`,
      [roundId],
    );

    const [roundEvidence, participantEvidence] = await Promise.all([
      this.evidenceForOwners('round', [roundId]),
      this.evidenceForOwners('participant', participantRows.map((row) => String(row.id))),
    ]);
    const summary = this.roundSummaryFromRow(rows[0], roundEvidence.get(roundId) ?? []);

    return {
      ...summary,
      roundKey: String(rows[0].round_key),
      primarySignalId: String(rows[0].primary_signal_id),
      metadata: metadata(rows[0].metadata),
      participants: participantRows.map((row) => ({
        id: String(row.id),
        entity: entityFromRow(row, 'entity_'),
        participantType: String(row.participant_type),
        role: String(row.role),
        leadStatus: String(row.lead_status),
        assertionClass: String(row.assertion_class),
        confidence: optionalNumber(row.confidence),
        firstObservedAt: iso(row.first_observed_at) ?? '',
        lastObservedAt: iso(row.last_observed_at) ?? '',
        metadata: metadata(row.metadata),
        evidence: participantEvidence.get(String(row.id)) ?? [],
      })),
    };
  }

  async getInvestorsForCompany(
    companyEntityId: string,
    query: BoundedTemporalQuery = {},
  ): Promise<CompanyInvestor[]> {
    await this.requireEntity(companyEntityId);
    const window = normalizeWindow(query);
    const limit = boundedLimit(query.limit);
    const params: unknown[] = [companyEntityId];
    const clauses = ['fr.company_entity_id = $1'];
    addTemporalClauses(clauses, params, 'fr.announced_at', window);
    params.push(limit);

    const rows = await this.rows<Record<string, unknown>>(
      `SELECT
         participant.id AS participant_id,
         participant.role,
         participant.lead_status,
         investor.id AS investor_id,
         investor.slug AS investor_slug,
         investor.display_name AS investor_display_name,
         investor.entity_type AS investor_entity_type,
         investor.primary_url AS investor_primary_url,
         fr.id AS round_id,
         fr.round_type,
         fr.announced_at,
         fr.amount,
         fr.currency
       FROM funding_rounds fr
       JOIN funding_round_participants participant ON participant.funding_round_id = fr.id
       JOIN intelligence_entities investor ON investor.id = participant.entity_id
      WHERE ${clauses.join(' AND ')}
        AND investor.entity_type IN ('investment_firm', 'person')
      ORDER BY fr.announced_at DESC NULLS LAST, investor.display_name, fr.id
      LIMIT $${params.length}`,
      params,
    );

    const [roundEvidence, participantEvidence] = await Promise.all([
      this.evidenceForOwners('round', rows.map((row) => String(row.round_id))),
      this.evidenceForOwners('participant', rows.map((row) => String(row.participant_id))),
    ]);
    const grouped = new Map<string, CompanyInvestor>();

    for (const row of rows) {
      const investor = entityFromRow(row, 'investor_');
      const evidence = distinctEvidence([
        ...(roundEvidence.get(String(row.round_id)) ?? []),
        ...(participantEvidence.get(String(row.participant_id)) ?? []),
      ]);
      const current = grouped.get(investor.id) ?? {
        investor,
        roundCount: 0,
        hasLed: false,
        rounds: [],
        evidence: [],
      };
      current.rounds.push({
        roundId: String(row.round_id),
        roundType: String(row.round_type) as FundingRoundType,
        announcedAt: iso(row.announced_at),
        amount: optionalString(row.amount),
        currency: optionalString(row.currency),
        role: String(row.role),
        leadStatus: String(row.lead_status),
        evidence,
      });
      current.roundCount += 1;
      current.hasLed ||= row.lead_status === 'confirmed_lead';
      current.evidence = distinctEvidence([...current.evidence, ...evidence]);
      grouped.set(investor.id, current);
    }

    return [...grouped.values()]
      .map((investor) => ({
        ...investor,
        firstInvestmentAt: minDate(investor.rounds.map((round) => round.announcedAt)),
        lastInvestmentAt: maxDate(investor.rounds.map((round) => round.announcedAt)),
      }))
      .sort((left, right) => right.roundCount - left.roundCount || left.investor.displayName.localeCompare(right.investor.displayName));
  }

  private roundSummaryFromRow(row: Record<string, unknown>, evidence: AnalyticsEvidence[]): FundingRoundSummary {
    const participantId = optionalString(row.self_participant_id);
    return {
      id: String(row.id),
      company: entityFromRow(row, 'company_'),
      roundType: String(row.round_type) as FundingRoundType,
      announcedAt: iso(row.announced_at),
      amount: optionalString(row.amount),
      currency: optionalString(row.currency),
      preMoneyValuation: optionalString(row.pre_money_valuation),
      postMoneyValuation: optionalString(row.post_money_valuation),
      assertionClass: String(row.assertion_class),
      confidence: optionalNumber(row.confidence),
      firstObservedAt: iso(row.first_observed_at) ?? '',
      lastObservedAt: iso(row.last_observed_at) ?? '',
      participantCount: Number(row.participant_count ?? 0),
      entityParticipation: participantId ? {
        id: participantId,
        participantType: String(row.self_participant_type),
        role: String(row.self_role),
        leadStatus: String(row.self_lead_status),
        assertionClass: String(row.self_assertion_class),
        confidence: optionalNumber(row.self_confidence),
        firstObservedAt: iso(row.self_first_observed_at) ?? '',
        lastObservedAt: iso(row.self_last_observed_at) ?? '',
      } : undefined,
      evidence,
    };
  }

  async getCoInvestors(
    firmEntityId: string,
    query: BoundedTemporalQuery = {},
  ): Promise<CoInvestorSummary[]> {
    const firm = await this.requireEntity(firmEntityId);
    if (firm.entityType !== 'investment_firm') {
      throw new InvestmentAnalyticsError(`Co-investor queries require an investment_firm; ${firmEntityId} is ${firm.entityType}.`);
    }
    const window = normalizeWindow(query);
    const limit = boundedLimit(query.limit);
    const params: unknown[] = [firmEntityId];
    const clauses = ['($1 = pair.firm_a_id OR $1 = pair.firm_b_id)'];
    addTemporalClauses(clauses, params, 'fr.announced_at', window);
    params.push(limit);

    const rows = await this.rows<Record<string, unknown>>(
      `WITH shared AS (
         SELECT
           pair.firm_a_id,
           pair.firm_b_id,
           fr.id AS round_id,
           fr.company_entity_id,
           fr.announced_at
         FROM co_investor_relationships pair
         CROSS JOIN LATERAL unnest(pair.shared_round_ids) shared_round(round_id)
         JOIN funding_rounds fr ON fr.id = shared_round.round_id
        WHERE ${clauses.join(' AND ')}
       )
       SELECT
         other_firm.id AS firm_id,
         other_firm.slug AS firm_slug,
         other_firm.display_name AS firm_display_name,
         other_firm.entity_type AS firm_entity_type,
         other_firm.primary_url AS firm_primary_url,
         count(DISTINCT shared.round_id)::INTEGER AS shared_round_count,
         count(DISTINCT shared.company_entity_id)::INTEGER AS shared_company_count,
         min(shared.announced_at) AS first_shared_round_at,
         max(shared.announced_at) AS last_shared_round_at,
         array_agg(DISTINCT shared.round_id ORDER BY shared.round_id) AS shared_round_ids,
         array_agg(DISTINCT shared.company_entity_id ORDER BY shared.company_entity_id) AS shared_company_ids
       FROM shared
       JOIN intelligence_entities other_firm
         ON other_firm.id = CASE
           WHEN shared.firm_a_id = $1 THEN shared.firm_b_id
           ELSE shared.firm_a_id
         END
      GROUP BY other_firm.id, other_firm.slug, other_firm.display_name,
               other_firm.entity_type, other_firm.primary_url
      ORDER BY shared_round_count DESC, last_shared_round_at DESC NULLS LAST, other_firm.display_name
      LIMIT $${params.length}`,
      params,
    );

    const allRoundIds = [...new Set(rows.flatMap((row) => stringArray(row.shared_round_ids)))];
    const evidenceByRound = await this.evidenceForOwners('round', allRoundIds);
    return rows.map((row) => {
      const sharedRoundIds = stringArray(row.shared_round_ids);
      return {
        firm: entityFromRow(row, 'firm_'),
        sharedRoundCount: Number(row.shared_round_count),
        sharedCompanyCount: Number(row.shared_company_count),
        firstSharedRoundAt: iso(row.first_shared_round_at),
        lastSharedRoundAt: iso(row.last_shared_round_at),
        sharedRoundIds,
        sharedCompanyIds: stringArray(row.shared_company_ids),
        evidence: distinctEvidence(sharedRoundIds.flatMap((id) => evidenceByRound.get(id) ?? [])),
      };
    });
  }

  async getSectorProfile(
    entityId: string,
    query: BoundedTemporalQuery = {},
  ): Promise<SectorProfile> {
    await this.requireEntity(entityId);
    const window = normalizeWindow(query);
    const limit = boundedLimit(query.limit, 50, 100);

    const observedParams: unknown[] = [entityId];
    const exposureClauses = ['(fr.company_entity_id = $1 OR participant.id IS NOT NULL)'];
    addTemporalClauses(exposureClauses, observedParams, 'fr.announced_at', window);
    observedParams.push(limit);
    const observedRows = await this.rows<Record<string, unknown>>(
      `WITH exposure AS (
         SELECT DISTINCT
           fr.id AS round_id,
           fr.company_entity_id,
           fr.announced_at
         FROM funding_rounds fr
         LEFT JOIN funding_round_participants participant
           ON participant.funding_round_id = fr.id
          AND participant.entity_id = $1
        WHERE ${exposureClauses.join(' AND ')}
       )
       SELECT
         sector.id AS sector_id,
         sector.slug,
         sector.label,
         sector.description,
         count(DISTINCT exposure.round_id)::INTEGER AS investment_count,
         count(DISTINCT exposure.company_entity_id)::INTEGER AS company_count,
         min(exposure.announced_at) AS first_investment_at,
         max(exposure.announced_at) AS last_investment_at,
         avg(assignment.confidence) FILTER (WHERE assignment.confidence IS NOT NULL) AS assignment_confidence,
         array_agg(DISTINCT assignment.assignment_basis ORDER BY assignment.assignment_basis) AS assignment_bases,
         array_agg(DISTINCT assignment.id ORDER BY assignment.id) AS assignment_ids,
         (SELECT count(DISTINCT all_exposure.round_id)::INTEGER FROM exposure all_exposure) AS total_rounds
       FROM exposure
       JOIN entity_sector_assignments assignment
         ON assignment.entity_id = exposure.company_entity_id
        AND assignment.assignment_basis IN ('source_fact', 'operator')
       JOIN intelligence_sectors sector ON sector.id = assignment.sector_id AND sector.active
      GROUP BY sector.id, sector.slug, sector.label, sector.description
      ORDER BY investment_count DESC, last_investment_at DESC NULLS LAST, sector.label
      LIMIT $${observedParams.length}`,
      observedParams,
    );

    const signalParams: unknown[] = [entityId];
    const signalClauses = ['signal_entity.entity_id = $1'];
    addTemporalClauses(signalClauses, signalParams, 'COALESCE(signal.published_at, signal.retrieved_at)', window);
    signalParams.push(limit);
    const affinityRows = await this.rows<Record<string, unknown>>(
      `SELECT
         topic.id AS topic_id,
         topic.slug,
         topic.label,
         avg(signal_topic.relevance) AS affinity_score,
         count(DISTINCT signal.id)::INTEGER AS signal_count,
         count(DISTINCT signal.source_url)::INTEGER AS source_count,
         max(COALESCE(signal.published_at, signal.retrieved_at)) AS newest_signal,
         array_agg(DISTINCT signal.id ORDER BY signal.id) AS signal_ids
       FROM signal_entities signal_entity
       JOIN intelligence_signals signal ON signal.id = signal_entity.signal_id
       JOIN signal_topics signal_topic ON signal_topic.signal_id = signal.id
       JOIN intelligence_topics topic ON topic.id = signal_topic.topic_id
      WHERE ${signalClauses.join(' AND ')}
      GROUP BY topic.id, topic.slug, topic.label
      ORDER BY affinity_score DESC, signal_count DESC, topic.label
      LIMIT $${signalParams.length}`,
      signalParams,
    );

    const assignmentIds = [...new Set(observedRows.flatMap((row) => stringArray(row.assignment_ids)))];
    const signalIds = [...new Set(affinityRows.flatMap((row) => stringArray(row.signal_ids)))];
    const [assignmentEvidence, signalEvidence] = await Promise.all([
      this.evidenceForOwners('sector_assignment', assignmentIds),
      this.evidenceForSignals(signalIds),
    ]);

    return {
      entityId,
      window,
      observedInvestmentBehavior: observedRows.map((row) => {
        const totalRounds = Number(row.total_rounds ?? 0);
        const investmentCount = Number(row.investment_count);
        const ids = stringArray(row.assignment_ids);
        return {
          sectorId: String(row.sector_id),
          slug: String(row.slug),
          label: String(row.label),
          description: optionalString(row.description),
          investmentCount,
          companyCount: Number(row.company_count),
          roundShare: totalRounds > 0 ? clampScore(investmentCount / totalRounds) : 0,
          firstInvestmentAt: iso(row.first_investment_at),
          lastInvestmentAt: iso(row.last_investment_at),
          assignmentBases: stringArray(row.assignment_bases),
          assignmentConfidence: optionalNumber(row.assignment_confidence),
          evidence: distinctEvidence(ids.flatMap((id) => assignmentEvidence.get(id) ?? [])),
        };
      }),
      publicSignalAffinity: affinityRows.map((row) => {
        const ids = stringArray(row.signal_ids);
        return {
          topicId: String(row.topic_id),
          slug: String(row.slug),
          label: String(row.label),
          affinityScore: clampScore(Number(row.affinity_score)),
          signalCount: Number(row.signal_count),
          sourceCount: Number(row.source_count),
          newestSignal: iso(row.newest_signal),
          evidence: distinctEvidence(ids.flatMap((id) => signalEvidence.get(id) ?? [])),
        };
      }),
    };
  }

  async getInvestmentTimeline(
    entityId: string,
    query: BoundedTemporalQuery = {},
  ): Promise<InvestmentTimelineEvent[]> {
    const limit = boundedLimit(query.limit);
    const rounds = await this.getFundingRoundsForEntity(entityId, { ...query, limit });
    return rounds
      .map((round): InvestmentTimelineEvent => ({
        id: `funding-round:${round.id}`,
        kind: 'funding_round',
        occurredAt: round.announcedAt,
        firstObservedAt: round.firstObservedAt,
        lastObservedAt: round.lastObservedAt,
        company: round.company,
        roundId: round.id,
        roundType: round.roundType,
        amount: round.amount,
        currency: round.currency,
        role: round.entityParticipation?.role,
        leadStatus: round.entityParticipation?.leadStatus,
        evidence: round.evidence,
      }))
      .sort((left, right) => compareOptionalDatesDescending(left.occurredAt, right.occurredAt))
      .slice(0, limit);
  }

  async getRelationships(entityId: string, query: RelationshipQuery = {}): Promise<RichRelationship[]> {
    await this.requireEntity(entityId);
    const direction = query.direction ?? 'both';
    if (!['incoming', 'outgoing', 'both'].includes(direction)) {
      throw new InvestmentAnalyticsError(`direction must be incoming, outgoing, or both; received ${String(direction)}.`);
    }
    const window = normalizeWindow(query);
    const limit = boundedLimit(query.limit);
    const relationships = normalizeStringFilter(query.relationships, 'relationships');
    const assertionClasses = normalizeStringFilter(query.assertionClasses, 'assertionClasses');
    const relationshipBases = normalizeStringFilter(query.relationshipBases, 'relationshipBases');
    const params: unknown[] = [entityId];
    const clauses = [direction === 'incoming'
      ? 'relationship.to_entity_id = $1'
      : direction === 'outgoing'
        ? 'relationship.from_entity_id = $1'
        : '(relationship.from_entity_id = $1 OR relationship.to_entity_id = $1)'];

    if (relationships) {
      params.push(relationships);
      clauses.push(`relationship.relationship = ANY($${params.length}::text[])`);
    }
    if (assertionClasses) {
      params.push(assertionClasses);
      clauses.push(`relationship.assertion_class = ANY($${params.length}::text[])`);
    }
    if (relationshipBases) {
      params.push(relationshipBases);
      clauses.push(`relationship.relationship_basis = ANY($${params.length}::text[])`);
    }
    addTemporalClauses(
      clauses,
      params,
      'COALESCE(relationship.effective_at, relationship.first_observed_at, relationship.created_at)',
      window,
    );
    params.push(limit);

    const rows = await this.rows<Record<string, unknown>>(
      `SELECT
         relationship.*,
         source_entity.id AS from_id,
         source_entity.slug AS from_slug,
         source_entity.display_name AS from_display_name,
         source_entity.entity_type AS from_entity_type,
         source_entity.primary_url AS from_primary_url,
         target_entity.id AS target_id,
         target_entity.slug AS target_slug,
         target_entity.display_name AS target_display_name,
         target_entity.entity_type AS target_entity_type,
         target_entity.primary_url AS target_primary_url,
         target_topic.id AS topic_id,
         target_topic.slug AS topic_slug,
         target_topic.label AS topic_label,
         target_sector.id AS sector_id,
         target_sector.slug AS sector_slug,
         target_sector.label AS sector_label
       FROM entity_relationships relationship
       JOIN intelligence_entities source_entity ON source_entity.id = relationship.from_entity_id
       LEFT JOIN intelligence_entities target_entity ON target_entity.id = relationship.to_entity_id
       LEFT JOIN intelligence_topics target_topic ON target_topic.id = relationship.to_topic_id
       LEFT JOIN intelligence_sectors target_sector ON target_sector.id = relationship.to_sector_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        COALESCE(relationship.effective_at, relationship.first_observed_at, relationship.created_at) DESC NULLS LAST,
        relationship.relationship,
        relationship.id
      LIMIT $${params.length}`,
      params,
    );

    const evidence = await this.evidenceForOwners('relationship', rows.map((row) => String(row.id)));
    return rows.map((row) => ({
      id: String(row.id),
      direction: row.from_entity_id === entityId ? 'outgoing' : 'incoming',
      from: entityFromRow(row, 'from_'),
      toEntity: row.target_id ? entityFromRow(row, 'target_') : undefined,
      toTopic: row.topic_id ? {
        id: String(row.topic_id),
        slug: String(row.topic_slug),
        label: String(row.topic_label),
      } : undefined,
      toSector: row.sector_id ? {
        id: String(row.sector_id),
        slug: String(row.sector_slug),
        label: String(row.sector_label),
      } : undefined,
      relationship: String(row.relationship),
      relationshipBasis: String(row.relationship_basis),
      statementKind: statementKind(row.relationship_basis, row.assertion_class),
      assertionClass: String(row.assertion_class),
      confidence: optionalNumber(row.confidence),
      rationale: optionalString(row.rationale),
      effectiveAt: iso(row.effective_at),
      validFrom: iso(row.valid_from),
      validTo: iso(row.valid_to),
      firstObservedAt: iso(row.first_observed_at) ?? '',
      lastObservedAt: iso(row.last_observed_at) ?? '',
      metadata: metadata(row.metadata),
      evidence: evidence.get(String(row.id)) ?? [],
    }));
  }

  async getNeighborhood(entityId: string, query: NeighborhoodQuery = {}): Promise<InvestmentNeighborhood> {
    await this.requireEntity(entityId);
    const depth = query.depth ?? 1;
    if (depth !== 1 && depth !== 2) {
      throw new InvestmentAnalyticsError(`depth must be 1 or 2; received ${String(query.depth)}.`);
    }
    const limit = boundedLimit(query.limit, DEFAULT_NEIGHBORHOOD_LIMIT, MAX_NEIGHBORHOOD_LIMIT);
    const relationships = normalizeStringFilter(query.relationships, 'relationships');
    const walkParams: unknown[] = [entityId, depth, limit + 1];
    const relationshipClause = relationships
      ? (() => {
          walkParams.push(relationships);
          return `AND graph_edge.relationship = ANY($${walkParams.length}::text[])`;
        })()
      : '';

    const reachedRows = await this.rows<Record<string, unknown>>(
      `WITH RECURSIVE
       ${NEIGHBORHOOD_GRAPH_CTE},
       walk(node_key, depth, path) AS (
         SELECT 'entity:' || $1, 0, ARRAY['entity:' || $1]::TEXT[]
         UNION ALL
         SELECT
           CASE
             WHEN graph_edge.source_key = walk.node_key THEN graph_edge.target_key
             ELSE graph_edge.source_key
           END,
           walk.depth + 1,
           walk.path || CASE
             WHEN graph_edge.source_key = walk.node_key THEN graph_edge.target_key
             ELSE graph_edge.source_key
           END
         FROM walk
         JOIN graph_edges graph_edge
           ON graph_edge.source_key = walk.node_key OR graph_edge.target_key = walk.node_key
        WHERE walk.depth < $2
          ${relationshipClause}
          AND NOT (
            CASE
              WHEN graph_edge.source_key = walk.node_key THEN graph_edge.target_key
              ELSE graph_edge.source_key
            END = ANY(walk.path)
          )
       )
       SELECT node_key, min(depth)::INTEGER AS depth
         FROM walk
        GROUP BY node_key
        ORDER BY min(depth), node_key
        LIMIT $3`,
      walkParams,
    );
    const truncated = reachedRows.length > limit;
    const selectedRows = reachedRows.slice(0, limit);
    const keys = selectedRows.map((row) => String(row.node_key));
    const depthByKey = new Map(selectedRows.map((row) => [String(row.node_key), Number(row.depth)]));

    const entityIds = keys.filter((key) => key.startsWith('entity:')).map((key) => key.slice(7));
    const topicIds = keys.filter((key) => key.startsWith('topic:')).map((key) => key.slice(6));
    const sectorIds = keys.filter((key) => key.startsWith('sector:')).map((key) => key.slice(7));
    const roundIds = keys.filter((key) => key.startsWith('round:')).map((key) => key.slice(6));
    const [entityRows, topicRows, sectorRows, roundRows] = await Promise.all([
      this.rows<Record<string, unknown>>(
        `SELECT id, display_name, entity_type, slug, primary_url
           FROM intelligence_entities WHERE id = ANY($1::text[])`,
        [entityIds],
      ),
      this.rows<Record<string, unknown>>(
        `SELECT id, slug, label FROM intelligence_topics WHERE id = ANY($1::text[])`,
        [topicIds],
      ),
      this.rows<Record<string, unknown>>(
        `SELECT id, slug, label FROM intelligence_sectors WHERE id = ANY($1::text[])`,
        [sectorIds],
      ),
      this.rows<Record<string, unknown>>(
        `SELECT round.id, round.round_type, round.announced_at,
                company.display_name AS company_display_name
           FROM funding_rounds round
           JOIN intelligence_entities company ON company.id = round.company_entity_id
          WHERE round.id = ANY($1::text[])`,
        [roundIds],
      ),
    ]);

    const edgeParams: unknown[] = [keys, Math.min(limit * 6, 600)];
    const edgeRelationshipClause = relationships
      ? (() => {
          edgeParams.push(relationships);
          return `AND graph_edge.relationship = ANY($${edgeParams.length}::text[])`;
        })()
      : '';
    const edgeRows = await this.rows<Record<string, unknown>>(
      `WITH ${NEIGHBORHOOD_GRAPH_CTE}
       SELECT *
         FROM graph_edges graph_edge
        WHERE graph_edge.source_key = ANY($1::text[])
          AND graph_edge.target_key = ANY($1::text[])
          ${edgeRelationshipClause}
        ORDER BY graph_edge.virtual, graph_edge.relationship, graph_edge.edge_id
        LIMIT $2`,
      edgeParams,
    );

    const relationshipIds = edgeRows.filter((row) => row.source_ref_type === 'relationship').map((row) => String(row.source_ref_id));
    const participantIds = edgeRows.filter((row) => row.source_ref_type === 'participant').map((row) => String(row.source_ref_id));
    const edgeRoundIds = edgeRows.filter((row) => row.source_ref_type === 'round').map((row) => String(row.source_ref_id));
    const [relationshipEvidence, participantEvidence, roundEvidence] = await Promise.all([
      this.evidenceForOwners('relationship', relationshipIds),
      this.evidenceForOwners('participant', participantIds),
      this.evidenceForOwners('round', edgeRoundIds),
    ]);

    const nodes: NeighborhoodNode[] = [
      ...entityRows.map((row) => ({
        key: `entity:${String(row.id)}`,
        id: String(row.id),
        kind: 'entity' as const,
        label: String(row.display_name),
        subtype: String(row.entity_type),
        depth: depthByKey.get(`entity:${String(row.id)}`) ?? depth,
        metadata: { slug: String(row.slug), primaryUrl: optionalString(row.primary_url) },
      })),
      ...topicRows.map((row) => ({
        key: `topic:${String(row.id)}`,
        id: String(row.id),
        kind: 'topic' as const,
        label: String(row.label),
        subtype: 'topic',
        depth: depthByKey.get(`topic:${String(row.id)}`) ?? depth,
        metadata: { slug: String(row.slug) },
      })),
      ...sectorRows.map((row) => ({
        key: `sector:${String(row.id)}`,
        id: String(row.id),
        kind: 'sector' as const,
        label: String(row.label),
        subtype: 'sector',
        depth: depthByKey.get(`sector:${String(row.id)}`) ?? depth,
        metadata: { slug: String(row.slug) },
      })),
      ...roundRows.map((row) => ({
        key: `round:${String(row.id)}`,
        id: String(row.id),
        kind: 'funding_round' as const,
        label: `${String(row.company_display_name)} ${String(row.round_type).replace(/_/g, ' ')}`,
        subtype: String(row.round_type),
        depth: depthByKey.get(`round:${String(row.id)}`) ?? depth,
        metadata: { announcedAt: iso(row.announced_at) },
      })),
    ].sort((left, right) => left.depth - right.depth || left.label.localeCompare(right.label));

    return {
      rootEntityId: entityId,
      depth,
      nodes,
      edges: edgeRows.map((row) => {
        const ownerId = String(row.source_ref_id);
        const evidence = row.source_ref_type === 'relationship'
          ? relationshipEvidence.get(ownerId)
          : row.source_ref_type === 'participant'
            ? participantEvidence.get(ownerId)
            : roundEvidence.get(ownerId);
        return {
          id: String(row.edge_id),
          sourceKey: String(row.source_key),
          targetKey: String(row.target_key),
          relationship: String(row.relationship),
          relationshipBasis: String(row.relationship_basis),
          statementKind: statementKind(row.relationship_basis, row.assertion_class),
          assertionClass: String(row.assertion_class),
          confidence: optionalNumber(row.confidence),
          effectiveAt: iso(row.effective_at),
          virtual: Boolean(row.virtual),
          evidence: evidence ?? [],
        };
      }),
      truncated,
    };
  }

  async getInvestorFit(
    companyEntityId: string,
    investorEntityId: string,
    options: InvestorFitOptions = {},
  ): Promise<InvestorFitScore> {
    const evaluatedAt = options.asOf
      ? normalizeFilterInstant(options.asOf, 'asOf', false)
      : new Date().toISOString();
    const [company, investor] = await Promise.all([
      this.requireEntity(companyEntityId),
      this.requireEntity(investorEntityId),
    ]);
    if (!['portfolio_company', 'strategic_company'].includes(company.entityType)) {
      throw new InvestmentAnalyticsError(`Investor fit requires a company entity; ${companyEntityId} is ${company.entityType}.`);
    }
    if (!['investment_firm', 'person'].includes(investor.entityType)) {
      throw new InvestmentAnalyticsError(`Investor fit requires an investment_firm or person; ${investorEntityId} is ${investor.entityType}.`);
    }

    const [profile, investorRounds, companyRounds, companyInvestors, companySectors, companyTopics, coInvestors] = await Promise.all([
      this.getSectorProfile(investorEntityId, { limit: 100 }),
      this.getFundingRoundsForEntity(investorEntityId, { limit: MAX_RESULT_LIMIT }),
      this.getFundingRoundsForEntity(companyEntityId, { limit: 50 }),
      this.getInvestorsForCompany(companyEntityId, { limit: 100 }),
      this.directSectors(companyEntityId),
      this.technologyTopics(companyEntityId),
      investor.entityType === 'investment_firm'
        ? this.getCoInvestors(investorEntityId, { limit: 100 })
        : Promise.resolve([] as CoInvestorSummary[]),
    ]);

    const limitations: string[] = [
      'This is a deterministic heuristic score, not a probability, recommendation, or statistically calibrated confidence.',
      'Round totals are not investor check sizes; disclosed round amount is therefore not used as check-size evidence.',
      'Geographic fit is unavailable until normalized geography and investment-location history are populated.',
      'Founder-background fit is omitted because proximity or shared employment does not establish investor preference.',
    ];
    if (investorRounds.length === MAX_RESULT_LIMIT) {
      limitations.push(`Investor history reached the bounded ${MAX_RESULT_LIMIT}-round read limit; older activity may be omitted.`);
    }

    const weights: Record<FitComponentKey, number> = {
      sectorFit: 0.35,
      stageFit: 0.20,
      recentActivityFit: 0.15,
      technologyFit: 0.20,
      networkFit: 0.10,
    };

    const sectorTargets = new Set(companySectors.map((sector) => sector.sectorId));
    const matchedSectorExposure = profile.observedInvestmentBehavior.filter((sector) => sectorTargets.has(sector.sectorId));
    const totalSectorInvestments = profile.observedInvestmentBehavior.reduce((sum, sector) => sum + sector.investmentCount, 0);
    const matchedSectorInvestments = matchedSectorExposure.reduce((sum, sector) => sum + sector.investmentCount, 0);
    const sectorAvailable = sectorTargets.size > 0 && totalSectorInvestments > 0;
    if (!companySectors.length) limitations.push('Sector fit is unavailable because the company has no evidence-backed normalized sector assignment.');
    if (!profile.observedInvestmentBehavior.length) limitations.push('Sector fit is unavailable because the investor has no sector-tagged funding-round history.');
    const sectorFit: FitComponent = {
      key: 'sectorFit',
      label: 'Observed sector fit',
      available: sectorAvailable,
      score: sectorAvailable ? clampScore(matchedSectorInvestments / totalSectorInvestments) : undefined,
      weight: weights.sectorFit,
      explanation: sectorAvailable
        ? `${matchedSectorInvestments} of ${totalSectorInvestments} sector-tagged historical round exposures overlap the company sectors.`
        : 'Insufficient normalized company-sector or investor-round exposure data.',
      evidence: matchedSectorExposure.map((sector) => ({
        kind: 'sector',
        label: `${sector.label}: ${sector.investmentCount} historical round exposure(s)`,
        sectorId: sector.sectorId,
        sourceUrls: evidenceUrls(sector.evidence),
      })),
    };

    const currentStage = companyRounds.find((round) => round.roundType !== 'unknown')?.roundType;
    const knownInvestorStages = investorRounds.filter((round) => round.roundType !== 'unknown');
    const matchingStageRounds = currentStage
      ? knownInvestorStages.filter((round) => round.roundType === currentStage)
      : [];
    const stageAvailable = Boolean(currentStage) && knownInvestorStages.length > 0;
    if (!currentStage) limitations.push('Stage fit is unavailable because the company has no established funding-round type.');
    if (!knownInvestorStages.length) limitations.push('Stage fit is unavailable because the investor has no known-stage round history.');
    const stageFit: FitComponent = {
      key: 'stageFit',
      label: 'Historical stage fit',
      available: stageAvailable,
      score: stageAvailable ? clampScore(matchingStageRounds.length / knownInvestorStages.length) : undefined,
      weight: weights.stageFit,
      explanation: stageAvailable
        ? `${matchingStageRounds.length} of ${knownInvestorStages.length} known-stage investor rounds match ${String(currentStage).replace(/_/g, ' ')}.`
        : 'Insufficient company-stage or investor-stage history.',
      evidence: matchingStageRounds.slice(0, 10).map((round) => ({
        kind: 'round',
        label: `${round.company.displayName} ${round.roundType.replace(/_/g, ' ')}`,
        entityId: round.company.id,
        roundId: round.id,
        sourceUrls: evidenceUrls(round.evidence),
      })),
    };

    const asOfDate = new Date(evaluatedAt);
    const recentCutoff = new Date(asOfDate);
    recentCutoff.setUTCFullYear(recentCutoff.getUTCFullYear() - 2);
    const datedInvestorRounds = investorRounds.filter((round) => round.announcedAt && Date.parse(round.announcedAt) <= asOfDate.getTime());
    const recentRounds = datedInvestorRounds.filter((round) => Date.parse(round.announcedAt ?? '') >= recentCutoff.getTime());
    const recentAvailable = datedInvestorRounds.length > 0;
    if (!recentAvailable) limitations.push('Recent activity fit is unavailable because the investor has no dated funding-round history.');
    const recentActivityFit: FitComponent = {
      key: 'recentActivityFit',
      label: 'Recent verified activity',
      available: recentAvailable,
      // Six verified rounds in 24 months reaches the v1 activity ceiling. This
      // threshold is an explicit heuristic, not a population-derived statistic.
      score: recentAvailable ? clampScore(recentRounds.length / 6) : undefined,
      weight: weights.recentActivityFit,
      explanation: recentAvailable
        ? `${recentRounds.length} evidence-backed round(s) occurred in the 24 months ending ${evaluatedAt.slice(0, 10)}; v1 caps this component at six.`
        : 'No dated investor rounds are available.',
      evidence: recentRounds.slice(0, 10).map((round) => ({
        kind: 'round',
        label: `${round.company.displayName} on ${round.announcedAt?.slice(0, 10) ?? 'undated'}`,
        entityId: round.company.id,
        roundId: round.id,
        sourceUrls: evidenceUrls(round.evidence),
      })),
    };

    const affinityByTopic = new Map(profile.publicSignalAffinity.map((topic) => [topic.topicId, topic]));
    const matchedTopics = companyTopics.filter((topic) => affinityByTopic.has(topic.topicId));
    const technologyAvailable = companyTopics.length > 0 && profile.publicSignalAffinity.length > 0;
    const technologyScore = technologyAvailable
      ? companyTopics.reduce((sum, topic) => sum + (affinityByTopic.get(topic.topicId)?.affinityScore ?? 0), 0) / companyTopics.length
      : undefined;
    if (!companyTopics.length) limitations.push('Technology fit is unavailable because the company has no evidence-backed technology topics.');
    if (!profile.publicSignalAffinity.length) limitations.push('Technology fit is unavailable because the investor has no public-signal topic affinity.');
    const technologyFit: FitComponent = {
      key: 'technologyFit',
      label: 'Public technology affinity',
      available: technologyAvailable,
      score: technologyScore === undefined ? undefined : clampScore(technologyScore),
      weight: weights.technologyFit,
      explanation: technologyAvailable
        ? `${matchedTopics.length} of ${companyTopics.length} company technology topic(s) appear in the investor's public signals.`
        : 'Insufficient evidence-backed company topics or investor public-signal affinity.',
      evidence: matchedTopics.map((topic) => {
        const affinity = affinityByTopic.get(topic.topicId);
        return {
          kind: 'topic',
          label: `${topic.label}: public affinity ${affinity?.affinityScore.toFixed(2) ?? '0.00'}`,
          topicId: topic.topicId,
          sourceUrls: [...new Set([
            ...evidenceUrls(topic.evidence),
            ...evidenceUrls(affinity?.evidence ?? []),
          ])],
        };
      }),
    };

    const existingInvestorIds = companyInvestors
      .map((entry) => entry.investor.id)
      .filter((id) => id !== investorEntityId);
    const coInvestorById = new Map(coInvestors.map((entry) => [entry.firm.id, entry]));
    const matchedNetwork = existingInvestorIds
      .map((id) => coInvestorById.get(id))
      .filter((entry): entry is CoInvestorSummary => Boolean(entry));
    const networkAvailable = investor.entityType === 'investment_firm' && existingInvestorIds.length > 0 && coInvestors.length > 0;
    if (!existingInvestorIds.length) limitations.push('Network fit is unavailable because the company has no other persisted round investors.');
    if (investor.entityType !== 'investment_firm') limitations.push('Firm syndicate fit is not calculated for a person entity.');
    const networkFit: FitComponent = {
      key: 'networkFit',
      label: 'Historical syndicate fit',
      available: networkAvailable,
      score: networkAvailable ? clampScore(matchedNetwork.length / existingInvestorIds.length) : undefined,
      weight: weights.networkFit,
      explanation: networkAvailable
        ? `${matchedNetwork.length} of ${existingInvestorIds.length} existing company investor(s) have shared verified rounds with this firm.`
        : 'Insufficient company-investor or candidate co-investor history.',
      evidence: matchedNetwork.map((entry) => ({
        kind: 'co_investor',
        label: `${entry.firm.displayName}: ${entry.sharedRoundCount} shared verified round(s)`,
        entityId: entry.firm.id,
        sourceUrls: evidenceUrls(entry.evidence),
      })),
    };

    const components: Record<FitComponentKey, FitComponent> = {
      sectorFit,
      stageFit,
      recentActivityFit,
      technologyFit,
      networkFit,
    };
    const availableComponents = Object.values(components).filter(
      (component): component is FitComponent & { score: number } => component.available && component.score !== undefined,
    );
    const availableWeight = availableComponents.reduce((sum, component) => sum + component.weight, 0);
    const overallScore = availableWeight > 0
      ? clampScore(availableComponents.reduce((sum, component) => sum + component.score * component.weight, 0) / availableWeight)
      : undefined;

    return {
      scoreKind: 'HEURISTIC',
      scoringVersion: 'vc-fit-v1',
      company,
      investor,
      overallScore,
      components,
      evidence: distinctFitEvidence(Object.values(components).flatMap((component) => component.evidence)),
      limitations,
      evaluatedAt,
    };
  }

  private async directSectors(entityId: string): Promise<Array<{
    sectorId: string;
    label: string;
    evidence: AnalyticsEvidence[];
  }>> {
    const rows = await this.rows<Record<string, unknown>>(
      `SELECT assignment.id AS assignment_id, sector.id AS sector_id, sector.label
         FROM entity_sector_assignments assignment
         JOIN intelligence_sectors sector ON sector.id = assignment.sector_id AND sector.active
        WHERE assignment.entity_id = $1
          AND assignment.assignment_basis IN ('source_fact', 'operator')
        ORDER BY sector.label`,
      [entityId],
    );
    const evidence = await this.evidenceForOwners('sector_assignment', rows.map((row) => String(row.assignment_id)));
    return rows.map((row) => ({
      sectorId: String(row.sector_id),
      label: String(row.label),
      evidence: evidence.get(String(row.assignment_id)) ?? [],
    }));
  }

  private async technologyTopics(entityId: string): Promise<Array<{
    topicId: string;
    label: string;
    evidence: AnalyticsEvidence[];
  }>> {
    const rows = await this.rows<Record<string, unknown>>(
      `WITH topic_evidence AS (
         SELECT relationship.to_topic_id AS topic_id, source.signal_id
           FROM entity_relationships relationship
           LEFT JOIN relationship_sources source ON source.relationship_id = relationship.id
          WHERE relationship.from_entity_id = $1
            AND relationship.to_topic_id IS NOT NULL
            AND relationship.relationship IN ('uses_technology', 'interested_in')
         UNION
         SELECT signal_topic.topic_id, signal_entity.signal_id
           FROM signal_entities signal_entity
           JOIN signal_topics signal_topic ON signal_topic.signal_id = signal_entity.signal_id
          WHERE signal_entity.entity_id = $1
       )
       SELECT topic.id AS topic_id, topic.label,
              array_remove(array_agg(DISTINCT topic_evidence.signal_id), NULL) AS signal_ids
         FROM topic_evidence
         JOIN intelligence_topics topic ON topic.id = topic_evidence.topic_id
        GROUP BY topic.id, topic.label
        ORDER BY topic.label
        LIMIT 100`,
      [entityId],
    );
    const signalIds = [...new Set(rows.flatMap((row) => stringArray(row.signal_ids)))];
    const evidence = await this.evidenceForSignals(signalIds);
    return rows.map((row) => ({
      topicId: String(row.topic_id),
      label: String(row.label),
      evidence: distinctEvidence(stringArray(row.signal_ids).flatMap((id) => evidence.get(id) ?? [])),
    }));
  }

  private async requireEntity(entityId: string): Promise<EntitySummary> {
    if (!entityId.trim()) throw new InvestmentAnalyticsError('entityId is required.');
    const rows = await this.rows<Record<string, unknown>>(
      `SELECT id, slug, display_name, entity_type, primary_url
         FROM intelligence_entities
        WHERE id = $1`,
      [entityId],
    );
    if (!rows[0]) throw new InvestmentAnalyticsError(`Entity ${entityId} was not found.`);
    return entityFromRow(rows[0]);
  }

  private async evidenceForOwners(
    ownerKind: 'round' | 'participant' | 'relationship' | 'sector_assignment',
    ownerIds: readonly string[],
  ): Promise<Map<string, AnalyticsEvidence[]>> {
    const uniqueOwnerIds = [...new Set(ownerIds.filter(Boolean))];
    if (!uniqueOwnerIds.length) return new Map();
    const config = {
      round: { table: 'funding_round_sources', ownerColumn: 'funding_round_id' },
      participant: { table: 'funding_round_participant_sources', ownerColumn: 'participant_id' },
      relationship: { table: 'relationship_sources', ownerColumn: 'relationship_id' },
      sector_assignment: { table: 'sector_assignment_sources', ownerColumn: 'assignment_id' },
    }[ownerKind];
    // table and ownerColumn come exclusively from the closed mapping above;
    // every caller-controlled value remains a PostgreSQL parameter.
    const rows = await this.rows<EvidenceOwnerRow>(
      `SELECT
         provenance.${config.ownerColumn} AS owner_id,
         provenance.signal_id,
         signal.source_id,
         signal.source_url,
         signal.source_kind,
         signal.title,
         signal.excerpt,
         signal.published_at,
         signal.retrieved_at,
         provenance.extraction_claim_id,
         provenance.evidence_text
       FROM ${config.table} provenance
       JOIN intelligence_signals signal ON signal.id = provenance.signal_id
      WHERE provenance.${config.ownerColumn} = ANY($1::text[])
      ORDER BY provenance.${config.ownerColumn},
               COALESCE(signal.published_at, signal.retrieved_at) DESC,
               signal.id`,
      [uniqueOwnerIds],
    );
    const byOwner = new Map<string, AnalyticsEvidence[]>();
    for (const row of rows) {
      const current = byOwner.get(String(row.owner_id)) ?? [];
      current.push(this.evidenceFromRow(row));
      byOwner.set(String(row.owner_id), current);
    }
    return byOwner;
  }

  private async evidenceForSignals(signalIds: readonly string[]): Promise<Map<string, AnalyticsEvidence[]>> {
    const uniqueSignalIds = [...new Set(signalIds.filter(Boolean))];
    if (!uniqueSignalIds.length) return new Map();
    const rows = await this.rows<EvidenceOwnerRow>(
      `SELECT
         signal.id AS owner_id,
         signal.id AS signal_id,
         signal.source_id,
         signal.source_url,
         signal.source_kind,
         signal.title,
         signal.excerpt,
         signal.published_at,
         signal.retrieved_at,
         NULL::TEXT AS extraction_claim_id,
         NULL::TEXT AS evidence_text
       FROM intelligence_signals signal
      WHERE signal.id = ANY($1::text[])
      ORDER BY COALESCE(signal.published_at, signal.retrieved_at) DESC, signal.id`,
      [uniqueSignalIds],
    );
    return new Map(rows.map((row) => [String(row.owner_id), [this.evidenceFromRow(row)]]));
  }

  private evidenceFromRow(row: EvidenceOwnerRow): AnalyticsEvidence {
    return {
      signalId: String(row.signal_id),
      sourceId: optionalString(row.source_id),
      sourceUrl: String(row.source_url),
      sourceKind: String(row.source_kind),
      title: optionalString(row.title),
      // The exact supporting quote is returned separately as evidenceText.
      // Bounding the general source excerpt prevents one portfolio response
      // from repeating an 8KB document for every round and participant.
      excerpt: optionalString(row.excerpt)?.slice(0, 800),
      publishedAt: iso(row.published_at),
      retrievedAt: iso(row.retrieved_at) ?? '',
      extractionClaimId: optionalString(row.extraction_claim_id),
      evidenceText: optionalString(row.evidence_text),
    };
  }

  private async rows<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return [...await this.executor.query(sql, params)] as T[];
  }
}

function evidenceUrls(evidence: readonly AnalyticsEvidence[]): string[] {
  return [...new Set(evidence.map((record) => record.sourceUrl).filter(Boolean))];
}

function distinctFitEvidence(evidence: readonly FitComponentEvidence[]): FitComponentEvidence[] {
  const result = new Map<string, FitComponentEvidence>();
  for (const item of evidence) {
    const key = [item.kind, item.entityId, item.sectorId, item.topicId, item.roundId, item.label].join(':');
    const current = result.get(key);
    result.set(key, current ? {
      ...current,
      sourceUrls: [...new Set([...current.sourceUrls, ...item.sourceUrls])],
    } : item);
  }
  return [...result.values()];
}
