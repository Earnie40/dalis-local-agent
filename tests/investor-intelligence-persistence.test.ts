import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function loadEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {
    // DATABASE_URL may already be present in the test environment.
  }
}
loadEnv();

const { closePool, getPool, runMigrations } = await import('@dacai-local-agent/shared');
const {
  InvestmentAnalyticsService,
  InvestmentGraphStore,
} = await import('@dacai-local-agent/investor-intelligence');

const RUN = `vcit_${Date.now().toString(36)}`;
const ids = {
  firmA: `${RUN}_firm_a`,
  firmB: `${RUN}_firm_b`,
  company: `${RUN}_company`,
  founder: `${RUN}_founder`,
  employer: `${RUN}_employer`,
  signalA: `${RUN}_signal_a`,
  signalB: `${RUN}_signal_b`,
};
const quoteA = 'Acme Aerospace announced a $12 million Series A led by Atlas Ventures with Beacon Capital participating.';
const quoteB = 'Acme Aerospace announced a Series B led by Beacon Capital with Atlas Ventures participating.';
const peopleQuote = 'Jordan Lee founded Acme Aerospace after previously working at NASA and is a partner at Atlas Ventures.';
const sectorQuote = 'Acme Aerospace builds aerospace systems for orbital logistics.';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await getPool().query('SELECT 1');
    await runMigrations();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  const pool = getPool();
  const entityRows = [
    [ids.firmA, 'investment_firm', 'Atlas Ventures', `${RUN}-atlas`, 'atlas ventures'],
    [ids.firmB, 'investment_firm', 'Beacon Capital', `${RUN}-beacon`, 'beacon capital'],
    [ids.company, 'portfolio_company', 'Acme Aerospace', `${RUN}-acme`, 'acme aerospace'],
    [ids.founder, 'person', 'Jordan Lee', `${RUN}-jordan`, 'jordan lee'],
    [ids.employer, 'organization', 'NASA', `${RUN}-nasa`, 'nasa'],
  ];
  for (const row of entityRows) {
    await pool.query(
      `INSERT INTO intelligence_entities (
         id, entity_type, display_name, canonical_name, normalized_name, slug,
         is_public_professional, watch_enabled, metadata
       ) VALUES ($1,$2,$3,$3,$5,$4,true,false,'{}'::jsonb)`,
      row,
    );
  }
  await pool.query(
    `INSERT INTO intelligence_signals (
       id, source_url, source_kind, title, excerpt, retrieved_at, content_hash,
       assertion_class, source_count, metadata
     ) VALUES
       ($1,$2,'public_investment_announcement','Acme Series A',$3,now(),$4,'observed',1,'{}'::jsonb),
       ($5,$6,'public_investment_announcement','Acme Series B',$7,now(),$8,'observed',1,'{}'::jsonb)`,
    [
      ids.signalA,
      `https://example.test/${RUN}/series-a`,
      `${quoteA} ${peopleQuote} ${sectorQuote}`,
      `${RUN}-hash-a`,
      ids.signalB,
      `https://example.test/${RUN}/series-b`,
      quoteB,
      `${RUN}-hash-b`,
    ],
  );

  const store = new InvestmentGraphStore();
  const first = {
    rounds: [{
      companyEntityId: ids.company,
      claimFingerprint: `${RUN}-round-a`,
      roundType: 'series_a' as const,
      announcedAt: '2024-02-10',
      amount: 12_000_000,
      currency: 'USD',
      assertionClass: 'observed' as const,
      provenance: { signalId: ids.signalA, evidenceText: quoteA },
      participants: [
        {
          entityId: ids.firmA,
          participantType: 'investment_firm' as const,
          role: 'lead' as const,
          leadStatus: 'confirmed_lead' as const,
          assertionClass: 'observed' as const,
          provenance: { signalId: ids.signalA, evidenceText: quoteA },
        },
        {
          entityId: ids.firmB,
          participantType: 'investment_firm' as const,
          role: 'participant' as const,
          leadStatus: 'confirmed_not_lead' as const,
          assertionClass: 'observed' as const,
          provenance: { signalId: ids.signalA, evidenceText: quoteA },
        },
      ],
    }],
    relationships: [
      {
        fromEntityId: ids.founder,
        toEntityId: ids.company,
        relationship: 'founded' as const,
        assertionClass: 'observed' as const,
        rationale: 'Explicit founder statement.',
        provenance: { signalId: ids.signalA, evidenceText: peopleQuote },
      },
      {
        fromEntityId: ids.founder,
        toEntityId: ids.employer,
        relationship: 'worked_at' as const,
        assertionClass: 'observed' as const,
        validTo: '2020-01-01',
        provenance: { signalId: ids.signalA, evidenceText: peopleQuote },
      },
      {
        fromEntityId: ids.founder,
        toEntityId: ids.firmA,
        relationship: 'partner_at' as const,
        assertionClass: 'observed' as const,
        provenance: { signalId: ids.signalA, evidenceText: peopleQuote },
      },
    ],
    sectors: [{
      entityId: ids.company,
      sectorSlug: 'aerospace',
      sectorLabel: 'Aerospace',
      assertionClass: 'observed' as const,
      provenance: { signalId: ids.signalA, evidenceText: sectorQuote },
    }],
  };
  await store.persist(first);
  // Repeating the exact bundle must merge observations and provenance rather
  // than create duplicate rounds, participants, edges, or assignments.
  await store.persist(first);
  await store.persist({
    rounds: [{
      companyEntityId: ids.company,
      claimFingerprint: `${RUN}-round-b`,
      roundType: 'series_b',
      announcedAt: '2026-03-05',
      assertionClass: 'observed',
      provenance: { signalId: ids.signalB, evidenceText: quoteB },
      participants: [
        {
          entityId: ids.firmA,
          participantType: 'investment_firm',
          role: 'participant',
          leadStatus: 'confirmed_not_lead',
          assertionClass: 'observed',
          provenance: { signalId: ids.signalB, evidenceText: quoteB },
        },
        {
          entityId: ids.firmB,
          participantType: 'investment_firm',
          role: 'lead',
          leadStatus: 'confirmed_lead',
          assertionClass: 'observed',
          provenance: { signalId: ids.signalB, evidenceText: quoteB },
        },
      ],
    }],
    relationships: [],
    sectors: [],
  });
});

afterAll(async () => {
  if (!dbAvailable) return;
  await getPool().query('DELETE FROM intelligence_entities WHERE id = ANY($1::text[])', [
    [ids.firmA, ids.firmB, ids.company, ids.founder, ids.employer],
  ]);
  await getPool().query('DELETE FROM intelligence_signals WHERE id = ANY($1::text[])', [
    [ids.signalA, ids.signalB],
  ]);
  await closePool();
});

const dbIt = (name: string, fn: () => Promise<void>) => it(name, async () => {
  if (!dbAvailable) {
    console.warn(`SKIPPED (no database): ${name}`);
    return;
  }
  await fn();
});

describe.sequential('VC investment graph PostgreSQL persistence', () => {
  dbIt('has the full migration schema and validated constraints', async () => {
    const { rows } = await getPool().query<{ name: string }>(
      `SELECT table_name AS name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
       UNION ALL
       SELECT table_name AS name
         FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = 'co_investor_relationships'`,
      [[
        'funding_rounds',
        'funding_round_participants',
        'intelligence_entity_aliases',
        'intelligence_entity_identifiers',
        'intelligence_signal_extractions',
        'intelligence_sectors',
        'entity_sector_assignments',
      ]],
    );
    expect(new Set(rows.map((row) => row.name))).toEqual(new Set([
      'funding_rounds',
      'funding_round_participants',
      'intelligence_entity_aliases',
      'intelligence_entity_identifiers',
      'intelligence_signal_extractions',
      'intelligence_sectors',
      'entity_sector_assignments',
      'co_investor_relationships',
    ]));
  });

  dbIt('persists repeated rounds, participants, portfolio summaries, and provenance idempotently', async () => {
    const { rows } = await getPool().query(
      `SELECT
         (SELECT count(*)::INTEGER FROM funding_rounds WHERE company_entity_id = $1) AS rounds,
         (SELECT count(*)::INTEGER FROM funding_round_participants p
           JOIN funding_rounds r ON r.id = p.funding_round_id WHERE r.company_entity_id = $1) AS participants,
         (SELECT count(*)::INTEGER FROM portfolio_relationships WHERE company_entity_id = $1) AS portfolios,
         (SELECT max(round_count)::INTEGER FROM portfolio_relationships WHERE company_entity_id = $1) AS max_round_count,
         (SELECT count(*)::INTEGER FROM entity_relationships
           WHERE to_entity_id = $1 AND relationship = 'invested_in') AS invested_edges,
         (SELECT count(*)::INTEGER FROM funding_round_sources s
           JOIN funding_rounds r ON r.id = s.funding_round_id WHERE r.company_entity_id = $1) AS round_sources`,
      [ids.company],
    );
    expect(rows[0]).toMatchObject({
      rounds: 2,
      participants: 4,
      portfolios: 2,
      max_round_count: 2,
      invested_edges: 2,
      round_sources: 2,
    });
  });

  dbIt('derives one canonical co-investor pair with temporal metadata', async () => {
    const { rows } = await getPool().query(
      `SELECT * FROM co_investor_relationships
        WHERE (firm_a_id = $1 AND firm_b_id = $2) OR (firm_a_id = $2 AND firm_b_id = $1)`,
      [ids.firmA, ids.firmB],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].shared_round_count).toBe(2);
    expect(rows[0].shared_company_count).toBe(1);
  });

  dbIt('preserves founder, employment, partner, sector, and exact evidence', async () => {
    const relationships = await getPool().query(
      `SELECT r.relationship, r.relationship_basis, rs.evidence_text, s.source_url
         FROM entity_relationships r
         JOIN relationship_sources rs ON rs.relationship_id = r.id
         JOIN intelligence_signals s ON s.id = rs.signal_id
        WHERE r.from_entity_id = $1
        ORDER BY r.relationship`,
      [ids.founder],
    );
    expect(relationships.rows.map((row) => row.relationship)).toEqual(['founded', 'partner_at', 'worked_at']);
    expect(relationships.rows.every((row) => row.relationship_basis === 'source_fact')).toBe(true);
    expect(relationships.rows.every((row) => row.evidence_text === peopleQuote)).toBe(true);

    const sectors = await getPool().query(
      `SELECT sector.slug, source.evidence_text
         FROM entity_sector_assignments assignment
         JOIN intelligence_sectors sector ON sector.id = assignment.sector_id
         JOIN sector_assignment_sources source ON source.assignment_id = assignment.id
        WHERE assignment.entity_id = $1`,
      [ids.company],
    );
    expect(sectors.rows).toEqual([{ slug: 'aerospace', evidence_text: sectorQuote }]);
  });

  dbIt('answers temporal portfolio, co-investor, profile, timeline, neighborhood, and fit queries', async () => {
    const analytics = new InvestmentAnalyticsService();
    const [portfolio, recentRounds, coInvestors, profile, timeline, neighborhood, fit] = await Promise.all([
      analytics.getPortfolio(ids.firmA),
      analytics.getFundingRoundsForEntity(ids.firmA, { from: '2026-01-01' }),
      analytics.getCoInvestors(ids.firmA),
      analytics.getSectorProfile(ids.firmA),
      analytics.getInvestmentTimeline(ids.firmA),
      analytics.getNeighborhood(ids.founder, { depth: 2 }),
      analytics.getInvestorFit(ids.company, ids.firmA),
    ]);
    expect(portfolio).toHaveLength(1);
    expect(portfolio[0].roundCount).toBe(2);
    expect(recentRounds).toHaveLength(1);
    expect(recentRounds[0].roundType).toBe('series_b');
    expect(coInvestors[0].sharedRoundCount).toBe(2);
    expect(profile.observedInvestmentBehavior[0].label).toBe('Aerospace');
    expect(profile.publicSignalAffinity).toEqual([]);
    expect(timeline).toHaveLength(2);
    expect(neighborhood.nodes.some((node) => node.id === ids.company)).toBe(true);
    expect(fit.scoreKind).toBe('HEURISTIC');
    expect(fit.limitations.join(' ')).toMatch(/not a probability/i);
  });

  dbIt('rejects malformed temporal filters instead of silently widening them', async () => {
    const analytics = new InvestmentAnalyticsService();
    await expect(analytics.getPortfolio(ids.firmA, { from: 'last year' })).rejects.toThrow(/from/i);
    await expect(analytics.getNeighborhood(ids.firmA, { depth: 9 as never })).rejects.toThrow(/depth/i);
  });
});
