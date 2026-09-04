/**
 * The collection boundary.
 *
 * This module is the reason the system is research rather than surveillance, so
 * everything here is deterministic code with no model in the path. A model may
 * suggest what to look for; only this file decides what may be retrieved.
 *
 * Two rules do the work:
 *
 *   1. **Allow-list, not deny-list.** A source kind that is not enumerated in
 *      ALLOWED_SOURCE_KINDS cannot be represented, so it cannot be collected.
 *      New categories of source require someone to add them deliberately.
 *   2. **Public professional activity only.** Public means retrievable without
 *      an account, a login, a paid personal-data broker, or membership in a
 *      closed group. Professional means what a person or firm published in
 *      their working capacity.
 *
 * The database enforces the same allow-list independently (migration 015), so a
 * direct SQL insert cannot introduce a source kind this file would refuse.
 */

/** Public source categories this system is permitted to retrieve. */
export const ALLOWED_SOURCE_KINDS = [
  'public_website',
  'public_blog',
  'press_release',
  'public_rss',
  'public_podcast',
  'public_video_description',
  'public_transcript',
  'public_interview',
  'conference_listing',
  'public_research_paper',
  'public_portfolio_page',
  'public_investment_announcement',
  'public_github_activity',
  'public_professional_post',
  'public_forum_thread',
  'regulatory_disclosure',
  'public_news_article',
] as const;

export type PublicSourceKind = (typeof ALLOWED_SOURCE_KINDS)[number];

const ALLOWED = new Set<string>(ALLOWED_SOURCE_KINDS);

export function isPublicSourceKind(value: string): value is PublicSourceKind {
  return ALLOWED.has(value);
}

/**
 * Collection practices that are refused outright.
 *
 * These are not "discouraged" — each maps to a check below that throws. They are
 * listed as data so the policy is inspectable and so documentation and tests can
 * assert against the same list the runtime uses.
 */
export const PROHIBITED_COLLECTION = [
  'private-group scraping',
  'private or restricted account access',
  'authentication-protected forum access',
  'login bypass or credential harvesting',
  'personal contact detail harvesting',
  'personal location tracking',
  'browsing-history acquisition',
  'leaked or breached database use',
  'purchased personal-data profiles',
  'tracking pixels or device fingerprinting',
  'non-public social activity',
  'private individual profiling',
] as const;

/**
 * Practices refused on the publishing side. Kept next to the collection rules
 * because they are the same commitment pointed the other direction: the system
 * earns attention by being findable, never by manufacturing consensus.
 */
export const PROHIBITED_DISTRIBUTION = [
  'fake accounts',
  'sockpuppets',
  'fake independent publications',
  'automated astroturfing',
  'mass unsolicited posting',
  'forum spam',
  'fake comments',
  'fake testimonials',
  'impersonation',
  'hidden sponsorship',
  'manufactured conversations',
  'automated harassment',
  'mass unsolicited messaging',
  'repeated targeting of a named individual',
] as const;

export class SourcePolicyError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'not-https'
      | 'credentials-in-url'
      | 'private-host'
      | 'disallowed-kind'
      | 'authenticated-surface'
      | 'private-individual'
      | 'prohibited-practice',
  ) {
    super(message);
    this.name = 'SourcePolicyError';
  }
}

/**
 * Host and path patterns that indicate a logged-in, private, or personal-data
 * surface rather than a public professional one.
 *
 * These are matched against the URL before any network request. The list is
 * intentionally about *surfaces*, not about companies: a firm's public blog on a
 * platform is fine, that same platform's private messaging path is not.
 */
const AUTHENTICATED_SURFACE_PATTERNS: ReadonlyArray<{ pattern: RegExp; note: string }> = [
  { pattern: /\/(login|signin|sign-in|auth|oauth|sso)(\/|$|\?)/i, note: 'authentication endpoint' },
  { pattern: /\/(messages|messaging|inbox|dm|direct)(\/|$|\?)/i, note: 'private messaging surface' },
  { pattern: /\/(settings|account|billing|admin|dashboard)(\/|$|\?)/i, note: 'account-private surface' },
  { pattern: /\/groups?\/[^/]+\/(members|requests|private)(\/|$)/i, note: 'private group surface' },
  { pattern: /\/my\/|\/me\/|\/profile\/edit/i, note: 'personal account surface' },
];

/** Data-broker and breach-aggregation hosts. Retrieval from these is refused. */
const PROHIBITED_HOST_PATTERNS: ReadonlyArray<{ pattern: RegExp; note: string }> = [
  { pattern: /(^|\.)(pipl|spokeo|whitepages|beenverified|intelius|peoplefinders|truthfinder|radaris)\./i, note: 'personal-data broker' },
  { pattern: /(^|\.)(haveibeenpwned|dehashed|leakcheck|snusbase|weleakinfo)\./i, note: 'breach-data aggregator' },
  { pattern: /(^|\.)(rocketreach|lusha|apollo|zoominfo|hunter|snov)\.(io|co|com)$/i, note: 'contact-data broker' },
];

/**
 * A URL is acceptable for public research.
 *
 * HTTPS-only and credential-free mirror the constraints the existing
 * `web.fetch` tool already enforces (packages/tools/src/web-tools.ts); DNS-level
 * private-address checking stays there, at the point of the actual request.
 * This is the policy layer: it answers "may we look at this at all", not "is
 * this host routable".
 */
export function assertPublicSourceUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourcePolicyError(`"${rawUrl}" is not a valid URL.`, 'not-https');
  }

  if (url.protocol !== 'https:') {
    throw new SourcePolicyError(
      `Only HTTPS sources are collected; "${url.protocol}//" is refused.`,
      'not-https',
    );
  }

  if (url.username || url.password) {
    throw new SourcePolicyError(
      'A URL carrying credentials describes an authenticated surface, which is out of scope.',
      'credentials-in-url',
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata.google.internal') {
    throw new SourcePolicyError(`"${host}" is a private or internal host.`, 'private-host');
  }

  for (const { pattern, note } of PROHIBITED_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new SourcePolicyError(
        `"${host}" is a ${note}. Personal-data acquisition is out of scope for this system.`,
        'prohibited-practice',
      );
    }
  }

  const surface = `${url.pathname}${url.search}`;
  for (const { pattern, note } of AUTHENTICATED_SURFACE_PATTERNS) {
    if (pattern.test(surface)) {
      throw new SourcePolicyError(
        `"${url.pathname}" looks like a ${note}. Only pages readable without an account are collected.`,
        'authenticated-surface',
      );
    }
  }

  return url;
}

export interface SourceCandidate {
  url: string;
  kind: string;
  title?: string;
  publisher?: string;
  /** Required. Unknown provenance is not the same as permitted provenance. */
  license: string;
}

export interface AcceptedSource {
  url: string;
  kind: PublicSourceKind;
  title?: string;
  publisher?: string;
  license: string;
  host: string;
}

/**
 * Full admission check for one candidate source.
 *
 * Returns the normalized source or throws. There is deliberately no "skip
 * quietly" path: a refused source is a reportable event, because silently
 * dropping sources makes a thin result indistinguishable from a filtered one.
 */
export function admitSource(candidate: SourceCandidate): AcceptedSource {
  const url = assertPublicSourceUrl(candidate.url);

  if (!isPublicSourceKind(candidate.kind)) {
    throw new SourcePolicyError(
      `Source kind "${candidate.kind}" is not an enumerated public source. ` +
        `Permitted kinds: ${ALLOWED_SOURCE_KINDS.join(', ')}.`,
      'disallowed-kind',
    );
  }

  if (!candidate.license?.trim()) {
    throw new SourcePolicyError(
      'A license or permission statement is required. Unknown provenance is not permitted.',
      'disallowed-kind',
    );
  }

  return {
    // Fragment stripped: it never changes what was retrieved, and keeping it
    // splits one page into several "distinct" sources.
    url: `${url.origin}${url.pathname}${url.search}`,
    kind: candidate.kind,
    title: candidate.title?.trim() || undefined,
    publisher: candidate.publisher?.trim() || undefined,
    license: candidate.license.trim(),
    host: url.hostname.toLowerCase(),
  };
}

export interface ResearchSubject {
  displayName: string;
  entityType: string;
  /**
   * False marks a private individual. Research refuses before any query is
   * issued — this is the check that keeps the system away from people who did
   * not put themselves forward in a professional capacity.
   */
  isPublicProfessional: boolean;
}

export function assertResearchableSubject(subject: ResearchSubject): void {
  if (!subject.isPublicProfessional) {
    throw new SourcePolicyError(
      `"${subject.displayName}" is not marked as a public professional entity. ` +
        'This system researches public professional activity only and does not profile private individuals.',
      'private-individual',
    );
  }
}

/**
 * Search queries are constrained to professional subject matter.
 *
 * A model composes the query text, so this is the check that stops a
 * well-intentioned prompt from turning into a personal-information lookup.
 */
const PERSONAL_QUERY_PATTERNS: ReadonlyArray<{ pattern: RegExp; note: string }> = [
  { pattern: /\b(home|personal|residential)\s+(address|phone|number)\b/i, note: 'personal contact details' },
  { pattern: /\b(email|phone|cell|mobile)\s+(address|number)\b/i, note: 'direct contact details' },
  { pattern: /\bwhere\s+does\s+\S+\s+live\b/i, note: 'residence lookup' },
  { pattern: /\b(net\s*worth|salary|compensation|divorce|marriage|spouse|children|kids|family)\b/i, note: 'private personal circumstances' },
  { pattern: /\b(health|medical|diagnosis|illness|religion|religious|political\s+donation)\b/i, note: 'sensitive personal category' },
  { pattern: /\b(leaked|breach|hacked|dump|database)\b.*\b(password|credential|email)/i, note: 'breach data' },
  { pattern: /\b(private|personal)\s+(instagram|facebook|account|profile|messages)\b/i, note: 'non-public social activity' },
  { pattern: /\b(daily\s+routine|schedule|whereabouts|travel\s+plans|location)\b/i, note: 'movement or location tracking' },
];

export function assertProfessionalQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new SourcePolicyError('A research query is required.', 'disallowed-kind');
  if (trimmed.length > 300) {
    throw new SourcePolicyError('Research queries are capped at 300 characters.', 'disallowed-kind');
  }

  for (const { pattern, note } of PERSONAL_QUERY_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new SourcePolicyError(
        `Refusing the query "${trimmed.slice(0, 80)}": it seeks ${note}. ` +
          'Research is limited to public professional activity — published writing, talks, ' +
          'announced investments, and public technical work.',
        'prohibited-practice',
      );
    }
  }

  return trimmed;
}

/** Human-readable statement of scope, for docs, prompts, and the UI. */
export function describeCollectionPolicy(): string {
  return [
    'PUBLIC PROFESSIONAL SOURCES ONLY.',
    `Permitted source kinds: ${ALLOWED_SOURCE_KINDS.join(', ')}.`,
    `Never collected: ${PROHIBITED_COLLECTION.join('; ')}.`,
    `Never performed: ${PROHIBITED_DISTRIBUTION.join('; ')}.`,
    'The objective is to become discoverable around relevant ideas, not to place content in front of a named individual.',
  ].join('\n');
}
