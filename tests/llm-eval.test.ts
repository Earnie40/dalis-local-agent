import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELDOUT_CASES,
  analyzeDisagreements,
  buildReviewPrompt,
  checkHonesty,
  extractStructuredReview,
  aggregateResults,
  scoreCaseReview,
  type StructuredReview,
} from '@dacai-local-agent/smart-contract';

const HELDOUT = join(process.cwd(), 'evaluation', 'heldout');
const load = (base: string) => readFileSync(join(HELDOUT, `${base}.sol`), 'utf8');

const reentrancySource = load('ho-reentrancy');
const cleanSource = load('ho-safe-escrow');

function makeReview(overrides: Partial<StructuredReview> = {}): StructuredReview {
  return {
    contractId: 'ho-01',
    findings: [
      {
        id: 'f1',
        category: 'reentrancy',
        severity: 'high',
        confidence: 0.7,
        evidence: 'external call before rewards cleared',
        sourceLines: [17, 18],
        functionName: 'claimReward',
        rationale: 'call before state update allows re-entry',
        remediation: 'clear rewards before the external call',
        status: 'confirmed',
        basis: 'MODEL_INFERENCE',
      },
    ],
    safeAreas: ['credit is operator-gated'],
    limitations: [],
    overallRisk: 'high',
    ...overrides,
  };
}

describe('structured review parsing', () => {
  it('parses a review wrapped in markdown fences', () => {
    const raw = '```json\n' + JSON.stringify(makeReview()) + '\n```';
    const out = extractStructuredReview(raw);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.review.findings.length).toBe(1);
  });

  it('rejects non-JSON garbage', () => {
    expect(extractStructuredReview('this is not json').ok).toBe(false);
  });

  it('rejects an object that violates the contract (unknown severity)', () => {
    const bad = JSON.parse(JSON.stringify(makeReview())) as StructuredReview;
    bad.findings[0].severity = 'catastrophic';
    expect(extractStructuredReview(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('honesty / hallucination check', () => {
  it('flags an invented function and an out-of-range source line', () => {
    const review = makeReview({
      findings: [
        {
          id: 'f1',
          category: 'reentrancy',
          severity: 'high',
          confidence: 0.9,
          evidence: 'unsafe sweepAll transfers everything',
          sourceLines: [999],
          functionName: 'sweepAll', // does not exist in ho-reentrancy.sol
          rationale: 'invented path',
          remediation: 'n/a',
          status: 'confirmed',
          basis: 'MODEL_INFERENCE',
        },
      ],
    });
    const report = checkHonesty(reentrancySource, review);
    expect(report.inventedFunctions).toContain('sweepAll');
    expect(report.wrongLineCitations).toBeGreaterThan(0);
    expect(report.hallucinatedFindingCount).toBeGreaterThan(0);
  });

  it('reports nothing invented on a clean review', () => {
    const review = makeReview({
      findings: [],
      safeAreas: ['CEI ordering plus a guard'],
      overallRisk: 'low',
    });
    const report = checkHonesty(cleanSource, review);
    expect(report.hallucinatedFindingCount).toBe(0);
  });
});

describe('objective scoring', () => {
  it('scores a true positive with correct severity', () => {
    const passed = HELDOUT_CASES.find((c) => c.id === 'ho-01')!;
    const r = scoreCaseReview(passed, makeReview(), reentrancySource);
    expect(r.truePositives).toBe(1);
    expect(r.falseNegatives).toBe(0);
    expect(r.falsePositives).toBe(0);
    expect(r.severityCorrect).toBe(1);
  });

  it('charges a false positive on a clean contract', () => {
    const clean = HELDOUT_CASES.find((c) => c.id === 'ho-07')!;
    const r = scoreCaseReview(clean, makeReview({ contractId: 'ho-07' }), cleanSource);
    expect(r.truePositives).toBe(0);
    expect(r.falsePositives).toBe(1);
  });

  it('aggregates precision/recall/F1 over scorable cases', () => {
    const clean = HELDOUT_CASES.find((c) => c.id === 'ho-07')!;
    const a = scoreCaseReview(HELDOUT_CASES.find((c) => c.id === 'ho-01')!, makeReview(), reentrancySource);
    const b = scoreCaseReview(clean, makeReview({ contractId: 'ho-07', findings: [] }), cleanSource);
    const agg = aggregateResults([a, b]);
    expect(agg.truePositives).toBe(1);
    expect(agg.falsePositives).toBe(0);
    expect(agg.falseNegatives).toBe(0);
    expect(agg.precision).toBe(1);
    expect(agg.recall).toBe(1);
    expect(agg.safeContractAccuracy).toBe(1);
  });
});

describe('disagreement analysis', () => {
  it('records detector-vs-model disagreement without resolving it', () => {
    const passed = HELDOUT_CASES.find((c) => c.id === 'ho-01')!;
    const review = makeReview({ findings: [] }); // model says no finding
    const records = analyzeDisagreements(passed, reentrancySource, review);
    const re = records.find((r) => r.category.startsWith('reentrancy'));
    expect(re).toBeDefined();
    expect(re!.model).toBeNull();
    expect(re!.detector).not.toBeNull();
    expect(re!.groundTruth).toBe('present');
    expect(re!.winner).toBe('detector');
  });
});

describe('prompt construction', () => {
  it('does not leak expected labels and always declares the JSON contract', () => {
    const passed = HELDOUT_CASES.find((c) => c.id === 'ho-01')!;
    const { system, user } = buildReviewPrompt('llm-only', reentrancySource, { contractId: passed.id });
    expect(user).not.toContain('reentrancy/claimReward');
    expect(system).toContain('"contractId"');
    expect(system).toContain('DETERMINISTIC_FINDING');
    expect(system).toContain('"status"');
  });
});