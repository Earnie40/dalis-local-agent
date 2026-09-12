import { getServers, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { runProcess } from './shell-tools';
import type { ToolDefinition } from './types';

const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const hostInput = {
  type: 'object',
  properties: { host: { type: 'string', minLength: 1, description: 'A hostname or IPv4/IPv6 address.' } },
  required: ['host'],
  additionalProperties: false,
};

function requireHost(input: Record<string, unknown>): string {
  if (typeof input.host !== 'string' || !input.host.trim()) {
    throw new Error('host must be a non-empty hostname or IP address.');
  }
  return input.host.trim();
}

/** OS lookup includes local hosts-file names. Stop waiting when the run cancels. */
async function lookupHost(host: string, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted();
  return new Promise<LookupAddress[]>((resolve, reject) => {
    const aborted = () => reject(combined.reason);
    combined.addEventListener('abort', aborted, { once: true });
    lookup(host, { all: true }).then(resolve, reject).finally(() => {
      combined.removeEventListener('abort', aborted);
    });
  });
}

export const systemNetworkInterfacesTool: ToolDefinition = {
  name: 'system.network.interfaces',
  description: 'Read structured local network adapters with IPv4/IPv6 addresses, subnet masks, MAC addresses, interface scope, hostname, and configured DNS servers.',
  inputSchema: emptyInput,
  permissionTier: 'safe',
  requiresShell: false,
  timeoutMs: 5_000,
  async execute(_input, ctx) {
    ctx.signal?.throwIfAborted();
    return { hostname: hostname(), interfaces: networkInterfaces(), dnsServers: getServers() };
  },
};

export function networkRouteCommandsForPlatform(platform: NodeJS.Platform) {
  if (platform === 'win32') return [{ file: 'route', args: ['print'] }];
  if (platform === 'darwin') return [{ file: '/usr/sbin/netstat', args: ['-rn'] }];
  return [
    { file: 'ip', args: ['-4', '-j', 'route', 'show', 'table', 'all'] },
    { file: 'ip', args: ['-6', '-j', 'route', 'show', 'table', 'all'] },
  ];
}

export const systemNetworkRoutesTool: ToolDefinition = {
  name: 'system.network.routes',
  description: 'Read the host IPv4 and IPv6 routing tables, including default gateways. Uses fixed commands and returns their output and exit status.',
  inputSchema: emptyInput,
  permissionTier: 'safe',
  requiresShell: false,
  timeoutMs: 15_000,
  async execute(_input, ctx) {
    const commands = await Promise.all(networkRouteCommandsForPlatform(process.platform).map((command) =>
      runProcess(command.file, command.args, {
        cwd: ctx.workspaceRoot ?? process.cwd(),
        timeoutMs: 15_000,
        signal: ctx.signal,
        useShell: false,
      }),
    ));
    return {
      exitCode: commands.find((result) => result.exitCode !== 0)?.exitCode ?? 0,
      commands,
    };
  },
};

export const systemNetworkDnsTool: ToolDefinition = {
  name: 'system.network.dns',
  description: 'Resolve a hostname or IP address through the operating system resolver and return all IPv4/IPv6 results plus configured DNS servers. Supports local network names; lookup timeout is 10 seconds.',
  inputSchema: hostInput,
  permissionTier: 'safe',
  requiresShell: false,
  requiresNetwork: true,
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const host = requireHost(input);
    return { host, addresses: await lookupHost(host, ctx.signal), dnsServers: getServers() };
  },
};

/** Resolve names first: only an IP address reaches ping's argv, never shell text or options. */
export function networkPingCommandForPlatform(platform: NodeJS.Platform, address: string) {
  const family = isIP(address);
  if (!family) throw new Error('Ping requires a resolved IPv4 or IPv6 address.');
  if (platform === 'win32') {
    return { file: 'ping', args: [`-${family}`, '-n', '4', '-w', '1000', address] };
  }
  if (platform === 'darwin') {
    return { file: family === 6 ? '/sbin/ping6' : '/sbin/ping', args: ['-n', '-c', '4', address] };
  }
  return { file: 'ping', args: [`-${family}`, '-n', '-c', '4', '-W', '1', address] };
}

export const systemNetworkPingTool: ToolDefinition = {
  name: 'system.network.ping',
  description: 'Send four ICMP echo requests to a hostname or IPv4/IPv6 address, including local network hosts. Reports the resolved target and raw packet-loss/latency output. DNS lookup has a 10-second timeout and ping has a 10-second timeout; ICMP failure alone does not prove a host is offline.',
  inputSchema: hostInput,
  permissionTier: 'safe',
  requiresShell: false,
  requiresNetwork: true,
  timeoutMs: 20_000,
  async execute(input, ctx) {
    const host = requireHost(input);
    const [target] = await lookupHost(host, ctx.signal);
    if (!target) throw new Error(`No address was returned for ${host}.`);
    const command = networkPingCommandForPlatform(process.platform, target.address);
    const result = await runProcess(command.file, command.args, {
      cwd: ctx.workspaceRoot ?? process.cwd(),
      timeoutMs: 10_000,
      signal: ctx.signal,
      useShell: false,
    });
    return { ...result, host, address: target.address, family: target.family };
  },
};

/** Dedicated diagnostics use the existing network capability check without requiring general shell access. */
export const NETWORK_DIAGNOSTIC_TOOLS = [
  systemNetworkInterfacesTool,
  systemNetworkRoutesTool,
  systemNetworkDnsTool,
  systemNetworkPingTool,
];
