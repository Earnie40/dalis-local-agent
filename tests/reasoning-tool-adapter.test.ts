import { describe, expect, it } from 'vitest';
import { PermissionedToolExecutor } from '../packages/tools/src/permissioned-executor';
import { ToolRegistry } from '../packages/tools/src/tool-registry';
import type { ToolDefinition } from '../packages/tools/src/types';
import { environmentForTool } from '../packages/agent-core/src/evidence-provenance';

function executor(tool: Partial<ToolDefinition> & Pick<ToolDefinition, 'name' | 'execute'>) {
  const registry = new ToolRegistry();
  registry.register({ description: 'Mock safe local observation', inputSchema: { type: 'object' }, permissionTier: 'safe', timeoutMs: 1000, ...tool });
  return new PermissionedToolExecutor({ registry, capabilities: { read: true, write: true, shell: true, network: true }, context: {} });
}

describe('reasoning evidence adapter boundary', () => {
  it('reports a nonzero exit code as failure even when the tool promise resolved', async () => {
    const result = await executor({ name: 'local.mock', execute: async () => ({ exitCode: 1, stdout: 'decoy success text' }) }).execute({ name: 'local.mock', arguments: {} });
    expect(result.success).toBe(false);
    expect(result.output).toContain('decoy success text');
    expect(result.evidence?.[0].detail?.exitCode).toBe(1);
  });

  it('takes origins from the registered adapter, not a model-supplied provenance argument', async () => {
    const result = await executor({ name: 'local.mock', execute: async () => 'safe mock public identifier',
      evidenceSources: () => [{ id: 'observed', locator: 'mock local provider', provenance: 'local_machine', content: 'safe mock public identifier', effect: 'read' }],
    }).execute({ name: 'local.mock', arguments: { provenance: 'production_data' } });
    expect(result.sources?.[0].provenance).toBe('local_machine');
    const read = await executor({ name: 'filesystem.read', execute: async () => 'wallet:0xabc' }).execute({ name: 'filesystem.read', arguments: { path: 'docs/example.md', provenance: 'production_data' } });
    expect(read.sources?.[0].provenance).toBe('documentation');
    expect(read.sources?.[0].effect).toBe('read');
  });

  it('reports the registered WSL target independently of the Windows host and model arguments', () => {
    const tool = executor({ name: 'wsl.run', commandRuntime: 'wsl', execute: async () => ({ exitCode: 0 }) }).listTools()[0];
    expect(environmentForTool(tool, { platform: 'win32', shell: 'cmd.exe', arch: 'x64' })).toEqual({ platform: 'linux', shell: '/bin/bash', arch: 'unknown' });
  });
});
