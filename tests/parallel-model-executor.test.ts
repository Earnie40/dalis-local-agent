import { describe, expect, it } from 'vitest';
import type { ToolExecutor, ToolSchema } from '@dacai-local-agent/agent-core';
import {
  EvidencePacketCollector,
  executeParallelParticipants,
  normalizeParallelParticipants,
  ReadOnlyToolExecutor,
  roleForParallelParticipant,
  type ParallelLoopResult,
  type ParallelParticipant,
} from '../apps/server/src/parallel-model-executor';

function participant(alias: string): ParallelParticipant {
  return {
    alias,
    providerInstanceId: alias === 'coder' ? 'local_ollama' : `${alias}_provider`,
    model: `${alias}-model`,
  };
}

function loopResult(answer: string, stopReason: ParallelLoopResult['stopReason'] = 'final-answer'): ParallelLoopResult {
  return {
    taskId: `task-${answer}`,
    answer,
    stopReason,
    turns: 2,
    toolCalls: 1,
    rejectedCalls: 0,
    deniedCalls: 0,
    retries: 0,
    durationMs: 12,
    usage: { inputTokens: 3, outputTokens: 5 },
    workingState: {
      reasoningMode: 'standard',
      knownPaths: ['package.json'],
      changedFiles: [],
      validationResults: [],
      contextCompactions: 0,
      mutationGeneration: 0,
      validatedMutationGeneration: 0,
    },
  };
}

function completed(participantInput: ParallelParticipant, answer = `${participantInput.alias} finding`) {
  const result = loopResult(answer);
  const collector = new EvidencePacketCollector(
    participantInput,
    'inspect the repository',
    roleForParallelParticipant(participantInput.alias),
  );
  collector.record({
    type: 'tool_result',
    turn: 1,
    toolCall: { name: 'filesystem.read', arguments: { path: 'package.json' } },
    result: { success: true, output: '{"name":"dacai-local-agent"}' },
  });
  return { result, packet: collector.complete(result) };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('parallel model executor', () => {
  it('starts independent read-only participants concurrently with Promise.allSettled', async () => {
    const sol = participant('sol');
    const claude = participant('claude');
    const coder = participant('coder');
    const gates = new Map([['sol', deferred()], ['claude', deferred()], ['coder', deferred()]]);
    const started: string[] = [];

    const execution = executeParallelParticipants({
      participants: [sol, claude, coder],
      objective: 'inspect the repository',
      runReadOnly: async (current) => {
        started.push(current.alias);
        await gates.get(current.alias)?.promise;
        return completed(current);
      },
    });

    await Promise.resolve();
    expect(started).toEqual(['sol', 'claude', 'coder']);
    for (const gate of gates.values()) gate.resolve();

    const result = await execution;
    expect(result.participants.map((entry) => entry.participant.alias)).toEqual(['sol', 'claude', 'coder']);
    expect(result.participants.every((entry) => entry.packet.status === 'completed')).toBe(true);
  });

  it('retains successful evidence and identities when one participant fails', async () => {
    const sol = participant('sol');
    const claude = participant('claude');
    const coder = participant('coder');
    const result = await executeParallelParticipants({
      participants: [sol, claude, coder],
      objective: 'inspect the repository',
      runReadOnly: async (current) => {
        if (current.alias === 'claude') throw new Error('sanitized provider outage');
        return completed(current, `${current.alias} only`);
      },
    });

    expect(result.participants.map((entry) => entry.packet.participant)).toEqual(['sol', 'claude', 'coder']);
    expect(result.participants.find((entry) => entry.participant.alias === 'claude')?.packet.status).toBe('failed');
    expect(result.participants.find((entry) => entry.participant.alias === 'sol')?.packet.findings).toEqual(['sol only']);
    expect(result.participants.find((entry) => entry.participant.alias === 'coder')?.packet.findings).toEqual(['coder only']);
  });

  it('passes one cancellation signal to every concurrent worker', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    controller.abort();

    const result = await executeParallelParticipants({
      participants: [participant('sol'), participant('claude'), participant('coder')],
      objective: 'inspect the repository',
      signal: controller.signal,
      runReadOnly: async (current, _role, signal) => {
        if (signal) seen.push(signal);
        return completed(current, `${current.alias} cancelled`);
      },
    });

    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal === controller.signal && signal.aborted)).toBe(true);
    expect(result.participants).toHaveLength(3);
  });

  it('sequences a sole writer after every read-only participant settles', async () => {
    const sol = participant('sol');
    const claude = participant('claude');
    const coder = participant('coder');
    const order: string[] = [];

    const result = await executeParallelParticipants({
      participants: [sol, claude, coder],
      objective: 'make a small change',
      writerAlias: 'sol',
      runReadOnly: async (current) => {
        order.push(`start:${current.alias}`);
        await Promise.resolve();
        order.push(`end:${current.alias}`);
        return completed(current);
      },
      runWriter: async (current, _role, evidence) => {
        order.push(`writer:${current.alias}`);
        expect(evidence.map((entry) => entry.participant.alias)).toEqual(['claude', 'coder']);
        expect(order.slice(0, -1)).toContain('end:claude');
        expect(order.slice(0, -1)).toContain('end:coder');
        return completed(current, 'writer result');
      },
    });

    expect(order.at(-1)).toBe('writer:sol');
    expect(result.participants.map((entry) => entry.participant.alias)).toEqual(['claude', 'coder', 'sol']);
  });

  it('prevents a reviewer or explorer from bypassing the permissioned executor with mutations', async () => {
    const calls: string[] = [];
    const schemas: ToolSchema[] = [
      { name: 'filesystem.read', description: 'read', inputSchema: {} },
      { name: 'filesystem.edit', description: 'edit', inputSchema: {} },
    ];
    const inner: ToolExecutor = {
      listTools: () => schemas,
      execute: async (call) => {
        calls.push(call.name);
        return { success: true, output: 'inner result' };
      },
    };
    const executor = new ReadOnlyToolExecutor(inner);

    expect(executor.listTools().map((tool) => tool.name)).toEqual(['filesystem.read']);
    const denied = await executor.execute({ name: 'filesystem.edit', arguments: {} });
    expect(denied).toMatchObject({ success: false, denied: true, error: 'parallel-read-only' });
    expect(calls).toEqual([]);

    await executor.execute({ name: 'filesystem.read', arguments: { path: 'package.json' } });
    expect(calls).toEqual(['filesystem.read']);
  });

  it('keeps model agreement advisory and emits the required evidence synthesis sections', async () => {
    const result = await executeParallelParticipants({
      participants: [participant('sol'), participant('claude')],
      objective: 'inspect the repository',
      runReadOnly: async (current) => completed(current, 'Both models recommend a change.'),
    });

    expect(result.synthesis).toContain('AGREEMENTS');
    expect(result.synthesis).toContain('DISAGREEMENTS');
    expect(result.synthesis).toContain('OBJECTIVE EVIDENCE');
    expect(result.synthesis).toContain('UNRESOLVED QUESTIONS');
    expect(result.synthesis).toContain('FINAL SYNTHESIS');
    expect(result.synthesis).toContain('advisory only');
  });

  it('removes hidden-reasoning blocks before a packet can be shared with another provider', () => {
    const current = participant('claude');
    const result = loopResult('<think>private reasoning</think>Visible architecture finding.');
    const collector = new EvidencePacketCollector(current, 'inspect the repository', 'architecture-reviewer');

    expect(collector.complete(result).findings).toEqual(['Visible architecture finding.']);
  });

  it('requires a unique explicit participant list and makes a writer one of those participants', () => {
    expect(normalizeParallelParticipants(['sol', 'claude', 'coder'], 'sol')).toEqual({
      participants: ['sol', 'claude', 'coder'],
      writerAlias: 'sol',
    });
    expect(() => normalizeParallelParticipants(['sol'])).toThrow(/at least two/i);
    expect(() => normalizeParallelParticipants(['sol', 'sol'])).toThrow(/unique/i);
    expect(() => normalizeParallelParticipants(['sol', 'claude'], 'coder')).toThrow(/one of the explicitly selected/i);
  });
});
