import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcess } from '../packages/tools/src/shell-tools';
import { networkNmapTool, systemPrivilegesTool } from '../packages/tools/src/security-tools';
import { PermissionEngine } from '../packages/security/src/permission-engine';

vi.mock('../packages/tools/src/shell-tools', () => ({ runProcess: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe('security tool execution', () => {
  it('passes NSE and target arguments as argv, preserving report paths with spaces', async () => {
    const args = ['-sV', '--script', 'default', '-oX', 'output/report with spaces.xml', '127.0.0.1'];
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 7 } as never);
    expect(await networkNmapTool.execute({ args }, { workspaceRoot: process.cwd() })).toEqual({ exitCode: 7 });
    expect(runProcess).toHaveBeenCalledWith(process.platform === 'win32' ? 'nmap.exe' : 'nmap', args,
      expect.objectContaining({ useShell: false, cwd: process.cwd() }));
  });

  it('keeps network capability enforcement for the dedicated scanner', () => {
    const decision = new PermissionEngine().authorizeTool({
      ...networkNmapTool, toolName: networkNmapTool.name, tier: networkNmapTool.permissionTier,
      capabilities: { read: true, write: true, shell: true, network: false },
    });
    expect(decision.kind).toBe('denied');
    expect(decision.reason).toContain('network');
  });

  it('rejects malformed arguments before spawning', async () => {
    await expect(networkNmapTool.execute({ args: ['-p', 80] }, { workspaceRoot: process.cwd() })).rejects.toThrow('array of strings');
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32')('reports the measured Windows token, including failed probes', async () => {
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 0, stdout: 'False\r\n' } as never);
    expect(await systemPrivilegesTool.execute({}, {})).toMatchObject({ elevated: false });
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 0, stdout: 'True\r\n' } as never);
    expect(await systemPrivilegesTool.execute({}, {})).toMatchObject({ elevated: true });
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 1, stdout: '' } as never);
    expect(await systemPrivilegesTool.execute({}, {})).toMatchObject({ elevated: null });
  });
});
