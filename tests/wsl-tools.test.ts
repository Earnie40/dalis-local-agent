import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcess } from '../packages/tools/src/shell-tools';
import { wslRunTool } from '../packages/tools/src/wsl-tools';

vi.mock('../packages/tools/src/shell-tools', () => ({ runProcess: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe.skipIf(process.platform !== 'win32')('WSL execution user', () => {
  it('selects root without interpolating the Linux command into the Windows shell', async () => {
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 0, stdout: '0' } as never);
    const command = 'id -u; printf "%s" "a b"';
    const result = await wslRunTool.execute({ command, distro: 'Ubuntu-24.04', user: 'root' }, { workspaceRoot: process.cwd() });
    expect(result).toMatchObject({ user: 'root', exitCode: 0 });
    expect(runProcess).toHaveBeenCalledWith('wsl.exe', [
      '-d', 'Ubuntu-24.04', '--user', 'root', '--cd', process.cwd(), '--', 'bash', '-lc',
      `source <(printf %s ${Buffer.from(command).toString('base64')} | base64 -d)`,
    ], expect.objectContaining({ useShell: false }));
  });

  it('preserves the default distro user when no user is requested', async () => {
    vi.mocked(runProcess).mockResolvedValue({ exitCode: 0 } as never);
    await wslRunTool.execute({ command: 'id' }, { workspaceRoot: process.cwd() });
    expect(vi.mocked(runProcess).mock.calls[0][1]).not.toContain('--user');
  });
});
