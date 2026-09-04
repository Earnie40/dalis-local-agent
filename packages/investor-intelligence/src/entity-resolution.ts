import type {
  ExtractedEntityMention,
  ExtractedEntityType,
  IdentifierKind,
} from './investment-extraction.js';

export const RESOLVABLE_ENTITY_TYPES = [
  'investment_firm',
  'person',
  'portfolio_company',
  'strategic_company',
  'organization',
  'community',
  'publication',
  'conference',
  'government_body',
] as const;

export type ResolvableEntityType = (typeof RESOLVABLE_ENTITY_TYPES)[number];

export interface ResolutionEntityRecord {
  id: string;
  entityType: ResolvableEntityType;
  displayName: string;
  normalizedName: string;
}

/** Row projection from `intelligence_entity_aliases`. */
export interface ResolutionAliasRecord {
  entityId: string;
  alias: string;
  normalizedAlias: string;
  verified: boolean;
}

/** Row projection from `intelligence_entity_identifiers`. */
export interface ResolutionIdentifierRecord {
  entityId: string;
  identifierKind: IdentifierKind;
  rawValue: string;
  normalizedValue: string;
  verified: boolean;
}

export interface EntityResolutionContext {
  entities: readonly ResolutionEntityRecord[];
  aliases?: readonly ResolutionAliasRecord[];
  identifiers?: readonly ResolutionIdentifierRecord[];
  /** Required to create a new person; known people can still resolve without it. */
  isPublicProfessionalSubject?: boolean;
}

export type EntityResolutionMatchBasis = 'verified_identifier' | 'verified_alias' | 'normalized_name';

export interface EntityCreationProposal {
  entityType: ResolvableEntityType;
  canonicalName: string;
  normalizedName: string;
  aliases: Array<{
    alias: string;
    normalizedAlias: string;
    aliasKind: 'canonical';
    verified: true;
  }>;
  identifiers: Array<{
    identifierKind: IdentifierKind;
    rawValue: string;
    normalizedValue: string;
    verified: true;
  }>;
}

export type EntityResolutionDecision =
  | {
      status: 'matched';
      mentionRef: string;
      entityId: string;
      matchedBy: EntityResolutionMatchBasis;
      normalizedKey: string;
    }
  | {
      status: 'create';
      mentionRef: string;
      proposal: EntityCreationProposal;
      reason: 'no_exact_match';
    }
  | {
      status: 'ambiguous';
      mentionRef: string;
      candidateEntityIds: readonly string[];
      matchedBy: EntityResolutionMatchBasis;
      normalizedKey: string;
      reason: string;
    }
  | {
      status: 'rejected';
      mentionRef: string;
      candidateEntityIds: readonly string[];
      reasonCode: 'identifier_type_conflict' | 'private_person' | 'invalid_identifier' | 'invalid_name';
      reason: string;
    };

/**
 * Must stay byte-compatible with migration 024's normalized_name backfill:
 * ASCII alphanumerics, lowercase, and collapsed spaces. Corporate suffixes and
 * words are deliberately retained; this is exact-key resolution, not fuzzy
 * company-name matching.
 */
export function normalizeEntityName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeEntityIdentifier(kind: IdentifierKind, rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;

  switch (kind) {
    case 'domain': {
      const normalized = value.toLowerCase().replace(/\.$/, '');
      return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
        ? normalized
        : undefined;
    }
    case 'website_url':
    case 'linkedin_url': {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) return undefined;
        if (kind === 'linkedin_url' && !/(^|\.)linkedin\.com$/i.test(url.hostname)) return undefined;
        url.hash = '';
        const normalized = url.toString().replace(/\/$/, '').toLowerCase();
        return normalized;
      } catch {
        return undefined;
      }
    }
    case 'external_slug':
      return value.toLowerCase();
    case 'external_id':
      // External IDs can be case-sensitive; exact means retaining their case.
      return value;
  }
}

export function compatibleEntityTypes(extractedType: ExtractedEntityType): readonly ResolvableEntityType[] {
  switch (extractedType) {
    case 'investment_firm':
      return ['investment_firm'];
    case 'person':
      return ['person'];
    case 'company':
      // "Company" describes the role in this document, not a permanent
      // database classification. The same legal organization may already be
      // known as a strategic company or professional employer; exact identity
      // evidence should resolve that node rather than create a duplicate.
      return ['portfolio_company', 'strategic_company', 'organization'];
    case 'organization':
      // Known employers retain their precise type; new ones are organizations.
      return ['organization', 'strategic_company', 'portfolio_company', 'government_body', 'investment_firm'];
  }
}

export function creationEntityType(extractedType: ExtractedEntityType): ResolvableEntityType {
  switch (extractedType) {
    case 'company':
      return 'portfolio_company';
    case 'organization':
      return 'organization';
    default:
      return extractedType;
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function entityMap(context: EntityResolutionContext): Map<string, ResolutionEntityRecord> {
  return new Map(context.entities.map((entity) => [entity.id, entity] as const));
}

/**
 * Conservative deterministic resolution:
 *
 * 1. exact, verified identifiers;
 * 2. exact, verified aliases or exact normalized canonical name, constrained by
 *    compatible entity type;
 * 3. propose creation rather than guessing.
 *
 * No edit distance, embedding, substring, domain-host heuristic, or model call
 * is permitted in this function.
 */
export function resolveEntityMention(
  mention: ExtractedEntityMention,
  context: EntityResolutionContext,
): EntityResolutionDecision {
  const byId = entityMap(context);
  const compatible = new Set(compatibleEntityTypes(mention.entityType));

  const normalizedIdentifiers: Array<{ kind: IdentifierKind; raw: string; normalized: string }> = [];
  for (const identifier of mention.identifiers) {
    const normalized = normalizeEntityIdentifier(identifier.kind, identifier.value);
    if (!normalized) {
      return {
        status: 'rejected',
        mentionRef: mention.ref,
        candidateEntityIds: [],
        reasonCode: 'invalid_identifier',
        reason: `Identifier ${identifier.kind}="${identifier.value}" cannot be normalized as a public exact identifier.`,
      };
    }
    normalizedIdentifiers.push({ kind: identifier.kind, raw: identifier.value, normalized });
  }

  const identifierMatches = new Set<string>();
  for (const candidate of normalizedIdentifiers) {
    for (const stored of context.identifiers ?? []) {
      if (!stored.verified || stored.identifierKind !== candidate.kind) continue;
      if (stored.normalizedValue === candidate.normalized) identifierMatches.add(stored.entityId);
    }
  }

  if (identifierMatches.size) {
    const allMatches = uniqueSorted(identifierMatches);
    const incompatible = allMatches.filter((id) => {
      const entity = byId.get(id);
      return !entity || !compatible.has(entity.entityType);
    });
    if (incompatible.length) {
      return {
        status: 'rejected',
        mentionRef: mention.ref,
        candidateEntityIds: allMatches,
        reasonCode: 'identifier_type_conflict',
        reason: `A verified exact identifier belongs to an incompatible entity type; refusing to create or retype an entity.`,
      };
    }
    if (allMatches.length === 1) {
      return {
        status: 'matched',
        mentionRef: mention.ref,
        entityId: allMatches[0],
        matchedBy: 'verified_identifier',
        normalizedKey: normalizedIdentifiers.map((value) => `${value.kind}:${value.normalized}`).join('|'),
      };
    }
    return {
      status: 'ambiguous',
      mentionRef: mention.ref,
      candidateEntityIds: allMatches,
      matchedBy: 'verified_identifier',
      normalizedKey: normalizedIdentifiers.map((value) => `${value.kind}:${value.normalized}`).join('|'),
      reason: 'Different verified identifiers on the same mention resolve to different compatible entities.',
    };
  }

  const normalizedName = normalizeEntityName(mention.displayName);
  if (!normalizedName) {
    return {
      status: 'rejected',
      mentionRef: mention.ref,
      candidateEntityIds: [],
      reasonCode: 'invalid_name',
      reason: 'The display name has no usable normalized form.',
    };
  }

  const aliasMatches = uniqueSorted((context.aliases ?? [])
    .filter((alias) => alias.verified && alias.normalizedAlias === normalizedName)
    .map((alias) => alias.entityId)
    .filter((id) => {
      const entity = byId.get(id);
      return entity !== undefined && compatible.has(entity.entityType);
    }));

  const nameMatches = uniqueSorted(context.entities
    .filter((entity) => compatible.has(entity.entityType) && entity.normalizedName === normalizedName)
    .map((entity) => entity.id));

  const exactMatches = uniqueSorted([...aliasMatches, ...nameMatches]);
  if (exactMatches.length === 1) {
    return {
      status: 'matched',
      mentionRef: mention.ref,
      entityId: exactMatches[0],
      matchedBy: aliasMatches.includes(exactMatches[0]) ? 'verified_alias' : 'normalized_name',
      normalizedKey: normalizedName,
    };
  }
  if (exactMatches.length > 1) {
    return {
      status: 'ambiguous',
      mentionRef: mention.ref,
      candidateEntityIds: exactMatches,
      matchedBy: aliasMatches.length ? 'verified_alias' : 'normalized_name',
      normalizedKey: normalizedName,
      reason: 'More than one compatible entity has this exact verified alias or normalized canonical name.',
    };
  }

  const incompatibleNameMatches = uniqueSorted(context.entities
    .filter((entity) => !compatible.has(entity.entityType) && entity.normalizedName === normalizedName)
    .map((entity) => entity.id));
  if (incompatibleNameMatches.length) {
    return {
      status: 'ambiguous',
      mentionRef: mention.ref,
      candidateEntityIds: incompatibleNameMatches,
      matchedBy: 'normalized_name',
      normalizedKey: normalizedName,
      reason:
        'An exact normalized name already exists under an incompatible type; ' +
        'refusing to create a likely duplicate or silently reclassify it.',
    };
  }

  if (mention.entityType === 'person' && context.isPublicProfessionalSubject !== true) {
    return {
      status: 'rejected',
      mentionRef: mention.ref,
      candidateEntityIds: [],
      reasonCode: 'private_person',
      reason: 'Creating a person requires an explicit public-professional subject gate.',
    };
  }

  return {
    status: 'create',
    mentionRef: mention.ref,
    reason: 'no_exact_match',
    proposal: {
      entityType: creationEntityType(mention.entityType),
      canonicalName: mention.displayName.trim(),
      normalizedName,
      aliases: [{
        alias: mention.displayName.trim(),
        normalizedAlias: normalizedName,
        aliasKind: 'canonical',
        verified: true,
      }],
      identifiers: normalizedIdentifiers.map((identifier) => ({
        identifierKind: identifier.kind,
        rawValue: identifier.raw,
        normalizedValue: identifier.normalized,
        verified: true,
      })),
    },
  };
}

export interface ResolveEntityMentionsResult {
  decisions: ReadonlyMap<string, EntityResolutionDecision>;
  matched: number;
  proposed: number;
  ambiguous: number;
  rejected: number;
  /** True only when every mention can proceed to canonical persistence. */
  complete: boolean;
}

/** Resolve a whole document and preserve one decision per local reference. */
export function resolveEntityMentions(
  mentions: readonly ExtractedEntityMention[],
  context: EntityResolutionContext,
): ResolveEntityMentionsResult {
  const decisions = new Map<string, EntityResolutionDecision>();
  let matched = 0;
  let proposed = 0;
  let ambiguous = 0;
  let rejected = 0;

  for (const mention of mentions) {
    const decision = resolveEntityMention(mention, context);
    decisions.set(mention.ref, decision);
    if (decision.status === 'matched') matched += 1;
    else if (decision.status === 'create') proposed += 1;
    else if (decision.status === 'ambiguous') ambiguous += 1;
    else rejected += 1;
  }

  return {
    decisions,
    matched,
    proposed,
    ambiguous,
    rejected,
    complete: ambiguous === 0 && rejected === 0,
  };
}

export interface EntityResolutionAuditStage {
  mentionRef: string;
  extractedEntityType: ExtractedEntityType;
  normalizedName: string;
  decisionStatus: EntityResolutionDecision['status'];
  resolvedEntityId?: string;
  candidateEntityIds: readonly string[];
  decisionBasis?: EntityResolutionMatchBasis;
  reason: string;
}

/** Deterministic audit payload; persistence/actor attribution remains outside the resolver. */
export function stageEntityResolutionAudit(
  mention: ExtractedEntityMention,
  decision: EntityResolutionDecision,
): EntityResolutionAuditStage {
  switch (decision.status) {
    case 'matched':
      return {
        mentionRef: mention.ref,
        extractedEntityType: mention.entityType,
        normalizedName: normalizeEntityName(mention.displayName),
        decisionStatus: decision.status,
        resolvedEntityId: decision.entityId,
        candidateEntityIds: [decision.entityId],
        decisionBasis: decision.matchedBy,
        reason: `Matched exact ${decision.matchedBy}.`,
      };
    case 'create':
      return {
        mentionRef: mention.ref,
        extractedEntityType: mention.entityType,
        normalizedName: decision.proposal.normalizedName,
        decisionStatus: decision.status,
        candidateEntityIds: [],
        reason: decision.reason,
      };
    case 'ambiguous':
      return {
        mentionRef: mention.ref,
        extractedEntityType: mention.entityType,
        normalizedName: normalizeEntityName(mention.displayName),
        decisionStatus: decision.status,
        candidateEntityIds: decision.candidateEntityIds,
        decisionBasis: decision.matchedBy,
        reason: decision.reason,
      };
    case 'rejected':
      return {
        mentionRef: mention.ref,
        extractedEntityType: mention.entityType,
        normalizedName: normalizeEntityName(mention.displayName),
        decisionStatus: decision.status,
        candidateEntityIds: decision.candidateEntityIds,
        reason: `${decision.reasonCode}: ${decision.reason}`,
      };
  }
}
