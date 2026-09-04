import { createId, getPool } from '@dacai-local-agent/shared';

/**
 * DACAIS capability status — the single guard against overclaiming.
 *
 * The ladder exists because "we are building toward X" and "we do X" are
 * different statements, and the second one is a lie when only the first is true.
 * Encoding the difference as data rather than as writing discipline means the
 * distinction survives being handed to a language model.
 *
 * Each level means something specific and is NOT implied by the one before it:
 *
 *   PRODUCTION         running, used, and observable in production today.
 *   WORKING_PROTOTYPE  really runs and can be demonstrated end to end.
 *   IN_DEVELOPMENT     being built; parts work, the whole does not yet.
 *   DESIGN_COMPLETE    designed and specified. No working implementation.
 *   RESEARCH           actively investigated. No committed design.
 *   HORIZON            stated strategic direction. Nothing built.
 *   UNVERIFIED         asserted by an operator; the system has seen no evidence.
 *
 * Present-tense capability language is only ever generated for PRODUCTION and
 * WORKING_PROTOTYPE. Everything below gets intent framing, and UNVERIFIED is
 * excluded from generated content entirely.
 */

export type CapabilityStatus =
  | 'PRODUCTION'
  | 'WORKING_PROTOTYPE'
  | 'IN_DEVELOPMENT'
  | 'DESIGN_COMPLETE'
  | 'RESEARCH'
  | 'HORIZON'
  | 'UNVERIFIED';

/** Ordered strongest to weakest. UNVERIFIED sits outside the ladder entirely. */
export const CAPABILITY_LADDER: readonly CapabilityStatus[] = [
  'PRODUCTION',
  'WORKING_PROTOTYPE',
  'IN_DEVELOPMENT',
  'DESIGN_COMPLETE',
  'RESEARCH',
  'HORIZON',
  'UNVERIFIED',
];

const RANK = new Map<CapabilityStatus, number>(
  CAPABILITY_LADDER.map((status, index) => [status, index]),
);

export function isCapabilityStatus(value: string): value is CapabilityStatus {
  return RANK.has(value as CapabilityStatus);
}

/** True when `actual` is at least as strong as `required`. */
export function atLeastStatus(actual: CapabilityStatus, required: CapabilityStatus): boolean {
  return (RANK.get(actual) ?? Number.MAX_SAFE_INTEGER) <= (RANK.get(required) ?? -1);
}

/**
 * The two statuses that may be described in the present tense.
 *
 * This is the single place that decision is made. The risk guard, the content
 * generator, and the diligence scorer all consult it rather than each carrying
 * their own idea of what counts as real.
 */
export function allowsPresentTense(status: CapabilityStatus): boolean {
  return status === 'PRODUCTION' || status === 'WORKING_PROTOTYPE';
}

/** May this capability appear in externally published content at all? */
export function isPublishable(status: CapabilityStatus): boolean {
  return status !== 'UNVERIFIED';
}

/**
 * How a capability at each status may honestly be described.
 *
 * Returned as guidance to the drafting model AND as the assertion the risk guard
 * checks against, so the instruction and the enforcement cannot drift apart.
 */
export function framingFor(status: CapabilityStatus): {
  tense: 'present' | 'progressive' | 'intent';
  guidance: string;
  exampleVerb: string;
} {
  switch (status) {
    case 'PRODUCTION':
      return {
        tense: 'present',
        guidance: 'Running in production. Present tense is accurate; name what it actually does.',
        exampleVerb: 'operates',
      };
    case 'WORKING_PROTOTYPE':
      return {
        tense: 'present',
        guidance:
          'Really runs and can be demonstrated. Present tense is accurate, but say it is a working ' +
          'implementation rather than implying production scale or production usage.',
        exampleVerb: 'runs',
      };
    case 'IN_DEVELOPMENT':
      return {
        tense: 'progressive',
        guidance:
          'Under construction. Describe it as being built. Never state that it does the thing yet, ' +
          'and never describe a partial implementation as the finished capability.',
        exampleVerb: 'is building',
      };
    case 'DESIGN_COMPLETE':
      return {
        tense: 'intent',
        guidance:
          'Designed but not implemented. Describe the architecture and the intent. Do not describe ' +
          'behaviour, performance, or results, because none have been observed.',
        exampleVerb: 'has designed an architecture intended to',
      };
    case 'RESEARCH':
      return {
        tense: 'intent',
        guidance:
          'Under investigation. Describe it as an open question being researched, never as a ' +
          'capability or a roadmap commitment.',
        exampleVerb: 'is researching',
      };
    case 'HORIZON':
      return {
        tense: 'intent',
        guidance:
          'Strategic direction only. Nothing is built. Say where the architecture is intended to ' +
          'extend, and state plainly that it is a direction rather than a current capability.',
        exampleVerb: 'is developing architecture intended to extend toward',
      };
    case 'UNVERIFIED':
      return {
        tense: 'intent',
        guidance:
          'No evidence has been found for this claim. It must not appear in generated content at all ' +
          'until evidence is attached and a status is assigned.',
        exampleVerb: '(not publishable)',
      };
  }
}

export interface CapabilityInput {
  slug?: string;
  name: string;
  description: string;
  status?: CapabilityStatus;
  demonstrable?: boolean;
  publiclyShareable?: boolean;
  safePhrasing?: string;
  /**
   * True when a human declared this capability rather than the system deriving
   * it from repository evidence. Declared capabilities start UNVERIFIED and
   * cannot be promoted without evidence being attached.
   */
  operatorDeclared?: boolean;
}

export interface Capability {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: CapabilityStatus;
  demonstrable: boolean;
  publiclyShareable: boolean;
  safePhrasing?: string;
  operatorDeclared: boolean;
  lastVerifiedAt?: string;
  evidenceCount: number;
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export class CapabilityStore {
  async upsert(input: CapabilityInput): Promise<Capability> {
    const name = input.name?.trim();
    if (!name) throw new CapabilityError('name is required.');
    const description = input.description?.trim();
    if (!description) throw new CapabilityError('description is required.');

    const status = input.status ?? 'UNVERIFIED';
    if (!isCapabilityStatus(status)) throw new CapabilityError(`Unknown capability status "${status}".`);

    // An operator-declared capability starts UNVERIFIED regardless of what the
    // seed file claims. Promotion requires evidence, which is a separate,
    // evidence-bearing operation.
    const effectiveStatus = input.operatorDeclared ? 'UNVERIFIED' : status;

    const slug = input.slug?.trim() || slugifyCapability(name);
    const { rows } = await getPool().query(
      `INSERT INTO dacais_capabilities
         (id, slug, name, description, status, demonstrable, publicly_shareable, safe_phrasing, operator_declared)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         safe_phrasing = COALESCE(EXCLUDED.safe_phrasing, dacais_capabilities.safe_phrasing),
         -- Status is NOT overwritten on conflict: re-running a seed must never
         -- silently demote a capability that evidence has since promoted.
         updated_at = now()
       RETURNING *`,
      [
        createId('cap'),
        slug,
        name,
        description,
        effectiveStatus,
        // Both flags are derived, never taken on faith from the caller.
        effectiveStatus === 'PRODUCTION' || effectiveStatus === 'WORKING_PROTOTYPE'
          ? (input.demonstrable ?? false)
          : false,
        isPublishable(effectiveStatus) ? (input.publiclyShareable ?? false) : false,
        input.safePhrasing?.trim() ?? null,
        input.operatorDeclared ?? false,
      ],
    );
    return toCapability(rows[0], 0);
  }

  /**
   * Promotes a capability on the ladder.
   *
   * Refuses without evidence. This is the one operation that can make a claim
   * publishable, so it is the one that must not be possible to perform on a
   * model's assertion or an operator's optimism alone.
   */
  async promote(
    slug: string,
    status: CapabilityStatus,
    options: { demonstrable?: boolean; publiclyShareable?: boolean; verifiedBy: string } = { verifiedBy: '' },
  ): Promise<Capability> {
    if (!isCapabilityStatus(status)) throw new CapabilityError(`Unknown capability status "${status}".`);
    if (!options.verifiedBy?.trim()) {
      throw new CapabilityError('A named verifier is required to change a capability status.');
    }

    const existing = await this.bySlug(slug);
    if (!existing) throw new CapabilityError(`Unknown capability "${slug}".`);

    if (status !== 'UNVERIFIED' && existing.evidenceCount === 0) {
      throw new CapabilityError(
        `Refusing to set "${slug}" to ${status}: no evidence is attached. ` +
          'A capability status is a claim about reality and must be backed by a retrievable artifact ' +
          '(source symbol, test, benchmark, or document).',
      );
    }

    const { rows } = await getPool().query(
      `UPDATE dacais_capabilities
          SET status = $2,
              demonstrable = $3,
              publicly_shareable = $4,
              last_verified_at = now(),
              updated_at = now()
        WHERE slug = $1
        RETURNING *`,
      [
        slug,
        status,
        allowsPresentTense(status) ? (options.demonstrable ?? existing.demonstrable) : false,
        isPublishable(status) ? (options.publiclyShareable ?? existing.publiclyShareable) : false,
      ],
    );
    return toCapability(rows[0], existing.evidenceCount);
  }

  async bySlug(slug: string): Promise<Capability | undefined> {
    const { rows } = await getPool().query(
      `SELECT c.*, (SELECT count(*)::int FROM dacais_evidence e WHERE e.capability_id = c.id) AS evidence_count
         FROM dacais_capabilities c WHERE c.slug = $1`,
      [slug],
    );
    return rows[0] ? toCapability(rows[0], Number(rows[0].evidence_count)) : undefined;
  }

  async byId(id: string): Promise<Capability | undefined> {
    const { rows } = await getPool().query(
      `SELECT c.*, (SELECT count(*)::int FROM dacais_evidence e WHERE e.capability_id = c.id) AS evidence_count
         FROM dacais_capabilities c WHERE c.id = $1`,
      [id],
    );
    return rows[0] ? toCapability(rows[0], Number(rows[0].evidence_count)) : undefined;
  }

  async list(options: { publishableOnly?: boolean } = {}): Promise<Capability[]> {
    const { rows } = await getPool().query(
      `SELECT c.*, (SELECT count(*)::int FROM dacais_evidence e WHERE e.capability_id = c.id) AS evidence_count
         FROM dacais_capabilities c
        ${options.publishableOnly ? "WHERE c.status <> 'UNVERIFIED'" : ''}
        ORDER BY array_position($1::text[], c.status), c.name`,
      [[...CAPABILITY_LADDER]],
    );
    return rows.map((row) => toCapability(row, Number(row.evidence_count)));
  }

  /**
   * Capabilities admissible in generated content.
   *
   * UNVERIFIED is excluded and so is anything with zero attached evidence: a
   * capability nobody can point at is not something to publish about, whatever
   * status someone assigned it.
   */
  async publishable(): Promise<Capability[]> {
    return (await this.list({ publishableOnly: true })).filter((c) => c.evidenceCount > 0);
  }
}

function toCapability(row: Record<string, unknown>, evidenceCount: number): Capability {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    status: String(row.status) as CapabilityStatus,
    demonstrable: Boolean(row.demonstrable),
    publiclyShareable: Boolean(row.publicly_shareable),
    safePhrasing: (row.safe_phrasing as string | null) ?? undefined,
    operatorDeclared: Boolean(row.operator_declared),
    lastVerifiedAt: (row.last_verified_at as Date | null)?.toISOString(),
    evidenceCount,
  };
}

function slugifyCapability(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new CapabilityError(`"${name}" does not produce a usable slug.`);
  return slug.slice(0, 120);
}
