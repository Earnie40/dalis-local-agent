import { describe, expect, it } from 'vitest';
import { PermissionEngine } from '../packages/security/src/permission-engine';
import {
  SYSTEM_TOOLS,
  systemWifiScanTool,
  wifiScanCommandForPlatform,
} from '../packages/tools/src/system-info';

describe('nearby Wi-Fi discovery', () => {
  it('uses fixed argv commands for each supported host family', () => {
    expect(wifiScanCommandForPlatform('win32')).toEqual({
      file: 'netsh',
      args: ['wlan', 'show', 'networks', 'mode=bssid'],
    });
    expect(wifiScanCommandForPlatform('darwin')).toEqual({
      file: '/usr/sbin/system_profiler',
      args: ['SPAirPortDataType'],
    });
    expect(wifiScanCommandForPlatform('linux')).toMatchObject({
      file: 'nmcli',
      args: expect.arrayContaining(['SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY', '--rescan', 'yes']),
    });
  });

  it('is a safe read-only tool that does not require shell or write access', () => {
    expect(systemWifiScanTool.permissionTier).toBe('safe');
    expect(systemWifiScanTool.requiresShell).toBe(false);
    expect(systemWifiScanTool.requiresWrite).toBeUndefined();

    const decision = new PermissionEngine().authorizeTool({
      toolName: systemWifiScanTool.name,
      tier: systemWifiScanTool.permissionTier,
      capabilities: { read: true, write: false, shell: false, network: false },
      requiresShell: systemWifiScanTool.requiresShell,
      requiresWrite: systemWifiScanTool.requiresWrite,
    });
    expect(decision.kind).toBe('allowed');
  });

  it('is registered independently of shell access', () => {
    expect(SYSTEM_TOOLS.map((tool) => tool.name)).toEqual([
      'system.network.info',
      'system.wifi.scan',
    ]);
  });
});
