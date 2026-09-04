import { describe, expect, it, vi } from 'vitest';
import { classifyCommand } from '../packages/security/src/command-classifier';
import { PermissionEngine } from '../packages/security/src/permission-engine';
import { PermissionedToolExecutor } from '../packages/tools/src/permissioned-executor';
import { ToolRegistry } from '../packages/tools/src/tool-registry';
import { wslRunTool } from '../packages/tools/src/wsl-tools';
import type { ToolDefinition } from '../packages/tools/src/types';

const capabilities = { read: true, write: true, shell: true, network: true };

describe('runtime-aware command classification', () => {
  it('describes an unclassified Linux command in the WSL context, not as a missing host executable', () => {
    const classification = classifyCommand('uname -a', { runtime: 'wsl' });

    expect(classification.runtime).toBe('wsl');
    expect(classification.executable).toBe('uname');
    expect(classification.reason).not.toMatch(/not a recognized executable/i);
    expect(classification.reason).toMatch(/WSL Linux runtime/);
    expect(classification.reason).toMatch(/does not check whether it is installed/i);
    // Unknown still fails upward: the runtime never lowers the tier.
    expect(classification.tier).toBe('high-impact');
    expect(classification.layer).toBe('unknown-operation');
  });

  it('defaults to the host shell and records it on the classification', () => {
    const classification = classifyCommand('uname -a');
    expect(classification.runtime).toBe('host');
    expect(classification.tier).toBe('high-impact');
    expect(classification.reason).toMatch(/host shell/);
  });

  it.each([
    ['rm -rf /mnt/c/Users', 'high-impact'],
    ['sudo apt install nmap', 'high-impact'],
    ['curl http://example.com', 'high-impact'],
    ['git push origin main', 'high-impact'],
    ['cat /etc/passwd', 'high-impact'],
    ['ls; rm -rf .', 'high-impact'],
    ['npm test', 'mutation'],
    ['git status', 'safe'],
    ['ls -la', 'safe'],
  ])('keeps the same tier for %j inside WSL as on the host', (command, tier) => {
    expect(classifyCommand(command, { runtime: 'wsl' }).tier).toBe(tier);
    expect(classifyCommand(command).tier).toBe(tier);
  });

  it('the permission engine still requires approval for an unclassified WSL command', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'wsl.run',
      tier: 'mutation',
      capabilities,
      command: 'uname -a',
      commandRuntime: 'wsl',
      requiresRead: true,
      requiresWrite: true,
      requiresShell: true,
    });

    expect(decision.kind).toBe('approval-required');
    expect(decision.tier).toBe('high-impact');
    expect(decision.reason).not.toMatch(/not a recognized executable/i);
    expect(decision.reason).toMatch(/WSL Linux runtime/);
  });

  it('a safe Linux command never drops below the tier the WSL tool declared', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'wsl.run',
      tier: 'mutation',
      capabilities,
      command: 'ls -la',
      commandRuntime: 'wsl',
      requiresShell: true,
    });

    expect(decision.kind).toBe('approval-required');
    expect(decision.tier).toBe('mutation');
  });

  it('wsl.run declares the WSL runtime for its command argument', () => {
    expect(wslRunTool.commandRuntime).toBe('wsl');
    expect(wslRunTool.permissionTier).toBe('mutation');
    expect(wslRunTool.autoApprove).toBeUndefined();
  });

  it('the executor classifies in the runtime the tool declares and still routes through the approval gate', async () => {
    const execute = vi.fn(async () => ({ stdout: 'Linux host 6.6.0 GNU/Linux', exitCode: 0 }));
    const tool: ToolDefinition = {
      name: 'wsl.run',
      description: 'stub',
      inputSchema: { type: 'object' },
      permissionTier: 'mutation',
      commandRuntime: 'wsl',
      requiresRead: true,
      requiresWrite: true,
      requiresShell: true,
      timeoutMs: 1_000,
      execute,
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const audit: Array<{ toolName: string; decision: { kind: string; tier: string; reason: string } }> = [];
    const approvals = { request: vi.fn(async () => true) };
    const executor = new PermissionedToolExecutor({
      registry,
      capabilities,
      context: {},
      audit: { record: (entry) => { audit.push({ toolName: entry.toolName, decision: entry.decision }); } },
      approvals,
    });

    const result = await executor.execute({ id: 'c1', name: 'wsl.run', arguments: { command: 'uname -a' } });

    expect(result.success).toBe(true);
    expect(approvals.request).toHaveBeenCalledOnce();
    expect(approvals.request.mock.calls[0][0].decision.tier).toBe('high-impact');
    expect(audit[0].decision.kind).toBe('approval-required');
    expect(audit[0].decision.reason).not.toMatch(/not a recognized executable/i);
    expect(audit[0].decision.reason).toMatch(/WSL Linux runtime/);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('a WSL tool is not auto-approved just because its command is safe on Linux', async () => {
    const tool: ToolDefinition = {
      name: 'wsl.run',
      description: 'stub',
      inputSchema: { type: 'object' },
      permissionTier: 'mutation',
      commandRuntime: 'wsl',
      requiresShell: true,
      timeoutMs: 1_000,
      execute: async () => 'ran',
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new PermissionedToolExecutor({ registry, capabilities, context: {} });

    const result = await executor.execute({ id: 'c1', name: 'wsl.run', arguments: { command: 'ls' } });

    expect(result.denied).toBe(true);
    expect(result.output).toContain('requires explicit approval');
  });
});
