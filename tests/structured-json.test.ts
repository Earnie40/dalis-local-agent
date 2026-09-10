import { describe, expect, it } from 'vitest';
import { parseStructuredJson, StructuredJsonParseError } from '@dacai-local-agent/shared';

describe('bounded structured JSON formatting repair', () => {
  it('preserves valid JSON without repairs or inferred content', () => {
    expect(parseStructuredJson('{"solutionPath":"unknown","evidence":[]}')).toEqual({
      value: { solutionPath: 'unknown', evidence: [] },
      repairs: [],
    });
    expect(parseStructuredJson('[{"goal":"explore"}]')).toEqual({
      value: [{ goal: 'explore' }],
      repairs: [],
    });
  });

  it('repairs a leading BOM, prose, fences, and nested trailing commas', () => {
    const raw = '\uFEFFHere is the plan:\n```json\n{"goal":"explore","steps":[{"known":false,},],}\n```';
    expect(parseStructuredJson(raw)).toEqual({
      value: { goal: 'explore', steps: [{ known: false }] },
      repairs: [
        'removed leading BOM',
        'extracted single JSON object from surrounding text',
        'removed trailing commas',
      ],
    });
  });

  it('preserves commas, braces, escaped quotes, and fences inside strings during repair', () => {
    const goal = 'Keep ,} and ,] and ```json {"quoted":"value"} ``` and \\ intact';
    const raw = '```json\n' + JSON.stringify({ goal, steps: ['unknown'] }).replace(/}$/, ',}') + '\n```';
    expect(parseStructuredJson(raw).value).toEqual({ goal, steps: ['unknown'] });
  });

  it('repairs standalone trailing commas without unwrapping array values', () => {
    expect(parseStructuredJson('{"steps":["discover",],}')).toEqual({
      value: { steps: ['discover'] },
      repairs: ['removed trailing commas'],
    });
    expect(parseStructuredJson('[{"goal":"explore"},]').value).toEqual([{ goal: 'explore' }]);
  });

  it('removes a BOM from otherwise valid JSON without changing its value', () => {
    expect(parseStructuredJson('\uFEFF{"goal":"explore"}')).toEqual({
      value: { goal: 'explore' },
      repairs: ['removed leading BOM'],
    });
  });

  it.each([
    '{"goal":"first"} {"goal":"second"}',
    '```json\n{"goal":"first"}\n```\n```json\n{"goal":"second",}\n```',
    '{"goal":"first"} {"goal":}',
  ])('rejects ambiguous output: %s', (raw) => {
    expect(() => parseStructuredJson(raw)).toThrow(/multiple JSON values/);
  });

  it.each([
    '{"goal":"explore"',
    '{"goal":"explore", "steps": [',
    '{"outer":{"goal":"explore"}',
    '[{"goal":"explore"}',
    '{"goal":"first"} {"goal":',
    '{"goal":"unterminated}',
  ])('never completes truncated JSON or extracts a nested object: %s', (raw) => {
    expect(() => parseStructuredJson(raw)).toThrow(StructuredJsonParseError);
  });

  it.each([
    '{"goal":,}',
    '{"steps":[,]}',
    '{"steps":["discover",,]}',
    '{,}',
    "{'goal':'explore'}",
    '{"goal":unknown}',
    '{"goal":"explore" "steps":[]}',
  ])('does not invent missing values, quotes, or separators: %s', (raw) => {
    expect(() => parseStructuredJson(raw)).toThrow(StructuredJsonParseError);
  });

  it('retains the original strict parse failure when recovery fails', () => {
    const raw = 'a plan without a JSON object';
    let initialError = '';
    try { JSON.parse(raw); } catch (error) { initialError = (error as Error).message; }
    try {
      parseStructuredJson(raw);
      expect.fail('must reject non-JSON');
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredJsonParseError);
      expect((error as StructuredJsonParseError).initialParseError).toBe(initialError);
      expect((error as Error).message).toContain(initialError);
      expect((error as Error).message).toContain('No single complete JSON object found');
    }
  });
});
