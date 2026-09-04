import { classifyCommand } from '@dacai-local-agent/security';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { runProcess } from './shell-tools';

/**
 * Agent access to Windows Subsystem for Linux.
 *
 * `terminal.open` already knows how to launch a WSL window, but that is a host
 * action for the human: it returns nothing the agent can reason about. These
 * tools are the other half — the agent runs a command inside a distro and reads
 * the result, the same way shell.run works for the Windows side.
 *
 * Everything here is argv-based rather than shell-interpolated on the Windows
 * side: the distro name never reaches a shell, and the command is handed to
 * bash inside the distro as a single argument.
 */

const NUL = String.fromCharCode(0);

/**
 * `wsl.exe --list` writes UTF-16LE. Read back as UTF-8 that becomes every
 * character followed by a NUL, so "Ubuntu" arrives as "U\0b\0u\0n\0t\0u\0".
 * Dropping the NULs restores the ASCII the parser below expects.
 */
function stripUtf16Nulls(text: string): string {
  return text.split(NUL).join('');
}

/** Distro names are argv values, but keep them boring so they cannot smuggle flags. */
const DISTRO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('No workspace is selected.');
  return ctx.workspaceRoot;
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('WSL tools are only available on Windows hosts.');
  }
}

function readDistro(input: Record<string, unknown>): string | undefined {
  const value = typeof input.distro === 'string' ? input.distro.trim() : '';
  if (!value) return undefined;
  if (!DISTRO_PATTERN.test(value)) {
    throw new Error(`Invalid distro name: ${value}`);
  }
  return value;
}

export const wslListTool: ToolDefinition = {
  name: 'wsl.list',
  description:
    'List the installed WSL distributions and their running state. Read-only: it inspects the host, ' +
    'starts nothing, and is the correct way to discover a distro name before calling wsl.run.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresShell: true,
  timeoutMs: 20_000,

  async execute(_input, ctx) {
    assertWindows();

    const result = await runProcess('wsl.exe', ['--list', '--verbose'], {
      cwd: ctx.workspaceRoot ?? process.cwd(),
      timeoutMs: 20_000,
      signal: ctx.signal,
      useShell: false,
    });

    const stdout = stripUtf16Nulls(result.stdout);

    // Rows look like "* Ubuntu-24.04   Running   2"; the leading star marks the
    // default distro, which is what wsl.run targets when none is named.
    const distros = stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const isDefault = line.startsWith('*');
        const [name, state, version] = line.replace(/^\*\s*/, '').split(/\s{1,}/);
        return { name, state, version, default: isDefault };
      })
      .filter((entry) => Boolean(entry.name));

    return { ...result, stdout, distros };
  },
};

export const wslRunTool: ToolDefinition = {
  name: 'wsl.run',
  description:
    'Run a command inside a WSL distribution and return its output. Use this for Linux-native work on ' +
    'this Windows host — package managers, Linux toolchains, POSIX scripts — when shell.run would give ' +
    'you PowerShell instead. The workspace directory is the working directory, translated to its /mnt path.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        minLength: 1,
        maxLength: 8_000,
        description: 'The command line to run inside the distro, interpreted by bash.',
      },
      distro: {
        type: 'string',
        description: 'Distribution name from wsl.list. Omit to use the default distro.',
      },
      cwd: {
        type: 'string',
        description:
          'Optional working directory. A Windows path is translated by WSL; a /-rooted path is used as-is. ' +
          'Defaults to the selected workspace.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1_000,
        maximum: 120_000,
        description: 'Timeout in milliseconds. Default: 60000.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  /*
   * Same reasoning as shell.run: a general-purpose command path is never
   * auto-approved on the strength of one classification. WSL additionally
   * reaches the Windows filesystem through /mnt, so it is not a weaker
   * boundary than the Windows shell and must not be treated as one.
   */
  permissionTier: 'mutation',
  requiresRead: true,
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 120_000,

  async execute(input, ctx) {
    assertWindows();

    const root = requireRoot(ctx);
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) throw new Error('"command" is required.');

    const distro = readDistro(input);
    const classification = classifyCommand(command);

    const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    const cwd = requestedCwd || root;

    let timeoutMs =
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
        ? Math.floor(input.timeoutMs)
        : 60_000;
    timeoutMs = Math.max(1_000, Math.min(timeoutMs, 120_000));

    // `--` ends WSL's own option parsing, so nothing in the command is read as
    // a wsl.exe flag. bash -lc keeps one argument, so no Windows-side quoting
    // rules apply to what the user actually asked to run.
    const args = [
      ...(distro ? ['-d', distro] : []),
      '--cd',
      cwd,
      '--',
      'bash',
      '-lc',
      command,
    ];

    const result = await runProcess('wsl.exe', args, {
      cwd: root,
      timeoutMs,
      signal: ctx.signal,
      useShell: false,
    });

    return {
      ...result,
      distro: distro ?? '(default)',
      cwd,
      classifiedAs: classification.tier,
      executable: classification.executable,
    };
  },
};

export const WSL_TOOLS: ToolDefinition[] = [wslListTool, wslRunTool];

/** wsl.list alone — safe to offer where a run has no write/shell mutation rights. */
export const READ_ONLY_WSL_TOOLS: ToolDefinition[] = [wslListTool];
