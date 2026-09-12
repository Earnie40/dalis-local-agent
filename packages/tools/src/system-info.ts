import { runProcess } from './shell-tools';
import { NETWORK_DIAGNOSTIC_TOOLS } from './network-diagnostics';
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

export interface FixedSystemCommand {
  file: string;
  args: string[];
}

/** Fixed, argv-based commands for observing nearby Wi-Fi broadcasts. */
export function wifiScanCommandForPlatform(platform: NodeJS.Platform): FixedSystemCommand {
  if (platform === 'win32') {
    return {
      file: 'netsh',
      args: ['wlan', 'show', 'networks', 'mode=bssid'],
    };
  }

  if (platform === 'darwin') {
    return {
      file: '/usr/sbin/system_profiler',
      args: ['SPAirPortDataType'],
    };
  }

  return {
    file: 'nmcli',
    args: [
      '--terse',
      '--escape',
      'yes',
      '--fields',
      'SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY',
      'device',
      'wifi',
      'list',
      '--rescan',
      'yes',
    ],
  };
}

/**
 * Nearby Wi-Fi discovery is a bounded local observation. Giving it a dedicated
 * tool avoids routing a basic SSID lookup through the general-purpose shell,
 * workspace write permission, or an interactive approval.
 */
export const systemWifiScanTool: ToolDefinition = {
  name: 'system.wifi.scan',
  description:
    'List nearby Wi-Fi networks that are currently broadcasting. Reports visible SSIDs and, when the operating system exposes them, BSSIDs, signal strength, band/channel, and security. Fixed read-only command; it does not connect to or modify a network.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'safe',
  requiresShell: false,
  timeoutMs: 30_000,
  async execute(_input, ctx) {
    const command = wifiScanCommandForPlatform(process.platform);
    return runProcess(command.file, command.args, {
      cwd: ctx.workspaceRoot ?? process.cwd(),
      timeoutMs: 30_000,
      signal: ctx.signal,
      useShell: false,
    });
  },
};

/** Safe local-system observations are registered independently of shell access. */
export const SYSTEM_TOOLS: ToolDefinition[] = [
  systemNetworkInfoTool,
  systemWifiScanTool,
  ...NETWORK_DIAGNOSTIC_TOOLS,
];
