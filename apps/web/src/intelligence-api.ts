/**
 * Typed client for the investor & ecosystem intelligence API.
 *
 * Follows the same bare-relative-path convention as api.ts (the dev server
 * proxies /api to the backend). Kept in its own file because the domain has
 * its own, fairly large, request/response surface.
 */

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* keep raw body */
    }
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });

export interface Entity {
  id: string;
  slug: string;
  displayName: string;
  entityType: string;
  professionalSummary?: string;
  primaryUrl?: string;
  isPublicProfessional: boolean;
  watchEnabled: boolean;
  notes?: string;
}

export interface ThemeStrength {
  id: string;
  slug: string;
  label: string;
  description?: string;
  importance: number;
  timeDecay: number;
  signalCount: number;
  sourceCount: number;
  newestSignal?: string;
}

export interface GraphEdgeRow {
  id: string;
  relationship: string;
  statementKind: string;
  assertionClass: string;
  confidence?: number;
  sourceCount: number;
  rationale?: string;
  targetLabel?: string;
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

export interface EntitySummary {
  id: string;
  slug: string;
  displayName: string;
  entityType: string;
  primaryUrl?: string;
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
  roundType: string;
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

export interface CompanyInvestor {
  investor: EntitySummary;
  roundCount: number;
  firstInvestmentAt?: string;
  lastInvestmentAt?: string;
  hasLed: boolean;
  rounds: Array<{
    roundId: string;
    roundType: string;
    announcedAt?: string;
    amount?: string;
    currency?: string;
    role: string;
    leadStatus: string;
    evidence: AnalyticsEvidence[];
  }>;
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

export interface SectorProfile {
  entityId: string;
  window: { from?: string; to?: string };
  observedInvestmentBehavior: Array<{
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
  }>;
  publicSignalAffinity: Array<{
    topicId: string;
    slug: string;
    label: string;
    affinityScore: number;
    signalCount: number;
    sourceCount: number;
    newestSignal?: string;
    evidence: AnalyticsEvidence[];
  }>;
}

export interface InvestmentTimelineEvent {
  id: string;
  kind: 'funding_round';
  occurredAt?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  company: EntitySummary;
  roundId: string;
  roundType: string;
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
  statementKind: string;
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

export interface InvestmentNeighborhood {
  rootEntityId: string;
  depth: 1 | 2;
  nodes: Array<{
    key: string;
    id: string;
    kind: 'entity' | 'topic' | 'sector' | 'funding_round';
    label: string;
    subtype?: string;
    depth: number;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    sourceKey: string;
    targetKey: string;
    relationship: string;
    relationshipBasis: string;
    statementKind: string;
    assertionClass: string;
    confidence?: number;
    effectiveAt?: string;
    virtual: boolean;
    evidence: AnalyticsEvidence[];
  }>;
  truncated: boolean;
}

export type FitComponentKey = 'sectorFit' | 'stageFit' | 'recentActivityFit' | 'technologyFit' | 'networkFit';

export interface InvestorFitScore {
  scoreKind: 'HEURISTIC';
  scoringVersion: string;
  company: EntitySummary;
  investor: EntitySummary;
  overallScore?: number;
  components: Record<FitComponentKey, {
    key: FitComponentKey;
    label: string;
    available: boolean;
    score?: number;
    weight: number;
    explanation: string;
    evidence: Array<{
      kind: string;
      label: string;
      entityId?: string;
      sectorId?: string;
      topicId?: string;
      roundId?: string;
      sourceUrls: string[];
    }>;
  }>;
  evidence: Array<{ kind: string; label: string; sourceUrls: string[] }>;
  limitations: string[];
  evaluatedAt: string;
}

export interface TemporalQuery {
  from?: string;
  to?: string;
  limit?: number;
}

export interface SourceRecord {
  id: string;
  url: string;
  kind: string;
  title?: string;
  enabled: boolean;
  failureCount: number;
  lastFetchAt?: string;
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
  assertionClass: string;
  sourceCount: number;
}

export interface CollectionResult {
  runId: string;
  entityId: string;
  entityName: string;
  queriesIssued: number;
  sourcesDiscovered: number;
  signalsIngested: number;
  duplicates: number;
  rejected: number;
  sourceFailures: number;
  providersUsed: string[];
  investmentExtraction: {
    signalsProcessed: number;
    claimsPersisted: number;
    noFacts: number;
    ambiguous: number;
    rejected: number;
    failed: number;
    skipped: number;
  };
  notes: string[];
}

export interface InvestmentExtractionBatch {
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
}

export interface Capability {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  demonstrable: boolean;
  publiclyShareable: boolean;
  safePhrasing?: string;
  operatorDeclared: boolean;
  lastVerifiedAt?: string;
  evidenceCount: number;
}

export interface EvidenceRecord {
  id: string;
  capabilityId?: string;
  kind: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  symbolName?: string;
  testName?: string;
  excerpt?: string;
  locator?: string;
  collectedAt: string;
}

export interface ClaimRecord {
  id: string;
  capabilityId?: string;
  text: string;
  status: string;
  confidence?: number;
  supportingEvidenceCount: number;
  contradictingEvidenceCount: number;
}

export interface EvidenceGap {
  capabilitySlug: string;
  capabilityName: string;
  status: string;
  reason: string;
  recommendedAction: string;
}

export interface MetricRecord {
  id: string;
  slug: string;
  label: string;
  unit?: string;
  status: 'MEASURED' | 'NEEDS_MEASUREMENT' | 'STALE';
  value?: number;
  valueText?: string;
  measurementSource?: string;
  measuredAt?: string;
}

export interface OpportunityRecord {
  id: string;
  entityId?: string;
  topicId?: string;
  headline: string;
  signalSummary: string;
  whyItMatters: string;
  dacaisIntersection: string;
  missingEvidence?: string;
  recommendedAssetType: string;
  suggestedVisualKind?: string;
  suggestedVisual?: string;
  risks?: string;
  reasoning: string;
  score: number;
  scoreComponents: Record<string, number>;
  confidence: number;
  status: string;
  createdAt: string;
}

export interface ContentAsset {
  id: string;
  opportunityId?: string;
  channelId?: string;
  assetType: string;
  title?: string;
  body: string;
  audience?: string;
  tone?: string;
  visualKind?: string;
  visualSpec?: string;
  state: string;
  riskFindings: Array<{ severity: string; code: string; message: string; excerpt?: string; remedy?: string }>;
  unsupportedStatements: string[];
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  generatedByModel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentAuditRow {
  fromState?: string;
  toState: string;
  action: string;
  actor: string;
  detail?: string;
  occurredAt: string;
}

export interface Channel {
  id: string;
  slug: string;
  name: string;
  channelType: string;
  audience?: string;
  fitNotes?: string;
  norms?: string;
  publishingEnabled: boolean;
  enabled: boolean;
}

export interface DiligenceQuestion {
  id: string;
  question: string;
  answer: string;
  score: 'STRONG' | 'INCOMPLETE' | 'UNSUPPORTED' | 'DANGEROUS';
  evidenceCount: number;
  betterAnswer?: string;
  missingEvidence?: string;
  requiredAction?: string;
}

export interface DiligenceSession {
  id: string;
  role: string;
  questions: DiligenceQuestion[];
  strongCount: number;
  unsupportedCount: number;
  dangerousCount: number;
}

export interface Brief {
  generatedAt: string;
  items: Array<{ opportunity: OpportunityRecord; rank: number }>;
  belowThresholdCount: number;
}

export interface Overview {
  entitiesTracked: number;
  capabilities: { total: number; publishable: number };
  opportunities: { total: number; highConfidence: number };
  draftsAwaitingReview: number;
  evidenceGaps: number;
  metrics: { measured: number; needsMeasurement: number };
}

export const intelligenceApi = {
  policy: () => call<{ policy: string }>('/api/intelligence/policy'),
  providers: () => call<{ providers: Array<{ id: string; available: boolean; reason?: string }> }>('/api/intelligence/providers'),
  overview: () => call<Overview>('/api/intelligence/overview'),

  entityTypes: () => call<{ entityTypes: string[] }>('/api/intelligence/entity-types'),
  listEntities: (params?: { entityType?: string; watchedOnly?: boolean }) =>
    call<{ entities: Entity[] }>(`/api/intelligence/entities${qs(params)}`),
  createEntity: (input: { displayName: string; entityType: string; primaryUrl?: string; professionalSummary?: string; isPublicProfessional?: boolean }) =>
    post<{ entity: Entity }>('/api/intelligence/entities', input),
  getEntity: (id: string) =>
    call<{ entity: Entity; themes: ThemeStrength[]; relationships: GraphEdgeRow[]; sources: SourceRecord[]; opportunities: OpportunityRecord[] }>(
      `/api/intelligence/entities/${id}`,
    ),
  entitySignals: (id: string, days = 90) =>
    call<{ signals: SignalRow[] }>(`/api/intelligence/entities/${id}/signals?days=${days}`),

  getPortfolio: (id: string, params?: TemporalQuery) =>
    call<{ portfolio: PortfolioEntry[] }>(`/api/intelligence/entities/${encodeURIComponent(id)}/portfolio${qs({ ...params })}`),
  getFundingRounds: (id: string, params?: TemporalQuery) =>
    call<{ rounds: FundingRoundSummary[] }>(`/api/intelligence/entities/${encodeURIComponent(id)}/funding-rounds${qs({ ...params })}`),
  getFundingRound: (id: string) =>
    call<{ round: FundingRoundDetail }>(`/api/intelligence/funding-rounds/${encodeURIComponent(id)}`),
  getCompanyInvestors: (id: string, params?: TemporalQuery) =>
    call<{ investors: CompanyInvestor[] }>(`/api/intelligence/companies/${encodeURIComponent(id)}/investors${qs({ ...params })}`),
  getCoInvestors: (id: string, params?: TemporalQuery) =>
    call<{ coInvestors: CoInvestorSummary[] }>(`/api/intelligence/entities/${encodeURIComponent(id)}/co-investors${qs({ ...params })}`),
  getSectorProfile: (id: string, params?: TemporalQuery) =>
    call<{ profile: SectorProfile }>(`/api/intelligence/entities/${encodeURIComponent(id)}/sector-profile${qs({ ...params })}`),
  getInvestmentTimeline: (id: string, params?: TemporalQuery) =>
    call<{ events: InvestmentTimelineEvent[] }>(`/api/intelligence/entities/${encodeURIComponent(id)}/investment-timeline${qs({ ...params })}`),
  getRelationships: (id: string, params?: TemporalQuery & {
    direction?: 'incoming' | 'outgoing' | 'both';
    relationship?: string;
    assertionClass?: string;
    relationshipBasis?: string;
  }) => call<{ relationships: RichRelationship[] }>(
    `/api/intelligence/entities/${encodeURIComponent(id)}/relationships${qs({ ...params })}`,
  ),
  getNeighborhood: (id: string, params?: { depth?: 1 | 2; limit?: number; relationship?: string }) =>
    call<{ neighborhood: InvestmentNeighborhood }>(
      `/api/intelligence/entities/${encodeURIComponent(id)}/neighborhood${qs({ ...params })}`,
    ),
  getInvestorFits: (companyId: string, params?: { investorId?: string; asOf?: string; limit?: number }) =>
    call<{ fits: InvestorFitScore[]; scoringMethod: 'HEURISTIC'; disclaimer: string }>(
      `/api/intelligence/companies/${encodeURIComponent(companyId)}/investor-fits${qs({ ...params })}`,
    ),

  collect: (id: string, body?: { queries?: string[]; maxSources?: number }) =>
    post<{ result: CollectionResult }>(`/api/intelligence/entities/${id}/collect`, body ?? {}),
  extractThemes: (id: string, limit?: number) =>
    post<{ result: { signalsAnalyzed: number; topicsTouched: number; themesRejected: number; fellBack: boolean } }>(
      `/api/intelligence/entities/${id}/extract-themes`, { limit },
    ),
  extractInvestments: (id: string, limit?: number) =>
    post<{ result: InvestmentExtractionBatch }>(
      `/api/intelligence/entities/${id}/extract-investments`, { limit },
    ),
  buildGraph: (id: string, minImportance?: number) =>
    post<{ result: { edges: number } }>(`/api/intelligence/entities/${id}/build-graph`, { minImportance }),
  findOpportunities: (id: string, body?: { minImportance?: number; maxOpportunities?: number }) =>
    post<{ opportunities: Array<{ id: string; headline: string; score: number; confidence: number }> }>(
      `/api/intelligence/entities/${id}/find-opportunities`, body ?? {},
    ),

  listCapabilities: (publishableOnly?: boolean) =>
    call<{ capabilities: Capability[] }>(`/api/intelligence/capabilities${qs({ publishableOnly })}`),
  createCapability: (input: { name: string; description: string; status?: string; operatorDeclared?: boolean }) =>
    post<{ capability: Capability }>('/api/intelligence/capabilities', input),
  promoteCapability: (slug: string, body: { status: string; demonstrable?: boolean; publiclyShareable?: boolean }) =>
    post<{ capability: Capability }>(`/api/intelligence/capabilities/${slug}/promote`, body),
  getCapability: (slug: string) =>
    call<{ capability: Capability; evidence: EvidenceRecord[]; claims: ClaimRecord[] }>(`/api/intelligence/capabilities/${slug}`),
  evidenceGaps: () => call<{ gaps: EvidenceGap[] }>('/api/intelligence/evidence-gaps'),
  searchEvidence: (q: string, limit = 8) =>
    call<{ hits: Array<{ kind: string; filePath: string; symbolName?: string; startLine?: number; endLine?: number; excerpt: string; distance?: number }> }>(
      `/api/intelligence/evidence/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  recordEvidence: (input: { capabilityId?: string; kind: string; filePath?: string; startLine?: number; endLine?: number; symbolName?: string; testName?: string; excerpt?: string }) =>
    post<{ evidence: EvidenceRecord }>('/api/intelligence/evidence', input),

  listMetrics: () => call<{ metrics: MetricRecord[] }>('/api/intelligence/metrics'),
  refreshMetrics: () => post<{ metrics: MetricRecord[] }>('/api/intelligence/metrics/refresh'),

  listOpportunities: (limit = 10, minConfidence = 0) =>
    call<{ opportunities: OpportunityRecord[] }>(`/api/intelligence/opportunities?limit=${limit}&minConfidence=${minConfidence}`),
  getOpportunity: (id: string) =>
    call<{ opportunity: OpportunityRecord; signals: SignalRow[]; evidence: EvidenceRecord[] }>(`/api/intelligence/opportunities/${id}`),
  draftFromOpportunity: (id: string, body?: { assetType?: string; audience?: string; tone?: string }) =>
    post<{ asset: ContentAsset; findings: unknown[]; blocked: boolean }>(`/api/intelligence/opportunities/${id}/draft`, body ?? {}),

  brief: (minConfidence?: number, maxItems?: number) =>
    call<{ brief: Brief; text: string }>(`/api/intelligence/brief${qs({ minConfidence, maxItems })}`),

  assetTypes: () => call<{ assetTypes: string[] }>('/api/intelligence/asset-types'),
  listContent: (state?: string) => call<{ assets: ContentAsset[] }>(`/api/intelligence/content${qs({ state })}`),
  getContent: (id: string) => call<{ asset: ContentAsset; audit: ContentAuditRow[] }>(`/api/intelligence/content/${id}`),
  riskReview: (id: string) => post<{ asset: ContentAsset; findings: unknown[]; blocked: boolean }>(`/api/intelligence/content/${id}/risk-review`),
  submitContent: (id: string) => post<{ asset: ContentAsset }>(`/api/intelligence/content/${id}/submit`),
  approveContent: (id: string) => post<{ asset: ContentAsset }>(`/api/intelligence/content/${id}/approve`),
  rejectContent: (id: string, reason: string) => post<{ asset: ContentAsset }>(`/api/intelligence/content/${id}/reject`, { reason }),
  editContent: (id: string, body: { body?: string; title?: string; audience?: string; tone?: string }) =>
    post<{ asset: ContentAsset }>(`/api/intelligence/content/${id}/edit`, body),
  exportContent: (id: string) => call<{ text: string; asset: ContentAsset }>(`/api/intelligence/content/${id}/export`),

  listChannels: () => call<{ channels: Channel[] }>('/api/intelligence/channels'),
  seedChannels: () => post<{ created: number }>('/api/intelligence/channels/seed-defaults'),
  recommendChannels: (contentId: string) =>
    post<{ recommendations: Array<{ channel: Channel; fit: string; reasoning: string; cautions: string[] }> }>(
      `/api/intelligence/content/${contentId}/recommend-channels`,
    ),

  diligenceRoles: () => call<{ roles: string[] }>('/api/intelligence/diligence/roles'),
  runDiligence: (body: { role: string; focus?: string; questionCount?: number }) =>
    post<{ session: DiligenceSession }>('/api/intelligence/diligence/run', body),
  diligenceBacklog: (limit = 50) =>
    call<{ backlog: Array<DiligenceQuestion & { sessionRole: string }> }>(`/api/intelligence/diligence/backlog?limit=${limit}`),

  generateMemo: (body: { subjectName?: string; publicSourceUrls?: string[] }) =>
    post<{ memo: { id: string; title: string; recommendation: string; sections: Record<string, unknown> } }>('/api/intelligence/memo', body),
};

function qs(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== '');
  if (!entries.length) return '';
  return `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')}`;
}
