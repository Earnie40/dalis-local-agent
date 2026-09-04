import { describe, expect, it } from 'vitest';
import { scoreOpportunity, validateWeights, ScoringError, DEFAULT_WEIGHTS, type Capability } from '@dacai-local-agent/investor-intelligence';

function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: 'cap_1', slug: 's', name: 'Test capability', description: 'd',
    status: 'WORKING_PROTOTYPE', demonstrable: true, publiclyShareable: true,
    operatorDeclared: false, evidenceCount: 2, ...overrides,
  };
}

describe('opportunity scoring — deterministic, not model-authored', () => {
  it('rejects weights that do not sum to 1.0', () => {
    expect(() => validateWeights({ ...DEFAULT_WEIGHTS, themeRelevance: 0.9 })).toThrow(ScoringError);
  });

  it('rejects a negative or out-of-range weight', () => {
    expect(() => validateWeights({ ...DEFAULT_WEIGHTS, themeRelevance: -0.1, evidenceStrength: 0.35 })).toThrow(ScoringError);
  });

  it('accepts the documented default weights', () => {
    expect(() => validateWeights(DEFAULT_WEIGHTS)).not.toThrow();
  });

  it('is a pure function of its inputs: identical input produces identical output', () => {
    const input = {
      themeImportance: 0.6, evidenceCount: 3, evidenceKinds: 2,
      signalDates: ['2026-08-01T00:00:00.000Z'], distinctSources: 2,
      capabilities: [capability()], existingContentCount: 0, audienceIsTechnical: true,
      now: new Date('2026-08-20T00:00:00.000Z'),
    };
    const a = scoreOpportunity(input);
    const b = scoreOpportunity(input);
    expect(a).toEqual(b);
  });

  it('more evidence increases the evidence-strength component, holding everything else fixed', () => {
    const base = {
      themeImportance: 0.6, evidenceKinds: 1, signalDates: ['2026-08-01T00:00:00.000Z'],
      distinctSources: 2, capabilities: [capability()], existingContentCount: 0,
      audienceIsTechnical: true, now: new Date('2026-08-20T00:00:00.000Z'),
    };
    const thin = scoreOpportunity({ ...base, evidenceCount: 1 });
    const rich = scoreOpportunity({ ...base, evidenceCount: 8 });
    expect(rich.components.evidenceStrength).toBeGreaterThan(thin.components.evidenceStrength);
  });

  it('more prior content on the same topic reduces differentiation', () => {
    const base = {
      themeImportance: 0.6, evidenceCount: 3, evidenceKinds: 2,
      signalDates: ['2026-08-01T00:00:00.000Z'], distinctSources: 2,
      capabilities: [capability()], audienceIsTechnical: true,
      now: new Date('2026-08-20T00:00:00.000Z'),
    };
    const fresh = scoreOpportunity({ ...base, existingContentCount: 0 });
    const saturated = scoreOpportunity({ ...base, existingContentCount: 10 });
    expect(saturated.components.differentiation).toBeLessThan(fresh.components.differentiation);
  });

  it('an older signal scores lower on timeliness than a recent one', () => {
    const base = {
      themeImportance: 0.6, evidenceCount: 3, evidenceKinds: 2, distinctSources: 2,
      capabilities: [capability()], existingContentCount: 0, audienceIsTechnical: true,
      now: new Date('2026-08-20T00:00:00.000Z'),
    };
    const recent = scoreOpportunity({ ...base, signalDates: ['2026-08-19T00:00:00.000Z'] });
    const old = scoreOpportunity({ ...base, signalDates: ['2025-01-01T00:00:00.000Z'] });
    expect(recent.components.timeliness).toBeGreaterThan(old.components.timeliness);
  });

  it('capabilities below working-prototype reduce demonstrability toward zero', () => {
    const base = {
      themeImportance: 0.6, evidenceCount: 3, evidenceKinds: 2,
      signalDates: ['2026-08-01T00:00:00.000Z'], distinctSources: 2,
      existingContentCount: 0, audienceIsTechnical: true,
      now: new Date('2026-08-20T00:00:00.000Z'),
    };
    const working = scoreOpportunity({ ...base, capabilities: [capability({ status: 'WORKING_PROTOTYPE', demonstrable: true })] });
    const horizon = scoreOpportunity({ ...base, capabilities: [capability({ status: 'HORIZON', demonstrable: false })] });
    expect(horizon.components.demonstrability).toBe(0);
    expect(working.components.demonstrability).toBeGreaterThan(horizon.components.demonstrability);
  });

  it('single-source themes are flagged with low confidence in the explanation', () => {
    const result = scoreOpportunity({
      themeImportance: 0.6, evidenceCount: 3, evidenceKinds: 2,
      signalDates: ['2026-08-01T00:00:00.000Z'], distinctSources: 1,
      capabilities: [capability()], existingContentCount: 0, audienceIsTechnical: true,
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(result.explanation.some((line) => line.includes('not corroboration'))).toBe(true);
  });

  it('every component and the final score stay within 0..1', () => {
    const result = scoreOpportunity({
      themeImportance: 1, evidenceCount: 50, evidenceKinds: 10,
      signalDates: Array(20).fill('2026-08-19T00:00:00.000Z'), distinctSources: 20,
      capabilities: Array(10).fill(capability()), existingContentCount: 0, audienceIsTechnical: true,
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    for (const value of Object.values(result.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
