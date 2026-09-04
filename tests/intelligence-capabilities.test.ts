import { describe, expect, it } from 'vitest';
import {
  allowsPresentTense,
  atLeastStatus,
  isPublishable,
  CAPABILITY_LADDER,
  isCapabilityStatus,
  framingFor,
} from '@dacai-local-agent/investor-intelligence';

describe('capability status ladder', () => {
  it('only allows present tense for PRODUCTION and WORKING_PROTOTYPE', () => {
    expect(allowsPresentTense('PRODUCTION')).toBe(true);
    expect(allowsPresentTense('WORKING_PROTOTYPE')).toBe(true);
    expect(allowsPresentTense('IN_DEVELOPMENT')).toBe(false);
    expect(allowsPresentTense('DESIGN_COMPLETE')).toBe(false);
    expect(allowsPresentTense('RESEARCH')).toBe(false);
    expect(allowsPresentTense('HORIZON')).toBe(false);
    expect(allowsPresentTense('UNVERIFIED')).toBe(false);
  });

  it('excludes only UNVERIFIED from publishability', () => {
    for (const status of CAPABILITY_LADDER) {
      expect(isPublishable(status)).toBe(status !== 'UNVERIFIED');
    }
  });

  it('orders the ladder so a weaker status never satisfies a stronger requirement', () => {
    expect(atLeastStatus('PRODUCTION', 'WORKING_PROTOTYPE')).toBe(true);
    expect(atLeastStatus('WORKING_PROTOTYPE', 'PRODUCTION')).toBe(false);
    expect(atLeastStatus('HORIZON', 'RESEARCH')).toBe(false);
    expect(atLeastStatus('UNVERIFIED', 'HORIZON')).toBe(false);
  });

  it('rejects an unknown status string', () => {
    expect(isCapabilityStatus('SHIPPED')).toBe(false);
    expect(isCapabilityStatus('PRODUCTION')).toBe(true);
  });

  it('every status has framing guidance, and only the top two use present tense', () => {
    for (const status of CAPABILITY_LADDER) {
      const framing = framingFor(status);
      expect(framing.guidance.length).toBeGreaterThan(0);
      expect(framing.tense === 'present').toBe(allowsPresentTense(status));
    }
  });

  it('UNVERIFIED framing explicitly says it is not publishable', () => {
    expect(framingFor('UNVERIFIED').guidance).toMatch(/must not appear in generated content/);
  });
});
