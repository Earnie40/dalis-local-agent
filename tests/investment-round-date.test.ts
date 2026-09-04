import { describe, expect, it } from 'vitest';
import {
  INVESTMENT_EXTRACTION_SCHEMA_VERSION,
  parseExplicitRoundDateFromEvidence,
} from '@dacai-local-agent/investor-intelligence';

describe('deterministic funding-round evidence date enrichment', () => {
  it('parses one valid full English month date', () => {
    expect(parseExplicitRoundDateFromEvidence(
      'The company announced its Series A on January 7, 2026.',
    )).toBe('2026-01-07');
    expect(parseExplicitRoundDateFromEvidence(
      'The round closed on february 29, 2024 after regulatory approval.',
    )).toBe('2024-02-29');
  });

  it('parses one standalone ISO calendar date', () => {
    expect(parseExplicitRoundDateFromEvidence(
      'The financing was announced on 2025-11-03.',
    )).toBe('2025-11-03');
  });

  it('rejects invalid Gregorian dates and unsupported date shapes', () => {
    expect(parseExplicitRoundDateFromEvidence('The round closed on February 29, 2025.')).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence('The round closed on 2025-02-29.')).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence('The round closed on Feb 3, 2025.')).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence('The round closed on 03/04/2025.')).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence('The round closed on March 3 2025.')).toBeUndefined();
  });

  it('leaves zero, repeated, or multiple date candidates unknown', () => {
    expect(parseExplicitRoundDateFromEvidence('The company announced a new seed financing.')).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence(
      'The round was announced January 7, 2026 and closed January 7, 2026.',
    )).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence(
      'The article was published January 6, 2026; the round was announced January 7, 2026.',
    )).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence(
      'The release says January 7, 2026 (2026-01-07).',
    )).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence(
      'The release says February 30, 2026, then references 2026-03-01.',
    )).toBeUndefined();
  });

  it('does not parse an ISO prefix embedded in a timestamp or identifier', () => {
    expect(parseExplicitRoundDateFromEvidence('Timestamp: 2026-01-07T15:30:00Z.')).toBeUndefined();
    expect(parseExplicitRoundDateFromEvidence('Reference round_2026-01-07_internal.')).toBeUndefined();
  });

  it('uses a new durable extraction contract version for the changed semantics', () => {
    expect(INVESTMENT_EXTRACTION_SCHEMA_VERSION).toBe('vc-investment-facts-v2');
  });
});
