import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJsonCandidates, parseWithSchema } from '@dacai-local-agent/providers';

describe('structured generation — malformed model output is rejected, not persisted', () => {
  const Schema = z.object({ theme: z.string(), relevance: z.number().min(0).max(1) });

  it('parses a clean JSON object', () => {
    const result = parseWithSchema('{"theme":"physical AI","relevance":0.9}', Schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.theme).toBe('physical AI');
  });

  it('recovers JSON wrapped in markdown fences and prose', () => {
    const raw = 'Sure! Here is the result:\n```json\n{"theme":"robotics","relevance":0.7}\n```\nLet me know if you need more.';
    const result = parseWithSchema(raw, Schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.theme).toBe('robotics');
  });

  it('rejects prose with no JSON object at all', () => {
    const result = parseWithSchema('I cannot help with that request.', Schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unparseable');
  });

  it('rejects a JSON object that does not satisfy the schema', () => {
    const result = parseWithSchema('{"theme":"robotics","relevance":"very high"}', Schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('schema-rejected');
  });

  it('rejects a schema-violating value even when it is technically valid JSON (out-of-range number)', () => {
    const result = parseWithSchema('{"theme":"robotics","relevance":5}', Schema);
    expect(result.ok).toBe(false);
  });

  it('picks the largest of several candidate objects (the real payload, not an envelope)', () => {
    const raw = '{"note":"ignore"} then the real answer: {"theme":"aerospace","relevance":0.85,"extra":"padding-padding-padding"}';
    const result = parseWithSchema(raw, Schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.theme).toBe('aerospace');
  });

  it('extractJsonCandidates does not get confused by braces inside string values', () => {
    const candidates = extractJsonCandidates('{"theme":"a { weird } value","relevance":0.5}');
    expect(candidates).toHaveLength(1);
    expect((candidates[0] as { theme: string }).theme).toBe('a { weird } value');
  });

  it('extractJsonCandidates finds nothing in pure prose', () => {
    expect(extractJsonCandidates('no json here at all')).toHaveLength(0);
  });
});
