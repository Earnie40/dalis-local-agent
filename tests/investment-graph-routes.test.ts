import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvestmentAnalyticsError, type Entity } from '@dacai-local-agent/investor-intelligence';
import { registerInvestmentGraphReadRoutes } from '../apps/server/src/routes/intelligence.js';

const firm = entity('firm_1', 'Example Ventures', 'investment_firm');
const company = entity('company_1', 'Acme Aerospace', 'portfolio_company');

function entity(id: string, displayName: string, entityType: Entity['entityType']): Entity {
  return {
    id,
    slug: displayName.toLowerCase().replace(/\s+/g, '-'),
    displayName,
    canonicalName: displayName,
    normalizedName: displayName.toLowerCase(),
    entityType,
    isPublicProfessional: true,
    watchEnabled: false,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function dependencies() {
  const entities = {
    byId: vi.fn(async (id: string) => [firm, company].find((item) => item.id === id)),
    list: vi.fn(async () => [firm]),
  };
  const analytics = {
    getPortfolio: vi.fn(async () => [{ company, roundCount: 1, rounds: [], evidence: [] }]),
    getFundingRoundsForEntity: vi.fn(async () => [{ id: 'round_1' }]),
    getFundingRound: vi.fn(async (id: string) => id === 'round_1' ? { id, participants: [] } : undefined),
    getInvestorsForCompany: vi.fn(async () => [{ investor: firm, roundCount: 1 }]),
    getCoInvestors: vi.fn(async () => [{ firm: entity('firm_2', 'Syndicate Fund', 'investment_firm') }]),
    getSectorProfile: vi.fn(async () => ({
      entityId: firm.id,
      observedInvestmentBehavior: [],
      publicSignalAffinity: [],
    })),
    getInvestmentTimeline: vi.fn(async () => [{ id: 'funding-round:round_1' }]),
    getRelationships: vi.fn(async () => [{ id: 'rel_1', statementKind: 'FACT' }]),
    getNeighborhood: vi.fn(async () => ({ rootEntityId: firm.id, depth: 1, nodes: [], edges: [] })),
    getInvestorFit: vi.fn(async () => ({
      scoreKind: 'HEURISTIC',
      scoringVersion: 'vc-fit-v1',
      company,
      investor: firm,
      overallScore: 0.75,
      components: {},
      evidence: [],
      limitations: ['Not a probability.'],
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    })),
  };
  return { entities, analytics };
}

const servers: FastifyInstance[] = [];

async function app() {
  const server = Fastify();
  servers.push(server);
  const deps = dependencies();
  registerInvestmentGraphReadRoutes(server, deps as never);
  await server.ready();
  return { server, deps };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('investment graph read API', () => {
  it.each([
    ['/api/intelligence/entities/firm_1/portfolio', 'portfolio'],
    ['/api/intelligence/entities/firm_1/funding-rounds', 'rounds'],
    ['/api/intelligence/entities/firm_1/co-investors', 'coInvestors'],
    ['/api/intelligence/entities/firm_1/sector-profile', 'profile'],
    ['/api/intelligence/entities/firm_1/investment-timeline', 'events'],
    ['/api/intelligence/entities/firm_1/relationships', 'relationships'],
    ['/api/intelligence/entities/firm_1/neighborhood', 'neighborhood'],
    ['/api/intelligence/companies/company_1/investors', 'investors'],
  ])('returns the compatible %s envelope', async (url, key) => {
    const { server } = await app();
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty(key);
  });

  it('forwards temporal and relationship filters in typed form', async () => {
    const { server, deps } = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/api/intelligence/entities/firm_1/relationships?from=2025-01-01&to=2026-01-01&limit=20&direction=incoming&relationship=worked_at,partner_at&relationshipBasis=source_fact',
    });
    expect(response.statusCode).toBe(200);
    expect(deps.analytics.getRelationships).toHaveBeenCalledWith('firm_1', {
      from: '2025-01-01',
      to: '2026-01-01',
      limit: 20,
      direction: 'incoming',
      relationships: ['worked_at', 'partner_at'],
      assertionClasses: undefined,
      relationshipBases: ['source_fact'],
    });
  });

  it('returns funding-round detail and a real 404 for an unknown round', async () => {
    const { server } = await app();
    const found = await server.inject({ method: 'GET', url: '/api/intelligence/funding-rounds/round_1' });
    const missing = await server.inject({ method: 'GET', url: '/api/intelligence/funding-rounds/missing' });
    expect(found.statusCode).toBe(200);
    expect(found.json().round.id).toBe('round_1');
    expect(missing.statusCode).toBe(404);
  });

  it('returns 404 before querying analytics for an unknown entity', async () => {
    const { server, deps } = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/api/intelligence/entities/missing/portfolio',
    });
    expect(response.statusCode).toBe(404);
    expect(deps.analytics.getPortfolio).not.toHaveBeenCalled();
  });

  it('rejects a non-company on company routes', async () => {
    const { server } = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/api/intelligence/companies/firm_1/investors',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not a company/i);
  });

  it('labels fit output as a heuristic rather than probability/confidence', async () => {
    const { server } = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/api/intelligence/companies/company_1/investor-fits?investorId=firm_1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scoringMethod).toBe('HEURISTIC');
    expect(response.json().disclaimer).toMatch(/not probabilities/i);
    expect(response.json().fits[0].scoreKind).toBe('HEURISTIC');
  });

  it('maps analytics validation failures to a 400 response', async () => {
    const { server, deps } = await app();
    deps.analytics.getNeighborhood.mockRejectedValueOnce(
      new InvestmentAnalyticsError('depth must be 1 or 2'),
    );
    const response = await server.inject({
      method: 'GET',
      url: '/api/intelligence/entities/firm_1/neighborhood?depth=9',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/depth/);
  });
});
