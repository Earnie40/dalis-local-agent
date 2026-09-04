import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FundingRoundInputType,
  ResolvedInvestmentFacts,
} from '@dacai-local-agent/investor-intelligence';

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
const { InvestmentGraphStore } = await import('@dacai-local-agent/investor-intelligence');

const RUN = `vcr_${Date.now().toString(36)}_${process.pid}`;
const companyIds: string[] = [];
const signalIds: string[] = [];
const store = new InvestmentGraphStore();
let serial = 0;
let dbAvailable = false;

beforeAll(async () => {
  try {
    await getPool().query('SELECT 1');
    await runMigrations();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  if (companyIds.length) {
    await getPool().query('DELETE FROM intelligence_entities WHERE id = ANY($1::text[])', [companyIds]);
  }
  if (signalIds.length) {
    await getPool().query('DELETE FROM intelligence_signals WHERE id = ANY($1::text[])', [signalIds]);
  }
  await closePool();
});

const dbIt = (name: string, fn: () => Promise<void>) => it(name, async () => {
  if (!dbAvailable) {
    console.warn(`SKIPPED (no database): ${name}`);
    return;
  }
  await fn();
});

async function createCompany(label: string): Promise<string> {
  const suffix = `${label}_${serial++}`;
  const id = `${RUN}_company_${suffix}`;
  companyIds.push(id);
  await getPool().query(
    `INSERT INTO intelligence_entities (
       id, entity_type, display_name, canonical_name, normalized_name, slug,
       is_public_professional, watch_enabled, metadata
     ) VALUES ($1,'portfolio_company',$2,$2,$3,$4,true,false,'{}'::jsonb)`,
    [id, `Round reconciliation ${suffix}`, `round reconciliation ${suffix}`, `${RUN}-${suffix}`],
  );
  return id;
}

interface ObservationInput {
  companyEntityId: string;
  label: string;
  roundType?: FundingRoundInputType;
  announcedAt?: string;
  amount?: number;
  currency?: string;
  preMoneyValuation?: number;
}

async function persistObservation(input: ObservationInput): Promise<{
  facts: ResolvedInvestmentFacts;
  roundId: string;
  signalId: string;
}> {
  const sequence = serial++;
  const signalId = `${RUN}_signal_${sequence}`;
  const evidence = `${input.label} (${RUN}-${sequence}).`;
  signalIds.push(signalId);
  await getPool().query(
    `INSERT INTO intelligence_signals (
       id, source_url, source_kind, title, excerpt, content_hash,
       assertion_class, source_count, metadata
     ) VALUES ($1,$2,'public_investment_announcement',$3,$4,$5,'observed',1,'{}'::jsonb)`,
    [
      signalId,
      `https://example.test/${RUN}/${sequence}`,
      input.label,
      evidence,
      `${RUN}-hash-${sequence}`,
    ],
  );

  const facts: ResolvedInvestmentFacts = {
    rounds: [{
      companyEntityId: input.companyEntityId,
      claimFingerprint: `${RUN}-claim-${sequence}`,
      roundType: input.roundType ?? 'series_a',
      announcedAt: input.announcedAt,
      amount: input.amount,
      currency: input.currency,
      preMoneyValuation: input.preMoneyValuation,
      assertionClass: 'observed',
      provenance: { signalId, evidenceText: evidence },
      participants: [],
    }],
    relationships: [],
    sectors: [],
  };
  const result = await store.persist(facts);
  return { facts, roundId: result.fundingRoundIds[0], signalId };
}

async function roundRows(companyEntityId: string): Promise<Array<{
  id: string;
  announced_on: string | null;
  amount: string | null;
  currency: string | null;
  pre_money_valuation: string | null;
}>> {
  const { rows } = await getPool().query(
    `SELECT id,
            announced_at::date::text AS announced_on,
            amount::text,
            currency,
            pre_money_valuation::text
       FROM funding_rounds
      WHERE company_entity_id = $1
      ORDER BY id`,
    [companyEntityId],
  );
  return rows;
}

async function sourceCount(roundId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM funding_round_sources WHERE funding_round_id = $1',
    [roundId],
  );
  return Number(rows[0].count);
}

describe.sequential('funding-round reconciliation', () => {
  dbIt('enriches one undated money match with a later date without losing source idempotency', async () => {
    const companyEntityId = await createCompany('undated_first');
    const first = await persistObservation({
      companyEntityId,
      label: 'Undated Series A with disclosed amount',
      amount: 12_000_000,
      currency: 'USD',
    });
    const second = await persistObservation({
      companyEntityId,
      label: 'Dated Series A with disclosed amount',
      announcedAt: '2025-02-10',
      amount: 12_000_000,
      currency: 'USD',
    });

    expect(second.roundId).toBe(first.roundId);
    expect(await store.persist(second.facts)).toMatchObject({ fundingRoundIds: [first.roundId] });
    expect(await roundRows(companyEntityId)).toMatchObject([{
      id: first.roundId,
      announced_on: '2025-02-10',
      amount: '12000000.00',
      currency: 'USD',
    }]);
    expect(await sourceCount(first.roundId)).toBe(2);
  });

  dbIt('reconciles an undated observation to exactly one existing dated money match', async () => {
    const companyEntityId = await createCompany('dated_first');
    const first = await persistObservation({
      companyEntityId,
      label: 'Dated seed observation',
      roundType: 'seed',
      announcedAt: '2024-06-15',
      amount: 4_500_000,
      currency: 'usd',
    });
    const second = await persistObservation({
      companyEntityId,
      label: 'Undated seed observation',
      roundType: 'seed',
      amount: 4_500_000,
      currency: 'USD',
      preMoneyValuation: 18_000_000,
    });

    expect(second.roundId).toBe(first.roundId);
    expect(await roundRows(companyEntityId)).toMatchObject([{
      id: first.roundId,
      announced_on: '2024-06-15',
      amount: '4500000.00',
      currency: 'USD',
      pre_money_valuation: '18000000.00',
    }]);
    expect(await sourceCount(first.roundId)).toBe(2);
  });

  dbIt('fills a missing amount when company, type, and date identify one compatible round', async () => {
    const companyEntityId = await createCompany('missing_amount');
    const first = await persistObservation({
      companyEntityId,
      label: 'Series B date without amount',
      roundType: 'series_b',
      announcedAt: '2026-01-20',
    });
    const second = await persistObservation({
      companyEntityId,
      label: 'Series B amount on the same date',
      roundType: 'series_b',
      announcedAt: '2026-01-20',
      amount: 30_000_000,
      currency: 'USD',
    });

    expect(second.roundId).toBe(first.roundId);
    expect(await roundRows(companyEntityId)).toMatchObject([{
      id: first.roundId,
      announced_on: '2026-01-20',
      amount: '30000000.00',
      currency: 'USD',
    }]);
    expect(await sourceCount(first.roundId)).toBe(2);
  });

  dbIt('does not guess between multiple dated candidates for an undated observation', async () => {
    const companyEntityId = await createCompany('ambiguous_dates');
    const first = await persistObservation({
      companyEntityId,
      label: 'First same-sized venture round',
      roundType: 'venture',
      announcedAt: '2023-03-01',
      amount: 8_000_000,
      currency: 'USD',
    });
    const second = await persistObservation({
      companyEntityId,
      label: 'Second same-sized venture round',
      roundType: 'venture',
      announcedAt: '2024-03-01',
      amount: 8_000_000,
      currency: 'USD',
    });
    const ambiguous = await persistObservation({
      companyEntityId,
      label: 'Undated same-sized venture round',
      roundType: 'venture',
      amount: 8_000_000,
      currency: 'USD',
    });

    expect(new Set([first.roundId, second.roundId, ambiguous.roundId]).size).toBe(3);
    expect(await roundRows(companyEntityId)).toHaveLength(3);
    expect(await sourceCount(first.roundId)).toBe(1);
    expect(await sourceCount(second.roundId)).toBe(1);
    expect(await sourceCount(ambiguous.roundId)).toBe(1);
  });

  dbIt('does not merge a missing-amount observation when same-date candidates are ambiguous', async () => {
    const companyEntityId = await createCompany('ambiguous_amount');
    const first = await persistObservation({
      companyEntityId,
      label: 'First Series C amount',
      roundType: 'series_c',
      announcedAt: '2025-09-09',
      amount: 40_000_000,
      currency: 'USD',
    });
    const second = await persistObservation({
      companyEntityId,
      label: 'Conflicting Series C amount',
      roundType: 'series_c',
      announcedAt: '2025-09-09',
      amount: 55_000_000,
      currency: 'USD',
    });
    const ambiguous = await persistObservation({
      companyEntityId,
      label: 'Series C on the same date without amount',
      roundType: 'series_c',
      announcedAt: '2025-09-09',
    });

    expect(new Set([first.roundId, second.roundId, ambiguous.roundId]).size).toBe(3);
    expect(await roundRows(companyEntityId)).toHaveLength(3);
  });

  dbIt('requires disclosed money to reconcile observations across a missing date', async () => {
    const companyEntityId = await createCompany('weak_identity');
    const dated = await persistObservation({
      companyEntityId,
      label: 'Dated pre-seed without disclosed amount',
      roundType: 'pre_seed',
      announcedAt: '2022-11-04',
    });
    const undated = await persistObservation({
      companyEntityId,
      label: 'Undated pre-seed without disclosed amount',
      roundType: 'pre_seed',
    });

    expect(undated.roundId).not.toBe(dated.roundId);
    expect(await roundRows(companyEntityId)).toHaveLength(2);
  });
});
