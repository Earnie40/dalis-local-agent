import { describe, expect, it } from 'vitest';
import {
  AgentCapabilityError,
  runAgentLoop,
  toolCallSignature,
  truncateToolOutput,
  type LoopToolResult,
  type ToolExecutor,
} from '../packages/agent-core/src/agent-loop';
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelProvider,
  NormalizedToolCall,
  ProviderCapabilities,
  ToolSchema,
} from '../packages/agent-core/src/types';

const VERIFIED: ProviderCapabilities = { toolCalling: 'verified', streaming: 'verified' };

const ECHO_TOOL: ToolSchema = {
  name: 'echo',
  description: 'Echo a value.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
};

/** A provider that replays a fixed script of turns. */
function scriptedProvider(
  turns: Array<{ content?: string; toolCalls?: NormalizedToolCall[] }>,
): ModelProvider & { requests: ModelChatRequest[] } {
  let index = 0;
  const requests: ModelChatRequest[] = [];

  return {
    requests,
    instanceId: 'local_ollama',
    kind: 'ollama',
    usageClass: 'LOCAL_OLLAMA',
    async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
      requests.push(structuredClone(request));
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return {
        content: turn.content ?? '',
        toolCalls: turn.toolCalls,
        model: request.model,
        providerInstanceId: 'local_ollama',
        usageClass: 'LOCAL_OLLAMA',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    supportsTools: () => 'verified',
    listModels: async () => [],
    health: async () => ({
      status: 'connected',
      instanceId: 'local_ollama',
      usageClass: 'LOCAL_OLLAMA',
      location: 'Local',
    }),
    getUsage: async () => ({}),
  };
}

function executor(
  handler: (call: NormalizedToolCall) => LoopToolResult | Promise<LoopToolResult>,
  tools: ToolSchema[] = [ECHO_TOOL],
): ToolExecutor & { calls: NormalizedToolCall[] } {
  const calls: NormalizedToolCall[] = [];
  return {
    calls,
    listTools: () => tools,
    async execute(call) {
      calls.push(call);
      return handler(call);
    },
  };
}

const call = (name: string, args: Record<string, unknown> = {}, id = 'c1'): NormalizedToolCall => ({
  id,
  name,
  arguments: args,
});

describe('agent loop', () => {
  it('returns the answer when the model stops calling tools', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([{ content: 'The answer is 42.' }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'What is the answer?',
    });

    expect(result.answer).toBe('The answer is 42.');
    expect(result.stopReason).toBe('final-answer');
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(0);
  });

  it('feeds a tool result back and continues to a final answer', async () => {
    const exec = executor(() => ({ output: 'file contents here', success: true }));
    const provider = scriptedProvider([
      { toolCalls: [call('echo', { value: 'x' })] },
      { content: 'Based on the file, the answer is 7.' },
    ]);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: exec,
      prompt: 'Read the file',
    });

    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.answer).toContain('7');

    // The second request must carry the tool observation back to the model.
    const secondTurn = provider.requests[1].messages;
    expect(secondTurn.some((m) => m.role === 'tool' && m.content.includes('file contents'))).toBe(true);
  });

  it('accumulates token usage across turns', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([{ toolCalls: [call('echo')] }, { content: 'done' }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
    });

    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });
});

describe('capability gate', () => {
  it.each(['declared', 'unknown', 'unsupported'] as const)(
    'refuses a %s model when tools are offered',
    async (status) => {
      await expect(
        runAgentLoop({
          provider: scriptedProvider([{ content: 'hi' }]),
          model: 'phi3:mini',
          capabilities: { toolCalling: status, streaming: 'verified' },
          executor: executor(() => ({ output: 'ok', success: true })),
          prompt: 'go',
        }),
      ).rejects.toBeInstanceOf(AgentCapabilityError);
    },
  );

  it('admits an advisory-class model when no tools are offered', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([{ content: 'A summary.' }]),
      model: 'phi3:mini',
      capabilities: { toolCalling: 'unsupported', streaming: 'verified' },
      executor: executor(() => ({ output: '', success: true }), []),
      prompt: 'Summarize this',
    });

    expect(result.answer).toBe('A summary.');
  });
});

describe('malformed and wasteful calls', () => {
  it('tells the model which tools exist when it invents one', async () => {
    const provider = scriptedProvider([
      { toolCalls: [call('open_powershell')] },
      { content: 'Understood, using echo instead.' },
    ]);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
    });

    expect(result.rejectedCalls).toBe(1);
    expect(result.toolCalls).toBe(0);
    const feedback = provider.requests[1].messages.find((m) => m.role === 'tool');
    expect(feedback?.content).toContain('no tool named "open_powershell"');
    expect(feedback?.content).toContain('echo');
  });

  it('rejects an identical repeated call instead of re-running it', async () => {
    const exec = executor(() => ({ output: 'same result', success: true }));
    const provider = scriptedProvider([
      { toolCalls: [call('echo', { value: 'a' })] },
      { toolCalls: [call('echo', { value: 'a' })] },
      { content: 'Fine, the answer is a.' },
    ]);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: exec,
      prompt: 'go',
    });

    expect(exec.calls).toHaveLength(1);
    expect(result.rejectedCalls).toBe(1);
    expect(result.answer).toContain('a');
  });

  it('treats differing arguments as a distinct call', async () => {
    const exec = executor(() => ({ output: 'ok', success: true }));
    await runAgentLoop({
      provider: scriptedProvider([
        { toolCalls: [call('echo', { value: 'a' })] },
        { toolCalls: [call('echo', { value: 'b' })] },
        { content: 'done' },
      ]),
      model: 'm',
      capabilities: VERIFIED,
      executor: exec,
      prompt: 'go',
    });

    expect(exec.calls).toHaveLength(2);
  });

  it('gives the model one turn to recover, then stops if it cannot', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([{ content: 'thinking', toolCalls: [call('nope')] }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
      maxTurns: 8,
    });

    // Turn 1 is corrective feedback; turn 2 repeats the mistake, so it stops
    // rather than burning all 8 turns on the same invalid call.
    expect(result.stopReason).toBe('no-progress');
    expect(result.turns).toBe(2);
  });

  it('surfaces a denied call to the model without ending the run', async () => {
    const provider = scriptedProvider([
      { toolCalls: [call('echo', { value: 'x' })] },
      { content: 'I will avoid that.' },
    ]);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({
        output: 'Denied: workspace does not grant shell access.',
        success: false,
        denied: true,
      })),
      prompt: 'go',
    });

    expect(result.deniedCalls).toBe(1);
    expect(result.stopReason).toBe('final-answer');
    expect(provider.requests[1].messages.some((m) => m.content.includes('Denied'))).toBe(true);
  });

  it('keeps running when a tool throws', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([{ toolCalls: [call('echo')] }, { content: 'recovered' }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => {
        throw new Error('disk on fire');
      }),
      prompt: 'go',
    });

    expect(result.answer).toBe('recovered');
  });
});

describe('bounds', () => {
  it('stops at maxTurns and keeps the last thing the model said', async () => {
    let turn = 0;
    const result = await runAgentLoop({
      provider: {
        ...scriptedProvider([{}]),
        async chat(request) {
          turn += 1;
          // Fresh arguments each turn, so duplicate detection never fires and
          // the run is bounded by maxTurns alone.
          return {
            content: 'still working',
            toolCalls: [call('echo', { n: turn }, `c${turn}`)],
            model: request.model,
            providerInstanceId: 'local_ollama' as const,
            usageClass: 'LOCAL_OLLAMA' as const,
          };
        },
      },
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
      maxTurns: 3,
    });

    expect(result.stopReason).toBe('max-turns');
    expect(result.turns).toBe(3);
    expect(result.answer).toBe('still working');
  });

  it('stops when the tool-call budget is spent', async () => {
    let n = 0;
    const result = await runAgentLoop({
      provider: {
        ...scriptedProvider([{}]),
        async chat(request) {
          n += 1;
          return {
            content: '',
            toolCalls: [call('echo', { n }, `c${n}`)],
            model: request.model,
            providerInstanceId: 'local_ollama',
            usageClass: 'LOCAL_OLLAMA',
          };
        },
      },
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
      maxTurns: 20,
      maxToolCalls: 2,
    });

    expect(result.stopReason).toBe('tool-budget');
    expect(result.toolCalls).toBe(2);
  });

  it('stops promptly when cancelled', async () => {
    const controller = new AbortController();
    const result = await runAgentLoop({
      provider: scriptedProvider([{ toolCalls: [call('echo', { v: 1 })] }, { content: 'never reached' }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => {
        controller.abort();
        return { output: 'ok', success: true };
      }),
      prompt: 'go',
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('cancelled');
  });

  it('reports a provider failure rather than throwing', async () => {
    const result = await runAgentLoop({
      provider: {
        ...scriptedProvider([{}]),
        async chat() {
          throw new Error('Ollama is unreachable');
        },
      },
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
    });

    expect(result.stopReason).toBe('provider-error');
    expect(result.error).toContain('unreachable');
  });
});

describe('helpers', () => {
  it('treats argument order as irrelevant to call identity', () => {
    expect(toolCallSignature(call('t', { a: 1, b: 2 }))).toBe(toolCallSignature(call('t', { b: 2, a: 1 })));
  });

  it('distinguishes different values', () => {
    expect(toolCallSignature(call('t', { a: 1 }))).not.toBe(toolCallSignature(call('t', { a: 2 })));
  });

  it('keeps head and tail when truncating tool output', () => {
    const output = `${'A'.repeat(3000)}TAIL_MARKER`;
    const truncated = truncateToolOutput(output, 500);

    expect(truncated.length).toBeLessThan(700);
    expect(truncated).toContain('AAA');
    // The tail carries the failure summary in real tool output.
    expect(truncated).toContain('TAIL_MARKER');
    expect(truncated).toContain('characters truncated');
  });

  it('leaves short output untouched', () => {
    expect(truncateToolOutput('short', 500)).toBe('short');
  });
});

describe('event stream', () => {
  it('emits model, call and result events in order', async () => {
    const events: string[] = [];
    await runAgentLoop({
      provider: scriptedProvider([{ toolCalls: [call('echo')] }, { content: 'done' }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'go',
      onEvent: (event) => events.push(event.type),
    });

    expect(events).toEqual(['model_response', 'tool_call', 'tool_result', 'model_response']);
  });
});

describe('evidence requirement', () => {
  it('pushes back on an answer given without inspecting anything', async () => {
    const provider = scriptedProvider([
      // Answers immediately, having used only a search.
      { content: 'The file is tests/foo.test.ts and the values are user, group, others.' },
      { toolCalls: [call('read_file', { path: 'src/types.ts' })] },
      { content: 'The file is src/types.ts: safe, mutation, high-impact.' },
    ]);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'export type Tier = safe|mutation', success: true }), [
        { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      ]),
      prompt: 'Which file defines the tiers?',
      evidenceRequirement: { tools: ['read_file'] },
    });

    expect(result.answer).toContain('src/types.ts');
    // The nudge is a real corrective turn, recorded as a retry.
    expect(result.retries).toBe(1);
  });

  it('accepts the answer once the required tool has succeeded', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([
        { toolCalls: [call('read_file', { path: 'a.ts' })] },
        { content: 'Answer from the file.' },
      ]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'contents', success: true }), [
        { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      ]),
      prompt: 'go',
      evidenceRequirement: { tools: ['read_file'] },
    });

    expect(result.answer).toBe('Answer from the file.');
    expect(result.retries).toBe(0);
  });

  it('does not count a failed tool call as evidence', async () => {
    const provider = scriptedProvider([
      { toolCalls: [call('read_file', { path: 'missing.ts' })] },
      { content: 'Answering anyway.' },
      { content: 'Second answer.' },
    ]);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'No such file', success: false }), [
        { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      ]),
      prompt: 'go',
      evidenceRequirement: { tools: ['read_file'] },
    });

    expect(result.retries).toBe(1);
  });

  it('gives up after the nudge budget rather than looping forever', async () => {
    const result = await runAgentLoop({
      provider: scriptedProvider([{ content: 'I insist on answering without looking.' }]),
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'x', success: true }), [
        { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
      ]),
      prompt: 'go',
      evidenceRequirement: { tools: ['read_file'], maxNudges: 1 },
      maxTurns: 6,
    });

    expect(result.stopReason).toBe('final-answer');
    expect(result.answer).toContain('without looking');
  });
});
