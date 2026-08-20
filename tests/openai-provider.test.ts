import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInstance } from '../packages/shared/src/config';
import { runAgentLoop, type ToolExecutor } from '../packages/agent-core/src/agent-loop';
import {
  buildOpenAIResponsesBody,
  normalizeOpenAIResponse,
  OpenAIProviderError,
  OpenAIResponsesProvider,
} from '../packages/providers/src/openai-provider';

const instance: ProviderInstance = {
  id: 'openai_sol',
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  usageClass: 'FUTURE_PAID_PROVIDER',
  transport: 'https-api',
  proxyRequired: false,
  authTokenEnvVar: 'OPENAI_API_KEY',
  requestTimeoutMs: 5_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OpenAI Responses provider', () => {
  it('constructs a Responses API request with instructions and function tools', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'gpt-5.6-sol',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'ready' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAIResponsesProvider(instance).chat({
      model: 'gpt-5.6-sol',
      systemPrompt: 'Use tools when required.',
      temperature: 0.08,
      messages: [{ role: 'user', content: 'Read package.json.' }],
      tools: [
        {
          name: 'filesystem.read',
          description: 'Read a file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    const requestBody = JSON.parse(String(init.body));
    expect(requestBody).toMatchObject({
      model: 'gpt-5.6-sol',
      instructions: 'Use tools when required.',
      input: [{ role: 'user', content: 'Read package.json.' }],
      tools: [
        {
          type: 'function',
          strict: true,
        },
      ],
    });
    expect(requestBody.tools[0].name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(requestBody.tools[0].name).not.toContain('.');
    expect(requestBody).not.toHaveProperty('temperature');
  });

  it('parses structured function calls and preserves the provider call_id', () => {
    const response = normalizeOpenAIResponse(
      {
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'function_call',
            id: 'fc_item_123',
            call_id: 'call_123',
            name: 'filesystem.read',
            arguments: '{"path":"package.json"}',
          },
        ],
      },
      'openai_sol',
      'gpt-5.6-sol',
    );

    expect(response.toolCallChannel).toBe('structured');
    expect(response.toolCalls).toEqual([
      {
        id: 'fc_item_123',
        providerCallId: 'call_123',
        name: 'filesystem.read',
        arguments: { path: 'package.json' },
      },
    ]);
  });

  it('uses the provider call_id for the matching function_call_output', () => {
    const body = buildOpenAIResponsesBody({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'user', content: 'Read package.json.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'fc_item_123',
              providerCallId: 'call_123',
              name: 'filesystem.read',
              arguments: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'tool',
          toolName: 'filesystem.read',
          toolCallId: 'call_123',
          content: '{"name":"dacai-local-agent"}',
        },
      ],
    });

    expect(body.input).toEqual([
      { role: 'user', content: 'Read package.json.' },
      {
        type: 'function_call',
        id: 'fc_item_123',
        call_id: 'call_123',
        name: 'filesystem_read',
        arguments: '{"path":"package.json"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: '{"name":"dacai-local-agent"}',
      },
    ]);
  });

  it('replays OpenAI reasoning before its function call after tool and working-state processing', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'gpt-5.6-sol',
            output: [
              {
                type: 'reasoning',
                id: 'rs_reasoning_123',
                summary: [],
                encrypted_content: 'opaque-reasoning-state',
              },
              {
                type: 'function_call',
                id: 'fc_read_123',
                call_id: 'call_read_123',
                name: 'dacai_1_filesystem_read',
                arguments: '{"path":"package.json"}',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'gpt-5.6-sol',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'package read complete' }] }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const executor: ToolExecutor = {
      listTools: () => [
        {
          name: 'filesystem.read',
          description: 'Read a repository file.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      execute: async () => ({ output: '{"name":"dacai-local-agent"}', success: true }),
    };
    const contextProvider = vi.fn(async () => 'curated graph context');

    const result = await runAgentLoop({
      provider: new OpenAIResponsesProvider(instance),
      model: 'gpt-5.6-sol',
      capabilities: { toolCalling: 'verified', streaming: 'unsupported' },
      executor,
      prompt: 'Read package.json and report the package name.',
      initialPlan: 'PENDING — inspect package metadata',
      initialContext: 'initial curated repository context',
      contextProvider,
      maxTurns: 3,
    });

    expect(result).toMatchObject({ answer: 'package read complete', turns: 2, toolCalls: 1 });
    expect(contextProvider).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(secondRequest.input).toEqual([
      { role: 'user', content: 'Read package.json and report the package name.' },
      {
        type: 'reasoning',
        id: 'rs_reasoning_123',
        summary: [],
        encrypted_content: 'opaque-reasoning-state',
      },
      {
        type: 'function_call',
        id: 'fc_read_123',
        call_id: 'call_read_123',
        name: 'dacai_1_filesystem_read',
        arguments: '{"path":"package.json"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read_123',
        output: '{"name":"dacai-local-agent"}',
      },
    ]);
  });

  it('does not manufacture OpenAI function_call records for uncorrelated internal messages', () => {
    const body = buildOpenAIResponsesBody({
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              name: 'internal.synthetic',
              arguments: { value: true },
            },
          ],
        },
        {
          role: 'tool',
          toolName: 'internal.synthetic',
          content: 'synthetic result',
        },
      ],
    });

    expect(body.input).toEqual([
      {
        role: 'user',
        content: 'Tool internal.synthetic output:\nsynthetic result',
      },
    ]);
  });

  it('fails clearly when OPENAI_API_KEY is missing without calling the network', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const request = new OpenAIResponsesProvider(instance).chat({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
    });

    await expect(request).rejects.toMatchObject<Partial<OpenAIProviderError>>({
      code: 'missing-api-key',
      instanceId: 'openai_sol',
    });
    await expect(request).rejects.toThrow('OPENAI_API_KEY is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces only OpenAI error fields for a rejected request', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Function output is missing its matching call.',
              type: 'invalid_request_error',
              param: 'input[3].call_id',
              code: 'invalid_value',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const request = new OpenAIResponsesProvider(instance).chat({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
    });

    await expect(request).rejects.toThrow(
      'HTTP 400 (type=invalid_request_error, param=input[3].call_id, code=invalid_value). Function output is missing its matching call.',
    );
  });
});
