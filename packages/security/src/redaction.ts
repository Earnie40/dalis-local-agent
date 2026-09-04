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
  | 'runpod-token'
  | 'oauth-token'
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
  'HF_TOKEN|HUGGINGFACE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|OLLAMA_REMOTE_AUTH_TOKEN|' +
  'DATABASE_URL|PGPASSWORD|PGSUPERPASSWORD|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|' +
  'RUNPOD_CONNECTION|[A-Z0-9_]*_SECRET|[A-Z0-9_]*_TOKEN|[A-Z0-9_]*_PASSWORD|' +
  '[A-Z0-9_]*_API_KEY|[A-Z0-9_]*_PRIVATE_KEY|[A-Z0-9_]*_CREDENTIALS?|' +
  '[A-Z0-9_]*_USER_KEY|[A-Z0-9_]*_ACCESS_KEY|[A-Z0-9_]*_AUTH|PASSWORD|SECRET|TOKEN|' +
  'API[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|PRIVATE[_-]?KEY';

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
  { kind: 'runpod-token', pattern: /\brpa_[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'oauth-token', pattern: /\bya29\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // postgres://user:PASSWORD@host — replace only the password group.
  { kind: 'database-url-password', pattern: /\b([a-z+]+:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi, group: 2 },
  { kind: 'bearer-header', pattern: /\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]{8,})/gi, group: 2 },
  { kind: 'bearer-header', pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, group: 2 },
  // Connection strings may contain spaces (for example an SSH command), so
  // redact their entire line rather than only the first token.
  { kind: 'env-assignment', pattern: /\b(RUNPOD_CONNECTION\s*[=:]\s*)([^\r\n]+)/gi, group: 2 },
  // KEY=value / KEY: "value" for known-sensitive names.
  {
    kind: 'env-assignment',
    pattern: new RegExp(
      `\\b(${SENSITIVE_ENV_KEYS})\\s*[=:]\\s*["']?` +
        '(?!(?:process|import\\.meta)\\.env\\.)' +
        '([^\\s"\',}]+)',
      'gi',
    ),
    group: 2,
  },
];

export const REDACTED = '[REDACTED]';

const PROTECTED_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  'application_default_credentials.json',
  'id_rsa',
  'id_ed25519',
  'runpodssh.txt',
]);

/**
 * Files whose contents must never be returned through ordinary agent tools.
 * Public-key companions (`*.pub`) are intentionally not included.
 */
export function isProtectedSecretPath(pathText: string): boolean {
  const normalized = pathText.replace(/\\/g, '/').toLowerCase();
  const basename = normalized.split('/').pop() ?? normalized;

  return (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename.endsWith('.pem') ||
    basename.endsWith('.key') ||
    PROTECTED_BASENAMES.has(basename) ||
    basename.startsWith('credentials') ||
    basename.startsWith('secrets') ||
    basename.includes('private-key') ||
    basename.includes('private_key') ||
    /(?:^|\/)\.aws\/credentials$/.test(normalized) ||
    /(?:service[-_]?account|credential[-_]?export).*\.json$/.test(basename)
  );
}

export interface ProtectedVariable {
  name: string;
  line: number;
}

/** Extracts names and locations from env/INI/YAML/JSON-style configuration, never values. */
export function extractProtectedVariables(content: string): ProtectedVariable[] {
  const variables: ProtectedVariable[] = [];
  const seen = new Set<string>();

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = /^\s*(?:export\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?:=|:)\s*/.exec(line);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    variables.push({ name: match[1], line: index + 1 });
  }

  return variables.slice(0, 500);
}

export function summarizeProtectedFile(path: string, content: string, bytes?: number): {
  path: string;
  protected: true;
  variables: string[];
  bytes?: number;
} {
  return {
    path,
    protected: true,
    variables: extractProtectedVariables(content).map(({ name }) => name),
    ...(bytes === undefined ? {} : { bytes }),
  };
}

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
      const sensitiveKey = new RegExp(`^(?:${SENSITIVE_ENV_KEYS})$`, 'i').test(key);
      const credentialReference =
        typeof item === 'string' && /^(?:process|import\.meta)\.env\.[A-Za-z_][A-Za-z0-9_]*$/.test(item);
      result[key] = sensitiveKey && item != null && !credentialReference ? REDACTED : redactDeep(item);
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
