import { describe, expect, it } from 'vitest';
import { TemporalIntegrityError } from '@dacai-local-agent/datasets';
import { makeClaim } from '@dacai-local-agent/domain-knowledge';
import {
  AdapterRegistry,
  AdapterRegistryError,
  type EvaluationRun,
} from '@dacai-local-agent/model-registry';
import {
  PredictionError,
  ResearchScopeError,
  brierScore,
  calibrationBins,
  createCostModel,
  createPrediction,
  createTradeEvent,
  createTraderIdentity,
  describeTradeEvent,
  directionalAccuracy,
  falseConfidenceRate,
  maxDrawdown,
  resolvePrediction,
  roundTripCost,
  validateDecisionInputs,
  walkForwardWindows,
  type ScoredPrediction,
} from '@dacai-local-agent/market-intelligence';

describe('trader behaviour research scope', () => {
  it('keeps participants pseudonymous unless evidence is cited', () => {
    const wallet = createTraderIdentity({
      participantId: 'wallet:0xabc',
      kind: 'wallet',
      sourceKinds: ['public_onchain_activity'],
    });
    expect(wallet.attribution).toBeUndefined();

    expect(() =>
      createTraderIdentity({
        participantId: 'wallet:0xabc',
        kind: 'wallet',
        sourceKinds: ['public_onchain_activity'],
        attribution: { name: 'A Real Person', evidence: [] },
      }),
    ).toThrow(/without cited public evidence/);
  });

  it('requires an authorization reference for an authorized account export', () => {
    expect(() =>
      createTraderIdentity({
        participantId: 'account:1',
        kind: 'account',
        sourceKinds: ['authorized_account_export'],
      }),
    ).toThrow(ResearchScopeError);
  });

  it('refuses to file an inference as a stated rationale', () => {
    const base = {
      id: 'trade-1',
      participantId: 'wallet:0xabc',
      instrument: 'ETH-USD',
      direction: 'long' as const,
      sizeClass: 'moderate' as const,
      entryTime: '2026-01-01T00:00:00.000Z',
      eventTime: '2026-01-01T00:00:00.000Z',
      availableAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:10.000Z',
      context: { regime: 'trending-up' as const },
    };

    expect(() =>
      createTradeEvent({
        ...base,
        statedRationale: makeClaim({
          value: 'momentum',
          assertionClass: 'inferred',
          confidence: 0.5,
          sources: [{ kind: 'model', locator: 'v1' }],
        }),
      }),
    ).toThrow(/must be a "stated" claim/);
  });

  it('renders observed, stated, and inferred as visibly separate layers', () => {
    const event = createTradeEvent({
      id: 'trade-2',
      participantId: 'wallet:0xabc',
      instrument: 'ETH-USD',
      direction: 'long',
      sizeClass: 'large',
      entryTime: '2026-01-01T00:00:00.000Z',
      eventTime: '2026-01-01T00:00:00.000Z',
      availableAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:10.000Z',
      context: { regime: 'trending-up' },
      statedRationale: makeClaim({
        value: 'bought the dip',
        assertionClass: 'stated',
        sources: [{ kind: 'public_commentary', locator: 'post/1' }],
      }),
      inferredRationale: makeClaim({
        value: 'liquidity expansion may also have contributed',
        assertionClass: 'inferred',
        confidence: 0.35,
        sources: [{ kind: 'public_onchain_activity', locator: 'pool/1' }],
      }),
    });

    const rendered = describeTradeEvent(event);
    expect(rendered).toContain('OBSERVED:');
    expect(rendered).toContain('STATED: bought the dip');
    expect(rendered).toContain('INFERRED (confidence 0.35)');
  });
});

describe('probabilistic predictions', () => {
  const base = {
    predictionId: 'p1',
    statement: 'ETH-USD rises over the next 24h',
    instrument: 'ETH-USD',
    probability: 0.62,
    confidence: 0.5,
    horizonMs: 24 * 60 * 60 * 1000,
    conditions: ['no exchange outage'],
    invalidatingConditions: ['trading halted'],
    evidence: ['momentum over 7d'],
    modelId: 'dacais-market',
    modelVersion: '0.1.0',
    issuedAt: '2026-01-01T00:00:00.000Z',
  };

  it('refuses a forecast that claims certainty', () => {
    expect(() => createPrediction({ ...base, probability: 1 })).toThrow(/claims certainty/);
    expect(() => createPrediction({ ...base, probability: 0 })).toThrow(PredictionError);
  });

  it('refuses an unfalsifiable forecast', () => {
    expect(() => createPrediction({ ...base, invalidatingConditions: [] })).toThrow(
      /at least one invalidating condition/,
    );
  });

  it('computes the resolution time from the horizon and hashes the record', () => {
    const record = createPrediction(base);
    expect(record.resolvesAt).toBe('2026-01-02T00:00:00.000Z');
    expect(record.predictionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cannot be rewritten after the fact', () => {
    const record = createPrediction(base);
    expect(() => {
      (record as { probability: number }).probability = 0.99;
    }).toThrow();
    expect(record.probability).toBe(0.62);
  });

  it('refuses to resolve before the horizon has elapsed', () => {
    const record = createPrediction(base);
    expect(() => resolvePrediction(record, { status: 'true', resolvedAt: '2026-01-01T12:00:00.000Z' })).toThrow(
      /before its horizon ends/,
    );
  });

  it('binds an outcome to the exact forecast that was made', () => {
    const record = createPrediction(base);
    const outcome = resolvePrediction(record, { status: 'true', resolvedAt: '2026-01-02T00:00:00.000Z' });
    expect(outcome.predictionHash).toBe(record.predictionHash);
  });
});

describe('forecast scoring', () => {
  const pair = (probability: number, status: 'true' | 'false' | 'invalidated'): ScoredPrediction => {
    const record = createPrediction({
      predictionId: `p-${probability}-${status}`,
      statement: 's',
      instrument: 'ETH-USD',
      probability,
      confidence: 0.5,
      horizonMs: 1000,
      conditions: [],
      invalidatingConditions: ['halted'],
      evidence: [],
      modelId: 'm',
      modelVersion: '1',
      issuedAt: '2026-01-01T00:00:00.000Z',
    });
    return {
      record,
      outcome: { predictionId: record.predictionId, predictionHash: record.predictionHash, status, resolvedAt: '2026-01-01T00:00:01.000Z' },
    };
  };

  it('scores a confident correct forecast better than a hedged one', () => {
    expect(brierScore([pair(0.9, 'true')])!).toBeLessThan(brierScore([pair(0.6, 'true')])!);
  });

  it('excludes invalidated forecasts rather than counting them wrong', () => {
    const withInvalid = [pair(0.9, 'true'), pair(0.9, 'invalidated')];
    expect(brierScore(withInvalid)).toBeCloseTo(brierScore([pair(0.9, 'true')])!, 10);
  });

  it('measures directional accuracy independently of calibration', () => {
    expect(directionalAccuracy([pair(0.6, 'true'), pair(0.6, 'false')])).toBe(0.5);
  });

  it('reports calibration by bin', () => {
    const bins = calibrationBins([pair(0.65, 'true'), pair(0.62, 'false')], 10);
    const bin = bins.find((b) => b.lower === 0.6);
    expect(bin?.count).toBe(2);
    expect(bin?.observedFrequency).toBe(0.5);
  });

  it('catches a model that is wrong precisely where it was surest', () => {
    expect(falseConfidenceRate([pair(0.95, 'false'), pair(0.9, 'false')], 0.8)).toBe(1);
    expect(falseConfidenceRate([pair(0.6, 'false')], 0.8)).toBeNull();
  });
});

describe('backtesting', () => {
  const day = 24 * 60 * 60 * 1000;

  it('refuses a cost model with an impossible participation rate', () => {
    expect(() => createCostModel({ feeRate: 0.001, slippageRate: 0.0005, latencyMs: 250, maxParticipationRate: 0 })).toThrow(
      /maxParticipationRate/,
    );
    expect(roundTripCost(createCostModel({ feeRate: 0.001, slippageRate: 0.0005, latencyMs: 250, maxParticipationRate: 0.1 }))).toBeCloseTo(0.003);
  });

  it('separates each test window from its training window by the embargo', () => {
    const windows = walkForwardWindows({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-04-01T00:00:00.000Z',
      trainMs: 30 * day,
      testMs: 10 * day,
      embargoMs: 2 * day,
    });

    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      const gap = Date.parse(window.testStart) - Date.parse(window.trainEnd);
      expect(gap).toBe(2 * day);
      expect(Date.parse(window.testStart)).toBeGreaterThan(Date.parse(window.trainEnd));
    }
  });

  it('fails a simulated decision that read information from the future', () => {
    expect(() =>
      validateDecisionInputs({
        decisionId: 'd1',
        decisionTime: '2026-01-10T00:00:00.000Z',
        inputs: [
          { id: 'future-print', eventTime: '2026-01-09T00:00:00.000Z', availableAt: '2026-01-20T00:00:00.000Z', observedAt: '2026-01-20T00:00:00.000Z' },
        ],
      }),
    ).toThrow(TemporalIntegrityError);
  });

  it('measures peak-to-trough drawdown', () => {
    expect(maxDrawdown([100, 120, 90, 130])).toBeCloseTo(0.25);
  });
});

describe('adapter registry', () => {
  const candidate = {
    adapterId: 'dacais-market-intelligence-adapter',
    domainId: 'market-intelligence' as const,
    baseModel: 'qwen3:8b',
    version: 1,
    status: 'candidate' as const,
    trainedOn: [{ datasetId: 'market-procedures', version: 1 }],
    trainingRunHash: 'a'.repeat(64),
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const evaluation: EvaluationRun = {
    evaluationId: 'ev-1',
    adapterId: candidate.adapterId,
    adapterVersion: 1,
    domainId: 'market-intelligence',
    suiteDatasetId: 'market-eval',
    suiteDatasetVersion: 1,
    score: 0.82,
    generalDelta: -0.01,
    ranAt: '2026-01-02T00:00:00.000Z',
  };

  const thresholds = { minScore: 0.75, maxGeneralRegression: 0.05 };

  it('refuses to register an adapter as already promoted', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.register({ ...candidate, status: 'promoted' })).toThrow(AdapterRegistryError);
  });

  it('refuses a candidate with untraceable training data', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.register({ ...candidate, trainedOn: [] })).toThrow(/names no dataset versions/);
  });

  it('promotes only with a passing evaluation and a named approver', () => {
    const registry = new AdapterRegistry();
    registry.register(candidate);

    const noApprover = registry.promote(candidate.adapterId, 1, {
      evaluation,
      thresholds,
      approvedBy: '  ',
      approvedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(noApprover.promoted).toBe(false);
    expect(noApprover.reasons.join()).toContain('named human approver');

    const lowScore = registry.promote(candidate.adapterId, 1, {
      evaluation: { ...evaluation, score: 0.2 },
      thresholds,
      approvedBy: 'kyle',
      approvedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(lowScore.promoted).toBe(false);

    const ok = registry.promote(candidate.adapterId, 1, {
      evaluation,
      thresholds,
      approvedBy: 'kyle',
      approvedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(ok.promoted).toBe(true);
    expect(ok.approvalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.routableFor('market-intelligence')).toHaveLength(1);
  });

  it('blocks promotion when the adapter regresses general capability', () => {
    const registry = new AdapterRegistry();
    registry.register(candidate);

    const result = registry.promote(candidate.adapterId, 1, {
      evaluation: { ...evaluation, generalDelta: -0.4 },
      thresholds,
      approvedBy: 'kyle',
      approvedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons.join()).toContain('regression');
  });

  it('does not route an unpromoted adapter', () => {
    const registry = new AdapterRegistry();
    registry.register(candidate);
    expect(registry.routableFor('market-intelligence')).toHaveLength(0);
  });
});
