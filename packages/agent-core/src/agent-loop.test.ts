import { describe, expect, it } from 'vitest';
import type { ModelChatRequest, ModelChatResponse, ModelProvider, NormalizedToolCall, ToolSchema } from './types';
import { runAgentLoop, type LoopToolResult, type ToolExecutor } from './agent-loop';

function response(content: string, toolCalls?: NormalizedToolCall[]): ModelChatResponse {
  return {
    content,
    toolCalls,
    model: 'qwen3:8b',
    providerInstanceId: 'test',
    usageClass: 'LOCAL_OLLAMA',
  };
}

function provider(turns: Array<(request: ModelChatRequest) => ModelChatResponse>): ModelProvider {
  let index = 0;
  return {
    instanceId: 'test',
    kind: 'ollama',
    usageClass: 'LOCAL_OLLAMA',
    async chat(request) { return turns[Math.min(index++, turns.length - 1)](request); },
    supportsTools: () => 'verified',
    listModels: async () => [],
    health: async () => ({ status: 'connected', instanceId: 'test', usageClass: 'LOCAL_OLLAMA', location: 'Local' }),
    getUsage: async () => ({}),
  };
}

function executor(tools: ToolSchema[], run: (call: NormalizedToolCall) => LoopToolResult): ToolExecutor {
  return { listTools: () => tools, execute: async (call) => run(call) };
}

const capabilities = { toolCalling: 'verified' as const, streaming: 'verified' as const, contextWindow: 32768 };

const tool = (name: string): ToolSchema => ({ name, description: name, inputSchema: { type: 'object' } });
const call = (id: string, name: string, args: Record<string, unknown>): NormalizedToolCall => ({ id, name, arguments: args });

describe('agent loop execution gates', () => {
  it('rejects progress prose until a completion signal is supplied', async () => {
    const result = await runAgentLoop({
      provider: provider([
        () => response('I found the files. Let me know if you want me to continue.'),
        (request) => {
          expect(request.messages.at(-1)?.content).toContain('TASK COMPLETION CHECK');
          return response('TASK_COMPLETE: verified simple task.');
        },
      ]),
      model: 'qwen3:8b', capabilities,
      executor: executor([], () => ({ success: true, output: '' })),
      prompt: 'Answer after completion.',
      completionSignalRequired: true,
      maxTurns: 4,
    });
    expect(result.stopReason).toBe('final-answer');
    expect(result.turns).toBe(2);
  });

  it('grounds a failed guessed path in a prior recursive listing', async () => {
    const result = await runAgentLoop({
      provider: provider([
        () => response('', [call('1', 'filesystem.list', { path: 'agent-docs-import', recursive: true })]),
        () => response('', [call('2', 'filesystem.read', { path: 'agent-docs-import/AGENT_RUNTIME.md' })]),
        (request) => {
          expect(request.messages.at(-1)?.content).toContain('PATH CORRECTION');
          expect(request.messages.at(-1)?.content).toContain('agent-docs-import/docs/AGENT_RUNTIME.md');
          return response('TASK_BLOCKED: test intentionally stops after path correction.');
        },
      ]),
      model: 'qwen3:8b', capabilities,
      executor: executor([tool('filesystem.list'), tool('filesystem.read')], (requested) => {
        if (requested.name === 'filesystem.list') {
          return { success: true, output: JSON.stringify({ entries: ['agent-docs-import/docs/AGENT_RUNTIME.md'] }) };
        }
        return { success: false, error: 'ENOENT', output: 'No such file: agent-docs-import/AGENT_RUNTIME.md' };
      }),
      prompt: 'Read the imported runtime documentation.',
      completionSignalRequired: true,
      maxTurns: 5,
    });
    expect(result.workingState.knownPaths).toContain('agent-docs-import/docs/AGENT_RUNTIME.md');
  });

  it('does not accept TASK_COMPLETE after a mutation until validation passes', async () => {
    const result = await runAgentLoop({
      provider: provider([
        () => response('', [call('1', 'filesystem.edit', { path: 'src/a.ts', oldText: 'a', newText: 'b' })]),
        () => response('TASK_COMPLETE: edited.'),
        (request) => {
          expect(request.messages.at(-1)?.content).toContain('VALIDATION REQUIRED');
          return response('', [call('2', 'tests.run', { command: 'pnpm -r typecheck' })]);
        },
        () => response('TASK_COMPLETE: edited and validated.'),
      ]),
      model: 'qwen3:8b', capabilities,
      executor: executor([tool('filesystem.edit'), tool('tests.run')], (requested) => {
        if (requested.name === 'filesystem.edit') return { success: true, output: '{}' };
        return { success: true, output: JSON.stringify({ exitCode: 0 }), evidence: [{ kind: 'exit_code', summary: 'exited 0', detail: { exitCode: 0 } }] };
      }),
      prompt: 'Change src/a.ts and verify it.',
      completionSignalRequired: true,
      requireValidationAfterMutation: true,
      maxTurns: 8,
    });
    expect(result.stopReason).toBe('final-answer');
    expect(result.workingState.mutationGeneration).toBe(result.workingState.validatedMutationGeneration);
    expect(result.workingState.validationResults.at(-1)).toContain('PASSED');
  });

  it('tracks engineering artifacts and requires a separate evidence inspection', async () => {
    const result = await runAgentLoop({
      provider: provider([
        () => response('', [call('1', 'cad.execute', {
          backend: 'cadquery',
          scriptPath: 'models/part.py',
          sourceSha256: 'a'.repeat(64),
          expectedArtifacts: ['output/a.step', 'output/a.stl'],
        })]),
        () => response('TASK_COMPLETE: generated artifacts.'),
        (request) => {
          expect(request.messages.at(-1)?.content).toContain('VALIDATION REQUIRED');
          return response('', [call('2', 'engineering.artifact.inspect', { paths: ['output/a.step', 'output/a.stl'] })]);
        },
        () => response('TASK_COMPLETE: artifacts generated and hash-verified.'),
      ]),
      model: 'qwen3:8b', capabilities,
      executor: executor([tool('cad.execute'), tool('engineering.artifact.inspect')], (requested) => {
        if (requested.name === 'cad.execute') return { success: true, output: '{}' };
        return {
          success: true,
          output: JSON.stringify({ validation: { filesPresent: true, contentHashed: true } }),
          evidence: [{
            kind: 'validation_result',
            summary: 'artifact hashes verified',
            detail: { filesPresent: true, contentHashed: true },
          }, {
            kind: 'artifact_hash', summary: 'a.step hash', detail: { path: 'output/a.step', sha256: 'b'.repeat(64) },
          }, {
            kind: 'artifact_hash', summary: 'a.stl hash', detail: { path: 'output/a.stl', sha256: 'c'.repeat(64) },
          }],
        };
      }),
      prompt: 'Generate and verify a CAD part.',
      completionSignalRequired: true,
      requireValidationAfterMutation: true,
      maxTurns: 8,
    });
    expect(result.workingState.changedFiles).toEqual(expect.arrayContaining(['output/a.step', 'output/a.stl']));
    expect(result.workingState.mutationGeneration).toBe(1);
    expect(result.workingState.validatedMutationGeneration).toBe(1);
    expect(result.completionState).toBe('VERIFICATION_COMPLETE');
  });

  it('does not let inspection of an unrelated artifact validate changed engineering outputs', async () => {
    const result = await runAgentLoop({
      provider: provider([
        () => response('', [call('1', 'cad.execute', {
          backend: 'cadquery', scriptPath: 'models/part.py', sourceSha256: 'a'.repeat(64),
          expectedArtifacts: ['output/a.step'],
        })]),
        () => response('', [call('2', 'engineering.artifact.inspect', { paths: ['unrelated/preexisting.step'] })]),
        () => response('TASK_COMPLETE: done.'),
        (request) => {
          expect(request.messages.at(-1)?.content).toContain('output/a.step');
          return response('TASK_BLOCKED: changed artifact was not inspected.');
        },
      ]),
      model: 'qwen3:8b', capabilities,
      executor: executor([tool('cad.execute'), tool('engineering.artifact.inspect')], (requested) => {
        if (requested.name === 'cad.execute') return { success: true, output: '{}' };
        return {
          success: true,
          output: JSON.stringify({ validation: { filesPresent: true, contentHashed: true } }),
          evidence: [
            { kind: 'validation_result', summary: 'hash inspected', detail: { filesPresent: true, contentHashed: true } },
            { kind: 'artifact_hash', summary: 'unrelated hash', detail: { path: 'unrelated/preexisting.step', sha256: 'd'.repeat(64) } },
          ],
        };
      }),
      prompt: 'Generate and verify a CAD part.',
      completionSignalRequired: true,
      requireValidationAfterMutation: true,
      maxTurns: 8,
    });
    expect(result.completionState).toBe('BLOCKED');
    expect(result.workingState.mutationGeneration).toBe(1);
    expect(result.workingState.validatedMutationGeneration).toBe(0);
  });
});
