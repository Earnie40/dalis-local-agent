import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInstance } from '../packages/shared/src/config';
import { runAgentLoop, type ToolExecutor } from '../packages/agent-core/src/agent-loop';
import {
  AnthropicProviderError,
  AnthropicProvider,
  buildAnthropicMessagesBody,
  normalizeAnthropicResponse,
} from '../packages/providers/src/anthropic-provider';

const instance: ProviderInstance = {
  id: 'anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  enabled: true,
  usageClass: 'FUTURE_PAID_PROVIDER',
  transport: 'https-api',
  authTokenEnvVar: 'ANTHROPIC_API_KEY',
  requestTimeoutMs: 5_000,
};

const readTool = {
  name: 'filesystem.read',
  description: 'Read a repository file.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Anthropic Messages provider', () => {
  it('constructs Messages API requests with system instructions and tool schemas', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'message',
          model: 'configured-claude',
          content: [{ type: 'text', text: 'ready' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new AnthropicProvider(instance).chat({
      model: 'configured-claude',
      systemPrompt: 'Use tools when required.',
      temperature: 0.1,
      messages: [{ role: 'user', content: 'Read package.json.' }],
      tools: [readTool],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'test-only-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'configured-claude',
      max_tokens: 4096,
      system: 'Use tools when required.',
      temperature: 0.1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read package.json.' }] }],
      tools: [{ name: 'filesystem.read', description: 'Read a repository file.', input_schema: readTool.inputSchema }],
    });
  });

  it('parses structured tool_use and preserves its id', () => {
    const response = normalizeAnthropicResponse(
      {
        type: 'message',
        model: 'configured-claude',
        content: [{ type: 'tool_use', id: 'toolu_read_123', name: 'filesystem.read', input: { path: 'package.json' } }],
      },
      'anthropic',
      'configured-claude',
    );

    expect(response.toolCallChannel).toBe('structured');
    expect(response.toolCalls).toEqual([
      { id: 'toolu_read_123', name: 'filesystem.read', arguments: { path: 'package.json' } },
    ]);
  });

  it('uses the preserved tool_use id for tool_result continuation', () => {
    const body = buildAnthropicMessagesBody({
      model: 'configured-claude',
      messages: [
        { role: 'user', content: 'Read package.json.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_read_123', name: 'filesystem.read', arguments: { path: 'package.json' } }],
        },
        {
          role: 'tool',
          toolName: 'filesystem.read',
          toolCallId: 'toolu_read_123',
          content: '{"name":"dacai-local-agent"}',
        },
      ],
    });

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read package.json.' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_read_123', name: 'filesystem.read', input: { path: 'package.json' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_read_123', content: '{"name":"dacai-local-agent"}' }],
      },
    ]);
  });

  it('round-trips an internal tool result through the agent loop before the final Claude response', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'message',
            model: 'configured-claude',
            content: [{ type: 'tool_use', id: 'toolu_read_123', name: 'filesystem.read', input: { path: 'package.json' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'message',
            model: 'configured-claude',
            content: [{ type: 'text', text: 'dacai-local-agent / 0.1.0' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const executor: ToolExecutor = {
      listTools: () => [readTool],
      execute: async () => ({ output: '{"name":"dacai-local-agent","version":"0.1.0"}', success: true }),
    };
    const result = await runAgentLoop({
      provider: new AnthropicProvider(instance),
      model: 'configured-claude',
      capabilities: { toolCalling: 'verified', streaming: 'unsupported' },
      executor,
      prompt: 'Read package.json and report package name and version.',
      initialPlan: 'PENDING — inspect package metadata',
      initialContext: 'curated repository context',
      maxTurns: 3,
    });

    expect(result).toMatchObject({ answer: 'dacai-local-agent / 0.1.0', turns: 2, toolCalls: 1 });
    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(secondRequest.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Read package.json and report package name and version.' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_read_123', name: 'filesystem.read', input: { path: 'package.json' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read_123',
            content: '{"name":"dacai-local-agent","version":"0.1.0"}',
          },
        ],
      },
    ]);
  });

  it('does not manufacture tool_result correlation for an internal synthetic call', () => {
    const body = buildAnthropicMessagesBody({
      model: 'configured-claude',
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ name: 'internal.synthetic', arguments: { value: true } }] },
        { role: 'tool', toolName: 'internal.synthetic', content: 'synthetic result' },
      ],
    });

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Tool internal.synthetic output:\nsynthetic result' }] },
    ]);
  });

  it('fails clearly when ANTHROPIC_API_KEY is missing without calling the network', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new AnthropicProvider(instance).chat({ model: 'configured-claude', messages: [{ role: 'user', content: 'hello' }] }))
      .rejects.toMatchObject<Partial<AnthropicProviderError>>({ code: 'missing-api-key', instanceId: 'anthropic' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces only sanitized Anthropic error fields', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.2.content is invalid' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const request = new AnthropicProvider(instance).chat({ model: 'configured-claude', messages: [{ role: 'user', content: 'hello' }] });
    await expect(request).rejects.toThrow(
      'HTTP 400 (type=invalid_request_error). messages.2.content is invalid',
    );
  });

  it('probes the key with a models listing rather than reporting a blanket unavailable', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-5' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const health = await new AnthropicProvider(instance).health();

    expect(health.status).toBe('connected');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect(init.method).toBe('GET');
    // A health check must never spend a completion.
    expect(init.body).toBeUndefined();
  });

  it('separates a missing key from a rejected one', async () => {
    const health = await new AnthropicProvider(instance).health();
    expect(health.status).toBe('not configured');

    vi.stubEnv('ANTHROPIC_API_KEY', 'test-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const rejected = await new AnthropicProvider(instance).health();
    expect(rejected.status).toBe('unavailable');
    expect(rejected.error).toContain('authentication_error');
  });
});
