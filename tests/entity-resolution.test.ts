import { describe, expect, it } from 'vitest';
import { ExtractedEntityMentionSchema, type ExtractedEntityMention } from '../packages/investor-intelligence/src/investment-extraction';
import {
  creationEntityType,
  normalizeEntityIdentifier,
  normalizeEntityName,
  resolveEntityMention,
  resolveEntityMentions,
  stageEntityResolutionAudit,
  type EntityResolutionContext,
} from '../packages/investor-intelligence/src/entity-resolution';

function mention(overrides: Partial<ExtractedEntityMention> = {}): ExtractedEntityMention {
  return ExtractedEntityMentionSchema.parse({
    ref: 'firm_1',
    entityType: 'investment_firm',
    displayName: 'Northstar Ventures',
    identifiers: [],
    evidenceQuote: 'Northstar Ventures announced the investment',
    ...overrides,
  });
}

const ENTITIES: EntityResolutionContext['entities'] = [
  { id: 'ent_northstar', entityType: 'investment_firm', displayName: 'Northstar Ventures', normalizedName: 'northstar ventures' },
  { id: 'ent_northstar_2', entityType: 'investment_firm', displayName: 'Northstar Venture Partners', normalizedName: 'northstar venture partners' },
  { id: 'ent_person', entityType: 'person', displayName: 'Northstar Ventures', normalizedName: 'northstar ventures' },
  { id: 'ent_company', entityType: 'portfolio_company', displayName: 'Orbital Forge', normalizedName: 'orbital forge' },
];

describe('conservative exact entity resolution', () => {
  it('normalizes names exactly like migration 024 without fuzzy suffix removal', () => {
    expect(normalizeEntityName('  Société North-Star, Inc.  ')).toBe('societe north star inc');
    expect(normalizeEntityName('Acme Holdings LLC')).not.toBe(normalizeEntityName('Acme Holdings'));
  });

  it('normalizes only legal exact identifier forms', () => {
    expect(normalizeEntityIdentifier('domain', 'NORTHSTAR.EXAMPLE.')).toBe('northstar.example');
    expect(normalizeEntityIdentifier('website_url', 'https://Northstar.Example/')).toBe('https://northstar.example');
    expect(normalizeEntityIdentifier('linkedin_url', 'https://example.com/company/x')).toBeUndefined();
    expect(normalizeEntityIdentifier('website_url', 'http://northstar.example')).toBeUndefined();
    expect(normalizeEntityIdentifier('external_id', 'Case-Sensitive-1')).toBe('Case-Sensitive-1');
  });

  it('gives an exact verified identifier priority over ambiguous names and aliases', () => {
    const decision = resolveEntityMention(
      mention({ identifiers: [{ kind: 'domain', value: 'northstar.example' }] }),
      {
        entities: ENTITIES,
        aliases: [
          { entityId: 'ent_northstar', alias: 'Northstar Ventures', normalizedAlias: 'northstar ventures', verified: true },
          { entityId: 'ent_northstar_2', alias: 'Northstar Ventures', normalizedAlias: 'northstar ventures', verified: true },
        ],
        identifiers: [{
          entityId: 'ent_northstar', identifierKind: 'domain', rawValue: 'northstar.example',
          normalizedValue: 'northstar.example', verified: true,
        }],
      },
    );
    expect(decision).toMatchObject({ status: 'matched', entityId: 'ent_northstar', matchedBy: 'verified_identifier' });
  });

  it('ignores unverified identifiers and aliases for automatic merging', () => {
    const decision = resolveEntityMention(
      mention({ displayName: 'North Star Capital', identifiers: [{ kind: 'domain', value: 'unverified.example' }] }),
      {
        entities: ENTITIES,
        aliases: [{
          entityId: 'ent_northstar', alias: 'North Star Capital', normalizedAlias: 'north star capital', verified: false,
        }],
        identifiers: [{
          entityId: 'ent_northstar', identifierKind: 'domain', rawValue: 'unverified.example',
          normalizedValue: 'unverified.example', verified: false,
        }],
      },
    );
    expect(decision).toMatchObject({ status: 'create', reason: 'no_exact_match' });
  });

  it('constrains exact name matching by expected entity type', () => {
    const firm = resolveEntityMention(mention(), { entities: ENTITIES });
    expect(firm).toMatchObject({ status: 'matched', entityId: 'ent_northstar' });

    const person = resolveEntityMention(mention({ entityType: 'person' }), { entities: ENTITIES });
    expect(person).toMatchObject({ status: 'matched', entityId: 'ent_person' });
  });

  it('abstains when exact verified aliases identify multiple compatible entities', () => {
    const decision = resolveEntityMention(mention(), {
      entities: ENTITIES,
      aliases: [
        { entityId: 'ent_northstar', alias: 'Northstar Ventures', normalizedAlias: 'northstar ventures', verified: true },
        { entityId: 'ent_northstar_2', alias: 'Northstar Ventures', normalizedAlias: 'northstar ventures', verified: true },
      ],
    });
    expect(decision).toMatchObject({
      status: 'ambiguous',
      candidateEntityIds: ['ent_northstar', 'ent_northstar_2'],
    });
  });

  it('rejects an exact identifier owned by an incompatible type rather than creating a duplicate', () => {
    const decision = resolveEntityMention(
      mention({ identifiers: [{ kind: 'external_id', value: 'person-1' }] }),
      {
        entities: ENTITIES,
        identifiers: [{
          entityId: 'ent_person', identifierKind: 'external_id', rawValue: 'person-1',
          normalizedValue: 'person-1', verified: true,
        }],
      },
    );
    expect(decision).toMatchObject({ status: 'rejected', reasonCode: 'identifier_type_conflict' });
  });

  it('proposes portfolio_company for an unmatched company and never fuzzy-merges it', () => {
    const decision = resolveEntityMention(
      mention({ ref: 'company_1', entityType: 'company', displayName: 'Orbital Forg', identifiers: [] }),
      { entities: ENTITIES },
    );
    expect(creationEntityType('company')).toBe('portfolio_company');
    expect(decision).toMatchObject({
      status: 'create',
      proposal: { entityType: 'portfolio_company', normalizedName: 'orbital forg' },
    });
  });

  it('fails closed before creating a person not explicitly gated public-professional', () => {
    const newPerson = mention({ ref: 'person_2', entityType: 'person', displayName: 'Jane Public' });
    expect(resolveEntityMention(newPerson, { entities: [] })).toMatchObject({
      status: 'rejected', reasonCode: 'private_person',
    });
    expect(resolveEntityMention(newPerson, { entities: [], isPublicProfessionalSubject: true })).toMatchObject({
      status: 'create', proposal: { entityType: 'person' },
    });
  });

  it('summarizes batch ambiguity and stages a deterministic audit payload', () => {
    const firm = mention();
    const company = mention({ ref: 'company_1', entityType: 'company', displayName: 'Orbital Forge' });
    const result = resolveEntityMentions([firm, company], { entities: ENTITIES });
    expect(result).toMatchObject({ matched: 2, proposed: 0, ambiguous: 0, rejected: 0, complete: true });

    const firmDecision = result.decisions.get('firm_1')!;
    expect(stageEntityResolutionAudit(firm, firmDecision)).toMatchObject({
      decisionStatus: 'matched', resolvedEntityId: 'ent_northstar', decisionBasis: 'normalized_name',
    });
  });
});
