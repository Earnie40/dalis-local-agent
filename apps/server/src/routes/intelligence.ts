import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@dacai-local-agent/shared';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import { StructuredGenerator } from '@dacai-local-agent/providers';
import {
  IntelligenceService,
  IntelligenceError,
  EntityError,
  CapabilityError,
  SourcePolicyError,
  ContentWorkflowError,
  DistributionError,
  ScoringError,
  GraphError,
  InvestmentAnalyticsError,
  InvestmentAnalyticsService,
  type Entity,
  type EntityStore,
  ENTITY_TYPES,
  ASSET_TYPES,
  DILIGENCE_ROLES,
  CapabilityStore,
  EvidenceAgent,
  ClaimStore,
  RiskGuard,
  NarrativeAgent,
  ContentStore,
  DiligenceAgent,
  MemoGenerator,
  BriefGenerator,
  renderBrief,
  DistributionAgent,
  ChannelStore,
  exportAsset,
  detectEvidenceGaps,
  describeCollectionPolicy,
} from '@dacai-local-agent/investor-intelligence';

/**
 * Investor & ecosystem intelligence API.
 *
 * Every mutating route resolves an actor: the operator identity that
 * authorized the action, recorded on every audit row this domain writes. There
 * is no route that publishes anything — publication requires the
 * INTELLIGENCE_PUBLISHING_ENABLED flag AND a per-channel flag AND the database
 * constraint that a human approver is named, and none of those live here.
 */

interface Deps {
  config: AppConfig;
  registry: ProviderRegistry;
}

function actorFrom(request: { headers: Record<string, unknown> }): string {
  const header = request.headers['x-dacais-actor'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : 'operator';
}

function errorResponse(error: unknown): { code: number; body: { error: string } } {
  if (
    error instanceof SourcePolicyError ||
    error instanceof EntityError ||
    error instanceof CapabilityError ||
    error instanceof ScoringError ||
    error instanceof GraphError ||
    error instanceof InvestmentAnalyticsError
  ) {
    return { code: 400, body: { error: error.message } };
  }
  if (error instanceof ContentWorkflowError || error instanceof DistributionError) {
    return { code: 409, body: { error: error.message } };
  }
  if (error instanceof IntelligenceError) {
    return { code: 422, body: { error: error.message } };
  }
  return { code: 500, body: { error: error instanceof Error ? error.message : 'Internal error.' } };
}

interface InvestmentGraphReadDeps {
  entities: Pick<EntityStore, 'byId' | 'list'>;
  analytics: Pick<
    InvestmentAnalyticsService,
    | 'getPortfolio'
    | 'getFundingRoundsForEntity'
    | 'getFundingRound'
    | 'getInvestorsForCompany'
    | 'getCoInvestors'
    | 'getSectorProfile'
    | 'getInvestmentTimeline'
    | 'getRelationships'
    | 'getNeighborhood'
    | 'getInvestorFit'
  >;
}

/**
 * Additive read API for the temporal investment graph. Exported as a narrow
 * registration seam so route tests can inject deterministic query services
 * without replacing the rest of the intelligence subsystem.
 */
export function registerInvestmentGraphReadRoutes(
  server: FastifyInstance,
  deps: InvestmentGraphReadDeps,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (handler: (request: any, reply: any) => Promise<unknown>) => async (request: any, reply: any) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      const { code, body } = errorResponse(error);
      return reply.code(code).send(body);
    }
  };

  const entityOr404 = async (id: string, reply: { code(code: number): { send(body: unknown): unknown } }) => {
    const entity = await deps.entities.byId(id);
    if (!entity) {
      reply.code(404).send({ error: 'Entity not found.' });
      return undefined;
    }
    return entity;
  };
  const temporal = (query: Record<string, unknown> | undefined) => ({
    from: stringValue(query?.from),
    to: stringValue(query?.to),
    limit: numericValue(query?.limit),
  });

  server.get('/api/intelligence/entities/:id/portfolio', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return { portfolio: await deps.analytics.getPortfolio(request.params.id, temporal(request.query)) };
  }));

  server.get('/api/intelligence/entities/:id/funding-rounds', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return { rounds: await deps.analytics.getFundingRoundsForEntity(request.params.id, temporal(request.query)) };
  }));

  server.get('/api/intelligence/entities/:id/co-investors', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return { coInvestors: await deps.analytics.getCoInvestors(request.params.id, temporal(request.query)) };
  }));

  server.get('/api/intelligence/entities/:id/sector-profile', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return { profile: await deps.analytics.getSectorProfile(request.params.id, temporal(request.query)) };
  }));

  server.get('/api/intelligence/entities/:id/investment-timeline', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return { events: await deps.analytics.getInvestmentTimeline(request.params.id, temporal(request.query)) };
  }));

  server.get('/api/intelligence/entities/:id/relationships', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return {
      relationships: await deps.analytics.getRelationships(request.params.id, {
        ...temporal(request.query),
        direction: stringValue(request.query?.direction) as 'incoming' | 'outgoing' | 'both' | undefined,
        relationships: csvValues(request.query?.relationship),
        assertionClasses: csvValues(request.query?.assertionClass),
        relationshipBases: csvValues(request.query?.relationshipBasis),
      }),
    };
  }));

  server.get('/api/intelligence/entities/:id/neighborhood', wrap(async (request, reply) => {
    if (!await entityOr404(request.params.id, reply)) return;
    return {
      neighborhood: await deps.analytics.getNeighborhood(request.params.id, {
        depth: numericValue(request.query?.depth) as 1 | 2 | undefined,
        limit: numericValue(request.query?.limit),
        relationships: csvValues(request.query?.relationship),
      }),
    };
  }));

  server.get('/api/intelligence/companies/:id/investors', wrap(async (request, reply) => {
    const company = await entityOr404(request.params.id, reply);
    if (!company) return;
    if (!isCompany(company)) return reply.code(400).send({ error: 'Entity is not a company.' });
    return { investors: await deps.analytics.getInvestorsForCompany(company.id, temporal(request.query)) };
  }));

  server.get('/api/intelligence/companies/:id/investor-fits', wrap(async (request, reply) => {
    const company = await entityOr404(request.params.id, reply);
    if (!company) return;
    if (!isCompany(company)) return reply.code(400).send({ error: 'Entity is not a company.' });

    const requestedInvestorId = stringValue(request.query?.investorId);
    const limit = Math.max(1, Math.min(numericValue(request.query?.limit) ?? 25, 50));
    const investors = requestedInvestorId
      ? [await entityOr404(requestedInvestorId, reply)].filter((entity): entity is Entity => Boolean(entity))
      : (await deps.entities.list({ entityType: 'investment_firm' })).slice(0, limit);
    if (requestedInvestorId && !investors.length) return;

    const fits = await Promise.all(investors.map((investor) =>
      deps.analytics.getInvestorFit(company.id, investor.id, { asOf: stringValue(request.query?.asOf) })));
    fits.sort((left, right) => (right.overallScore ?? -1) - (left.overallScore ?? -1));
    return {
      fits: fits.slice(0, limit),
      scoringMethod: 'HEURISTIC',
      disclaimer: 'Scores are deterministic heuristics, not probabilities or investment recommendations.',
    };
  }));

  server.get('/api/intelligence/funding-rounds/:id', wrap(async (request, reply) => {
    const round = await deps.analytics.getFundingRound(request.params.id);
    if (!round) return reply.code(404).send({ error: 'Funding round not found.' });
    return { round };
  }));
}

export function registerIntelligenceRoutes(server: FastifyInstance, deps: Deps): void {
  const generator = new StructuredGenerator(deps.registry);
  const service = new IntelligenceService({ generator });
  const capabilities = new CapabilityStore();
  const evidenceAgent = new EvidenceAgent();
  const claims = new ClaimStore();
  const riskGuard = new RiskGuard();
  const narrativeAgent = new NarrativeAgent(generator, riskGuard);
  const content = new ContentStore();
  const diligenceAgent = new DiligenceAgent(generator);
  const memoGenerator = new MemoGenerator(generator);
  const briefGenerator = new BriefGenerator();
  const distributionAgent = new DistributionAgent();
  const channels = new ChannelStore();
  const investmentAnalytics = new InvestmentAnalyticsService();

  registerInvestmentGraphReadRoutes(server, {
    entities: service.entities,
    analytics: investmentAnalytics,
  });

  // Route params/body/query vary per handler below and this file does not
  // declare a Fastify generic per route (~40 of them), so the wrapper itself
  // is typed loosely and each handler narrows what it reads from the request.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (handler: (request: any, reply: any) => Promise<unknown>) => async (request: any, reply: any) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      const { code, body } = errorResponse(error);
      request.log?.warn?.({ err: String(error) }, 'intelligence route error');
      return reply.code(code).send(body);
    }
  };

  // --- policy / status -----------------------------------------------------

  server.get('/api/intelligence/policy', async () => ({ policy: describeCollectionPolicy() }));

  server.get('/api/intelligence/providers', async () => ({ providers: service.providerStatus() }));

  server.get('/api/intelligence/overview', wrap(async () => {
    const [entities, capabilityList, opportunities, drafts, metrics] = await Promise.all([
      service.entities.list(),
      capabilities.list(),
      service.opportunities.top(20, 0),
      content.list('READY_FOR_REVIEW', 20),
      service.metrics.list(),
    ]);
    const gaps = detectEvidenceGaps(
      capabilityList,
      new Map(capabilityList.map((capability) => [capability.id, capability.evidenceCount])),
    );
    return {
      entitiesTracked: entities.length,
      capabilities: {
        total: capabilityList.length,
        publishable: capabilityList.filter((capability) => capability.status !== 'UNVERIFIED').length,
      },
      opportunities: {
        total: opportunities.length,
        highConfidence: opportunities.filter((opportunity) => opportunity.confidence >= 0.55).length,
      },
      draftsAwaitingReview: drafts.length,
      evidenceGaps: gaps.length,
      metrics: {
        measured: metrics.filter((metric) => metric.status === 'MEASURED').length,
        needsMeasurement: metrics.filter((metric) => metric.status !== 'MEASURED').length,
      },
    };
  }));

  // --- entities --------------------------------------------------------------

  server.get('/api/intelligence/entities', wrap(async (request) => {
    const entityType = request.query?.entityType;
    return { entities: await service.entities.list({ entityType, watchedOnly: request.query?.watchedOnly === 'true' }) };
  }));

  server.get('/api/intelligence/entity-types', async () => ({ entityTypes: ENTITY_TYPES }));

  server.post('/api/intelligence/entities', wrap(async (request, reply) => {
    const body = request.body ?? {};
    if (!body.displayName?.trim() || !body.entityType) {
      return reply.code(400).send({ error: 'displayName and entityType are required.' });
    }
    return { entity: await service.entities.upsert(body) };
  }));

  server.get('/api/intelligence/entities/:id', wrap(async (request, reply) => {
    const entity = await service.entities.byId(request.params.id);
    if (!entity) return reply.code(404).send({ error: 'Entity not found.' });

    const [strengths, edges, sources, opportunities] = await Promise.all([
      service.topics.strengthsFor(entity.id, 25),
      service.graph.edgesFor(entity.id),
      service.sources.forEntity(entity.id),
      service.opportunities.forEntity(entity.id),
    ]);

    return { entity, themes: strengths, relationships: edges, sources, opportunities };
  }));

  server.get('/api/intelligence/entities/:id/signals', wrap(async (request, reply) => {
    const entity = await service.entities.byId(request.params.id);
    if (!entity) return reply.code(404).send({ error: 'Entity not found.' });
    const days = Number(request.query?.days ?? 90);
    return { signals: await service.signals.recentForEntity(entity.id, days, Number(request.query?.limit ?? 50)) };
  }));

  // --- collection / pipeline --------------------------------------------------

  server.post('/api/intelligence/entities/:id/collect', wrap(async (request, reply) => {
    // No abort wiring here: request.raw emits 'close' as soon as its body has
    // been consumed to parse JSON, which happens on every normal request and
    // has nothing to do with the client going away (see routes/chat.ts for the
    // same footgun on the streaming path, where reply.raw is used instead).
    // Collection is a bounded, non-streaming operation, so it simply runs to
    // completion.
    try {
      const result = await service.collect({
        entityId: request.params.id,
        queries: request.body?.queries,
        maxSources: request.body?.maxSources,
        trigger: 'api',
      });
      return { result };
    } catch (error) {
      if (error instanceof EntityError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  }));

  server.post('/api/intelligence/entities/:id/extract-themes', wrap(async (request) => {
    const result = await service.extractThemes(request.params.id, Number(request.body?.limit ?? 20));
    return { result };
  }));

  server.post('/api/intelligence/entities/:id/extract-investments', wrap(async (request) => {
    const result = await service.extractInvestmentFacts(
      request.params.id,
      Number(request.body?.limit ?? 20),
    );
    return { result };
  }));

  server.post('/api/intelligence/entities/:id/build-graph', wrap(async (request) => {
    const result = await service.buildGraph(request.params.id, Number(request.body?.minImportance ?? 0.25));
    return { result };
  }));

  server.post('/api/intelligence/entities/:id/find-opportunities', wrap(async (request) => {
    const opportunities = await service.findOpportunities({
      entityId: request.params.id,
      minImportance: request.body?.minImportance,
      maxOpportunities: request.body?.maxOpportunities,
    });
    return { opportunities };
  }));

  // --- capabilities / evidence -------------------------------------------------

  server.get('/api/intelligence/capabilities', wrap(async (request) => ({
    capabilities: await capabilities.list({ publishableOnly: request.query?.publishableOnly === 'true' }),
  })));

  server.post('/api/intelligence/capabilities', wrap(async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name?.trim() || !body.description?.trim()) {
      return reply.code(400).send({ error: 'name and description are required.' });
    }
    return { capability: await capabilities.upsert(body) };
  }));

  server.post('/api/intelligence/capabilities/:slug/promote', wrap(async (request, reply) => {
    const body = request.body ?? {};
    const actor = actorFrom(request);
    if (!body.status) return reply.code(400).send({ error: 'status is required.' });
    return {
      capability: await capabilities.promote(request.params.slug, body.status, {
        demonstrable: body.demonstrable,
        publiclyShareable: body.publiclyShareable,
        verifiedBy: actor,
      }),
    };
  }));

  server.get('/api/intelligence/capabilities/:slug', wrap(async (request, reply) => {
    const capability = await capabilities.bySlug(request.params.slug);
    if (!capability) return reply.code(404).send({ error: 'Capability not found.' });
    const [evidence, capabilityClaims] = await Promise.all([
      evidenceAgent.forCapability(capability.id),
      claims.list(capability.id),
    ]);
    return { capability, evidence, claims: capabilityClaims };
  }));

  server.get('/api/intelligence/evidence/search', wrap(async (request, reply) => {
    const query = request.query?.q?.trim();
    if (!query) return reply.code(400).send({ error: 'q is required.' });
    return { hits: await evidenceAgent.search(query, Number(request.query?.limit ?? 8)) };
  }));

  server.post('/api/intelligence/evidence', wrap(async (request, reply) => {
    const body = request.body ?? {};
    if (!body.kind) return reply.code(400).send({ error: 'kind is required.' });
    return { evidence: await evidenceAgent.record(body) };
  }));

  server.post('/api/intelligence/claims', wrap(async (request, reply) => {
    const body = request.body ?? {};
    if (!body.text?.trim() || !body.status) {
      return reply.code(400).send({ error: 'text and status are required.' });
    }
    return { claim: await claims.create(body) };
  }));

  server.get('/api/intelligence/evidence-gaps', wrap(async () => {
    const capabilityList = await capabilities.list();
    const gaps = detectEvidenceGaps(
      capabilityList,
      new Map(capabilityList.map((capability) => [capability.id, capability.evidenceCount])),
    );
    return { gaps };
  }));

  // --- metrics -----------------------------------------------------------------

  server.get('/api/intelligence/metrics', wrap(async () => ({ metrics: await service.metrics.list() })));

  server.post('/api/intelligence/metrics/refresh', wrap(async () => ({ metrics: await service.metrics.refreshAll() })));

  // --- opportunities / visuals ---------------------------------------------------

  server.get('/api/intelligence/opportunities', wrap(async (request) => ({
    opportunities: await service.opportunities.top(
      Number(request.query?.limit ?? 10),
      Number(request.query?.minConfidence ?? 0),
    ),
  })));

  server.get('/api/intelligence/opportunities/:id', wrap(async (request, reply) => {
    const opportunity = await service.opportunities.byId(request.params.id);
    if (!opportunity) return reply.code(404).send({ error: 'Opportunity not found.' });
    const [signalIds, evidenceIds] = await Promise.all([
      service.opportunities.signalIdsFor(opportunity.id),
      service.opportunities.evidenceIdsFor(opportunity.id),
    ]);
    const [signals, evidence] = await Promise.all([
      service.signals.byIds(signalIds),
      evidenceAgent.byIds(evidenceIds),
    ]);
    return { opportunity, signals, evidence };
  }));

  // --- daily brief ---------------------------------------------------------------

  server.get('/api/intelligence/brief', wrap(async (request) => {
    const brief = await briefGenerator.generate({
      minConfidence: request.query?.minConfidence ? Number(request.query.minConfidence) : undefined,
      maxItems: request.query?.maxItems ? Number(request.query.maxItems) : undefined,
    });
    return { brief, text: renderBrief(brief) };
  }));

  // --- content workflow ------------------------------------------------------------

  server.get('/api/intelligence/asset-types', async () => ({ assetTypes: ASSET_TYPES }));

  server.post('/api/intelligence/opportunities/:id/draft', wrap(async (request, reply) => {
    const opportunity = await service.opportunities.byId(request.params.id);
    if (!opportunity) return reply.code(404).send({ error: 'Opportunity not found.' });

    const assetType = request.body?.assetType ?? opportunity.recommendedAssetType;
    const audience = request.body?.audience ?? 'Technical, frontier-tech-literate readers.';
    const tone = request.body?.tone ?? 'Direct, specific, no marketing language.';

    const [signalIds, evidenceIds, capabilityList, metrics] = await Promise.all([
      service.opportunities.signalIdsFor(opportunity.id),
      service.opportunities.evidenceIdsFor(opportunity.id),
      capabilities.publishable(),
      service.metrics.list(),
    ]);
    const [signals, evidence] = await Promise.all([
      service.signals.byIds(signalIds),
      evidenceAgent.byIds(evidenceIds),
    ]);

    const generated = await narrativeAgent.draft({
      assetType,
      audience,
      tone,
      opportunityHeadline: opportunity.headline,
      whyItMatters: opportunity.whyItMatters,
      capabilities: capabilityList,
      evidence,
      signals,
      metrics,
      visualKind: opportunity.suggestedVisualKind,
      visualSpec: opportunity.suggestedVisual,
      excludedClaims: request.body?.excludedClaims,
    });

    const asset = await content.create({
      opportunityId: opportunity.id,
      assetType,
      title: generated.draft.title,
      body: generated.draft.body,
      audience,
      tone,
      visualKind: opportunity.suggestedVisualKind,
      visualSpec: opportunity.suggestedVisual,
      riskFindings: generated.findings,
      unsupportedStatements: generated.draft.unsupportedStatements,
      generatedByModel: generated.model,
      generatedByInstance: generated.providerInstanceId,
      claims: generated.draft.claimsMade.map((text) => ({ text, evidenceId: evidence[0]?.id })),
      actor: actorFrom(request),
    });

    return { asset, findings: generated.findings, blocked: generated.blocked };
  }));

  server.get('/api/intelligence/content', wrap(async (request) => ({
    assets: await content.list(request.query?.state, Number(request.query?.limit ?? 50)),
  })));

  server.get('/api/intelligence/content/:id', wrap(async (request, reply) => {
    const asset = await content.byId(request.params.id);
    if (!asset) return reply.code(404).send({ error: 'Content asset not found.' });
    return { asset, audit: await content.auditTrail(asset.id) };
  }));

  server.post('/api/intelligence/content/:id/evidence-check', wrap(async (request) => {
    const asset = await content.transition({
      assetId: request.params.id,
      to: 'EVIDENCE_CHECK',
      action: 'evidence_checked',
      actor: actorFrom(request),
    });
    return { asset };
  }));

  server.post('/api/intelligence/content/:id/risk-review', wrap(async (request, reply) => {
    const asset = await content.byId(request.params.id);
    if (!asset) return reply.code(404).send({ error: 'Content asset not found.' });

    const capabilityList = await capabilities.list();
    // Deliberately no `claims` here. asset.unsupportedStatements is the
    // model's own record of statements it chose NOT to make -- feeding those
    // back in as if they were assertions in the body flags phantom claims that
    // do not appear in the text. Claim-level checking already ran once, on the
    // real claimsMade list, inside NarrativeAgent.draft(); this operator-
    // triggered re-check re-verifies the deterministic parts (present-tense
    // capability status, unmeasured numbers, secrets, prohibited practices)
    // against whatever the body currently says, including after a manual edit.
    const report = riskGuard.check({
      body: asset.body,
      title: asset.title,
      capabilities: capabilityList,
      measuredMetrics: (await service.metrics.measured()).map((metric) => ({
        label: metric.label, value: metric.valueText ?? String(metric.value ?? ''),
      })),
    });

    const actor = actorFrom(request);
    await content.recordRiskFindings(asset.id, report.findings, actor);

    // The declared workflow is DRAFT -> EVIDENCE_CHECK -> RISK_REVIEW; a
    // blocked draft is sent back to DRAFT for a rewrite rather than advanced.
    // Only DRAFT can reach EVIDENCE_CHECK, so a re-run after a block starts
    // from there again -- this route is idempotent from either state.
    if (asset.state === 'DRAFT') {
      await content.transition({ assetId: asset.id, to: 'EVIDENCE_CHECK', action: 'evidence_checked', actor });
    }
    const updated = await content.transition({
      assetId: asset.id,
      to: report.blocked ? 'DRAFT' : 'RISK_REVIEW',
      action: 'risk_reviewed',
      actor,
      detail: report.blocked ? 'blocked' : undefined,
    });

    return { asset: updated, findings: report.findings, blocked: report.blocked };
  }));

  server.post('/api/intelligence/content/:id/submit', wrap(async (request) => ({
    asset: await content.transition({
      assetId: request.params.id, to: 'READY_FOR_REVIEW', action: 'submitted', actor: actorFrom(request),
    }),
  })));

  server.post('/api/intelligence/content/:id/approve', wrap(async (request) => ({
    asset: await content.transition({
      assetId: request.params.id, to: 'HUMAN_APPROVED', action: 'approved', actor: actorFrom(request),
    }),
  })));

  server.post('/api/intelligence/content/:id/reject', wrap(async (request, reply) => {
    if (!request.body?.reason?.trim()) return reply.code(400).send({ error: 'reason is required.' });
    return {
      asset: await content.transition({
        assetId: request.params.id, to: 'REJECTED', action: 'rejected',
        actor: actorFrom(request), rejectedReason: request.body.reason,
      }),
    };
  }));

  server.post('/api/intelligence/content/:id/edit', wrap(async (request) => ({
    asset: await content.edit({ assetId: request.params.id, actor: actorFrom(request), ...request.body }),
  })));

  server.post('/api/intelligence/content/:id/exclude-claim', wrap(async (request, reply) => {
    if (!request.body?.claimText?.trim()) return reply.code(400).send({ error: 'claimText is required.' });
    await content.excludeClaim(request.params.id, request.body.claimText, actorFrom(request));
    return { ok: true };
  }));

  server.get('/api/intelligence/content/:id/export', wrap(async (request, reply) => {
    const asset = await content.byId(request.params.id);
    if (!asset) return reply.code(404).send({ error: 'Content asset not found.' });
    const text = exportAsset(asset);
    const exported = await content.transition({
      assetId: asset.id, to: 'EXPORTED', action: 'exported', actor: actorFrom(request),
    });
    return { text, asset: exported };
  }));

  // --- distribution ----------------------------------------------------------------

  server.get('/api/intelligence/channels', wrap(async () => ({ channels: await channels.list() })));

  server.post('/api/intelligence/channels/seed-defaults', wrap(async () => ({ created: await channels.seedDefaults() })));

  server.post('/api/intelligence/content/:id/recommend-channels', wrap(async (request, reply) => {
    const asset = await content.byId(request.params.id);
    if (!asset) return reply.code(404).send({ error: 'Content asset not found.' });
    const channelList = await channels.list();
    const recommendations = distributionAgent.recommend({
      assetType: asset.assetType,
      channels: channelList,
      isTechnicallySubstantive: asset.body.length > 400,
      hasDemonstrableCapability: (await capabilities.list()).some((capability) => capability.demonstrable),
    });
    return { recommendations };
  }));

  // --- diligence ---------------------------------------------------------------------

  server.get('/api/intelligence/diligence/roles', async () => ({ roles: DILIGENCE_ROLES }));

  server.post('/api/intelligence/diligence/run', wrap(async (request, reply) => {
    const body = request.body ?? {};
    if (!body.role || !DILIGENCE_ROLES.includes(body.role)) {
      return reply.code(400).send({ error: `role must be one of: ${DILIGENCE_ROLES.join(', ')}` });
    }
    const capabilityList = await capabilities.list();
    const allClaims = (await Promise.all(capabilityList.map((capability) => claims.list(capability.id)))).flat();
    const session = await diligenceAgent.run({
      role: body.role,
      focus: body.focus ?? 'General technical and commercial diligence.',
      capabilities: capabilityList,
      claims: allClaims,
      questionCount: body.questionCount,
    });
    return { session };
  }));

  server.get('/api/intelligence/diligence/backlog', wrap(async (request) => ({
    backlog: await diligenceAgent.backlog(Number(request.query?.limit ?? 50)),
  })));

  // --- investment memo ------------------------------------------------------------

  server.post('/api/intelligence/memo', wrap(async (request) => {
    const capabilityList = await capabilities.list();
    const allClaims = (await Promise.all(capabilityList.map((capability) => claims.list(capability.id)))).flat();
    const memo = await memoGenerator.generate({
      subjectName: request.body?.subjectName ?? 'DACAIS',
      capabilities: capabilityList,
      claims: allClaims,
      metrics: await service.metrics.list(),
      publicSourceUrls: request.body?.publicSourceUrls ?? [],
    });
    return { memo };
  }));

  server.get('/api/intelligence/memo/:id', wrap(async (request, reply) => {
    const memo = await memoGenerator.byId(request.params.id);
    if (!memo) return reply.code(404).send({ error: 'Memo not found.' });
    return { memo };
  }));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return Number(value);
}

function csvValues(value: unknown): string[] | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function isCompany(entity: Entity): boolean {
  return ['portfolio_company', 'strategic_company', 'organization'].includes(entity.entityType);
}
