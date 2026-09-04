import { z } from 'zod';
import { canonicalize, sha256Hex } from '@dacai-local-agent/domain-knowledge';
import type { StructuredGenerator } from '@dacai-local-agent/providers';
import { INTELLIGENCE_ALIAS, INTELLIGENCE_FALLBACK_ALIAS } from './model-routing.js';
import type { SignalRow } from './signals.js';

/**
 * Schema version written with staged claims. Increment this whenever the model
 * output contract or deterministic validation semantics change.
 */
export const INVESTMENT_EXTRACTION_SCHEMA_VERSION = 'vc-investment-facts-v2';

export const EXTRACTED_ENTITY_TYPES = [
  'investment_firm',
  'person',
  'company',
  'organization',
] as const;

export const ROUND_TYPES = [
  'pre_seed',
  'seed',
  'series_a',
  'series_b',
  'series_c',
  'growth',
  'strategic',
  'venture',
  'unknown',
] as const;

export const PARTICIPANT_TYPES = ['investment_firm', 'person'] as const;
export const PARTICIPANT_ROLES = ['lead', 'participant', 'associated_partner', 'unknown'] as const;
export const LEAD_STATUSES = ['confirmed_lead', 'confirmed_not_lead', 'unknown'] as const;
export const ALIAS_KINDS = ['canonical', 'legal', 'common', 'acronym', 'former'] as const;
export const IDENTIFIER_KINDS = [
  'domain',
  'website_url',
  'linkedin_url',
  'external_slug',
  'external_id',
] as const;

export type ExtractedEntityType = (typeof EXTRACTED_ENTITY_TYPES)[number];
export type RoundType = (typeof ROUND_TYPES)[number];
export type ParticipantType = (typeof PARTICIPANT_TYPES)[number];
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type AliasKind = (typeof ALIAS_KINDS)[number];
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

const LocalRefSchema = z.string().trim().regex(
  /^[a-z][a-z0-9_-]{0,63}$/,
  'Local references must start with a lowercase letter and contain only lowercase letters, numbers, _ or -.',
);

const EvidenceQuoteSchema = z.string().trim().min(8).max(800);

/** Strict YYYY-MM-DD with a real Gregorian calendar date. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1800 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const CalendarDateSchema = z.string().refine(isCalendarDate, 'Expected a real calendar date in YYYY-MM-DD form.');

const MoneySchema = z.object({
  /** ISO-4217-style uppercase code. Currency must be explicit in the source. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Decimal string avoids floating-point corruption of large announced amounts. */
  amount: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/, 'Expected a non-negative decimal string without separators.'),
  /** Exact source phrase such as "$25 million". */
  sourceText: EvidenceQuoteSchema,
}).strict();

const IdentifierSchema = z.object({
  kind: z.enum(IDENTIFIER_KINDS),
  value: z.string().trim().min(1).max(500),
}).strict().superRefine((identifier, context) => {
  if (identifier.kind === 'domain') {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(identifier.value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'domain must be a bare public DNS name.' });
    }
    return;
  }

  if (identifier.kind === 'website_url' || identifier.kind === 'linkedin_url') {
    try {
      const url = new URL(identifier.value);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('not public HTTPS');
      if (identifier.kind === 'linkedin_url' && !/(^|\.)linkedin\.com$/i.test(url.hostname)) {
        throw new Error('not LinkedIn');
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${identifier.kind} must be a credential-free HTTPS URL${identifier.kind === 'linkedin_url' ? ' on linkedin.com' : ''}.`,
      });
    }
  }
});

export const ExtractedEntityMentionSchema = z.object({
  ref: LocalRefSchema,
  entityType: z.enum(EXTRACTED_ENTITY_TYPES),
  displayName: z.string().trim().min(2).max(240),
  identifiers: z.array(IdentifierSchema).max(8).default([]),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

export const ExtractedSectorSchema = z.object({
  ref: LocalRefSchema,
  label: z.string().trim().min(2).max(120),
  kind: z.enum(['sector', 'technology', 'investment_thesis']),
  description: z.string().trim().min(4).max(400).optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

export const ExtractedFundingRoundSchema = z.object({
  ref: LocalRefSchema,
  companyRef: LocalRefSchema,
  roundType: z.enum(ROUND_TYPES),
  announcedOn: CalendarDateSchema.optional(),
  money: MoneySchema.optional(),
  sourceLabel: z.string().trim().min(2).max(160).optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const RoundParticipantFactSchema = z.object({
  kind: z.literal('round_participant'),
  participantRef: LocalRefSchema,
  participantType: z.enum(PARTICIPANT_TYPES),
  roundRef: LocalRefSchema,
  role: z.enum(PARTICIPANT_ROLES),
  leadStatus: z.enum(LEAD_STATUSES),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const PartnerAtFactSchema = z.object({
  kind: z.literal('partner_at'),
  personRef: LocalRefSchema,
  firmRef: LocalRefSchema,
  title: z.string().trim().min(2).max(160).optional(),
  startedOn: CalendarDateSchema.optional(),
  endedOn: CalendarDateSchema.optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const WorkedAtFactSchema = z.object({
  kind: z.literal('worked_at'),
  personRef: LocalRefSchema,
  organizationRef: LocalRefSchema,
  employmentStatus: z.enum(['current', 'previous', 'unknown']),
  title: z.string().trim().min(2).max(160).optional(),
  startedOn: CalendarDateSchema.optional(),
  endedOn: CalendarDateSchema.optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const FoundedFactSchema = z.object({
  kind: z.literal('founded'),
  founderRef: LocalRefSchema,
  companyRef: LocalRefSchema,
  foundedOn: CalendarDateSchema.optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const DirectInvestmentFactSchema = z.object({
  kind: z.literal('invested_in'),
  investorRef: LocalRefSchema,
  companyRef: LocalRefSchema,
  announcedOn: CalendarDateSchema.optional(),
  roundType: z.enum(ROUND_TYPES).optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const BoardMembershipFactSchema = z.object({
  kind: z.literal('board_member_of'),
  personRef: LocalRefSchema,
  organizationRef: LocalRefSchema,
  startedOn: CalendarDateSchema.optional(),
  endedOn: CalendarDateSchema.optional(),
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

const SectorAssignmentFactSchema = z.object({
  kind: z.enum(['operates_in', 'uses_technology', 'interested_in']),
  entityRef: LocalRefSchema,
  sectorRef: LocalRefSchema,
  evidenceQuote: EvidenceQuoteSchema,
}).strict();

export const ExtractedInvestmentFactSchema = z.discriminatedUnion('kind', [
  RoundParticipantFactSchema,
  PartnerAtFactSchema,
  WorkedAtFactSchema,
  FoundedFactSchema,
  DirectInvestmentFactSchema,
  BoardMembershipFactSchema,
  SectorAssignmentFactSchema,
]);

export const InvestmentExtractionSchema = z.object({
  entities: z.array(ExtractedEntityMentionSchema).max(40).default([]),
  sectors: z.array(ExtractedSectorSchema).max(20).default([]),
  fundingRounds: z.array(ExtractedFundingRoundSchema).max(20).default([]),
  facts: z.array(ExtractedInvestmentFactSchema).max(80).default([]),
  noFactsReason: z.string().trim().min(4).max(400).optional(),
}).strict().superRefine((value, context) => {
  // Entity/sector mentions by themselves are not graph facts and must not be a
  // loophole around the explicit no-facts outcome.
  if (!value.fundingRounds.length && !value.facts.length && !value.noFactsReason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['noFactsReason'],
      message: 'An empty extraction must explain why no supported investment facts were found.',
    });
  }
});

export type ExtractedEntityMention = z.infer<typeof ExtractedEntityMentionSchema>;
export type ExtractedSector = z.infer<typeof ExtractedSectorSchema>;
export type ExtractedFundingRound = z.infer<typeof ExtractedFundingRoundSchema>;
export type ExtractedInvestmentFact = z.infer<typeof ExtractedInvestmentFactSchema>;
export type InvestmentExtraction = z.infer<typeof InvestmentExtractionSchema>;

export interface InvestmentValidationIssue {
  path: string;
  code:
    | 'evidence_not_found'
    | 'entity_name_not_in_evidence'
    | 'duplicate_ref'
    | 'dangling_ref'
    | 'illegal_endpoint'
    | 'type_mismatch'
    | 'inconsistent_participation'
    | 'invalid_interval';
  message: string;
}

export interface InvestmentValidationResult {
  valid: boolean;
  issues: InvestmentValidationIssue[];
}

/**
 * Normalization used only for exact quote containment. It tolerates typography
 * and whitespace changes, but never drops words or permits semantic matching.
 */
export function normalizeEvidenceText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function evidenceQuoteAppearsIn(sourceText: string, quote: string): boolean {
  const normalizedSource = normalizeEvidenceText(sourceText);
  const normalizedQuote = normalizeEvidenceText(quote);
  return normalizedQuote.length >= 8 && normalizedSource.includes(normalizedQuote);
}

function entityHasType(
  entities: ReadonlyMap<string, ExtractedEntityMention>,
  ref: string,
  allowed: readonly ExtractedEntityType[],
  path: string,
  issues: InvestmentValidationIssue[],
): boolean {
  const entity = entities.get(ref);
  if (!entity) {
    issues.push({ path, code: 'dangling_ref', message: `Local entity reference "${ref}" was not declared.` });
    return false;
  }
  if (!allowed.includes(entity.entityType)) {
    issues.push({
      path,
      code: 'illegal_endpoint',
      message: `Entity "${ref}" is ${entity.entityType}; expected one of ${allowed.join(', ')}.`,
    });
    return false;
  }
  return true;
}

function checkDateInterval(
  startedOn: string | undefined,
  endedOn: string | undefined,
  path: string,
  issues: InvestmentValidationIssue[],
): void {
  if (startedOn && endedOn && startedOn > endedOn) {
    issues.push({ path, code: 'invalid_interval', message: `startedOn ${startedOn} is after endedOn ${endedOn}.` });
  }
}

/**
 * Cross-field validation that a JSON schema cannot express. No database lookup,
 * fuzzy matching, confidence judgement, or model call occurs here.
 */
export function validateInvestmentExtraction(
  extraction: InvestmentExtraction,
  sourceText: string,
): InvestmentValidationResult {
  const issues: InvestmentValidationIssue[] = [];
  const refs = new Map<string, string>();

  const registerRef = (ref: string, path: string): void => {
    const prior = refs.get(ref);
    if (prior) {
      issues.push({ path, code: 'duplicate_ref', message: `Local reference "${ref}" is already declared at ${prior}.` });
    } else {
      refs.set(ref, path);
    }
  };

  const checkEvidence = (quote: string, path: string): void => {
    if (!evidenceQuoteAppearsIn(sourceText, quote)) {
      issues.push({ path, code: 'evidence_not_found', message: 'The evidence quote does not appear verbatim in the source after typography/whitespace normalization.' });
    }
  };

  extraction.entities.forEach((entity, index) => {
    registerRef(entity.ref, `entities.${index}.ref`);
    checkEvidence(entity.evidenceQuote, `entities.${index}.evidenceQuote`);
    if (!normalizeEvidenceText(entity.evidenceQuote).includes(normalizeEvidenceText(entity.displayName))) {
      issues.push({
        path: `entities.${index}.displayName`,
        code: 'entity_name_not_in_evidence',
        message: 'The claimed entity name does not occur in its exact evidence quote.',
      });
    }
  });
  extraction.sectors.forEach((sector, index) => {
    registerRef(sector.ref, `sectors.${index}.ref`);
    checkEvidence(sector.evidenceQuote, `sectors.${index}.evidenceQuote`);
  });
  extraction.fundingRounds.forEach((round, index) => {
    registerRef(round.ref, `fundingRounds.${index}.ref`);
    checkEvidence(round.evidenceQuote, `fundingRounds.${index}.evidenceQuote`);
    if (round.money) checkEvidence(round.money.sourceText, `fundingRounds.${index}.money.sourceText`);
  });

  const entities = new Map(extraction.entities.map((entity) => [entity.ref, entity] as const));
  const sectors = new Map(extraction.sectors.map((sector) => [sector.ref, sector] as const));
  const rounds = new Map(extraction.fundingRounds.map((round) => [round.ref, round] as const));

  extraction.fundingRounds.forEach((round, index) => {
    entityHasType(entities, round.companyRef, ['company'], `fundingRounds.${index}.companyRef`, issues);
  });

  extraction.facts.forEach((fact, index) => {
    const base = `facts.${index}`;
    checkEvidence(fact.evidenceQuote, `${base}.evidenceQuote`);

    switch (fact.kind) {
      case 'round_participant': {
        const participantOk = entityHasType(
          entities,
          fact.participantRef,
          [fact.participantType],
          `${base}.participantRef`,
          issues,
        );
        if (participantOk && entities.get(fact.participantRef)?.entityType !== fact.participantType) {
          issues.push({ path: `${base}.participantType`, code: 'type_mismatch', message: 'participantType does not match the declared entity type.' });
        }
        if (!rounds.has(fact.roundRef)) {
          issues.push({ path: `${base}.roundRef`, code: 'dangling_ref', message: `Funding-round reference "${fact.roundRef}" was not declared.` });
        }
        if ((fact.role === 'lead') !== (fact.leadStatus === 'confirmed_lead')) {
          issues.push({
            path: `${base}.leadStatus`,
            code: 'inconsistent_participation',
            message: 'role=lead and leadStatus=confirmed_lead must be set together; uncertain claims must remain unknown.',
          });
        }
        if (fact.role === 'associated_partner' && fact.participantType !== 'person') {
          issues.push({ path: `${base}.role`, code: 'illegal_endpoint', message: 'associated_partner is only legal for a person participant.' });
        }
        break;
      }
      case 'partner_at':
        entityHasType(entities, fact.personRef, ['person'], `${base}.personRef`, issues);
        entityHasType(entities, fact.firmRef, ['investment_firm'], `${base}.firmRef`, issues);
        checkDateInterval(fact.startedOn, fact.endedOn, base, issues);
        break;
      case 'worked_at':
        entityHasType(entities, fact.personRef, ['person'], `${base}.personRef`, issues);
        entityHasType(entities, fact.organizationRef, ['investment_firm', 'company', 'organization'], `${base}.organizationRef`, issues);
        checkDateInterval(fact.startedOn, fact.endedOn, base, issues);
        if (fact.employmentStatus === 'current' && fact.endedOn) {
          issues.push({ path: `${base}.endedOn`, code: 'invalid_interval', message: 'A current employment claim cannot have endedOn.' });
        }
        break;
      case 'founded':
        entityHasType(entities, fact.founderRef, ['person'], `${base}.founderRef`, issues);
        entityHasType(entities, fact.companyRef, ['company'], `${base}.companyRef`, issues);
        break;
      case 'invested_in':
        entityHasType(entities, fact.investorRef, ['investment_firm', 'person'], `${base}.investorRef`, issues);
        entityHasType(entities, fact.companyRef, ['company'], `${base}.companyRef`, issues);
        if (fact.investorRef === fact.companyRef) {
          issues.push({ path: base, code: 'illegal_endpoint', message: 'An entity cannot invest in itself.' });
        }
        break;
      case 'board_member_of':
        entityHasType(entities, fact.personRef, ['person'], `${base}.personRef`, issues);
        entityHasType(entities, fact.organizationRef, ['investment_firm', 'company', 'organization'], `${base}.organizationRef`, issues);
        checkDateInterval(fact.startedOn, fact.endedOn, base, issues);
        break;
      case 'operates_in':
        entityHasType(entities, fact.entityRef, ['company', 'organization'], `${base}.entityRef`, issues);
        if (!sectors.has(fact.sectorRef)) {
          issues.push({ path: `${base}.sectorRef`, code: 'dangling_ref', message: `Sector reference "${fact.sectorRef}" was not declared.` });
        }
        break;
      case 'uses_technology':
        entityHasType(entities, fact.entityRef, ['company', 'organization'], `${base}.entityRef`, issues);
        if (!sectors.has(fact.sectorRef)) {
          issues.push({ path: `${base}.sectorRef`, code: 'dangling_ref', message: `Sector reference "${fact.sectorRef}" was not declared.` });
        }
        break;
      case 'interested_in':
        entityHasType(entities, fact.entityRef, ['investment_firm', 'person'], `${base}.entityRef`, issues);
        if (!sectors.has(fact.sectorRef)) {
          issues.push({ path: `${base}.sectorRef`, code: 'dangling_ref', message: `Sector reference "${fact.sectorRef}" was not declared.` });
        }
        break;
    }
  });

  return { valid: issues.length === 0, issues };
}

export class InvestmentExtractionValidationError extends Error {
  constructor(readonly issues: readonly InvestmentValidationIssue[]) {
    super(`Investment extraction failed deterministic validation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'InvestmentExtractionValidationError';
  }
}

export function requireValidInvestmentExtraction(
  extraction: InvestmentExtraction,
  sourceText: string,
): InvestmentExtraction {
  const validation = validateInvestmentExtraction(extraction, sourceText);
  if (!validation.valid) throw new InvestmentExtractionValidationError(validation.issues);
  return extraction;
}

export type ExtractionClaimValidationStatus = 'pending' | 'validated' | 'ambiguous' | 'rejected' | 'persisted';
export type ExtractionClaimKind =
  | 'entity_mention'
  | 'sector_mention'
  | 'funding_round'
  | ExtractedInvestmentFact['kind'];

export interface ExtractionClaimStage {
  signalId: string;
  claimKind: ExtractionClaimKind;
  /** Stable with respect to signal + typed payload; suitable for the table's UNIQUE fingerprint. */
  claimFingerprint: string;
  payload: Record<string, unknown>;
  evidenceText: string;
  validationStatus: ExtractionClaimValidationStatus;
  validationReason?: string;
  /** Validation confidence, not confidence that the real-world claim is true. */
  extractionConfidence: number;
  extractorModel: string;
  providerInstanceId: string;
  schemaVersion: string;
  validationIssues: readonly InvestmentValidationIssue[];
}

export interface StageExtractionClaimsInput {
  signalId: string;
  sourceText: string;
  extraction: InvestmentExtraction;
  extractorModel: string;
  providerInstanceId: string;
}

interface UnfingerprintedClaim {
  claimKind: ExtractionClaimKind;
  payload: Record<string, unknown>;
  evidenceText: string;
}

/**
 * Flattens validated model output into rows shaped for
 * `intelligence_extraction_claims`. Validation is document-atomic: if one local
 * reference or quote is invalid, every row is rejected and no subset can leak
 * into canonical graph tables.
 */
export function stageExtractionClaims(input: StageExtractionClaimsInput): ExtractionClaimStage[] {
  const validation = validateInvestmentExtraction(input.extraction, input.sourceText);
  const claims: UnfingerprintedClaim[] = [
    ...input.extraction.entities.map((entity) => ({
      claimKind: 'entity_mention' as const,
      payload: entity as Record<string, unknown>,
      evidenceText: entity.evidenceQuote,
    })),
    ...input.extraction.sectors.map((sector) => ({
      claimKind: 'sector_mention' as const,
      payload: sector as Record<string, unknown>,
      evidenceText: sector.evidenceQuote,
    })),
    ...input.extraction.fundingRounds.map((round) => ({
      claimKind: 'funding_round' as const,
      payload: round as Record<string, unknown>,
      evidenceText: round.evidenceQuote,
    })),
    ...input.extraction.facts.map((fact) => ({
      claimKind: fact.kind,
      payload: fact as Record<string, unknown>,
      evidenceText: fact.evidenceQuote,
    })),
  ];

  return claims.map((claim) => ({
    signalId: input.signalId,
    claimKind: claim.claimKind,
    claimFingerprint: sha256Hex(canonicalize({
      signalId: input.signalId,
      schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
      claimKind: claim.claimKind,
      payload: claim.payload,
    })),
    payload: claim.payload,
    evidenceText: claim.evidenceText,
    validationStatus: validation.valid ? 'validated' : 'rejected',
    validationReason: validation.valid
      ? undefined
      : validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    extractionConfidence: validation.valid ? 1 : 0,
    extractorModel: input.extractorModel,
    providerInstanceId: input.providerInstanceId,
    schemaVersion: INVESTMENT_EXTRACTION_SCHEMA_VERSION,
    validationIssues: validation.issues,
  }));
}

const INVESTMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entities: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          entityType: { enum: EXTRACTED_ENTITY_TYPES },
          displayName: { type: 'string' },
          identifiers: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: { kind: { enum: IDENTIFIER_KINDS }, value: { type: 'string' } },
              required: ['kind', 'value'],
            },
          },
          evidenceQuote: { type: 'string' },
        },
        required: ['ref', 'entityType', 'displayName', 'identifiers', 'evidenceQuote'],
      },
    },
    sectors: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ref: { type: 'string' }, label: { type: 'string' },
          kind: { enum: ['sector', 'technology', 'investment_thesis'] },
          description: { type: 'string' }, evidenceQuote: { type: 'string' },
        },
        required: ['ref', 'label', 'kind', 'evidenceQuote'],
      },
    },
    fundingRounds: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ref: { type: 'string' }, companyRef: { type: 'string' }, roundType: { enum: ROUND_TYPES },
          announcedOn: { type: 'string' }, sourceLabel: { type: 'string' }, evidenceQuote: { type: 'string' },
          money: {
            type: 'object', additionalProperties: false,
            properties: { currency: { type: 'string' }, amount: { type: 'string' }, sourceText: { type: 'string' } },
            required: ['currency', 'amount', 'sourceText'],
          },
        },
        required: ['ref', 'companyRef', 'roundType', 'evidenceQuote'],
      },
    },
    facts: {
      type: 'array',
      maxItems: 80,
      items: {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'round_participant' }, participantRef: { type: 'string' }, participantType: { enum: PARTICIPANT_TYPES }, roundRef: { type: 'string' }, role: { enum: PARTICIPANT_ROLES }, leadStatus: { enum: LEAD_STATUSES }, evidenceQuote: { type: 'string' } }, required: ['kind', 'participantRef', 'participantType', 'roundRef', 'role', 'leadStatus', 'evidenceQuote'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'partner_at' }, personRef: { type: 'string' }, firmRef: { type: 'string' }, title: { type: 'string' }, startedOn: { type: 'string' }, endedOn: { type: 'string' }, evidenceQuote: { type: 'string' } }, required: ['kind', 'personRef', 'firmRef', 'evidenceQuote'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'worked_at' }, personRef: { type: 'string' }, organizationRef: { type: 'string' }, employmentStatus: { enum: ['current', 'previous', 'unknown'] }, title: { type: 'string' }, startedOn: { type: 'string' }, endedOn: { type: 'string' }, evidenceQuote: { type: 'string' } }, required: ['kind', 'personRef', 'organizationRef', 'employmentStatus', 'evidenceQuote'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'founded' }, founderRef: { type: 'string' }, companyRef: { type: 'string' }, foundedOn: { type: 'string' }, evidenceQuote: { type: 'string' } }, required: ['kind', 'founderRef', 'companyRef', 'evidenceQuote'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'invested_in' }, investorRef: { type: 'string' }, companyRef: { type: 'string' }, announcedOn: { type: 'string' }, roundType: { enum: ROUND_TYPES }, evidenceQuote: { type: 'string' } }, required: ['kind', 'investorRef', 'companyRef', 'evidenceQuote'], additionalProperties: false },
          { type: 'object', properties: { kind: { const: 'board_member_of' }, personRef: { type: 'string' }, organizationRef: { type: 'string' }, startedOn: { type: 'string' }, endedOn: { type: 'string' }, evidenceQuote: { type: 'string' } }, required: ['kind', 'personRef', 'organizationRef', 'evidenceQuote'], additionalProperties: false },
          { type: 'object', properties: { kind: { enum: ['operates_in', 'uses_technology', 'interested_in'] }, entityRef: { type: 'string' }, sectorRef: { type: 'string' }, evidenceQuote: { type: 'string' } }, required: ['kind', 'entityRef', 'sectorRef', 'evidenceQuote'], additionalProperties: false },
        ],
      },
    },
    noFactsReason: { type: 'string' },
  },
  required: ['entities', 'sectors', 'fundingRounds', 'facts'],
};

const SYSTEM_PROMPT = [
  'Extract only explicit, public venture-capital investment facts from one document.',
  'Return the required JSON object and no prose.',
  '',
  'Rules:',
  '- Every entity, sector, round, and fact must include an exact quote copied from DOCUMENT TEXT.',
  '- Use short local refs (for example firm_1, company_1, person_1, round_1, sector_1).',
  '- Do not infer missing people, employers, rounds, investors, dates, amounts, lead status, or sectors.',
  '- Use entityType=company for an invested/operating company; resolution maps it to portfolio_company.',
  '- A round participant must be an investment_firm or person. Use unknown when role/lead status is not explicit.',
  '- Put round details only in fundingRounds. Do not put companyRef, roundType, money, or dates on a round_participant fact.',
  '- Put each investor in a separate facts item shaped exactly like:',
  '  {"kind":"round_participant","participantRef":"firm_1","participantType":"investment_firm","roundRef":"round_1","role":"lead","leadStatus":"confirmed_lead","evidenceQuote":"exact quote"}',
  '- The matching fundingRounds item is shaped like:',
  '  {"ref":"round_1","companyRef":"company_1","roundType":"series_a","money":{"currency":"USD","amount":"90000000","sourceText":"$90 million"},"evidenceQuote":"exact quote"}',
  '- Use YYYY-MM-DD only when that exact calendar date is explicit. Otherwise omit it.',
  '- For a funding round, set announcedOn only when its evidenceQuote contains exactly one unambiguous valid English Month D, YYYY or ISO YYYY-MM-DD date; normalize it to YYYY-MM-DD. Otherwise omit it.',
  '- Never use the page publication date as a round date unless that date is also explicit inside the funding round evidenceQuote.',
  '- Money is a decimal string plus uppercase currency. Preserve its exact source phrase in sourceText.',
  '- Use invested_in only for a direct portfolio/investment statement with no adequately identified round.',
  '- Do not emit co_invested_with. It is derived deterministically from shared validated round participation.',
  '- If the source explicitly states a company sector, declare a kind=sector sector mention and an operates_in fact linking the company ref to that sector ref.',
  '- If the source explicitly states a technology the company uses, declare a kind=technology sector mention and a uses_technology fact linking the company ref to that technology ref.',
  '- A sector mention uses label (never displayName), shaped exactly like:',
  '  {"ref":"sector_1","label":"Semiconductors","kind":"sector","evidenceQuote":"exact quote"}',
  '- Its company link is a separate fact shaped exactly like:',
  '  {"kind":"operates_in","entityRef":"company_1","sectorRef":"sector_1","evidenceQuote":"exact quote"}',
  '- If the source explicitly says a person founded or co-founded a company, declare both entities and emit a founded fact from founderRef to companyRef.',
  '- If the source explicitly names a former employer, declare the person and organization and emit worked_at with employmentStatus=previous.',
  '- These mappings authorize no inference: emit them only when the relationship itself is explicit and every mention and fact has an exact supporting quote.',
  '- Employment/founder/board facts must be public professional facts. Never extract personal contact or private data.',
  '- An empty extraction is valid; set noFactsReason.',
].join('\n');

export interface InvestmentExtractionResult {
  signalId: string;
  extraction: InvestmentExtraction;
  validation: InvestmentValidationResult;
  stagedClaims: ExtractionClaimStage[];
  model: string;
  providerInstanceId: string;
  fellBackFrom?: string;
  repaired: boolean;
}

/** StructuredGenerator adapter. It proposes typed candidates; code validates and stages them. */
export interface InvestmentFactExtractorOptions {
  /** Explicit model alias for an operator-run extraction; defaults to the production intelligence route. */
  alias?: string;
  /** Optional reachability fallback. Omit to fail on the explicitly selected alias. */
  fallbackAlias?: string;
}

export class InvestmentFactExtractor {
  private readonly alias: string;
  private readonly fallbackAlias?: string;

  constructor(
    private readonly generator: Pick<StructuredGenerator, 'generate'>,
    options: InvestmentFactExtractorOptions = {},
  ) {
    this.alias = options.alias ?? INTELLIGENCE_ALIAS;
    this.fallbackAlias = options.fallbackAlias === undefined
      ? (options.alias ? undefined : INTELLIGENCE_FALLBACK_ALIAS)
      : options.fallbackAlias;
  }

  async extract(
    signal: Pick<SignalRow, 'id' | 'sourceUrl' | 'title' | 'publishedAt' | 'excerpt'>,
    options: { signal?: AbortSignal } = {},
  ): Promise<InvestmentExtractionResult> {
    const result = await this.generator.generate({
      alias: this.alias,
      fallbackAlias: this.fallbackAlias,
      schema: InvestmentExtractionSchema,
      jsonSchema: INVESTMENT_JSON_SCHEMA,
      system: SYSTEM_PROMPT,
      workerRole: 'intelligence:investment-fact-extraction',
      signal: options.signal,
      temperature: 0,
      maxTokens: 8_000,
      user: [
        `SOURCE: ${signal.sourceUrl}`,
        signal.title ? `TITLE: ${signal.title}` : '',
        signal.publishedAt ? `PUBLISHED: ${signal.publishedAt}` : 'PUBLISHED: (not declared)',
        '',
        'DOCUMENT TEXT:',
        signal.excerpt,
      ].filter(Boolean).join('\n'),
    });

    const validation = validateInvestmentExtraction(result.value, signal.excerpt);
    const stagedClaims = stageExtractionClaims({
      signalId: signal.id,
      sourceText: signal.excerpt,
      extraction: result.value,
      extractorModel: result.model,
      providerInstanceId: result.providerInstanceId,
    });

    return {
      signalId: signal.id,
      extraction: result.value,
      validation,
      stagedClaims,
      model: result.model,
      providerInstanceId: result.providerInstanceId,
      fellBackFrom: result.fellBackFrom,
      repaired: result.repaired,
    };
  }
}
