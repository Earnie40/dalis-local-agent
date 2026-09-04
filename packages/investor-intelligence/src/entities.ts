import { createId, getPool } from '@dacai-local-agent/shared';
import { assertResearchableSubject, admitSource, type PublicSourceKind } from './sources.js';

/**
 * Entity and source registry.
 *
 * Everything the system watches lives in the database. Adding Lux Capital, an
 * aerospace prime, a robotics company, or a technical publication is an INSERT —
 * there is no per-entity code anywhere in this package, and the seeded entities
 * carry no privileged status.
 */

export type EntityType =
  | 'investment_firm'
  | 'person'
  | 'portfolio_company'
  | 'strategic_company'
  | 'community'
  | 'publication'
  | 'conference'
  | 'government_body'
  | 'organization';

export const ENTITY_TYPES: readonly EntityType[] = [
  'investment_firm',
  'person',
  'portfolio_company',
  'strategic_company',
  'community',
  'publication',
  'conference',
  'government_body',
  'organization',
];

export interface EntityInput {
  displayName: string;
  entityType: EntityType;
  slug?: string;
  canonicalName?: string;
  domain?: string;
  linkedinUrl?: string;
  externalSlug?: string;
  /** Headquarters for organizations only; never a person's whereabouts. */
  headquartersLocation?: string;
  /** Professional role/affiliation only. There is no field for personal data. */
  professionalSummary?: string;
  primaryUrl?: string;
  /**
   * Defaults true, because the entities this system is for are firms and people
   * who publish professionally. Setting it false marks someone as out of scope
   * and makes every research call on them fail closed.
   */
  isPublicProfessional?: boolean;
  watchEnabled?: boolean;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface Entity {
  id: string;
  slug: string;
  displayName: string;
  canonicalName: string;
  normalizedName: string;
  entityType: EntityType;
  domain?: string;
  linkedinUrl?: string;
  externalSlug?: string;
  headquartersLocation?: string;
  professionalSummary?: string;
  primaryUrl?: string;
  isPublicProfessional: boolean;
  watchEnabled: boolean;
  notes?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class EntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityError';
  }
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new EntityError(`"${value}" does not produce a usable slug.`);
  return slug.slice(0, 120);
}

/**
 * Conservative identity key used for candidate lookup, never as a globally
 * unique identifier. Names collide; the resolver must also consider entity
 * type and strong identifiers before accepting a match.
 */
function normalizeStoredEntityName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export class EntityStore {
  async upsert(input: EntityInput): Promise<Entity> {
    const displayName = input.displayName?.trim();
    if (!displayName) throw new EntityError('displayName is required.');
    if (!ENTITY_TYPES.includes(input.entityType)) {
      throw new EntityError(`Unknown entity type "${input.entityType}".`);
    }

    const slug = input.slug?.trim() || slugify(displayName);
    const canonicalName = input.canonicalName?.trim() || displayName;
    const normalizedName = normalizeStoredEntityName(canonicalName);
    const { rows } = await getPool().query(
      `INSERT INTO intelligence_entities (
         id, entity_type, display_name, slug, canonical_name, normalized_name,
         domain, linkedin_url, external_slug, headquarters_location,
         professional_summary, primary_url, is_public_professional, watch_enabled,
         notes, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         canonical_name = EXCLUDED.canonical_name,
         normalized_name = EXCLUDED.normalized_name,
         domain = COALESCE(EXCLUDED.domain, intelligence_entities.domain),
         linkedin_url = COALESCE(EXCLUDED.linkedin_url, intelligence_entities.linkedin_url),
         external_slug = COALESCE(EXCLUDED.external_slug, intelligence_entities.external_slug),
         headquarters_location = COALESCE(EXCLUDED.headquarters_location, intelligence_entities.headquarters_location),
         professional_summary = COALESCE(EXCLUDED.professional_summary, intelligence_entities.professional_summary),
         primary_url = COALESCE(EXCLUDED.primary_url, intelligence_entities.primary_url),
         is_public_professional = EXCLUDED.is_public_professional,
         watch_enabled = EXCLUDED.watch_enabled,
         notes = COALESCE(EXCLUDED.notes, intelligence_entities.notes),
         metadata = intelligence_entities.metadata || EXCLUDED.metadata,
         updated_at = now()
       WHERE intelligence_entities.entity_type = EXCLUDED.entity_type
       RETURNING *`,
      [
        createId('ent'),
        input.entityType,
        displayName,
        slug,
        canonicalName,
        normalizedName,
        normalizeDomain(input.domain ?? input.primaryUrl),
        input.linkedinUrl?.trim() ?? null,
        input.externalSlug?.trim() ?? null,
        input.entityType === 'person' ? null : (input.headquartersLocation?.trim() ?? null),
        input.professionalSummary?.trim() ?? null,
        input.primaryUrl?.trim() ?? null,
        input.isPublicProfessional ?? true,
        input.watchEnabled ?? true,
        input.notes?.trim() ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!rows[0]) {
      const existing = await this.bySlug(slug);
      throw new EntityError(
        `Entity slug "${slug}" is already ${existing?.entityType ?? 'a different type'}; ` +
          `refusing to silently reclassify it as ${input.entityType}. Use evidence-gated reclassification.`,
      );
    }
    return toEntity(rows[0]);
  }

  async bySlug(slug: string): Promise<Entity | undefined> {
    const { rows } = await getPool().query('SELECT * FROM intelligence_entities WHERE slug = $1', [slug]);
    return rows[0] ? toEntity(rows[0]) : undefined;
  }

  async byId(id: string): Promise<Entity | undefined> {
    const { rows } = await getPool().query('SELECT * FROM intelligence_entities WHERE id = $1', [id]);
    return rows[0] ? toEntity(rows[0]) : undefined;
  }

  async list(filter: { entityType?: EntityType; watchedOnly?: boolean } = {}): Promise<Entity[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.entityType) {
      params.push(filter.entityType);
      conditions.push(`entity_type = $${params.length}`);
    }
    if (filter.watchedOnly) conditions.push('watch_enabled');

    const { rows } = await getPool().query(
      `SELECT * FROM intelligence_entities
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY entity_type, display_name`,
      params,
    );
    return rows.map(toEntity);
  }

  /**
   * Entity-type changes are deliberately separate from upsert. A correction
   * must cite an already stored signal attached to the entity, and the audit
   * row is committed atomically with the new type.
   */
  async reclassify(input: {
    entityId: string;
    correctedType: EntityType;
    signalId: string;
    rationale: string;
    correctedBy: string;
    metadata?: Record<string, unknown>;
  }): Promise<Entity> {
    if (!ENTITY_TYPES.includes(input.correctedType)) {
      throw new EntityError(`Unknown corrected entity type "${input.correctedType}".`);
    }
    if (!input.rationale.trim() || !input.correctedBy.trim()) {
      throw new EntityError('An entity correction requires a rationale and named correcting actor.');
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<Record<string, unknown>>(
        'SELECT * FROM intelligence_entities WHERE id = $1 FOR UPDATE',
        [input.entityId],
      );
      if (!current.rows[0]) throw new EntityError(`Unknown entity "${input.entityId}".`);
      const previousType = String(current.rows[0].entity_type) as EntityType;
      if (previousType === input.correctedType) {
        await client.query('COMMIT');
        return toEntity(current.rows[0]);
      }

      const evidence = await client.query(
        `SELECT 1
           FROM signal_entities se
           JOIN intelligence_signals s ON s.id = se.signal_id
          WHERE se.entity_id = $1 AND se.signal_id = $2`,
        [input.entityId, input.signalId],
      );
      if (!evidence.rowCount) {
        throw new EntityError(
          `Signal "${input.signalId}" is not attached to entity "${input.entityId}"; refusing unsupported reclassification.`,
        );
      }

      await client.query(
        `INSERT INTO intelligence_entity_corrections (
           id, entity_id, previous_type, corrected_type, signal_id, rationale,
           corrected_by, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (entity_id, previous_type, corrected_type, signal_id) DO NOTHING`,
        [
          createId('cor'),
          input.entityId,
          previousType,
          input.correctedType,
          input.signalId,
          input.rationale.trim(),
          input.correctedBy.trim().slice(0, 200),
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE intelligence_entities
            SET entity_type = $2, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [input.entityId, input.correctedType],
      );
      await client.query('COMMIT');
      return toEntity(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The gate every research path calls before issuing a single query.
   *
   * Loading an entity and checking the flag are deliberately one operation, so
   * there is no way to obtain an entity without having had the check available.
   */
  async requireResearchable(entityId: string): Promise<Entity> {
    const entity = await this.byId(entityId);
    if (!entity) throw new EntityError(`Unknown entity "${entityId}".`);
    assertResearchableSubject({
      displayName: entity.displayName,
      entityType: entity.entityType,
      isPublicProfessional: entity.isPublicProfessional,
    });
    return entity;
  }
}

function toEntity(row: Record<string, unknown>): Entity {
  return {
    id: String(row.id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    canonicalName: String(row.canonical_name ?? row.display_name),
    normalizedName: String(row.normalized_name ?? normalizeStoredEntityName(String(row.display_name))),
    entityType: String(row.entity_type) as EntityType,
    domain: (row.domain as string | null) ?? undefined,
    linkedinUrl: (row.linkedin_url as string | null) ?? undefined,
    externalSlug: (row.external_slug as string | null) ?? undefined,
    headquartersLocation: (row.headquarters_location as string | null) ?? undefined,
    professionalSummary: (row.professional_summary as string | null) ?? undefined,
    primaryUrl: (row.primary_url as string | null) ?? undefined,
    isPublicProfessional: Boolean(row.is_public_professional),
    watchEnabled: Boolean(row.watch_enabled),
    notes: (row.notes as string | null) ?? undefined,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function normalizeDomain(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = candidate.includes('://') ? new URL(candidate) : new URL(`https://${candidate}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SourceInput {
  entityId?: string;
  url: string;
  kind: PublicSourceKind;
  title?: string;
  publisher?: string;
  license: string;
  metadata?: Record<string, unknown>;
}

export interface SourceRecord {
  id: string;
  entityId?: string;
  url: string;
  kind: string;
  title?: string;
  publisher?: string;
  license: string;
  enabled: boolean;
  failureCount: number;
  lastFetchAt?: string;
  lastStatus?: string;
}

export class SourceStore {
  /** Admission runs before the insert, so a refused source never reaches the table. */
  async register(input: SourceInput): Promise<SourceRecord> {
    const accepted = admitSource({
      url: input.url,
      kind: input.kind,
      title: input.title,
      publisher: input.publisher,
      license: input.license,
    });

    const { rows } = await getPool().query(
      `INSERT INTO intelligence_sources (id, entity_id, source_kind, url, title, publisher, license, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (url) DO UPDATE SET
         entity_id = COALESCE(EXCLUDED.entity_id, intelligence_sources.entity_id),
         title = COALESCE(EXCLUDED.title, intelligence_sources.title),
         publisher = COALESCE(EXCLUDED.publisher, intelligence_sources.publisher)
       RETURNING *`,
      [
        createId('src'),
        input.entityId ?? null,
        accepted.kind,
        accepted.url,
        accepted.title ?? null,
        accepted.publisher ?? null,
        accepted.license,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return toSource(rows[0]);
  }

  async recordFetch(sourceId: string, status: string, failed: boolean): Promise<void> {
    await getPool().query(
      `UPDATE intelligence_sources
          SET last_fetch_at = now(),
              last_status = $2,
              failure_count = CASE WHEN $3 THEN failure_count + 1 ELSE 0 END,
              -- A source that has failed repeatedly is disabled rather than
              -- retried forever; re-enabling is a deliberate operator action.
              enabled = CASE WHEN $3 AND failure_count + 1 >= 5 THEN false ELSE enabled END
        WHERE id = $1`,
      [sourceId, status.slice(0, 200), failed],
    );
  }

  async forEntity(entityId: string, enabledOnly = true): Promise<SourceRecord[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM intelligence_sources
        WHERE entity_id = $1 ${enabledOnly ? 'AND enabled' : ''}
        ORDER BY discovered_at DESC`,
      [entityId],
    );
    return rows.map(toSource);
  }
}

function toSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    entityId: (row.entity_id as string | null) ?? undefined,
    url: String(row.url),
    kind: String(row.source_kind),
    title: (row.title as string | null) ?? undefined,
    publisher: (row.publisher as string | null) ?? undefined,
    license: String(row.license),
    enabled: Boolean(row.enabled),
    failureCount: Number(row.failure_count ?? 0),
    lastFetchAt: (row.last_fetch_at as Date | null)?.toISOString(),
    lastStatus: (row.last_status as string | null) ?? undefined,
  };
}
