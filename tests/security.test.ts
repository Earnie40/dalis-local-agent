import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionEngine } from '../packages/security/src/permission-engine';
import { classifyCommand } from '../packages/security/src/command-classifier';
import { PathContainmentError, resolveWithinWorkspace } from '../packages/security/src/path-containment';
import { PostgresWorkspaceRegistry } from '../packages/workspace/src/workspace-registry';

const capabilities = { read: true, write: true, shell: true, network: true };

describe('permission engine', () => {
  it('classifies node workspace scripts as mutation-tier rather than unknown executables', () => {
    expect(classifyCommand('node scripts/transaction-snapshot.mjs').tier).toBe('mutation');
  });

  it('allows a read-only command without approval', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'shell.run',
      tier: 'safe',
      capabilities,
      command: 'git status',
      requiresShell: true,
    });

    expect(decision.kind).toBe('allowed');
    expect(decision.tier).toBe('safe');
  });

  it('escalates a destructive command to high-impact approval', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'shell.run',
      tier: 'safe',
      capabilities,
      command: 'rm -rf /tmp/test',
      requiresShell: true,
    });

    expect(decision.tier).toBe('high-impact');
    expect(decision.kind).not.toBe('allowed');
  });

  it('never lets a command classification lower the declared tier', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'shell.run',
      tier: 'high-impact',
      capabilities,
      command: 'git status',
      requiresShell: true,
    });

    expect(decision.tier).toBe('high-impact');
  });

  it('allows a trusted bounded mutation without an approval pause after capability checks', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'image.generate',
      tier: 'mutation',
      capabilities,
      autoApprove: true,
      requiresRead: true,
      requiresWrite: true,
    });

    expect(decision).toMatchObject({ kind: 'allowed', tier: 'mutation', layer: 'tier-policy' });
  });

  it('does not let bounded auto-approval waive workspace write capability', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'image.generate',
      tier: 'mutation',
      capabilities: { ...capabilities, write: false },
      autoApprove: true,
      requiresWrite: true,
    });

    expect(decision).toMatchObject({ kind: 'denied', layer: 'workspace-containment' });
  });

  it('denies outright when the workspace withholds the capability', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'shell.run',
      tier: 'safe',
      capabilities: { ...capabilities, shell: false },
      command: 'git status',
      requiresShell: true,
    });

    expect(decision.kind).toBe('denied');
    expect(decision.layer).toBe('workspace-containment');
  });

  it('does not let shell authority bypass an explicitly withheld read capability', () => {
    const decision = new PermissionEngine().authorizeTool({
      toolName: 'shell.run',
      tier: 'safe',
      capabilities: { read: false, write: false, shell: true, network: false },
      command: 'git status',
      requiresShell: true,
    });
    expect(decision).toMatchObject({ kind: 'denied', layer: 'workspace-containment' });
  });
});

describe('workspace capability invariants', () => {
  it.each([
    { read: false, write: true, shell: false, network: false },
    { read: false, write: false, shell: true, network: false },
  ])('rejects write or shell capability when read is disabled', async (requested) => {
    const registry = new PostgresWorkspaceRegistry();
    await expect(registry.create({
      displayName: 'invalid workspace',
      rootPath: '.',
      capabilities: requested,
    })).rejects.toThrow(/require read capability/i);
  });
});

describe('workspace containment', () => {
  const root = mkdtempSync(join(tmpdir(), 'dacai-ws-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export {};');

  it('resolves a path inside the workspace', () => {
    expect(resolveWithinWorkspace(root, 'src/index.ts')).toContain('index.ts');
  });

  it('rejects traversal out of the workspace', () => {
    expect(() => resolveWithinWorkspace(root, '../../etc/passwd')).toThrow(PathContainmentError);
  });

  it('rejects an absolute path outside the workspace', () => {
    expect(() => resolveWithinWorkspace(root, 'C:/Windows/System32/drivers/etc/hosts')).toThrow(
      PathContainmentError,
    );
  });

  it('rejects UNC and network paths', () => {
    expect(() => resolveWithinWorkspace(root, '\\\\server\\share\\file.txt')).toThrow(PathContainmentError);
  });

  it('allows a not-yet-existing file inside the workspace', () => {
    expect(resolveWithinWorkspace(root, 'src/new-file.ts')).toContain('new-file.ts');
  });
});
