import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildOllamaChatBody,
  normalizeOllamaToolSchema,
  normalizeToolCalls,
  OllamaProvider,
  parseTextToolCalls,
  sanitizeOllamaErrorBody,
  toOllamaTool,
} from '../packages/providers/src/ollama-provider';

afterEach(() => vi.unstubAllGlobals());

describe('Ollama request boundary normalization', () => {
  const filesystemTool = {
    name: 'filesystem.read',
    description: 'Read a workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  };

  it('omits think for qwen3-coder:30b while preserving its tool schemas', () => {
    const body = buildOllamaChatBody({
      model: 'qwen3-coder:30b',
      messages: [{ role: 'user', content: 'Read package.json.' }],
      tools: [filesystemTool],
      think: true,
      thinkingCapability: 'unsupported',
    }, false);

    expect(body).not.toHaveProperty('think');
    expect(body.tools).toEqual([toOllamaTool(filesystemTool)]);
  });

  it('preserves thinking for qwen3:8b when capability evidence supports it', () => {
    const body = buildOllamaChatBody({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'Plan carefully.' }],
      think: true,
      thinkingCapability: 'verified',
    }, false);

    expect(body.think).toBe(true);
  });

  it('uses model-specific Ollama metadata and avoids the unsupported-thinking HTTP 400', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requestBodies.push(body);

      if ('model' in body && !('messages' in body)) {
        return new Response(JSON.stringify({
          capabilities: body.model === 'qwen3:8b'
            ? ['completion', 'tools', 'thinking']
            : ['completion', 'tools'],
        }), { status: 200 });
      }

      if ('think' in body && body.model === 'qwen3-coder:30b') {
        return new Response(JSON.stringify({
          error: '"qwen3-coder:30b" does not support thinking',
        }), { status: 400 });
      }

      return new Response(JSON.stringify({
        model: body.model,
        message: {
          content: '',
          tool_calls: [{
            function: {
              name: 'filesystem.read',
              arguments: { path: 'package.json' },
            },
          }],
        },
      }), { status: 200 });
    }));

    const provider = new OllamaProvider({
      id: 'remote_gpu_ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11435', enabled: true,
      usageClass: 'REMOTE_GPU_OLLAMA', transport: 'ssh-tunnel', requestTimeoutMs: 1_000,
    });

    await provider.showModel('qwen3-coder:30b');
    await provider.showModel('qwen3:8b');

    expect(provider.supportsThinking('qwen3-coder:30b')).toBe('unsupported');
    expect(provider.supportsThinking('qwen3:8b')).toBe('declared');

    const result = await provider.chat({
      model: 'qwen3-coder:30b',
      messages: [{ role: 'user', content: 'Read package.json.' }],
      tools: [filesystemTool],
      think: true,
    });

    expect(result.toolCallChannel).toBe('structured');
    expect(result.toolCalls?.[0]).toMatchObject({
      name: 'filesystem.read',
      arguments: { path: 'package.json' },
    });
    const chatBody = requestBodies.at(-1);
    expect(chatBody).not.toHaveProperty('think');
    expect(chatBody?.tools).toHaveLength(1);
  });

  it('projects complex canonical schemas without mutating them', () => {
    const canonical = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        path: { type: ['string', 'null'], default: null, format: 'path' },
        mode: { $ref: '#/$defs/mode' },
      },
      required: ['path', 'missing'],
      $defs: { mode: { type: 'string', enum: ['read', 'write'] } },
      unevaluatedProperties: false,
    } as Record<string, unknown>;
    const before = structuredClone(canonical);
    expect(normalizeOllamaToolSchema(canonical)).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string' },
        mode: { type: 'string', enum: ['read', 'write'] },
      },
      required: ['path'],
    });
    expect(canonical).toEqual(before);
  });

  it('preserves structured assistant calls and tool-result identity in replay', () => {
    const body = buildOllamaChatBody({
      model: 'qwen3-coder:30b',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'filesystem.list', arguments: { path: '.' } }] },
        { role: 'tool', content: 'README.md', toolName: 'filesystem.list', toolCallId: 'call_1' },
      ],
    }, false) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[0].tool_calls).toEqual([{ function: { name: 'filesystem.list', arguments: { path: '.' } } }]);
    expect(body.messages[1].tool_name).toBe('filesystem.list');
  });

  it('sanitizes Ollama error details and ignores non-JSON bodies', () => {
    expect(sanitizeOllamaErrorBody('{"error":"invalid schema at https://internal.example using Bearer abcdefghijklmnopqrstuvwxyz"}'))
      .toBe('Ollama detail: invalid schema at [REDACTED_URL] using Bearer [REDACTED]');
    expect(sanitizeOllamaErrorBody('raw prompt-shaped gateway response')).toBe('');
  });

  it('maps the full tool envelope through the normalized provider projection', () => {
    expect(toOllamaTool({
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: { value: { type: ['string', 'null'], default: null } } },
    })).toEqual({
      type: 'function',
      function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: { value: { type: 'string' } } } },
    });
  });

  it('surfaces only a scrubbed Ollama 400 error field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid tool schema; token=rpa_abcdefghijklmnopqrstuvwxyz' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    const provider = new OllamaProvider({
      id: 'test_ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true,
      usageClass: 'LOCAL_OLLAMA', transport: 'loopback', requestTimeoutMs: 1_000,
    });
    await expect(provider.chat({ model: 'test', messages: [{ role: 'user', content: 'secret prompt' }] }))
      .rejects.toThrow('Ollama detail: invalid tool schema; token=[REDACTED]');
  });
});

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
