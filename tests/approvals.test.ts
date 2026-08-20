import { describe, expect, it, vi } from 'vitest';
import { ApprovalRegistry } from '../apps/server/src/approvals';
import { PermissionedToolExecutor } from '../packages/tools/src/permissioned-executor';
import { ToolRegistry } from '../packages/tools/src/tool-registry';
import { PermissionEngine } from '../packages/security/src/permission-engine';
import type { PermissionDecision } from '../packages/security/src/types';
import type { ToolDefinition } from '../packages/tools/src/types';

const decision: PermissionDecision = {
  kind: 'approval-required',
  tier: 'high-impact',
  reason: '"rm" is a high-impact executable.',
  layer: 'operation-classification',
};

describe('ApprovalRegistry', () => {
  it('resolves true when the human approves', async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request({
      runId: 'run_1',
      toolName: 'shell.run',
      decision,
      input: {},
      onRequested: (approval) => registry.decide(approval.id, true),
    });

    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the human denies', async () => {
    const registry = new ApprovalRegistry();
    const pending = registry.request({
      runId: 'run_1',
      toolName: 'shell.run',
      decision,
      input: {},
      onRequested: (approval) => registry.decide(approval.id, false),
    });

    await expect(pending).resolves.toBe(false);
  });

  it('denies on timeout rather than hanging or allowing', async () => {
    vi.useFakeTimers();
    const registry = new ApprovalRegistry();
    const pending = registry.request({ runId: 'run_1', toolName: 'shell.run', decision, input: {}, timeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('denies every outstanding request when the run is cancelled', async () => {
    const registry = new ApprovalRegistry();
    const first = registry.request({ runId: 'run_1', toolName: 'a', decision, input: {} });
    const second = registry.request({ runId: 'run_1', toolName: 'b', decision, input: {} });
    const other = registry.request({ runId: 'run_2', toolName: 'c', decision, input: {} });

    expect(registry.cancelRun('run_1')).toBe(2);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

    // A different run is untouched.
    expect(registry.pending().map((p) => p.toolName)).toEqual(['c']);
    registry.decide(registry.pending()[0].id, false);
    await other;
  });

  it('ignores a decision for an unknown or already-settled id', async () => {
    const registry = new ApprovalRegistry();
    expect(registry.decide('does-not-exist', true)).toBe(false);

    let id = '';
    const pending = registry.request({
      runId: 'run_1',
      toolName: 'shell.run',
      decision,
      input: {},
      onRequested: (approval) => {
        id = approval.id;
      },
    });

    expect(registry.decide(id, false)).toBe(true);
    // A second answer must not be able to flip an already-settled request.
    expect(registry.decide(id, true)).toBe(false);
    await expect(pending).resolves.toBe(false);
  });

  it('issues unguessable ids', () => {
    const registry = new ApprovalRegistry();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      registry.request({
        runId: 'r',
        toolName: 't',
        decision,
        input: {},
        onRequested: (approval) => ids.add(approval.id),
      });
    }

    expect(ids.size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/** The gate is only meaningful if the executor actually honours it. */
describe('executor honours the gate', () => {
  const dangerous: ToolDefinition = {
    name: 'shell.run',
    description: 'run',
    inputSchema: { type: 'object' },
    permissionTier: 'safe',
    requiresShell: true,
    timeoutMs: 5_000,
    execute: async () => ({ exitCode: 0, stdout: 'it ran' }),
  };

  function buildExecutor(approvals?: { request: () => Promise<boolean> }) {
    const registry = new ToolRegistry();
    registry.register(dangerous);

    return new PermissionedToolExecutor({
      registry,
      engine: new PermissionEngine({ autoApprove: ['safe'], requireApproval: ['mutation', 'high-impact'], deny: [] }),
      capabilities: { read: true, write: true, shell: true, network: true },
      context: {},
      approvals,
    });
  }

  const call = { id: 'c1', name: 'shell.run', arguments: { command: 'rm -rf .' } };

  it('runs the tool when approval is granted', async () => {
    const result = await buildExecutor({ request: async () => true }).execute(call);

    expect(result.success).toBe(true);
    expect(result.output).toContain('it ran');
  });

  it('blocks the tool when approval is refused', async () => {
    const result = await buildExecutor({ request: async () => false }).execute(call);

    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.output).not.toContain('it ran');
  });

  it('fails closed when no gate is wired at all', async () => {
    const result = await buildExecutor(undefined).execute(call);

    expect(result.denied).toBe(true);
    expect(result.output).toContain('requires explicit approval');
  });

  it('never asks for a call the engine already denied outright', async () => {
    const registry = new ToolRegistry();
    registry.register(dangerous);
    let asked = 0;

    const executor = new PermissionedToolExecutor({
      registry,
      capabilities: { read: true, write: true, shell: false, network: true },
      context: {},
      approvals: {
        request: async () => {
          asked += 1;
          return true;
        },
      },
    });

    const result = await executor.execute(call);

    // Workspace capability denial is final and not appealable to a human.
    expect(result.denied).toBe(true);
    expect(asked).toBe(0);
  });
});
