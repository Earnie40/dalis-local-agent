import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { PermissionEngine } from '../packages/security/src/permission-engine';
import { selectAgentTools } from '../apps/server/src/agent-tool-selection';
import {
  NETWORK_DIAGNOSTIC_TOOLS,
  networkPingCommandForPlatform,
  networkRouteCommandsForPlatform,
  systemNetworkDnsTool,
  systemNetworkInterfacesTool,
  systemNetworkPingTool,
  systemNetworkRoutesTool,
} from '../packages/tools/src/network-diagnostics';
import { SYSTEM_TOOLS } from '../packages/tools/src/system-info';
import { runProcess } from '../packages/tools/src/shell-tools';

vi.mock('node:dns', () => ({ getServers: vi.fn(() => ['192.0.2.1']) }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:os', () => ({ hostname: vi.fn(() => 'local-host'), networkInterfaces: vi.fn() }));
vi.mock('../packages/tools/src/shell-tools', () => ({ runProcess: vi.fn() }));

const commandResult = {
  command: 'diagnostic command', exitCode: 0, stdout: 'measured output', stderr: '',
  durationMs: 5, timedOut: false, cancelled: false, truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lookup).mockResolvedValue([{ address: '192.0.2.2', family: 4 }]);
  vi.mocked(runProcess).mockResolvedValue(commandResult);
});

describe('additional agent network diagnostics', () => {
  it('exposes every registered diagnostic without requiring general shell or write access', () => {
    const names = selectAgentTools(SYSTEM_TOOLS).map((tool) => tool.name);
    for (const tool of NETWORK_DIAGNOSTIC_TOOLS) {
      expect(names).toContain(tool.name);
      const decision = new PermissionEngine().authorizeTool({
        toolName: tool.name,
        tier: tool.permissionTier,
        requiresShell: tool.requiresShell,
        requiresNetwork: tool.requiresNetwork,
        requiresWrite: tool.requiresWrite,
        capabilities: { read: true, write: false, shell: false, network: true },
      });
      expect(decision.kind).toBe('allowed');
    }
  });

  it('keeps adapter and route observations available when network traffic is disabled', () => {
    for (const tool of NETWORK_DIAGNOSTIC_TOOLS) {
      const decision = new PermissionEngine().authorizeTool({
        toolName: tool.name,
        tier: tool.permissionTier,
        requiresShell: tool.requiresShell,
        requiresNetwork: tool.requiresNetwork,
        capabilities: { read: true, write: false, shell: false, network: false },
      });
      expect(decision.kind).toBe(tool.requiresNetwork ? 'denied' : 'allowed');
    }
  });

  it('returns actual adapter details including loopback and IPv6 without a shell command', async () => {
    const interfaces = {
      loopback: [{ address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6' as const,
        mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 }],
    };
    vi.mocked(networkInterfaces).mockReturnValue(interfaces);
    expect(await systemNetworkInterfacesTool.execute({}, {})).toEqual({
      hostname: 'local-host', interfaces, dnsServers: ['192.0.2.1'],
    });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('returns both address families from local hostname resolution', async () => {
    const addresses = [{ address: '192.0.2.2', family: 4 }, { address: '2001:db8::2', family: 6 }];
    vi.mocked(lookup).mockResolvedValue(addresses);
    expect(await systemNetworkDnsTool.execute({ host: 'nas.local' }, {})).toEqual({
      host: 'nas.local', addresses, dnsServers: ['192.0.2.1'],
    });
    expect(lookup).toHaveBeenCalledWith('nas.local', { all: true });
  });

  it('reports DNS failures and never starts a ping for an unresolved target', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('getaddrinfo ENOTFOUND missing.local'));
    await expect(systemNetworkDnsTool.execute({ host: 'missing.local' }, {})).rejects.toThrow('ENOTFOUND');
    await expect(systemNetworkPingTool.execute({ host: 'missing.local' }, {})).rejects.toThrow('ENOTFOUND');
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('returns promptly on cancellation during hostname lookup', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = systemNetworkDnsTool.execute({ host: 'nas.local' }, { signal: controller.signal });
    controller.abort(new Error('operator cancelled'));
    await expect(result).rejects.toThrow('operator cancelled');
  });

  it('passes only the resolved IP to ping and preserves failed command output', async () => {
    vi.mocked(runProcess).mockResolvedValue({ ...commandResult, exitCode: 1, stdout: '100% packet loss' });
    const result = await systemNetworkPingTool.execute({ host: 'nas.local' }, { workspaceRoot: process.cwd() });
    expect(result).toMatchObject({ host: 'nas.local', address: '192.0.2.2', family: 4, exitCode: 1, stdout: '100% packet loss' });
    const [file, args, options] = vi.mocked(runProcess).mock.calls[0];
    expect(file).toMatch(/ping$/);
    expect(args).toContain('192.0.2.2');
    expect(args).not.toContain('nas.local');
    expect(options).toMatchObject({ cwd: process.cwd(), timeoutMs: 10_000, useShell: false });
  });

  it('preserves routing errors instead of certifying an unsuccessful diagnostic', async () => {
    vi.mocked(runProcess).mockResolvedValue({ ...commandResult, exitCode: 2, stderr: 'route utility unavailable' });
    const result = await systemNetworkRoutesTool.execute({}, {}) as { exitCode: number; commands: unknown[] };
    expect(result.exitCode).toBe(2);
    expect(result.commands[0]).toMatchObject({ stderr: 'route utility unavailable' });
    expect(vi.mocked(runProcess).mock.calls.every(([, , options]) => options.useShell === false)).toBe(true);
  });

  it('selects platform commands covering IPv4 and IPv6 routing and ping', () => {
    expect(networkRouteCommandsForPlatform('win32')).toEqual([{ file: 'route', args: ['print'] }]);
    expect(networkRouteCommandsForPlatform('darwin')).toEqual([{ file: '/usr/sbin/netstat', args: ['-rn'] }]);
    expect(networkRouteCommandsForPlatform('linux').map((command) => command.args[0])).toEqual(['-4', '-6']);
    expect(networkPingCommandForPlatform('win32', '::1').args).toEqual(['-6', '-n', '4', '-w', '1000', '::1']);
    expect(networkPingCommandForPlatform('darwin', '::1').file).toBe('/sbin/ping6');
    expect(networkPingCommandForPlatform('linux', '127.0.0.1').args).toEqual(['-4', '-n', '-c', '4', '-W', '1', '127.0.0.1']);
    expect(() => networkPingCommandForPlatform('win32', '-t')).toThrow('resolved IPv4 or IPv6');
  });
});
