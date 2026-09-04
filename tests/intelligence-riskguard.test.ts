import { describe, expect, it } from 'vitest';
import { RiskGuard, type Capability } from '@dacai-local-agent/investor-intelligence';

function capability(overrides: Partial<Capability>): Capability {
  return {
    id: 'cap_1',
    slug: 'test-capability',
    name: 'Autonomous Aerospace Control',
    description: 'Aerospace control system.',
    status: 'HORIZON',
    demonstrable: false,
    publiclyShareable: true,
    operatorDeclared: false,
    evidenceCount: 1,
    ...overrides,
  };
}

describe('RiskGuard — overclaim protection', () => {
  it('blocks present-tense description of a HORIZON-stage capability', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'DACAIS operates autonomous aerospace systems today, controlling flight hardware directly.',
      capabilities: [capability({ status: 'HORIZON' })],
    });
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.code === 'present-tense-overclaim')).toBe(true);
  });

  it('allows the same capability described with intent framing', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'DACAIS is developing architecture intended to extend its control model toward autonomous aerospace systems.',
      capabilities: [capability({ status: 'HORIZON' })],
    });
    expect(report.blocked).toBe(false);
  });

  it('allows present-tense description of a WORKING_PROTOTYPE capability', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'The DACAIS Autonomous Aerospace Control system runs today as a working prototype.',
      capabilities: [capability({ status: 'WORKING_PROTOTYPE' })],
    });
    expect(report.blocked).toBe(false);
  });

  it('blocks any reference to an UNVERIFIED capability regardless of tense', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'DACAIS is developing Autonomous Aerospace Control as a future direction.',
      capabilities: [capability({ status: 'UNVERIFIED' })],
    });
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.code === 'unverified-capability')).toBe(true);
  });

  it('blocks a claim with zero supporting evidence', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'Something unrelated.',
      capabilities: [],
      claims: [{ text: 'DACAIS has 500 enterprise customers.', supportingEvidenceCount: 0 }],
    });
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.code === 'unsupported-claim')).toBe(true);
  });

  it('does not block a claim with supporting evidence', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'Something unrelated.',
      capabilities: [],
      claims: [{ text: 'DACAIS passes its permission engine tests.', supportingEvidenceCount: 2 }],
    });
    expect(report.blocked).toBe(false);
  });

  it('blocks a number in the draft that is not in the measured metric set', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'The system achieves 99.9% uptime and processes 10,000 requests per second.',
      capabilities: [],
    });
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.code === 'unverified-metric')).toBe(true);
  });

  it('does not block a number that matches a measured metric', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'Local inference serves 83.2% of requests.',
      capabilities: [],
      measuredMetrics: [{ label: 'Share of inference served locally', value: '83.2%' }],
    });
    expect(report.findings.some((f) => f.code === 'unverified-metric')).toBe(false);
  });

  it('flags a secret leaking into the draft text', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'Configure the client with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH.',
      capabilities: [],
    });
    expect(report.blocked).toBe(true);
    expect(report.findings.some((f) => f.code === 'secret-leak')).toBe(true);
  });

  it('warns (does not necessarily block) on a market-position superlative with no evidence basis', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'DACAIS is the first and only platform to do this, industry-leading in every respect.',
      capabilities: [],
    });
    expect(report.findings.some((f) => f.code === 'unsupported-claim' && f.message.includes('the first'))).toBe(true);
  });

  it('warns when text describes a prohibited distribution practice as a plan', () => {
    const guard = new RiskGuard();
    const report = guard.check({
      body: 'We should set up several fake accounts to post positive comments about this.',
      capabilities: [],
    });
    expect(report.findings.some((f) => f.code === 'prohibited-practice')).toBe(true);
  });
});
