import { spawn } from 'node:child_process';
import { classifyCommand, sanitizeText } from '@dacai-local-agent/security';
import type {
  ToolDefinition,
  ToolExecutionContext,
} from './types';
import { systemNetworkInfoTool } from './system-info';

const MAX_OUTPUT_CHARS = 20_000;

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

/**
 * Child processes receive only the environment needed for normal toolchain
 * operation. Parent-process credentials and application secrets are not
 * inherited.
 */
export function minimalEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'SystemRoot',
    'windir',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'TZ',
    'NUMBER_OF_PROCESSORS',
    'PROGRAMFILES',
    'ProgramFiles',
    'PROGRAMDATA',
    'APPDATA',
    'LOCALAPPDATA',
  ];

  const result: NodeJS.ProcessEnv = {};

  for (const key of allowed) {
    if (env[key] !== undefined) {
      result[key] = env[key];
    }
  }

  result.CI = '1';
  result.NO_COLOR = '1';

  /*
   * Avoid interactive prompts if a child tool unexpectedly encounters one.
   */
  result.GIT_TERMINAL_PROMPT = '0';

  return result;
}

function appendBounded(
  current: string,
  chunk: Buffer | string,
): string {
  if (
    current.length >=
    MAX_OUTPUT_CHARS * 2
  ) {
    return current;
  }

  const text =
    typeof chunk === 'string'
      ? chunk
      : chunk.toString();

  const remaining =
    MAX_OUTPUT_CHARS * 2 -
    current.length;

  return (
    current +
    text.slice(0, remaining)
  );
}

function cap(
  text: string,
): {
  text: string;
  truncated: boolean;
} {
  if (
    text.length <=
    MAX_OUTPUT_CHARS
  ) {
    return {
      text,
      truncated: false,
    };
  }

  const half =
    Math.floor(
      (MAX_OUTPUT_CHARS - 60) / 2,
    );

  return {
    text:
      `${text.slice(0, half)}\n` +
      '… [output truncated] …\n' +
      text.slice(-half),

    truncated: true,
  };
}

/**
 * Executes a process.
 *
 * argv-based callers use shell=false.
 *
 * shell=true is reserved for the explicitly controlled shell tool, where the
 * command has already passed through permission classification and approval.
 */
export function runProcess(
  file: string,
  args: string[] | undefined,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    useShell?: boolean;
  },
): Promise<CommandResult> {
  return new Promise(
    (resolve, reject) => {
      if (options.signal?.aborted) {
        resolve({
          command:
            sanitizeText(formatCommand(file, args)),

          exitCode: -1,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          cancelled: true,
          truncated: false,
        });

        return;
      }

      const startedAt =
        Date.now();

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const child =
        spawn(
          file,
          args ?? [],
          {
            cwd:
              options.cwd,

            env:
              minimalEnv(),

            shell:
              options.useShell ??
              false,

            windowsHide:
              true,

            stdio: [
              'ignore',
              'pipe',
              'pipe',
            ],
          },
        );

      const finish =
        (
          code: number | null,
        ) => {
          if (settled) {
            return;
          }

          settled = true;

          clearTimeout(
            timer,
          );

          options.signal?.removeEventListener(
            'abort',
            onAbort,
          );

          const out =
            cap(sanitizeText(stdout));

          const err =
            cap(sanitizeText(stderr));

          resolve({
            command:
              sanitizeText(formatCommand(file, args)),

            exitCode:
              timedOut
                ? 124
                : cancelled
                  ? -1
                  : code ?? -1,

            stdout:
              out.text,

            stderr:
              err.text,

            durationMs:
              Date.now() -
              startedAt,

            timedOut,
            cancelled,

            truncated:
              out.truncated ||
              err.truncated,
          });
        };

      const terminate = () => {
        /*
         * Tools are expected to honor their AbortSignal where possible.
         *
         * child.kill() is the final local process boundary here.
         */
        try {
          child.kill(
            'SIGKILL',
          );
        } catch {
          // The process may already have exited.
        }
      };

      const timer =
        setTimeout(
          () => {
            timedOut = true;
            terminate();
          },
          options.timeoutMs,
        );

      const onAbort = () => {
        cancelled = true;
        terminate();
      };

      options.signal?.addEventListener(
        'abort',
        onAbort,
        {
          once: true,
        },
      );

      child.stdout?.on(
        'data',
        (chunk: Buffer) => {
          stdout =
            appendBounded(
              stdout,
              chunk,
            );
        },
      );

      child.stderr?.on(
        'data',
        (chunk: Buffer) => {
          stderr =
            appendBounded(
              stderr,
              chunk,
            );
        },
      );

      child.once(
        'error',
        (error) => {
          if (settled) {
            return;
          }

          settled = true;

          clearTimeout(
            timer,
          );

          options.signal?.removeEventListener(
            'abort',
            onAbort,
          );

          reject(new Error(sanitizeText(error.message)));
        },
      );

      child.once(
        'close',
        (code) => {
          finish(code);
        },
      );
    },
  );
}

function formatCommand(
  file: string,
  args:
    | string[]
    | undefined,
): string {
  if (
    !args ||
    args.length === 0
  ) {
    return file;
  }

  return [
    file,
    ...args,
  ].join(' ');
}

function requireRoot(
  ctx: ToolExecutionContext,
): string {
  if (!ctx.workspaceRoot) {
    throw new Error(
      'No workspace is selected.',
    );
  }

  return ctx.workspaceRoot;
}

/**
 * Free-form shell execution is inherently more capable than a fixed diagnostic
 * command, so its baseline is mutation rather than safe.
 *
 * The permission engine still receives the command text and may raise the risk
 * further based on classification.
 */
export const shellRunTool: ToolDefinition = {
  name: 'shell.run',

  description:
    'Run an explicitly approved shell command inside the selected workspace. ' +
    'Commands are classified before execution, receive a minimal environment, ' +
    'and are bounded by timeout and output limits.',

  inputSchema: {
    type: 'object',

    properties: {
      command: {
        type: 'string',
        minLength: 1,
        maxLength: 8_000,
        description:
          'The command line to run.',
      },

      timeoutMs: {
        type: 'number',
        minimum: 1_000,
        maximum: 120_000,
        description:
          'Timeout in milliseconds. Default: 60000.',
      },
    },

    required: [
      'command',
    ],

    additionalProperties:
      false,
  },

  /*
   * Do not make a general-purpose shell tool auto-approved merely because a
   * classifier currently considers a specific command low risk.
   */
  permissionTier: 'mutation',

  requiresRead: true,

  requiresWrite: true,

  requiresShell: true,

  timeoutMs: 120_000,

  async execute(
    input,
    ctx,
  ) {
    const root =
      requireRoot(ctx);

    const command =
      typeof input.command ===
      'string'
        ? input.command.trim()
        : '';

    if (!command) {
      throw new Error(
        '"command" is required.',
      );
    }

    const classification =
      classifyCommand(
        command,
      );

    let timeoutMs =
      typeof input.timeoutMs ===
        'number' &&
      Number.isFinite(
        input.timeoutMs,
      )
        ? Math.floor(
            input.timeoutMs,
          )
        : 60_000;

    timeoutMs =
      Math.max(
        1_000,
        Math.min(
          timeoutMs,
          120_000,
        ),
      );

    const result =
      await runProcess(
        command,
        undefined,
        {
          cwd: root,
          timeoutMs,
          signal:
            ctx.signal,

          /*
           * This is the only intentionally free-form shell path.
           */
          useShell: true,
        },
      );

    return {
      ...result,

      classifiedAs:
        classification.tier,

      executable:
        classification.executable,
    };
  },
};

/**
 * Git inspection is deliberately narrower than arbitrary `git <subcommand>
 * ...args>`.
 *
 * Some commands that appear read-only can mutate when certain flags are
 * supplied, so each supported operation is constrained separately.
 */
const GIT_OPERATIONS = [
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'ls-files',
  'rev-parse',
  'describe',
  'shortlog',
] as const;

type GitOperation =
  (typeof GIT_OPERATIONS)[number];

/**
 * Flags that can write files, invoke external helpers, or substantially alter
 * execution behavior are not accepted through the read-only git tool.
 */
const FORBIDDEN_GIT_ARGUMENTS = [
  '--output',
  '--output=',
  '--ext-diff',
  '--textconv',
  '--exec',
  '--format-patch',
  '--patch-with-raw-output',
];

function validateGitArguments(
  operation: GitOperation,
  args: string[],
): void {
  for (const arg of args) {
    if (
      arg.includes('\0') ||
      arg.includes('\r') ||
      arg.includes('\n')
    ) {
      throw new Error(
        'Git arguments may not contain control characters.',
      );
    }

    for (
      const forbidden of
      FORBIDDEN_GIT_ARGUMENTS
    ) {
      if (
        forbidden.endsWith(
          '=',
        )
          ? arg.startsWith(
              forbidden,
            )
          : arg ===
            forbidden
      ) {
        throw new Error(
          `Argument "${arg}" is not permitted by the read-only git tool.`,
        );
      }
    }
  }

  /*
   * rev-parse is useful for repository inspection, but flags that ask Git for
   * paths outside the work tree are intentionally excluded here.
   */
  if (
    operation ===
    'rev-parse'
  ) {
    const blocked =
      new Set([
        '--git-path',
        '--path-format',
      ]);

    for (
      const arg of args
    ) {
      if (
        blocked.has(arg) ||
        arg.startsWith(
          '--git-path=',
        ) ||
        arg.startsWith(
          '--path-format=',
        )
      ) {
        throw new Error(
          `Argument "${arg}" is not permitted for read-only rev-parse.`,
        );
      }
    }
  }
}

export const gitTool: ToolDefinition = {
  name: 'git.run',

  description:
    'Run a constrained read-only Git inspection command in the selected workspace. ' +
    'Commands are passed directly to Git without a shell.',

  inputSchema: {
    type: 'object',

    properties: {
      subcommand: {
        type: 'string',
        enum:
          GIT_OPERATIONS,

        description:
          `One of: ${GIT_OPERATIONS.join(', ')}`,
      },

      args: {
        type: 'array',

        maxItems: 50,

        items: {
          type: 'string',
          maxLength: 1_000,
        },

        description:
          'Additional arguments for the selected read-only operation.',
      },
    },

    required: [
      'subcommand',
    ],

    additionalProperties:
      false,
  },

  permissionTier: 'safe',

  requiresRead: true,

  requiresShell: true,

  timeoutMs: 30_000,

  async execute(
    input,
    ctx,
  ) {
    const root =
      requireRoot(ctx);

    const requested =
      typeof input.subcommand ===
      'string'
        ? input.subcommand.trim()
        : '';

    if (
      !GIT_OPERATIONS.includes(
        requested as GitOperation,
      )
    ) {
      throw new Error(
        `Unsupported Git operation "${requested}".`,
      );
    }

    const operation =
      requested as GitOperation;

    const args =
      Array.isArray(
        input.args,
      )
        ? input.args.filter(
            (
              value,
            ): value is string =>
              typeof value ===
              'string',
          )
        : [];

    validateGitArguments(
      operation,
      args,
    );

    /*
     * Disable external diff/text conversion behavior where applicable.
     *
     * These protections are supplied by us rather than controlled by the
     * model-supplied argument list.
     */
    const hardeningArgs =
      operation === 'diff' ||
      operation === 'show' ||
      operation === 'log'
        ? [
            '--no-ext-diff',
            '--no-textconv',
          ]
        : [];

    return runProcess(
      'git',
      [
        operation,
        ...hardeningArgs,
        ...args,
      ],
      {
        cwd: root,
        timeoutMs:
          30_000,

        signal:
          ctx.signal,

        useShell:
          false,
      },
    );
  },
};

/**
 * Fixed project verification commands.
 *
 * These are intentionally enumerated rather than accepting arbitrary commands
 * or arguments.
 */
const TEST_COMMANDS: Record<
  string,
  {
    file: string;
    args: string[];
  }
> = {
  'pnpm test': {
    file: 'pnpm',
    args: ['test'],
  },

  'pnpm typecheck': {
    file: 'pnpm',
    args: ['typecheck'],
  },

  'pnpm build': {
    file: 'pnpm',
    args: ['build'],
  },

  'pnpm lint': {
    file: 'pnpm',
    args: ['lint'],
  },

  'npm test': {
    file: 'npm',
    args: ['test'],
  },

  'npm run build': {
    file: 'npm',
    args: [
      'run',
      'build',
    ],
  },

  'yarn test': {
    file: 'yarn',
    args: ['test'],
  },

  'cargo test': {
    file: 'cargo',
    args: ['test'],
  },

  'go test': {
    file: 'go',
    args: [
      'test',
      './...',
    ],
  },

  pytest: {
    file: 'pytest',
    args: [],
  },
};

/**
 * Best-effort counts from common test runners.
 *
 * If a runner cannot be recognized, the caller still receives the exit code.
 */
export function parseTestCounts(
  output: string,
):
  | {
      passed: number;
      failed: number;
      skipped: number;
    }
  | undefined {
  const vitest =
    /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/i.exec(
      output,
    );

  if (vitest) {
    return {
      passed:
        Number(
          vitest[2],
        ),

      failed:
        Number(
          vitest[1] ??
            0,
        ),

      skipped: 0,
    };
  }

  const jest =
    /Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed/i.exec(
      output,
    );

  if (jest) {
    return {
      passed:
        Number(
          jest[3],
        ),

      failed:
        Number(
          jest[1] ??
            0,
        ),

      skipped:
        Number(
          jest[2] ??
            0,
        ),
    };
  }

  /*
   * Pytest commonly emits result components in different orders. Parse the
   * individual counters instead of assuming one exact summary layout.
   */
  const pytestPassed =
    /(\d+)\s+passed/i.exec(
      output,
    );

  if (pytestPassed) {
    const pytestFailed =
      /(\d+)\s+failed/i.exec(
        output,
      );

    const pytestSkipped =
      /(\d+)\s+skipped/i.exec(
        output,
      );

    return {
      passed:
        Number(
          pytestPassed[1],
        ),

      failed:
        Number(
          pytestFailed?.[1] ??
            0,
        ),

      skipped:
        Number(
          pytestSkipped?.[1] ??
            0,
        ),
    };
  }

  return undefined;
}

export const testTool: ToolDefinition = {
  name: 'tests.run',

  description:
    'Run one approved project test, typecheck, build, or lint command and return objective process results.',

  inputSchema: {
    type: 'object',

    properties: {
      command: {
        type: 'string',
        enum:
          Object.keys(
            TEST_COMMANDS,
          ),

        description:
          `One of: ${Object.keys(
            TEST_COMMANDS,
          ).join(', ')}`,
      },
    },

    required: [
      'command',
    ],

    additionalProperties:
      false,
  },

  /*
   * Test/build scripts execute repository-controlled code and therefore are not
   * treated as equivalent to passive file inspection.
   */
  permissionTier: 'mutation',

  requiresRead: true,

  requiresWrite: true,

  requiresShell: true,

  timeoutMs: 600_000,

  async execute(
    input,
    ctx,
  ) {
    const root =
      requireRoot(ctx);

    const requested =
      typeof input.command ===
      'string'
        ? input.command.trim()
        : '';

    const known =
      TEST_COMMANDS[
        requested
      ];

    if (!known) {
      throw new Error(
        `Unknown test command "${requested}". Permitted: ${Object.keys(
          TEST_COMMANDS,
        ).join(', ')}.`,
      );
    }

    const result =
      await runProcess(
        known.file,
        known.args,
        {
          cwd: root,

          timeoutMs:
            600_000,

          signal:
            ctx.signal,

          /*
           * Windows package-manager shims may require command-shell resolution.
           * The executable and argv here are fixed by TEST_COMMANDS rather than
           * supplied by the model.
           */
          useShell:
            process.platform ===
            'win32',
        },
      );

    const combined =
      `${result.stdout}\n${result.stderr}`;

    return {
      ...result,

      command:
        requested,

      passed:
        !result.timedOut &&
        !result.cancelled &&
        result.exitCode ===
          0,

      testCounts:
        parseTestCounts(
          combined,
        ),
    };
  },
};

export const SHELL_TOOLS: ToolDefinition[] = [
  shellRunTool,
  gitTool,
  testTool,
  systemNetworkInfoTool,
];

/**
 * Passive shell-adjacent inspection tools only.
 *
 * No project scripts or arbitrary command lines are included.
 */
export const READ_ONLY_SHELL_TOOLS: ToolDefinition[] = [
  gitTool,
  systemNetworkInfoTool,
];
