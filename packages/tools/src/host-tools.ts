import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import { runProcess } from './shell-tools';
import type { ToolDefinition } from './types';

/**
 * Human-facing host/UI tools.
 *
 * These tools intentionally do not replace agent-side inspection/execution:
 *
 * - workspace.open-file opens a file visually for the human operator.
 *   The agent must use filesystem.read to inspect file contents.
 * - terminal.open opens an interactive terminal window for the human operator.
 *   The agent must use shell.run, tests.run, git.run, or code.diagnostics when it
 *   needs objective command output back in its own reasoning loop.
 */

export const workspaceOpenFileTool: ToolDefinition = {
  name: 'workspace.open-file',
  description:
    'Open a workspace file visually in the local VS Code window for the HUMAN operator after approval. ' +
    'This does NOT read the file into agent context and returns no source text for reasoning. ' +
    'When the agent needs to inspect a file, use filesystem.read instead. The path is confined to the registered workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Workspace-relative file path to open visually for the human operator. Use filesystem.read instead when the agent needs the contents.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresShell: true,
  timeoutMs: 15_000,

  async execute(input, ctx) {
    if (!ctx.workspaceRoot) {
      throw new Error('A workspace is required.');
    }

    const requested =
      typeof input.path === 'string'
        ? input.path.trim()
        : '';

    if (!requested) {
      throw new Error('"path" is required and must be a workspace-relative file path.');
    }

    // Reuse the same hardened containment boundary as filesystem.* tools rather
    // than maintaining a second lexical path check here.
    const path = resolveWithinWorkspace(
      ctx.workspaceRoot,
      requested,
    );

    return runProcess(
      'code',
      ['--reuse-window', path],
      {
        cwd: ctx.workspaceRoot,
        timeoutMs: 15_000,
        signal: ctx.signal,
        useShell: false,
      },
    );
  },
};

const TERMINAL_TARGETS = {
  powershell: {
    file: 'powershell.exe',
    args: ['-NoExit'],
  },
  cmd: {
    file: 'cmd.exe',
    args: ['/K'],
  },
  wsl: {
    file: 'wsl.exe',
    args: [],
  },
  docker: {
    file: 'powershell.exe',
    args: ['-NoExit', '-Command', 'docker desktop start'],
  },
} as const;

type TerminalTarget = keyof typeof TERMINAL_TARGETS;

export const terminalOpenTool: ToolDefinition = {
  name: 'terminal.open',
  description:
    'Open an approved interactive PowerShell, Command Prompt, WSL, or Docker-related terminal window for the HUMAN operator. ' +
    'This is a UI/host action and does NOT return terminal command output to the agent for reasoning. ' +
    'When the agent itself needs to execute a command and inspect its result, use shell.run, tests.run, git.run, or code.diagnostics instead.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: Object.keys(TERMINAL_TARGETS),
        description: 'Interactive terminal type to open for the human operator.',
      },
      command: {
        type: 'string',
        description:
          'Optional command to place/run in the newly opened human terminal. Do not use terminal.open merely to obtain command output for the agent.',
      },
    },
    required: ['target'],
    additionalProperties: false,
  },
  permissionTier: 'high-impact',
  requiresShell: true,
  timeoutMs: 15_000,

  async execute(input, ctx) {
    const target = String(input.target) as TerminalTarget;
    const config = TERMINAL_TARGETS[target];

    if (!config) {
      throw new Error(`Unsupported terminal target: ${target}`);
    }

    const command =
      typeof input.command === 'string'
        ? input.command.trim()
        : '';

    if (command.length > 2_000) {
      throw new Error('Terminal command is limited to 2,000 characters.');
    }

    const args: string[] = [...config.args];

    if (command && target !== 'docker') {
      args.push(command);
    }

    if (command && target === 'docker') {
      args.splice(
        0,
        args.length,
        '-NoExit',
        '-Command',
        command,
      );
    }

    return runProcess(
      'cmd.exe',
      ['/c', 'start', '', config.file, ...args],
      {
        cwd: ctx.workspaceRoot ?? process.cwd(),
        timeoutMs: 15_000,
        signal: ctx.signal,
        useShell: false,
      },
    );
  },
};

export const HOST_TOOLS: ToolDefinition[] = [
  workspaceOpenFileTool,
  terminalOpenTool,
];