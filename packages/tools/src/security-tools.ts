import { runProcess } from './shell-tools';
import type { ToolDefinition } from './types';

export const systemPrivilegesTool: ToolDefinition = {
  name: 'system.privileges',
  description: 'Measure the agent server process privileges. Windows Administrator and WSL root are separate: wsl.run can select user root without elevating Windows.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'safe',
  requiresShell: true,
  timeoutMs: 15_000,
  async execute(_input, ctx) {
    if (process.platform !== 'win32') {
      return { platform: process.platform, uid: process.getuid?.(), elevated: process.getuid?.() === 0 };
    }
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    ], { cwd: ctx.workspaceRoot ?? process.cwd(), timeoutMs: 15_000, signal: ctx.signal, useShell: false });
    return { ...result, platform: process.platform, elevated: result.exitCode === 0 ? result.stdout.trim() === 'True' : null };
  },
};

export const networkNmapTool: ToolDefinition = {
  name: 'system.network.nmap',
  description: 'Run installed native Nmap with an argument array and return stdout, stderr, and exit status. Supports port mapping, discovery, service/OS detection, UDP, NSE scripts, and output files. Pass each option/value separately. For Linux Nmap or root operations use wsl.run with user root. Driver and OS privileges determine available scan types.',
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'Nmap arguments, for example ["-sT", "-sV", "-p", "3001", "127.0.0.1"]. All installed Nmap options are available.' },
      timeoutMs: { type: 'number', minimum: 1000, maximum: 120000, description: 'Default 60000 milliseconds.' },
    },
    required: ['args'],
    additionalProperties: false,
  },
  // Nmap can write reports and NSE can change remote state. It uses the same
  // existing execution permissions as a shell; this adds no topic/target policy.
  permissionTier: 'mutation',
  requiresRead: true,
  requiresWrite: true,
  requiresShell: true,
  requiresNetwork: true,
  timeoutMs: 120_000,
  async execute(input, ctx) {
    if (!ctx.workspaceRoot) throw new Error('No workspace is selected.');
    if (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === 'string')) {
      throw new Error('args must be an array of strings.');
    }
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1000, Math.min(120000, Math.floor(input.timeoutMs))) : 60000;
    return runProcess(process.platform === 'win32' ? 'nmap.exe' : 'nmap', input.args, {
      cwd: ctx.workspaceRoot, timeoutMs, signal: ctx.signal, useShell: false,
    });
  },
};

export const SECURITY_TOOLS: ToolDefinition[] = [systemPrivilegesTool, networkNmapTool];
