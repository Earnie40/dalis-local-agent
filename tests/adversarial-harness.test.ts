import { describe, expect, it } from 'vitest';
import {
  AdversarialAuthorizationError,
  BoundedAdversarialHarness,
  SYNTHETIC_NETWORK,
  SYNTHETIC_TARGET,
  assertEconomicInvariants,
  isSyntheticDestination,
} from '@dacai-local-agent/security';

function harness(overrides: Partial<ConstructorParameters<typeof BoundedAdversarialHarness>[0]> = {}) {
  return new BoundedAdversarialHarness({
    engagementId: 'eng_synthetic',
    operator: 'test-operator',
    expiresAt: new Date(Date.now() + 60_000),
    allowedTargets: new Set([SYNTHETIC_TARGET]),
    allowedNetworks: [SYNTHETIC_NETWORK],
    maxActions: 2,
    maxConcurrency: 1,
    ...overrides,
  });
}

describe('BoundedAdversarialHarness', () => {
  it('runs only an allowed synthetic target and records hashed evidence', async () => {
    const result = await harness().run({
      testId: 'api-input-1', category: 'api-input', target: SYNTHETIC_TARGET,
      resolvedIp: '10.20.1.5', expected: 'malformed input is rejected',
    }, async () => ({ observed: 'HTTP 400', disposition: 'blocked', confidence: 1 }));
    expect(result.disposition).toBe('blocked');
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(harness().state.actions).toBe(0);
  });

  it('stops before I/O for an out-of-scope target', async () => {
    const run = harness().run({ testId: 'escape', category: 'network-boundary', target: 'outside.test', expected: 'blocked' }, async () => {
      throw new Error('must not execute');
    });
    await expect(run).rejects.toThrow(AdversarialAuthorizationError);
  });

  it('stops permanently when the action budget is exhausted', async () => {
    const guarded = harness({ maxActions: 1 });
    await guarded.run({ testId: 'one', category: 'api-input', target: SYNTHETIC_TARGET, expected: 'blocked' }, async () => ({ observed: 'blocked', disposition: 'blocked' }));
    await expect(guarded.run({ testId: 'two', category: 'api-input', target: SYNTHETIC_TARGET, expected: 'blocked' }, async () => ({ observed: 'blocked', disposition: 'blocked' }))).rejects.toThrow(/budget/);
  });

  it('rejects unsafe economic state', () => {
    expect(() => assertEconomicInvariants({ granted: 1, purchased: 0, consumed: 0, reserved: 2, successfulCharges: 0 })).toThrow();
    expect(() => assertEconomicInvariants({ granted: 1, purchased: 0, consumed: 0, reserved: 0, successfulCharges: 2 })).toThrow();
  });
});

describe('synthetic destination validation', () => {
  it('accepts only the synthetic host and CIDR', () => {
    expect(isSyntheticDestination(SYNTHETIC_TARGET, '10.20.1.5')).toBe(true);
    expect(isSyntheticDestination(SYNTHETIC_TARGET, '203.0.113.50')).toBe(false);
    expect(isSyntheticDestination('evil.example.test', '10.20.1.5')).toBe(false);
  });
});
