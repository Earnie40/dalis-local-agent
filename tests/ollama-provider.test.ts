import { describe, expect, it } from 'vitest';
import { normalizeToolCalls, parseTextToolCalls } from '../packages/providers/src/ollama-provider';

describe('structured tool call normalization', () => {
  it('maps Ollama tool_calls into the neutral shape', () => {
    const calls = normalizeToolCalls([
      { function: { name: 'filesystem.read', arguments: { path: 'src/index.ts' } } },
    ]);

    expect(calls).toEqual([{ id: 'call_1', name: 'filesystem.read', arguments: { path: 'src/index.ts' } }]);
  });

  it('accepts arguments delivered as a JSON string', () => {
    const calls = normalizeToolCalls([{ function: { name: 'shell.run', arguments: '{"command":"git status"}' } }]);
    expect(calls[0].arguments).toEqual({ command: 'git status' });
  });

  it('drops a call with unparseable arguments rather than passing it through', () => {
    expect(normalizeToolCalls([{ function: { name: 'shell.run', arguments: '{not json' } }])).toHaveLength(0);
  });

  it('drops a call with no name', () => {
    expect(normalizeToolCalls([{ function: { arguments: {} } }])).toHaveLength(0);
  });

  it('treats missing arguments as an empty object', () => {
    expect(normalizeToolCalls([{ function: { name: 'git.status' } }])[0].arguments).toEqual({});
  });
});

/**
 * qwen2.5-coder emits correct calls as message text rather than populating
 * tool_calls. These cases mirror what the live model actually returns.
 */
describe('text-channel tool call recovery', () => {
  const offered = ['probe_echo', 'get_weather'];

  it('recovers a bare JSON object emitted as message text', () => {
    const result = parseTextToolCalls('{"name": "get_weather", "arguments": {"city": "Paris"}}', offered);

    expect(result.calls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }]);
    expect(result.remainingText).toBe('');
  });

  it('recovers a call wrapped in a json fence and keeps surrounding prose', () => {
    const result = parseTextToolCalls(
      'Let me check.\n```json\n{"name":"get_weather","arguments":{"city":"Oslo"}}\n```\nDone.',
      offered,
    );

    expect(result.calls[0].arguments).toEqual({ city: 'Oslo' });
    expect(result.remainingText).toContain('Let me check.');
    expect(result.remainingText).not.toContain('get_weather');
  });

  it('strips template markers such as <|tool_call|>', () => {
    const result = parseTextToolCalls('<|tool_call|>{"name":"probe_echo","arguments":{"word":"ready"}}', offered);
    expect(result.calls).toHaveLength(1);
    expect(result.remainingText).toBe('');
  });

  it('rejects a mangled fragment that is not valid JSON', () => {
    // phi4-mini emits exactly this shape.
    expect(parseTextToolCalls('<|tool_call|>{s: "ready"}', offered).calls).toHaveLength(0);
  });

  it('rejects a call to a tool that was never offered', () => {
    expect(parseTextToolCalls('{"name":"rm_rf","arguments":{"path":"/"}}', offered).calls).toHaveLength(0);
  });

  it('rejects arguments that are not an object', () => {
    expect(parseTextToolCalls('{"name":"probe_echo","arguments":"ready"}', offered).calls).toHaveLength(0);
  });

  it('ignores prose that merely mentions a tool name', () => {
    expect(parseTextToolCalls('I would call probe_echo with the word ready.', offered).calls).toHaveLength(0);
  });

  it('is inert when no tools were offered', () => {
    expect(parseTextToolCalls('{"name":"probe_echo","arguments":{"word":"x"}}', []).calls).toHaveLength(0);
  });

  it('recovers multiple calls and preserves brace-containing strings', () => {
    const result = parseTextToolCalls(
      '{"name":"probe_echo","arguments":{"word":"a{b}c"}} {"name":"get_weather","arguments":{"city":"Rome"}}',
      offered,
    );

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].arguments.word).toBe('a{b}c');
    expect(result.calls[1].arguments.city).toBe('Rome');
  });
});
