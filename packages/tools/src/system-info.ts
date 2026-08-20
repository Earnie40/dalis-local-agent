import { runProcess } from './shell-tools';
import type { ToolDefinition } from './types';

/**
 * Read-only local network diagnostics. Commands and arguments are fixed so this
 * exposes connection state without becoming a general shell or network tool.
 */
export const systemNetworkInfoTool: ToolDefinition = {
  name: 'system.network.info',
  description:
    'Read the local Wi-Fi/network connection status and identify the currently connected SSID when the operating system exposes it. Read-only; it does not connect, scan, or change network settings.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'safe',
  // This is a fixed, read-only diagnostic—not general shell capability.
  requiresShell: false,
  timeoutMs: 15_000,
  async execute(_input, ctx) {
    const cwd = ctx.workspaceRoot ?? process.cwd();
    const platform = process.platform;

    if (platform === 'win32') {
      const wlan = await runProcess('netsh', ['wlan', 'show', 'interfaces'], {
        cwd,
        timeoutMs: 15_000,
        signal: ctx.signal,
        useShell: false,
      });
      if (wlan.exitCode === 0) return wlan;

      const profile = await runProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | Format-List Name,InterfaceAlias,NetworkCategory,IPv4Connectivity,IPv6Connectivity'],
        { cwd, timeoutMs: 15_000, signal: ctx.signal, useShell: false },
      );
      return { ...profile, wlanDiagnostic: wlan.stderr || wlan.stdout };
    }

    if (platform === 'darwin') {
      return runProcess('/usr/sbin/networksetup', ['-getinfo', 'Wi-Fi'], {
        cwd,
        timeoutMs: 15_000,
        signal: ctx.signal,
        useShell: false,
      });
    }

    return runProcess('nmcli', ['-t', '-f', 'active,ssid,device,type', 'connection', 'show'], {
      cwd,
      timeoutMs: 15_000,
      signal: ctx.signal,
      useShell: false,
    });
  },
};
