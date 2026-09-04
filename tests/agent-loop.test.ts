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
  it('omits thinking for an unsupported model in automatic reasoning mode', async () => {
    const provider = scriptedProvider([{ content: 'done' }]);

    await runAgentLoop({
      provider,
      model: 'qwen3-coder:30b',
      capabilities: {
        ...VERIFIED,
        configurableThinking: 'unsupported',
      },
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'Inspect the workspace.',
      reasoningMode: 'auto',
    });

    expect(provider.requests[0].think).toBeUndefined();
    expect(provider.requests[0].thinkingCapability).toBe('unsupported');
  });

  it('keeps thinking available for a verified thinking model', async () => {
    const provider = scriptedProvider([{ content: 'done' }]);

    await runAgentLoop({
      provider,
      model: 'qwen3:8b',
      capabilities: {
        ...VERIFIED,
        configurableThinking: 'verified',
      },
      executor: executor(() => ({ output: 'ok', success: true })),
      prompt: 'Inspect the workspace.',
      reasoningMode: 'deep',
    });

    expect(provider.requests[0].think).toBe(true);
    expect(provider.requests[0].thinkingCapability).toBe('verified');
  });

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
    expect(result.completionState).toBe('GOAL_COMPLETE');
  });

  it('preserves server-authorized engineering tools through per-turn selection', async () => {
    const provider = scriptedProvider([{ content: 'TASK_BLOCKED: capability inventory only.' }]);
    const toolNames = [
      'filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat',
      'engineering.capabilities.inspect', 'engineering.artifact.inspect',
      'cad.execute', 'bim.execute', 'scene.render',
    ];
    await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true }), toolNames.map((name) => ({
        name, description: name, inputSchema: { type: 'object' },
      }))),
      prompt: 'Generate a parametric CAD part.',
    });
    expect(provider.requests[0].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'engineering.capabilities.inspect', 'engineering.artifact.inspect',
      'cad.execute', 'bim.execute', 'scene.render',
    ]));
  });

  it('starts distinct read-only repository calls concurrently while preserving result order', async () => {
    const readOnlyTools: ToolSchema[] = ['filesystem.read', 'filesystem.search'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }));
    const started: string[] = [];
    let release: (() => void) | undefined;
    let bothStarted: (() => void) | undefined;
    const executionGate = new Promise<void>((resolve) => { release = resolve; });
    const allStarted = new Promise<void>((resolve) => { bothStarted = resolve; });

    const run = runAgentLoop({
      provider: scriptedProvider([
        { toolCalls: [call('filesystem.read', { path: 'a.ts' }, 'read'), call('filesystem.search', { path: 'src' }, 'search')] },
        { content: 'Evidence collected.' },
      ]),
      model: 'm', capabilities: VERIFIED,
      executor: executor(async (requested) => {
        started.push(requested.name);
        if (started.length === 2) bothStarted?.();
        await executionGate;
        return { output: requested.name, success: true };
      }, readOnlyTools),
      prompt: 'Inspect the repository.',
    });

    await Promise.race([
      allStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read-only calls were not batched')), 250)),
    ]);
    release?.();
    const result = await run;

    expect(started).toEqual(['filesystem.read', 'filesystem.search']);
    expect(result.toolCalls).toBe(2);
    expect(result.answer).toBe('Evidence collected.');
  });

  it('honors explicit waiting and blocked terminal states', async () => {
    const waiting = await runAgentLoop({
      provider: scriptedProvider([{ content: 'TASK_WAITING_FOR_USER: choose a deployment target.' }]),
      model: 'm', capabilities: VERIFIED, executor: executor(() => ({ output: 'ok', success: true })), prompt: 'Deploy it',
    });
    const blocked = await runAgentLoop({
      provider: scriptedProvider([{ content: 'TASK_BLOCKED: credentials are unavailable.' }]),
      model: 'm', capabilities: VERIFIED, executor: executor(() => ({ output: 'ok', success: true })), prompt: 'Deploy it',
    });
    expect(waiting.completionState).toBe('WAITING_FOR_USER');
    expect(blocked.completionState).toBe('BLOCKED');
  });

  it('announces and uses a synthesis reserve near a deep audit ceiling', async () => {
    const events: string[] = [];
    await runAgentLoop({
      provider: scriptedProvider([{ toolCalls: [call('echo', { n: 1 })] }, { content: 'TASK_COMPLETE: report complete.' }]),
      model: 'm', capabilities: VERIFIED, executor: executor(() => ({ output: 'evidence', success: true })),
      prompt: 'Audit', maxTurns: 4, synthesisReserveTurns: 3, runMode: 'repository_audit',
      onEvent: (event) => { if (event.type === 'budget') events.push(event.message ?? ''); },
    });
    expect(events.some((message) => message.includes('Broad discovery is closing'))).toBe(true);
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
  it('reports hard budget exhaustion rather than treating the last model text as success', async () => {
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
    expect(result.completionState).toBe('HARD_BUDGET_EXHAUSTED');
    expect(result.answer).toContain('HARD_BUDGET_EXHAUSTED');
    expect(result.answer).toContain('still working');
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

    expect(events).toEqual(['budget', 'model_request', 'model_response', 'tool_call', 'tool_result', 'budget', 'model_request', 'model_response']);
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
    expect(result.retries).toBeGreaterThanOrEqual(1);
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

    expect(result.retries).toBeGreaterThanOrEqual(1);
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

describe('evidence requirement drives per-turn tool exposure', () => {
  const schema = (name: string): ToolSchema => ({ name, description: name, inputSchema: { type: 'object' } });
  const runTools = [
    'filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat',
    'shell.run', 'wsl.list', 'wsl.run',
  ].map(schema);

  it('exposes the required live-system tools and accepts their output as evidence', async () => {
    const provider = scriptedProvider([
      { toolCalls: [call('wsl.run', { command: 'uname -a' })] },
      { content: 'TASK_COMPLETE: reported the kernel string from the WSL output.' },
    ]);
    const exec = executor(() => ({ output: 'Linux host 6.6.0 #1 SMP x86_64 GNU/Linux', success: true }), runTools);

    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: exec,
      prompt: 'use WSL and run uname -a',
      evidenceRequirement: { tools: ['wsl.list', 'wsl.run'], maxNudges: 2 },
    });

    // The runtime tools reach the model on the very first turn, so the run
    // does not have to start with repository inspection.
    expect(provider.requests[0].tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['wsl.list', 'wsl.run']),
    );
    expect(exec.calls[0]?.name).toBe('wsl.run');
    expect(exec.calls.map((requested) => requested.name)).not.toContain('filesystem.list');
    expect(exec.calls.map((requested) => requested.name)).not.toContain('filesystem.search');
    // Live output satisfied the gate: no evidence nudge, no rejected call.
    expect(result.retries).toBe(0);
    expect(result.rejectedCalls).toBe(0);
    expect(result.completionState).toBe('GOAL_COMPLETE');
    expect(result.turns).toBe(2);
  });

  it('still hides runtime tools by default so ordinary coding turns stay compact', async () => {
    const provider = scriptedProvider([{ content: 'done' }]);
    await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'ok', success: true }), runTools),
      prompt: 'Explain how the parser module is structured.',
    });
    expect(provider.requests[0].tools?.map((tool) => tool.name)).not.toContain('wsl.run');
  });

  it('a repository evidence requirement is not satisfied by live-system output', async () => {
    const provider = scriptedProvider([
      { toolCalls: [call('shell.run', { command: 'echo hi' })] },
      { content: 'Answer without inspecting the repository.' },
      { content: 'Still no inspection.' },
    ]);
    const result = await runAgentLoop({
      provider,
      model: 'm',
      capabilities: VERIFIED,
      executor: executor(() => ({ output: 'hi', success: true }), runTools),
      prompt: 'Explain how the parser module is structured.',
      evidenceRequirement: { tools: ['filesystem.list', 'filesystem.search', 'filesystem.read', 'filesystem.stat'], maxNudges: 1 },
    });
    expect(result.retries).toBeGreaterThanOrEqual(1);
    expect(provider.requests.at(-1)?.messages.some((message) =>
      typeof message.content === 'string' && message.content.includes('You have not yet used any of these tools successfully: filesystem.list'),
    )).toBe(true);
  });
});
