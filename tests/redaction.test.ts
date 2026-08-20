import { describe, expect, it } from 'vitest';
import {
  containsSecret,
  redactDeep,
  redactSecrets,
  sanitizeText,
  scanForSecrets,
} from '../packages/security/src/redaction';

describe('secret redaction', () => {
  it('redacts provider tokens without touching surrounding text', () => {
    const redacted = redactSecrets('using hf_abcdefghijklmnopqrstuvwxyz01 for inference');
    expect(redacted).toBe('using [REDACTED] for inference');
  });

  it.each([
    ['anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwx'],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['slack', ['xoxb', '123456789012', 'abcdefghijklmno'].join('-')],
  ])('detects a %s credential', (_label, secret) => {
    expect(containsSecret(secret)).toBe(true);
    expect(redactSecrets(secret)).not.toContain(secret);
  });

  it('keeps the database URL usable while removing the password', () => {
    const redacted = redactSecrets('postgresql://dacai_local_agent:sup3rSecretPw@localhost:5433/db');
    expect(redacted).toContain('dacai_local_agent');
    expect(redacted).toContain('localhost:5433');
    expect(redacted).not.toContain('sup3rSecretPw');
  });

  it('redacts sensitive env assignments by name', () => {
    const redacted = redactSecrets('OLLAMA_REMOTE_AUTH_TOKEN=zzzzzzzzzzzzzzzz\nPORT=3001');
    expect(redacted).not.toContain('zzzzzzzzzzzzzzzz');
    expect(redacted).toContain('PORT=3001');
  });

  it('strips a private key block entirely', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(key)).toBe('[REDACTED]');
  });

  it('scrubs a known env value even when it has no recognisable prefix', () => {
    const env = { OLLAMA_REMOTE_AUTH_TOKEN: 'plainlookingvalue123' } as NodeJS.ProcessEnv;
    expect(sanitizeText('token is plainlookingvalue123', env)).toBe('token is [REDACTED]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'ran pnpm test in packages/shared and 12 tests passed';
    expect(redactSecrets(text)).toBe(text);
    expect(scanForSecrets(text)).toHaveLength(0);
  });

  it('redacts strings nested anywhere in a structure', () => {
    const result = redactDeep({
      tool: 'shell.run',
      args: { env: ['HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz01'] },
      exitCode: 0,
    });

    expect(JSON.stringify(result)).not.toContain('hf_abcdefghij');
    expect(result.exitCode).toBe(0);
  });

  it('reports findings without echoing the secret', () => {
    const findings = scanForSecrets('hf_abcdefghijklmnopqrstuvwxyz01');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('huggingface-token');
    expect(JSON.stringify(findings)).not.toContain('hf_abc');
  });
});

