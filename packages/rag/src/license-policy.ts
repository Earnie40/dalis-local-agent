/** Result of the fail-closed knowledge-ingestion licence gate. */
export interface LicenseValidation {
  accepted: boolean;
  normalized?: string;
  reason?: string;
}

const NON_GRANT_LABELS = new Set([
  'all rights reserved',
  'n/a',
  'na',
  'none',
  'not applicable',
  'proprietary',
  'publicly accessible',
  'publicly available',
  'tbd',
  'todo',
  'unknown',
  'unlicensed',
  'unspecified',
]);

// Public availability and authorship are provenance, not permission. A custom
// statement must positively identify authorization, consent, or a grant of rights.
const POSITIVE_GRANT = /\b(?:permission|consent|authorization)\s+(?:is\s+)?granted\b|\bauthori[sz]ed\s+(?:by|for)\b|\blicen[cs](?:e|ed)\s+(?:by|for|under)\b|\bright(?:s)?\s+(?:are\s+)?granted\b/i;
const NEGATIVE_GRANT = /\b(?:not|no|without|denied|revoked|forbidden|prohibited|unauthori[sz]ed|unknown|missing|absent|unconfirmed)\b.{0,48}\b(?:licen[cs](?:e|ed|ing)?|permission|consent|rights?|authorization)\b|\b(?:licen[cs](?:e|ed|ing)?|permission|consent|rights?|authorization)\b.{0,48}\b(?:not|no|without|denied|revoked|unknown|missing|absent|unconfirmed)\b/i;

// Intentionally conservative: this is the subset used by the local dependency
// and corpus inventory. Additions should be reviewed rather than accepting an
// arbitrary label merely because it resembles an SPDX identifier.
const SPDX_LICENSE_IDS = new Set([
  '0BSD', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0',
  'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', 'CC0-1.0',
  'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-NC-3.0', 'CC-BY-NC-4.0',
  'CC-BY-NC-ND-3.0', 'CC-BY-NC-ND-4.0', 'CC-BY-NC-SA-3.0',
  'CC-BY-NC-SA-4.0', 'CC-BY-ND-3.0', 'CC-BY-ND-4.0',
  'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'EPL-2.0', 'GPL-2.0-only',
  'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'ISC',
  'LGPL-2.1-only', 'LGPL-3.0-only', 'MIT', 'MPL-2.0',
  'ODC-BY-1.0', 'ODC-ODbL-1.0', 'ODC-PDDL-1.0', 'Python-2.0',
  'Unlicense',
].map((id) => id.toLowerCase()));
const SPDX_EXCEPTIONS = new Set([
  'Classpath-exception-2.0', 'GCC-exception-2.0',
  'GCC-exception-3.1', 'LLVM-exception', 'OpenJDK-assembly-exception-1.0',
].map((id) => id.toLowerCase()));
const PUBLIC_DOMAIN = /^(?:public[- ]domain|public domain dedication)$/i;
// This local assertion is intentionally bound to this repository/operator.
// Other owners must supply an explicit grant/authorization statement instead
// of minting an unverified "*-internal-original" label.
const INTERNAL_ORIGINAL = /^DACAIS-internal-original$/i;

function isAcceptedSpdx(expression: string): boolean {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*/gi);
  if (!tokens || tokens.join('').toLowerCase() !== expression.replace(/\s+/g, '').toLowerCase()) return false;
  let cursor = 0;

  const parseLicense = (): boolean => {
    const token = tokens[cursor];
    if (!token || !SPDX_LICENSE_IDS.has(token.toLowerCase())) return false;
    cursor += 1;
    if (tokens[cursor]?.toUpperCase() === 'WITH') {
      cursor += 1;
      const exception = tokens[cursor];
      if (!exception || !SPDX_EXCEPTIONS.has(exception.toLowerCase())) return false;
      cursor += 1;
    }
    return true;
  };
  const parsePrimary = (): boolean => {
    if (tokens[cursor] !== '(') return parseLicense();
    cursor += 1;
    if (!parseOr() || tokens[cursor] !== ')') return false;
    cursor += 1;
    return true;
  };
  const parseAnd = (): boolean => {
    if (!parsePrimary()) return false;
    while (tokens[cursor]?.toUpperCase() === 'AND') {
      cursor += 1;
      if (!parsePrimary()) return false;
    }
    return true;
  };
  const parseOr = (): boolean => {
    if (!parseAnd()) return false;
    while (tokens[cursor]?.toUpperCase() === 'OR') {
      cursor += 1;
      if (!parseAnd()) return false;
    }
    return true;
  };

  return parseOr() && cursor === tokens.length;
}

/**
 * Validates that a caller supplied an affirmative rights basis, rather than a
 * non-empty label. This cannot prove ownership; it makes the asserted basis
 * explicit, auditable, and impossible to replace with "unknown" or "public".
 */
export function validateLicenseStatement(value: unknown): LicenseValidation {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : undefined;
  if (!normalized) {
    return { accepted: false, reason: 'A license or permission statement is required.' };
  }
  if (normalized.length > 500) {
    return { accepted: false, reason: 'The license or permission statement exceeds 500 characters.' };
  }

  const lower = normalized.toLowerCase();
  if (
    NON_GRANT_LABELS.has(lower)
    || NEGATIVE_GRANT.test(normalized)
    || /\b(?:publicly accessible|publicly available|found online|web page)\b/i.test(normalized)
  ) {
    return {
      accepted: false,
      reason: `"${normalized}" does not establish permission to ingest this material.`,
    };
  }

  if (
    isAcceptedSpdx(normalized)
    || PUBLIC_DOMAIN.test(normalized)
    || INTERNAL_ORIGINAL.test(normalized)
    || POSITIVE_GRANT.test(normalized)
  ) {
    return { accepted: true, normalized };
  }

  return {
    accepted: false,
    reason: 'Use a recognized SPDX/open-data identifier, a public-domain declaration, or an explicit ownership/permission grant.',
  };
}
