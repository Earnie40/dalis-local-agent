import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedToolCall, ToolExecutor, ToolSchema } from '@dacai-local-agent/agent-core';

const persisted = vi.hoisted(() => ({ current: undefined as unknown, history: [] as unknown[] }));

vi.mock('../packages/context/src/index.ts', () => ({
  loadWorkingState: vi.fn(async () => persisted.current),
  saveWorkingState: vi.fn(async (state: unknown) => {
    persisted.current = structuredClone(state);
    persisted.history.push(structuredClone(state));
  }),
}));

vi.mock('../packages/memory/src/index.ts', () => ({
  rememberFailure: vi.fn(async () => undefined),
}));

import { RunStateTracker } from '../apps/server/src/run-state-tracker';
import { ResumedRunStateTracker } from '../apps/server/src/resumed-run-state-tracker';
import { TransactionalMutationExecutor } from '../apps/server/src/transactional-mutation-executor';

const emptyState = () => ({
  threadId: 'thread-engineering',
  objective: 'generate two CAD artifacts',
  plan: [],
  completedSteps: [],
  pendingSteps: [],
  inspectedFiles: [],
  relevantSymbols: [],
  changedFiles: [],
  knownErrors: [],
  architectureFacts: [],
  validationState: { status: 'running' },
});

beforeEach(() => {
  persisted.current = emptyState();
  persisted.history.length = 0;
});

describe('engineering run-state integration', () => {
  const event = {
    type: 'tool_result',
    turn: 1,
    toolCall: {
      name: 'cad.execute',
      arguments: {
        expectedArtifacts: ['output/a.step', 'output/a.stl'],
        outputPath: 'output/a.step',
      },
    },
    result: { success: true, output: '{}' },
  };

  it('persists every generated artifact in a fresh run', async () => {
    const tracker = new RunStateTracker('thread-engineering', 'generate two CAD artifacts');
    await tracker.initialize();
    await tracker.record(event);
    expect((persisted.current as ReturnType<typeof emptyState>).changedFiles).toEqual([
      'output/a.step',
      'output/a.stl',
    ]);
  });

  it('persists every generated artifact after a resumed run', async () => {
    const tracker = new ResumedRunStateTracker('thread-engineering');
    await tracker.record(event);
    expect((persisted.current as ReturnType<typeof emptyState>).changedFiles).toEqual([
      'output/a.step',
      'output/a.stl',
    ]);
  });

  it('opens recovery entries for every declared engineering output', async () => {
    let mutated = false;
    const calls: NormalizedToolCall[] = [];
    const schemas: ToolSchema[] = [
      { name: 'shell.run', description: 'shell', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
      { name: 'cad.execute', description: 'cad', inputSchema: { type: 'object' } },
    ];
    const inner: ToolExecutor = {
      listTools: () => schemas,
      async execute(call) {
        calls.push(call);
        if (call.name === 'cad.execute') {
          mutated = true;
          return { success: true, output: '{"exitCode":0}' };
        }
        const command = String(call.arguments?.command ?? '');
        const encodedRequest = command.match(/--payload\s+([A-Za-z0-9_-]+)/)?.[1];
        if (!encodedRequest) return { success: false, output: 'missing helper payload' };
        const request = JSON.parse(Buffer.from(encodedRequest, 'base64url').toString('utf8')) as {
          operation: string;
          transactionId?: string;
          paths?: string[];
        };
        const paths = request.paths ?? [];
        const report = request.operation === 'snapshot'
          ? {
              transactionId: request.transactionId,
              entries: paths.map((path) => ({
                path, existedBefore: false, backupPath: null, preHash: null, postHash: null,
              })),
            }
          : request.operation === 'fingerprint'
            ? { entries: paths.map((path) => ({ path, hash: mutated ? `post-${path}` : null })) }
            : {};
        return {
          success: true,
          output: `DACAI_TRANSACTION_JSON:${Buffer.from(JSON.stringify(report), 'utf8').toString('base64url')}`,
        };
      },
    };

    const executor = new TransactionalMutationExecutor(inner, {
      threadId: 'thread-engineering',
      workspaceRoot: process.cwd(),
    });
    const result = await executor.execute({
      name: 'cad.execute',
      arguments: { expectedArtifacts: ['output/a.step', 'output/a.stl'] },
    });
    expect(result.success).toBe(true);
    expect(calls.filter((call) => call.name === 'cad.execute')).toHaveLength(1);
    const transaction = (persisted.current as ReturnType<typeof emptyState>).validationState.activeTransaction as {
      entries: Array<{ path: string; existedBefore: boolean }>;
    };
    expect(transaction.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'output/a.step', existedBefore: false }),
      expect.objectContaining({ path: 'output/a.stl', existedBefore: false }),
    ]));
  });
});
