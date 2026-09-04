import { createId, getPool } from '@dacai-local-agent/shared';
import type { StructuredGenerator } from '@dacai-local-agent/providers';
import { EntityStore, SourceStore, type Entity } from './entities.js';
import { SignalStore, type SignalRow } from './signals.js';
import { ThemeExtractor, TopicStore, hostOf } from './themes.js';
import { GraphStore, inference } from './graph.js';
import { CapabilityStore, type Capability } from './capabilities.js';
import { EvidenceAgent, detectEvidenceGaps, type EvidenceRecord } from './evidence-agent.js';
import { MetricEngine } from './metrics.js';
import { OpportunityStore, scoreOpportunity, DEFAULT_WEIGHTS, type ScoringWeights, type AssetType } from './opportunity.js';
import { VisualRecommender } from './visuals.js';
import { ResearchProviderError, type PublicResearchProvider, type SearchHit } from './research/provider.js';
import { WebSearchProvider, DirectPageProvider, RssProvider, PublicGitHubProvider, ExaProvider, FirecrawlProvider } from './research/adapters.js';
import { SourcePolicyError, type PublicSourceKind } from './sources.js';
import { InvestmentFactExtractor } from './investment-extraction.js';
import {
  InvestmentPipeline,
  type InvestmentBatchResult,
  type InvestmentSignalPipelineResult,
} from './investment-pipeline.js';

/**
 * Orchestration.
 *
 * The nine agent roles from the design are logical, not processes: SignalAgent
 * and ResearchAgent are `collect()`, ThemeAgent is `extractThemes()`,
 * RelationshipGraphAgent is `buildGraph()`, EvidenceAgent and PerformanceAgent
 * are their own modules, and RiskGuard runs inside narrative generation. They
 * share one database connection, one model router, and one provider registry,
 * which is what makes them composable rather than nine services to operate.
 */

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
  investmentExtraction: InvestmentCollectionMetrics;
  /** Refusals and failures, surfaced rather than swallowed. */
  notes: string[];
}

export interface InvestmentCollectionMetrics {
  signalsProcessed: number;
  claimsPersisted: number;
  noFacts: number;
  ambiguous: number;
  rejected: number;
  failed: number;
  skipped: number;
}

export interface IntelligenceServiceOptions {
  generator: StructuredGenerator;
  providers?: PublicResearchProvider[];
  weights?: ScoringWeights;
  workspaceRoot?: string;
}

export class IntelligenceService {
  readonly entities = new EntityStore();
  readonly sources = new SourceStore();
  readonly signals = new SignalStore();
  readonly topics = new TopicStore();
  readonly graph = new GraphStore();
  readonly capabilities = new CapabilityStore();
  readonly evidence: EvidenceAgent;
  readonly metrics = new MetricEngine();
  readonly opportunities = new OpportunityStore();
  readonly investmentPipeline: InvestmentPipeline;

  private readonly themeExtractor: ThemeExtractor;
  private readonly visuals = new VisualRecommender();
  private readonly providers: PublicResearchProvider[];
  private readonly weights: ScoringWeights;

  constructor(private readonly options: IntelligenceServiceOptions) {
    this.themeExtractor = new ThemeExtractor(options.generator);
    this.investmentPipeline = new InvestmentPipeline(new InvestmentFactExtractor(options.generator));
    this.evidence = new EvidenceAgent(undefined, undefined, options.workspaceRoot);
    this.weights = options.weights ?? DEFAULT_WEIGHTS;
    this.providers = options.providers ?? [
      new WebSearchProvider(),
      new DirectPageProvider(),
      new RssProvider(),
      new PublicGitHubProvider(),
      new ExaProvider(),
      new FirecrawlProvider(),
    ];
  }

  /** Which research adapters are usable right now, and why the rest are not. */
  providerStatus(): Array<{ id: string; available: boolean; reason?: string }> {
    return this.providers.map((provider) => ({
      id: provider.id,
      available: provider.available(),
      reason: provider.unavailableReason(),
    }));
  }

  /**
   * Collect public signals for one entity.
   *
   * Every stage records what happened, including nothing happening. A run that
   * retrieves zero signals writes a row saying so — otherwise a silent network
   * failure is indistinguishable from an entity with no public activity, and
   * the operator draws the wrong conclusion from an empty screen.
   */
  async collect(input: {
    entityId: string;
    queries?: string[];
    maxSources?: number;
    trigger?: 'manual' | 'api' | 'scheduled' | 'proof';
    signal?: AbortSignal;
  }): Promise<CollectionResult> {
    // Fails closed on a private individual before any query is issued.
    const entity = await this.entities.requireResearchable(input.entityId);

    const runId = createId('run');
    const notes: string[] = [];
    const providersUsed = new Set<string>();
    const maxSources = Math.max(1, Math.min(input.maxSources ?? 12, 40));

    await getPool().query(
      `INSERT INTO intelligence_collection_runs (id, entity_id, trigger) VALUES ($1,$2,$3)`,
      [runId, entity.id, input.trigger ?? 'manual'],
    );

    const queries = input.queries?.length ? input.queries : defaultQueriesFor(entity);
    const candidates = new Map<string, SearchHit>();
    let sourceFailures = 0;

    // --- discovery ---------------------------------------------------------
    const search = this.providers.find((provider) => provider.id === 'exa' && provider.available())
      ?? this.providers.find((provider) => provider.id === 'duckduckgo');

    for (const query of queries) {
      if (!search) break;
      try {
        const hits = await search.search(query, { limit: 8, signal: input.signal });
        providersUsed.add(search.id);
        for (const hit of hits) {
          if (!candidates.has(hit.url)) candidates.set(hit.url, hit);
        }
      } catch (error) {
        sourceFailures += 1;
        notes.push(describeError(`search "${query}"`, error));
      }
    }

    // The entity's own site is authoritative for what it says about itself, so
    // it is crawled shallowly regardless of what search returned.
    if (entity.primaryUrl) {
      const direct = this.providers.find((provider) => provider.id === 'direct-page');
      try {
        const links = await direct?.discover(entity.primaryUrl, { limit: 15, signal: input.signal }) ?? [];
        providersUsed.add('direct-page');
        candidates.set(entity.primaryUrl, {
          url: entity.primaryUrl, title: entity.displayName, provider: 'direct-page',
        });
        for (const link of links.slice(0, 10)) {
          if (!candidates.has(link.url)) candidates.set(link.url, link);
        }
      } catch (error) {
        sourceFailures += 1;
        notes.push(describeError(`discover ${entity.primaryUrl}`, error));
      }
    }

    // --- retrieval + ingestion --------------------------------------------
    let ingested = 0;
    let duplicates = 0;
    let rejected = 0;
    const investmentExtraction = emptyInvestmentCollectionMetrics();
    const directFetcher = this.providers.find((provider) => provider.id === 'direct-page')!;
    const preferredFetcher = this.providers.find((provider) => provider.id === 'firecrawl' && provider.available())
      ?? directFetcher;

    for (const hit of [...candidates.values()].slice(0, maxSources)) {
      try {
        let document;
        try {
          document = await preferredFetcher.fetch(hit.url, { signal: input.signal });
          providersUsed.add(preferredFetcher.id);
        } catch (preferredError) {
          if (preferredFetcher.id === directFetcher.id) throw preferredError;
          notes.push(describeError(`${preferredFetcher.id} fallback for ${hit.url}`, preferredError));
          document = await directFetcher.fetch(hit.url, { signal: input.signal });
          providersUsed.add(directFetcher.id);
        }

        const kind = classifySourceKind(hit.url);
        const source = await this.sources.register({
          entityId: entity.id,
          url: document.url,
          kind,
          title: document.title ?? hit.title,
          license: 'public-web-page: retrieved from a publicly accessible URL for research and analysis',
        }).catch(() => undefined);

        const stored = await this.signals.ingest({
          document: { ...document, publishedAt: document.publishedAt ?? hit.publishedAt },
          sourceKind: kind,
          license: 'public-web-page: retrieved from a publicly accessible URL for research and analysis',
          entityIds: [entity.id],
          sourceId: source?.id,
        });

        if (stored.status === 'ingested') ingested += 1;
        else if (stored.status === 'duplicate') duplicates += 1;
        else {
          rejected += 1;
          if (stored.rejectionReason) notes.push(`${hit.url}: ${stored.rejectionReason}`);
        }
        if (stored.id) {
          try {
            const extraction = await this.investmentPipeline.processSignal(stored.id, { signal: input.signal });
            recordInvestmentExtraction(investmentExtraction, extraction);
            if (extraction.error && ['ambiguous', 'rejected', 'failed'].includes(extraction.status)) {
              notes.push(`Investment extraction ${extraction.status} for ${hit.url}: ${extraction.error}`);
            }
          } catch (error) {
            investmentExtraction.signalsProcessed += 1;
            investmentExtraction.failed += 1;
            notes.push(describeError(`investment extraction for ${hit.url}`, error));
          }
        }
        if (source) await this.sources.recordFetch(source.id, stored.status, false);
      } catch (error) {
        if (error instanceof SourcePolicyError) {
          rejected += 1;
          notes.push(`REFUSED ${hit.url}: ${error.message}`);
        } else {
          sourceFailures += 1;
          notes.push(describeError(hit.url, error));
        }
      }
    }

    await getPool().query(
      `UPDATE intelligence_collection_runs
          SET providers_used = $2, queries_issued = $3, sources_discovered = $4,
              signals_ingested = $5, duplicates = $6, rejected = $7,
              source_failures = $8, investment_signals_processed = $9,
              investment_claims_persisted = $10, investment_no_facts = $11,
              investment_ambiguous = $12, investment_rejected = $13,
              investment_failed = $14, finished_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify([...providersUsed]), queries.length, candidates.size,
       ingested, duplicates, rejected, sourceFailures,
       investmentExtraction.signalsProcessed, investmentExtraction.claimsPersisted,
       investmentExtraction.noFacts, investmentExtraction.ambiguous,
       investmentExtraction.rejected, investmentExtraction.failed],
    );

    return {
      runId,
      entityId: entity.id,
      entityName: entity.displayName,
      queriesIssued: queries.length,
      sourcesDiscovered: candidates.size,
      signalsIngested: ingested,
      duplicates,
      rejected,
      sourceFailures,
      providersUsed: [...providersUsed],
      investmentExtraction,
      notes,
    };
  }

  /** Extract and persist missing VC facts from signals already attached to an entity. */
  async extractInvestmentFacts(entityId: string, limit = 20, signal?: AbortSignal): Promise<InvestmentBatchResult> {
    await this.entities.requireResearchable(entityId);
    const result = await this.investmentPipeline.processUnprocessedEntitySignals({ entityId, limit, signal });
    const persistedSignalIds = result.results
      .filter((item) => item.status === 'persisted')
      .map((item) => item.signalId);

    if (persistedSignalIds.length) {
      const { rows } = await getPool().query<{ entity_id: string }>(
        `SELECT DISTINCT entity_id
           FROM signal_entities
          WHERE signal_id = ANY($1::TEXT[])`,
        [persistedSignalIds],
      );
      await Promise.all(rows.map((row) => this.topics.recomputeStrengths(row.entity_id)));
    }

    return result;
  }

  /**
   * Extract themes for an entity's un-analyzed signals, then recompute strengths.
   *
   * The model labels; `recomputeStrengths` produces every number afterward.
   */
  async extractThemes(entityId: string, limit = 20, signal?: AbortSignal): Promise<{
    signalsAnalyzed: number;
    topicsTouched: number;
    themesRejected: number;
    modelUsed?: string;
    fellBack: boolean;
  }> {
    const { rows } = await getPool().query(
      `SELECT s.* FROM intelligence_signals s
         JOIN signal_entities se ON se.signal_id = s.id
        WHERE se.entity_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM signal_topics st
             WHERE st.signal_id = s.id
               AND 'theme_extraction' = ANY(st.origins)
          )
        ORDER BY coalesce(s.published_at, s.retrieved_at) DESC
        LIMIT $2`,
      [entityId, Math.max(1, Math.min(limit, 100))],
    );

    let analyzed = 0;
    let rejectedThemes = 0;
    let modelUsed: string | undefined;
    let fellBack = false;
    const touched = new Set<string>();

    for (const row of rows) {
      const signalRow = toSignalRow(row);
      try {
        const extraction = await this.themeExtractor.extract(signalRow, { signal });
        modelUsed = extraction.model;
        if (extraction.fellBackFrom) fellBack = true;

        for (const theme of extraction.themes) {
          const topic = await this.topics.upsertTopic(theme.label, theme.description);
          await this.topics.linkSignal(signalRow.id, topic.id, theme.relevance);
          touched.add(topic.id);
        }
        analyzed += 1;
      } catch {
        // A signal the model could not process is left un-analyzed so a later
        // run retries it, rather than being marked done with no themes.
        rejectedThemes += 1;
      }
    }

    await this.topics.recomputeStrengths(entityId);
    return { signalsAnalyzed: analyzed, topicsTouched: touched.size, themesRejected: rejectedThemes, modelUsed, fellBack };
  }

  /**
   * Build graph edges from the recomputed theme strengths.
   *
   * Interest in a theme is an INFERENCE — the platform's reading of what an
   * entity's published output is about — and is stored as one, with confidence
   * and a rationale naming the signals it came from.
   */
  async buildGraph(entityId: string, minImportance = 0.25): Promise<{ edges: number }> {
    const strengths = await this.topics.strengthsFor(entityId, 40);
    let edges = 0;

    for (const strength of strengths) {
      if (strength.importance < minImportance) continue;

      const { rows } = await getPool().query<{ signal_id: string }>(
        `SELECT st.signal_id FROM signal_topics st
           JOIN signal_entities se ON se.signal_id = st.signal_id
          WHERE st.topic_id = $1 AND se.entity_id = $2
          LIMIT 20`,
        [strength.id, entityId],
      );
      const signalIds = rows.map((row) => row.signal_id);

      await this.graph.upsert(
        inference({
          fromEntityId: entityId,
          toTopicId: strength.id,
          relationship: 'interested_in',
          confidence: strength.importance,
          supportingSignalIds: signalIds,
          rationale:
            `${strength.signalCount} signal(s) across ${strength.sourceCount} distinct publisher(s) ` +
            `discuss "${strength.label}"; weighted recency ${strength.timeDecay.toFixed(2)}.`,
        }),
      );
      edges += 1;
    }

    return { edges };
  }

  /**
   * Score content opportunities at the intersection of an entity's themes and
   * DACAIS capabilities that have evidence.
   *
   * Capabilities without evidence are excluded up front, so an opportunity can
   * never be built on an unsupported claim.
   */
  async findOpportunities(input: {
    entityId: string;
    minImportance?: number;
    maxOpportunities?: number;
    signal?: AbortSignal;
  }): Promise<Array<{ id: string; headline: string; score: number; confidence: number }>> {
    const entity = await this.entities.requireResearchable(input.entityId);
    const strengths = await this.topics.strengthsFor(entity.id, 20);
    const capabilities = await this.capabilities.publishable();
    const measuredMetrics = await this.metrics.measured();

    if (!capabilities.length) {
      throw new IntelligenceError(
        'No DACAIS capability has both a verified status and attached evidence. ' +
          'Run evidence collection before scoring opportunities — an opportunity built on an ' +
          'unsupported capability is exactly what this system exists to prevent.',
      );
    }

    const created: Array<{ id: string; headline: string; score: number; confidence: number }> = [];
    const minImportance = input.minImportance ?? 0.2;

    for (const strength of strengths.slice(0, input.maxOpportunities ?? 8)) {
      if (strength.importance < minImportance) continue;

      const matched = await this.matchCapabilities(strength.label, capabilities);
      if (!matched.capabilities.length) continue;

      const evidence = await this.evidenceForCapabilities(matched.capabilities);
      const signals = await this.signalsForTopic(strength.id, entity.id);

      const score = scoreOpportunity(
        {
          themeImportance: strength.importance,
          evidenceCount: evidence.length,
          evidenceKinds: new Set(evidence.map((record) => record.kind)).size,
          signalDates: signals.map((row) => row.publishedAt),
          distinctSources: new Set(signals.map((row) => hostOf(row.sourceUrl))).size,
          capabilities: matched.capabilities,
          existingContentCount: await this.contentCountForTopic(strength.id),
          audienceIsTechnical: true,
        },
        this.weights,
      );

      const visual = this.visuals.recommend({
        capabilities: matched.capabilities,
        themeLabel: strength.label,
        hasMeasuredMetric: measuredMetrics.length > 0,
        assetType: 'technical_essay',
      });

      const gaps = detectEvidenceGaps(
        matched.capabilities,
        new Map(matched.capabilities.map((capability) => [capability.id, capability.evidenceCount])),
      );

      const record = await this.opportunities.create({
        entityId: entity.id,
        topicId: strength.id,
        headline: `${strength.label} — intersection with ${matched.capabilities[0].name}`,
        signalSummary:
          `${strength.signalCount} public signal(s) across ${strength.sourceCount} publisher(s) ` +
          `discuss ${strength.label}.`,
        whyItMatters: matched.reasoning,
        dacaisIntersection: matched.capabilities
          .map((capability) => `${capability.name} [${capability.status}]`)
          .join('; '),
        missingEvidence: gaps.map((gap) => `${gap.capabilityName}: ${gap.reason}`).join('; ') || undefined,
        recommendedAssetType: recommendAssetType(matched.capabilities),
        suggestedVisualKind: visual.kind,
        suggestedVisual: visual.mermaid ?? visual.requiresHuman,
        suggestedMetricId: measuredMetrics[0]?.id,
        risks: describeRisks(matched.capabilities),
        reasoning: [...score.explanation, `Visual: ${visual.rationale}`].join('\n'),
        score: score.score,
        scoreComponents: score.weighted as unknown as Record<string, number>,
        confidence: score.confidence,
        signalIds: signals.map((row) => row.id),
        evidenceIds: evidence.map((record) => record.id),
      });

      created.push({
        id: record.id,
        headline: record.headline,
        score: record.score,
        confidence: record.confidence,
      });
    }

    return created.sort((a, b) => b.score - a.score);
  }

  /**
   * Semantic match between a public theme and DACAIS capabilities.
   *
   * Uses the existing pgvector corpus rather than asking the model which
   * capabilities are relevant: retrieval over real capability descriptions is
   * reproducible, and a model asked "which of these 12 apply" will find a way
   * to relate all of them.
   */
  private async matchCapabilities(
    themeLabel: string,
    capabilities: readonly Capability[],
  ): Promise<{ capabilities: Capability[]; reasoning: string }> {
    const themeTokens = new Set(
      themeLabel.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4),
    );

    const scored = capabilities
      .map((capability) => {
        const haystack = `${capability.name} ${capability.description}`.toLowerCase();
        const overlap = [...themeTokens].filter((token) => haystack.includes(token)).length;
        return { capability, overlap };
      })
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 4);

    if (scored.length) {
      return {
        capabilities: scored.map((entry) => entry.capability),
        reasoning:
          `"${themeLabel}" overlaps directly with ${scored.map((entry) => entry.capability.name).join(', ')}.`,
      };
    }

    // No lexical overlap: fall back to semantic retrieval over the corpus.
    const hits = await this.evidence.search(themeLabel, 4).catch(() => []);
    if (!hits.length) return { capabilities: [], reasoning: '' };

    const related = capabilities.filter((capability) =>
      hits.some((hit) =>
        hit.filePath.toLowerCase().includes(capability.slug.split('-')[0]) ||
        hit.excerpt.toLowerCase().includes(capability.name.toLowerCase()),
      ),
    ).slice(0, 3);

    return {
      capabilities: related,
      reasoning: related.length
        ? `"${themeLabel}" relates to ${related.map((capability) => capability.name).join(', ')} ` +
          'through retrieved repository evidence rather than a direct name match.'
        : '',
    };
  }

  private async evidenceForCapabilities(capabilities: readonly Capability[]): Promise<EvidenceRecord[]> {
    const all: EvidenceRecord[] = [];
    for (const capability of capabilities) {
      all.push(...await this.evidence.forCapability(capability.id));
    }
    return all;
  }

  private async signalsForTopic(topicId: string, entityId: string): Promise<SignalRow[]> {
    const { rows } = await getPool().query(
      `SELECT s.* FROM intelligence_signals s
         JOIN signal_topics st ON st.signal_id = s.id
         JOIN signal_entities se ON se.signal_id = s.id
        WHERE st.topic_id = $1 AND se.entity_id = $2
        ORDER BY coalesce(s.published_at, s.retrieved_at) DESC
        LIMIT 20`,
      [topicId, entityId],
    );
    return rows.map(toSignalRow);
  }

  private async contentCountForTopic(topicId: string): Promise<number> {
    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM content_assets ca
         JOIN content_opportunities co ON co.id = ca.opportunity_id
        WHERE co.topic_id = $1 AND ca.state IN ('HUMAN_APPROVED','EXPORTED','PUBLISHED','MEASURED')`,
      [topicId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

function emptyInvestmentCollectionMetrics(): InvestmentCollectionMetrics {
  return {
    signalsProcessed: 0,
    claimsPersisted: 0,
    noFacts: 0,
    ambiguous: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };
}

function recordInvestmentExtraction(
  metrics: InvestmentCollectionMetrics,
  result: InvestmentSignalPipelineResult,
): void {
  metrics.claimsPersisted += result.persistedCount;
  if (result.skipped) {
    metrics.skipped += 1;
    return;
  }
  metrics.signalsProcessed += 1;
  if (result.status === 'no_facts') metrics.noFacts += 1;
  else if (result.status === 'ambiguous') metrics.ambiguous += 1;
  else if (result.status === 'rejected') metrics.rejected += 1;
  else if (result.status === 'failed') metrics.failed += 1;
}

export class IntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntelligenceError';
  }
}

/**
 * Default research queries.
 *
 * Every one is about published professional output. There is no query template
 * that reaches for a person's background, circumstances, or whereabouts.
 */
function defaultQueriesFor(entity: Entity): string[] {
  const name = entity.displayName;
  if (entity.entityType === 'person') {
    return [
      `"${name}" partner investment portfolio`,
      `"${name}" led investment funding round`,
      `"${name}" founded OR previously worked at`,
      `"${name}" investment thesis interview`,
    ];
  }
  return [
    `"${name}" portfolio investments`,
    `"${name}" led Series A OR seed funding`,
    `"${name}" participated funding round`,
    entity.primaryUrl
      ? `site:${safeHost(entity.primaryUrl)} "${name}" portfolio OR companies`
      : `"${name}" investment thesis`,
  ];
}

function safeHost(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Source kind from URL shape. Conservative: unknown shapes become a website. */
function classifySourceKind(url: string): PublicSourceKind {
  const lower = url.toLowerCase();
  if (lower.includes('github.com')) return 'public_github_activity';
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'public_video_description';
  if (/\/(blog|posts?|writing|essays?)\//.test(lower)) return 'public_blog';
  if (/\/(news|press|announcements?)\//.test(lower)) return 'press_release';
  if (/\/(portfolio|companies|investments)\b/.test(lower)) return 'public_portfolio_page';
  if (lower.includes('arxiv.org') || lower.includes('/papers/')) return 'public_research_paper';
  if (lower.includes('podcast') || lower.includes('/episodes/')) return 'public_podcast';
  if (lower.includes('linkedin.com')) return 'public_professional_post';
  return 'public_website';
}

function recommendAssetType(capabilities: readonly Capability[]): AssetType {
  const working = capabilities.filter(
    (capability) => capability.status === 'PRODUCTION' || capability.status === 'WORKING_PROTOTYPE',
  );
  if (working.some((capability) => capability.demonstrable)) return 'demo_description';
  if (working.length >= 2) return 'architecture_explainer';
  if (working.length === 1) return 'technical_essay';
  return 'short_technical_update';
}

function describeRisks(capabilities: readonly Capability[]): string {
  const future = capabilities.filter(
    (capability) => capability.status !== 'PRODUCTION' && capability.status !== 'WORKING_PROTOTYPE',
  );
  if (!future.length) {
    return 'Every referenced capability is at working-prototype status or above; present-tense description is accurate.';
  }
  return (
    `Do not imply production deployment of: ${future.map((c) => `${c.name} (${c.status})`).join(', ')}. ` +
    'Frame these as architecture and direction. The risk guard blocks a present-tense claim about them.'
  );
}

function describeError(context: string, error: unknown): string {
  if (error instanceof ResearchProviderError) return `${context}: [${error.code}] ${error.message}`;
  return `${context}: ${error instanceof Error ? error.message : String(error)}`;
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
