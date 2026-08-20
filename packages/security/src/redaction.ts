/**
 * The single secret-redaction implementation for the platform. Logs, tool
 * output, API/SSE payloads, and training traces all call this — never a second
 * parallel copy, so a new pattern added here protects every surface at once.
 *
 * Detection is deliberately over-eager: a false positive costs a redacted
 * string, a false negative costs a leaked credential.
 */

export type SecretKind =
  | 'huggingface-token'
  | 'anthropic-key'
  | 'openai-key'
  | 'github-token'
  | 'aws-access-key'
  | 'google-api-key'
  | 'slack-token'
  | 'private-key-block'
  | 'jwt'
  | 'database-url-password'
  | 'bearer-header'
  | 'env-assignment';

interface SecretPattern {
  kind: SecretKind;
  pattern: RegExp;
  /** When set, only this capture group is replaced, keeping the surrounding key. */
  group?: number;
}

/** Env var names whose VALUES must never appear in output. */
const SENSITIVE_ENV_KEYS =
  'HF_TOKEN|HUGGINGFACE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|OLLAMA_REMOTE_AUTH_TOKEN|DATABASE_URL|PGPASSWORD|PGSUPERPASSWORD|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|.*_SECRET|.*_TOKEN|.*_PASSWORD|.*_API_KEY';

const PATTERNS: SecretPattern[] = [
  { kind: 'private-key-block', pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { kind: 'huggingface-token', pattern: /\bhf_[A-Za-z0-9]{16,}\b/g },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Length is left loose deliberately: over-matching costs a redacted string,
  // under-matching costs a leaked credential.
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // postgres://user:PASSWORD@host — replace only the password group.
  { kind: 'database-url-password', pattern: /\b([a-z+]+:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi, group: 2 },
  { kind: 'bearer-header', pattern: /\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi, group: 2 },
  // KEY=value / KEY: "value" for known-sensitive names.
  { kind: 'env-assignment', pattern: new RegExp(`\\b(${SENSITIVE_ENV_KEYS})\\s*[=:]\\s*["']?([^\\s"',}]+)`, 'gi'), group: 2 },
];

export const REDACTED = '[REDACTED]';

export interface SecretFinding {
  kind: SecretKind;
  /** Character offset in the scanned text — never the matched value itself. */
  index: number;
  length: number;
}

/** Reports what was found without ever returning the secret material. */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (!text) return findings;

  for (const { kind, pattern, group } of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = group ? match[group] : match[0];
      if (!value) continue;
      findings.push({ kind, index: match.index, length: value.length });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}

export function containsSecret(text: string): boolean {
  return scanForSecrets(text).length > 0;
}

/** Replaces every detected secret with [REDACTED], preserving surrounding text. */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let output = text;
  for (const { pattern, group } of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    output = output.replace(re, (whole, ...groups) => {
      if (!group) return REDACTED;
      const captured = groups[group - 1] as string | undefined;
      if (!captured) return whole;
      return whole.replace(captured, REDACTED);
    });
  }
  return output;
}

/**
 * Redacts any string anywhere in a structure. Used before persisting tool
 * output, trace steps, or anything bound for an API response.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactDeep(item);
    }
    return result as T;
  }
  return value;
}

/**
 * Values of sensitive env vars as they exist in this process, so output can be
 * scrubbed of a secret even when it appears without its recognisable prefix.
 */
export function redactKnownEnvValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;

  const keyMatcher = new RegExp(`^(?:${SENSITIVE_ENV_KEYS})$`, 'i');
  let output = text;

  for (const [key, value] of Object.entries(env)) {
    // Short values would cause absurd false positives (e.g. a port number).
    if (!value || value.length < 8 || !keyMatcher.test(key)) continue;
    output = output.split(value).join(REDACTED);
  }

  return output;
}

/** The full scrub applied at every persistence and transport boundary. */
export function sanitizeText(text: string, env?: NodeJS.ProcessEnv): string {
  return redactSecrets(redactKnownEnvValues(text, env));
}
