import { describe, expect, it } from 'vitest';
import {
  InvestmentExtractionSchema,
  InvestmentFactExtractor,
  evidenceQuoteAppearsIn,
  isCalendarDate,
  normalizeEvidenceText,
  stageExtractionClaims,
  validateInvestmentExtraction,
  type InvestmentExtraction,
} from '../packages/investor-intelligence/src/investment-extraction';

const DOCUMENT = [
  'Northstar Ventures led a $25 million Series A investment in Orbital Forge on 2026-04-03.',
  'Jane Partner is a partner at Northstar Ventures.',
  'Orbital Forge builds robotics systems for the aerospace market.',
].join(' ');

function validExtraction(): InvestmentExtraction {
  return InvestmentExtractionSchema.parse({
    entities: [
      {
        ref: 'firm_1', entityType: 'investment_firm', displayName: 'Northstar Ventures',
        identifiers: [{ kind: 'domain', value: 'northstar.example' }],
        evidenceQuote: 'Northstar Ventures led a $25 million Series A investment',
      },
      {
        ref: 'company_1', entityType: 'company', displayName: 'Orbital Forge', identifiers: [],
        evidenceQuote: 'investment in Orbital Forge on 2026-04-03',
      },
      {
        ref: 'person_1', entityType: 'person', displayName: 'Jane Partner', identifiers: [],
        evidenceQuote: 'Jane Partner is a partner at Northstar Ventures',
      },
    ],
    sectors: [
      { ref: 'sector_1', label: 'Aerospace', kind: 'sector', evidenceQuote: 'the aerospace market' },
      { ref: 'technology_1', label: 'Robotics', kind: 'technology', evidenceQuote: 'robotics systems' },
    ],
    fundingRounds: [{
      ref: 'round_1', companyRef: 'company_1', roundType: 'series_a', announcedOn: '2026-04-03',
      money: { currency: 'USD', amount: '25000000', sourceText: '$25 million' },
      evidenceQuote: 'Northstar Ventures led a $25 million Series A investment in Orbital Forge on 2026-04-03',
    }],
    facts: [
      {
        kind: 'round_participant', participantRef: 'firm_1', participantType: 'investment_firm',
        roundRef: 'round_1', role: 'lead', leadStatus: 'confirmed_lead',
        evidenceQuote: 'Northstar Ventures led a $25 million Series A investment',
      },
      {
        kind: 'partner_at', personRef: 'person_1', firmRef: 'firm_1',
        evidenceQuote: 'Jane Partner is a partner at Northstar Ventures',
      },
      {
        kind: 'operates_in', entityRef: 'company_1', sectorRef: 'sector_1',
        evidenceQuote: 'Orbital Forge builds robotics systems for the aerospace market',
      },
      {
        kind: 'uses_technology', entityRef: 'company_1', sectorRef: 'technology_1',
        evidenceQuote: 'Orbital Forge builds robotics systems',
      },
    ],
  });
}

describe('typed VC investment extraction', () => {
  it('accepts only real YYYY-MM-DD calendar dates', () => {
    expect(isCalendarDate('2026-04-03')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('04/03/2026')).toBe(false);

    const candidate = validExtraction();
    expect(InvestmentExtractionSchema.safeParse({
      ...candidate,
      fundingRounds: [{ ...candidate.fundingRounds[0], announcedOn: '2026-02-30' }],
    }).success).toBe(false);
  });

  it('rejects non-canonical or negative money instead of coercing it', () => {
    const candidate = validExtraction();
    for (const amount of ['$25m', '25,000,000', '-1']) {
      expect(InvestmentExtractionSchema.safeParse({
        ...candidate,
        fundingRounds: [{
          ...candidate.fundingRounds[0],
          money: { ...candidate.fundingRounds[0].money!, amount },
        }],
      }).success).toBe(false);
    }
  });

  it('validates exact evidence plus legal local-reference endpoints', () => {
    const validation = validateInvestmentExtraction(validExtraction(), DOCUMENT);
    expect(validation).toEqual({ valid: true, issues: [] });
  });

  it('normalizes only typography and whitespace for exact quote checks', () => {
    expect(normalizeEvidenceText('  “Physical\nAI” — systems  ')).toBe('"physical ai" - systems');
    expect(evidenceQuoteAppearsIn('The firm calls it “Physical AI” — systems.', 'calls it "Physical AI" - systems')).toBe(true);
    expect(evidenceQuoteAppearsIn('The firm invests in robotics.', 'The firm invests in aerospace.')).toBe(false);
  });

  it('rejects a fluent quote that is absent from the source', () => {
    const candidate = validExtraction();
    candidate.facts[0] = {
      ...candidate.facts[0],
      evidenceQuote: 'Northstar Ventures led the landmark round with several partners',
    };
    const validation = validateInvestmentExtraction(candidate, DOCUMENT);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(expect.objectContaining({
      path: 'facts.0.evidenceQuote', code: 'evidence_not_found',
    }));
  });

  it('rejects dangling references and illegal endpoint types', () => {
    const candidate = validExtraction();
    candidate.facts.push({
      kind: 'founded', founderRef: 'firm_1', companyRef: 'missing_company',
      evidenceQuote: 'Northstar Ventures led a $25 million Series A investment',
    });
    const validation = validateInvestmentExtraction(candidate, DOCUMENT);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'facts.4.founderRef', code: 'illegal_endpoint' }),
      expect.objectContaining({ path: 'facts.4.companyRef', code: 'dangling_ref' }),
    ]));
  });

  it('requires lead role and confirmed lead status to agree', () => {
    const candidate = validExtraction();
    candidate.facts[0] = { ...candidate.facts[0], leadStatus: 'unknown' };
    const validation = validateInvestmentExtraction(candidate, DOCUMENT);
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: 'inconsistent_participation' }));
  });

  it('stages deterministic, table-shaped claim fingerprints and rejects atomically', () => {
    const extraction = validExtraction();
    const input = {
      signalId: 'sig_1', sourceText: DOCUMENT, extraction,
      extractorModel: 'model-a', providerInstanceId: 'provider-a',
    };
    const first = stageExtractionClaims(input);
    const second = stageExtractionClaims(input);

    expect(first).toHaveLength(10);
    expect(first.map((claim) => claim.claimFingerprint)).toEqual(second.map((claim) => claim.claimFingerprint));
    expect(first.every((claim) => claim.validationStatus === 'validated')).toBe(true);
    expect(first.every((claim) => claim.extractionConfidence === 1)).toBe(true);

    extraction.facts[0] = { ...extraction.facts[0], evidenceQuote: 'an invented quotation absent from the source' };
    const rejected = stageExtractionClaims({ ...input, extraction });
    expect(rejected.every((claim) => claim.validationStatus === 'rejected')).toBe(true);
    expect(rejected.every((claim) => claim.extractionConfidence === 0)).toBe(true);
    expect(rejected[0].validationReason).toMatch(/evidence quote/i);
  });

  it('adapts StructuredGenerator but leaves deterministic validation visible', async () => {
    let workerRole: string | undefined;
    let maxTokens: number | undefined;
    let systemPrompt = '';
    const generator = {
      async generate<T>(request: { workerRole?: string; maxTokens?: number; system: string }): Promise<{
        value: T; alias: string; model: string; providerInstanceId: string;
        repaired: boolean; durationMs: number;
      }> {
        workerRole = request.workerRole;
        maxTokens = request.maxTokens;
        systemPrompt = request.system;
        return {
          value: validExtraction() as T,
          alias: 'intelligence', model: 'fixture-model', providerInstanceId: 'fixture-provider',
          repaired: false, durationMs: 1,
        };
      },
    };
    const extractor = new InvestmentFactExtractor(generator as never);
    const result = await extractor.extract({
      id: 'sig_1', sourceUrl: 'https://example.com/round', title: 'Round',
      publishedAt: '2026-04-03T00:00:00.000Z', excerpt: DOCUMENT,
    });

    expect(workerRole).toBe('intelligence:investment-fact-extraction');
    expect(maxTokens).toBe(8_000);
    expect(systemPrompt).toContain('kind=sector sector mention and an operates_in fact');
    expect(systemPrompt).toContain('kind=technology sector mention and a uses_technology fact');
    expect(systemPrompt).toContain('emit a founded fact from founderRef to companyRef');
    expect(systemPrompt).toContain('emit worked_at with employmentStatus=previous');
    expect(systemPrompt).toContain('authorize no inference');
    expect(result.validation.valid).toBe(true);
    expect(result.stagedClaims).toHaveLength(10);
    expect(result.model).toBe('fixture-model');
  });
});
