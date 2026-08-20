import type {
  CommandClassification,
  PermissionTier,
} from './types';

/**
 * Lightweight classifier tokenizer.
 *
 * This is intentionally not treated as a complete shell parser. It understands
 * ordinary single/double quoting well enough for classification, while more
 * complicated shell syntax is escalated before operation classification.
 */
export function tokenize(
  command: string,
): string[] {
  const tokens: string[] = [];

  let current = '';
  let quote:
    | '"'
    | "'"
    | undefined;

  let escaped = false;

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (
    let index = 0;
    index < command.length;
    index += 1
  ) {
    const char =
      command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (
      char === '\\' &&
      quote === '"'
    ) {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }

      continue;
    }

    if (
      char === '"' ||
      char === "'"
    ) {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
  }

  flush();

  return tokens;
}

/**
 * Detect shell syntax whose behavior cannot safely be described by classifying
 * one executable/subcommand pair.
 *
 * Detection is quote-aware:
 *
 * - control characters inside single-quoted data are ignored
 * - ordinary quoted JSON does not become a command chain
 * - command/environment expansion remains elevated because it can hide the
 *   effective executable, arguments, or target
 */
function containsComplexShellSyntax(
  command: string,
): boolean {
  let quote:
    | '"'
    | "'"
    | undefined;

  let escaped = false;

  for (
    let index = 0;
    index < command.length;
    index += 1
  ) {
    const char =
      command[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (
      char === '\\' &&
      quote === '"'
    ) {
      escaped = true;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }

      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        continue;
      }

      /*
       * Command substitution remains active inside double quotes in common
       * shells.
       */
      if (
        char === '`' ||
        char === '$'
      ) {
        return true;
      }

      continue;
    }

    if (
      char === '"' ||
      char === "'"
    ) {
      quote = char;
      continue;
    }

    /*
     * Shell chaining, redirection, grouping, command substitution, and
     * environment expansion.
     */
    if (
      char === ';' ||
      char === '&' ||
      char === '|' ||
      char === '<' ||
      char === '>' ||
      char === '`' ||
      char === '$' ||
      char === '(' ||
      char === ')' ||
      char === '{' ||
      char === '}'
    ) {
      return true;
    }

    /*
     * cmd.exe environment-variable expansion can similarly hide effective
     * arguments.
     */
    if (
      char === '%' &&
      command.indexOf(
        '%',
        index + 1,
      ) !== -1
    ) {
      return true;
    }
  }

  /*
   * Unterminated quoting is ambiguous rather than safe.
   */
  return quote !== undefined;
}

/**
 * Commands whose non-mutating behavior can be confidently determined from a
 * fixed subcommand.
 *
 * Operations such as git branch/remote/tag are intentionally excluded because
 * their behavior changes from read-only to mutating based on arguments.
 */
const SAFE_OPERATIONS:
  Record<
    string,
    Set<string>
  > = {
  git: new Set([
    'status',
    'diff',
    'log',
    'show',
    'blame',
    'ls-files',
    'rev-parse',
    'describe',
    'shortlog',
  ]),

  npm: new Set([
    'ls',
    'why',
  ]),

  pnpm: new Set([
    'ls',
    'why',
  ]),
};

/**
 * Whole executables considered observational when their arguments stay within
 * the workspace and do not contain command/control syntax.
 *
 * `find` and `fd` are deliberately omitted because variants/options exist that
 * can execute another command.
 */
const SAFE_EXECUTABLES =
  new Set([
    'ls',
    'dir',

    'cat',
    'type',

    'head',
    'tail',

    'wc',

    'grep',
    'rg',

    'which',
    'where',

    'echo',
    'pwd',
    'whoami',
    'date',

    'tree',
    'stat',
    'du',
    'df',
  ]);

/**
 * Executables for which only a version query is automatically read-only.
 */
const VERSION_EXECUTABLES =
  new Set([
    'node',
    'python',
    'python3',

    'npm',
    'pnpm',
    'yarn',

    'git',

    'cargo',
    'go',
    'dotnet',
  ]);

const VERSION_FLAGS =
  new Set([
    '--version',
    '-v',
    '-V',
  ]);

/**
 * Normal project-local execution.
 *
 * These commands can modify generated state or execute repository-controlled
 * code, so they are not `safe`, but they are distinct from externally-facing
 * or destructive operations.
 */
const MUTATION_OPERATIONS:
  Record<
    string,
    Set<string>
  > = {
  git: new Set([
    'add',
    'commit',
    'checkout',
    'switch',
    'restore',
    'stash',
    'merge',
    'tag',
    'init',
  ]),

  npm: new Set([
    'run',
    'test',
    'build',
  ]),

  pnpm: new Set([
    'run',
    'test',
    'build',
  ]),

  yarn: new Set([
    'run',
    'test',
    'build',
  ]),

  cargo: new Set([
    'build',
    'test',
    'check',
    'fmt',
    'clippy',
  ]),

  go: new Set([
    'build',
    'test',
    'run',
    'vet',
    'fmt',
  ]),

  dotnet: new Set([
    'build',
    'test',
  ]),

  make:
    new Set(),

  pytest:
    new Set(),

  vitest:
    new Set(),

  jest:
    new Set(),

  tsc:
    new Set(),
};

/**
 * Executables that inherently cross a stronger trust boundary or commonly
 * perform destructive, credential-sensitive, privileged, or external-facing
 * work.
 *
 * They always require elevated authorization regardless of arguments.
 */
const HIGH_IMPACT_EXECUTABLES =
  new Set([
    /*
     * Filesystem / system mutation.
     */
    'rm',
    'rmdir',
    'del',
    'erase',

    'format',
    'mkfs',
    'diskpart',
    'fdisk',

    'shutdown',
    'reboot',

    'kill',
    'taskkill',
    'killall',

    'chmod',
    'chown',
    'icacls',
    'takeown',

    /*
     * Privilege changes.
     */
    'runas',
    'sudo',
    'su',

    /*
     * Direct network clients.
     */
    'curl',
    'wget',
    'iwr',
    'invoke-webrequest',

    'ssh',
    'scp',
    'sftp',
    'rsync',

    'nc',
    'ncat',
    'telnet',

    /*
     * Dynamic shell/code execution helpers.
     */
    'invoke-expression',
    'iex',

    /*
     * Infrastructure / cloud control planes.
     */
    'terraform',
    'kubectl',
    'helm',

    'aws',
    'az',
    'gcloud',

    'doctl',
    'flyctl',

    'vercel',
    'netlify',

    /*
     * Database clients.
     */
    'psql',
    'mysql',
    'mongo',
    'mongosh',
    'redis-cli',
    'sqlcmd',

    /*
     * Container daemon access.
     *
     * Even apparently read-only Docker operations communicate with a privileged
     * daemon and can expose environment/log information, so they do not belong
     * in the auto-approved shell class.
     */
    'docker',

    /*
     * Credential / package-publication tooling.
     */
    'npm-publish',

    'gpg',
    'openssl',
    'keytool',
    'certutil',
  ]);

/**
 * Operations whose impact is high even though the executable itself also has
 * lower-impact local operations.
 */
const HIGH_IMPACT_OPERATIONS:
  Record<
    string,
    Set<string>
  > = {
  git: new Set([
    /*
     * External/network operations.
     */
    'push',
    'pull',
    'fetch',

    /*
     * History/destructive operations.
     */
    'reset',
    'clean',
    'rebase',

    'filter-branch',
    'filter-repo',

    'gc',
    'prune',
    'reflog',
  ]),

  npm: new Set([
    /*
     * Network/package lifecycle operations.
     */
    'install',
    'ci',

    'publish',
    'unpublish',
    'deprecate',

    'owner',
    'token',

    'login',
    'adduser',

    'view',
    'outdated',
  ]),

  pnpm: new Set([
    'install',
    'add',
    'remove',

    'publish',
    'outdated',
  ]),

  yarn: new Set([
    'install',
    'add',
    'remove',
    'publish',
  ]),

  cargo: new Set([
    'publish',
    'yank',
    'login',
  ]),
};

/**
 * Global argument-level escalation indicators.
 *
 * These are deliberately limited to flags whose meaning is consistently
 * associated with bypassing protections or broad/destructive effects.
 *
 * Short flags such as `-r` and `-f` are NOT globally elevated because their
 * meaning varies dramatically between executables.
 */
const DANGEROUS_FLAGS:
  Array<{
    flag: RegExp;
    reason: string;
  }> = [
  {
    flag:
      /^--force$/i,

    reason:
      'force flag',
  },

  {
    flag:
      /^--force-with-lease$/i,

    reason:
      'force-update flag',
  },

  {
    flag:
      /^--hard$/i,

    reason:
      'hard reset mode',
  },

  {
    flag:
      /^--no-verify$/i,

    reason:
      'bypasses verification hooks',
  },

  {
    flag:
      /^--delete$/i,

    reason:
      'delete mode',
  },

  {
    flag:
      /^--prune$/i,

    reason:
      'pruning operation',
  },

  {
    flag:
      /^--assume-yes$/i,

    reason:
      'suppresses confirmation',
  },
];

/**
 * Arguments that allow Git inspection commands to invoke external helpers or
 * write output are elevated rather than considered passive inspection.
 */
const GIT_INSPECTION_ESCALATIONS =
  [
    /^--ext-diff$/i,
    /^--textconv$/i,

    /^--output$/i,
    /^--output=/i,

    /^--exec$/i,
    /^--exec=/i,

    /^--git-path$/i,
    /^--git-path=/i,
  ];

/**
 * Residual high-risk patterns.
 *
 * Pattern matching is supplementary only. Primary classification remains based
 * on executable + operation.
 */
const HIGH_RISK_PATTERNS:
  Array<{
    pattern: RegExp;
    reason: string;
  }> = [
  {
    pattern:
      /\bdrop\s+(table|database|schema)\b/i,

    reason:
      'destructive database statement',
  },

  {
    pattern:
      /\btruncate\s+table\b/i,

    reason:
      'destructive database statement',
  },

  {
    pattern:
      /remove-item\b.*\b-recurse\b/i,

    reason:
      'recursive PowerShell deletion',
  },

  {
    pattern:
      /\bformat\s+[a-z]:/i,

    reason:
      'disk format operation',
  },

  {
    pattern:
      /:\(\)\s*\{.*\}\s*:/,

    reason:
      'process-exhaustion pattern',
  },

  {
    pattern:
      /\b(id_rsa|id_ed25519|known_hosts|authorized_keys)\b/i,

    reason:
      'SSH credential material',
  },

  {
    pattern:
      /(?:^|[\\/])\.ssh(?:[\\/]|$)/i,

    reason:
      'SSH credential directory',
  },

  {
    pattern:
      /(?:^|[\\/])\.aws[\\/]credentials\b/i,

    reason:
      'cloud credential material',
  },

  {
    pattern:
      /(?:^|[\\/])\.npmrc\b/i,

    reason:
      'package-registry credential material',
  },

  {
    pattern:
      /(?:^|[\\/])\.env(?:\.|$)/i,

    reason:
      'environment/credential material',
  },
];

export const TIER_ORDER:
  Record<
    PermissionTier,
    number
  > = {
  safe: 0,
  mutation: 1,
  'high-impact': 2,
};

function maxTier(
  a: PermissionTier,
  b: PermissionTier,
): PermissionTier {
  return TIER_ORDER[a] >=
    TIER_ORDER[b]
    ? a
    : b;
}

function normalizeExecutable(
  raw: string,
): string {
  const base =
    raw
      .split(/[\\/]/)
      .pop() ??
    raw;

  return base
    .replace(
      /\.(exe|cmd|bat|ps1)$/i,
      '',
    )
    .toLowerCase();
}

/**
 * Determine the first ordinary positional argument.
 *
 * This works for the common subcommand-style CLIs handled here.
 *
 * Commands with global options that consume separate values before their
 * operation are intentionally likely to fall into unknown/high-impact rather
 * than being guessed safe.
 */
function findOperation(
  args: string[],
): string | undefined {
  return args
    .find(
      (arg) =>
        !arg.startsWith(
          '-',
        ),
    )
    ?.toLowerCase();
}

function isVersionQuery(
  executable: string,
  args: string[],
): boolean {
  if (
    !VERSION_EXECUTABLES.has(
      executable,
    )
  ) {
    return false;
  }

  if (
    args.length !== 1
  ) {
    return false;
  }

  return VERSION_FLAGS.has(
    args[0],
  );
}

/**
 * git branch can either list or mutate branches.
 *
 * Only the no-argument listing form is auto-classified as read-only.
 */
function isReadOnlyGitBranch(
  args: string[],
): boolean {
  return (
    args.length === 1 &&
    args[0].toLowerCase() ===
      'branch'
  );
}

/**
 * git remote with no extra argument lists remotes.
 *
 * `-v` / `--verbose` are also observational.
 *
 * add/remove/set-url/etc. are not.
 */
function isReadOnlyGitRemote(
  args: string[],
): boolean {
  if (
    args.length === 1 &&
    args[0].toLowerCase() ===
      'remote'
  ) {
    return true;
  }

  return (
    args.length === 2 &&
    args[0].toLowerCase() ===
      'remote' &&
    (
      args[1] === '-v' ||
      args[1] === '--verbose'
    )
  );
}

/**
 * Plain `git tag` lists tags.
 *
 * Creating, deleting, signing, or changing tags is not classified as safe.
 */
function isReadOnlyGitTag(
  args: string[],
): boolean {
  if (
    args.length === 1 &&
    args[0].toLowerCase() ===
      'tag'
  ) {
    return true;
  }

  return (
    args.length === 2 &&
    args[0].toLowerCase() ===
      'tag' &&
    (
      args[1] === '--list' ||
      args[1] === '-l'
    )
  );
}

/**
 * Shell cwd does not create a filesystem sandbox.
 *
 * An otherwise read-only utility can still inspect files outside the selected
 * workspace if it receives an absolute, home-relative, UNC, or parent-traversal
 * path.
 *
 * Such requests are therefore elevated for explicit authorization.
 */
function containsExternalPathReference(
  args: string[],
): boolean {
  for (
    const arg of args
  ) {
    if (
      arg.startsWith('-')
    ) {
      continue;
    }

    /*
     * POSIX absolute / home-relative.
     */
    if (
      arg.startsWith('/') ||
      arg === '~' ||
      arg.startsWith('~/') ||
      arg.startsWith('~\\')
    ) {
      return true;
    }

    /*
     * Windows drive / UNC paths.
     */
    if (
      /^[a-z]:[\\/]/i.test(
        arg,
      ) ||
      /^\\\\/.test(arg)
    ) {
      return true;
    }

    const normalized =
      arg.replace(
        /\\/g,
        '/',
      );

    if (
      normalized
        .split('/')
        .includes('..')
    ) {
      return true;
    }
  }

  return false;
}

function containsGitInspectionEscalation(
  executable: string,
  operation:
    | string
    | undefined,
  args: string[],
): string | undefined {
  if (
    executable !== 'git' ||
    !operation ||
    !SAFE_OPERATIONS.git.has(
      operation,
    )
  ) {
    return undefined;
  }

  for (
    const arg of args
  ) {
    const hit =
      GIT_INSPECTION_ESCALATIONS.find(
        (pattern) =>
          pattern.test(arg),
      );

    if (hit) {
      return arg;
    }
  }

  return undefined;
}

/**
 * Classify a shell command through layered analysis.
 *
 * Important:
 *
 * This classifier is an authorization signal, not a sandbox.
 *
 * Unknown or ambiguous behavior always escalates to high-impact. A caller must
 * never treat failure to recognize danger as proof that a command is safe.
 */
export function classifyCommand(
  command: string,
): CommandClassification {
  const trimmed =
    command.trim();

  if (!trimmed) {
    return {
      tier:
        'high-impact',

      executable: '',

      reason:
        'Empty command.',

      layer:
        'unknown-operation',
    };
  }

  if (
    containsComplexShellSyntax(
      trimmed,
    )
  ) {
    const tokens =
      tokenize(trimmed);

    return {
      tier:
        'high-impact',

      executable:
        normalizeExecutable(
          tokens[0] ??
            '',
        ),

      reason:
        'Command contains shell chaining, redirection, grouping, substitution, expansion, or ambiguous quoting.',

      layer:
        'argument-analysis',
    };
  }

  const tokens =
    tokenize(trimmed);

  const executable =
    normalizeExecutable(
      tokens[0] ??
        '',
    );

  const args =
    tokens.slice(1);

  if (!executable) {
    return {
      tier:
        'high-impact',

      executable: '',

      reason:
        'Unable to determine executable.',

      layer:
        'unknown-operation',
    };
  }

  const operation =
    findOperation(
      args,
    );

  let tier:
    PermissionTier;

  let reason:
    string;

  let layer:
    CommandClassification['layer'] =
    'operation-classification';

  /*
   * High-impact executable always wins.
   */
  if (
    HIGH_IMPACT_EXECUTABLES.has(
      executable,
    )
  ) {
    tier =
      'high-impact';

    reason =
      `"${executable}" crosses a privileged, destructive, credential-sensitive, or external execution boundary.`;
  }

  /*
   * Explicit version queries are passive.
   */
  else if (
    isVersionQuery(
      executable,
      args,
    )
  ) {
    tier =
      'safe';

    reason =
      `"${executable} ${args[0]}" only reports tool version information.`;
  }

  /*
   * Conditional Git commands.
   */
  else if (
    executable === 'git' &&
    isReadOnlyGitBranch(
      args,
    )
  ) {
    tier =
      'safe';

    reason =
      '"git branch" without additional arguments only lists local branches.';
  }

  else if (
    executable === 'git' &&
    isReadOnlyGitRemote(
      args,
    )
  ) {
    tier =
      'safe';

    reason =
      '"git remote" is being used only to inspect configured remotes.';
  }

  else if (
    executable === 'git' &&
    isReadOnlyGitTag(
      args,
    )
  ) {
    tier =
      'safe';

    reason =
      '"git tag" is being used only to list tags.';
  }

  /*
   * Explicitly high-impact operation.
   */
  else if (
    operation &&
    HIGH_IMPACT_OPERATIONS[
      executable
    ]?.has(
      operation,
    )
  ) {
    tier =
      'high-impact';

    reason =
      `"${executable} ${operation}" performs network-facing, destructive, publication, credential, or history-changing work.`;
  }

  /*
   * Explicit read-only operation.
   */
  else if (
    operation &&
    SAFE_OPERATIONS[
      executable
    ]?.has(
      operation,
    )
  ) {
    tier =
      'safe';

    reason =
      `"${executable} ${operation}" is classified as observational.`;
  }

  /*
   * Whole executable considered observational.
   */
  else if (
    SAFE_EXECUTABLES.has(
      executable,
    )
  ) {
    tier =
      'safe';

    reason =
      `"${executable}" is classified as observational.`;
  }

  /*
   * Known project mutation.
   */
  else if (
    Object.prototype.hasOwnProperty.call(
      MUTATION_OPERATIONS,
      executable,
    )
  ) {
    const known =
      MUTATION_OPERATIONS[
        executable
      ];

    if (
      known.size === 0 ||
      (
        operation !==
          undefined &&
        known.has(
          operation,
        )
      )
    ) {
      tier =
        'mutation';

      reason =
        `"${executable}${operation ? ` ${operation}` : ''}" may execute project code or modify project-local state.`;
    } else {
      tier =
        'high-impact';

      reason =
        `"${executable} ${operation ?? ''}" is not a recognized operation for this executable.`;

      layer =
        'unknown-operation';
    }
  }

  /*
   * Unknown always fails upward.
   */
  else {
    tier =
      'high-impact';

    reason =
      `"${executable}" is not a recognized executable.`;

    layer =
      'unknown-operation';
  }

  /*
   * A passive shell utility can still reach outside the workspace because cwd
   * is not filesystem isolation.
   */
  if (
    tier === 'safe' &&
    SAFE_EXECUTABLES.has(
      executable,
    ) &&
    containsExternalPathReference(
      args,
    )
  ) {
    tier =
      'high-impact';

    reason =
      `${reason} Escalated because an absolute, home-relative, UNC, or parent-traversal path may leave the selected workspace.`;

    layer =
      'argument-analysis';
  }

  /*
   * Git inspection helpers can invoke external behavior or produce output files
   * under certain flags.
   */
  const gitEscalation =
    containsGitInspectionEscalation(
      executable,
      operation,
      args,
    );

  if (
    gitEscalation &&
    tier !==
      'high-impact'
  ) {
    tier =
      'high-impact';

    reason =
      `${reason} Escalated because "${gitEscalation}" changes the behavior of an otherwise observational Git command.`;

    layer =
      'argument-analysis';
  }

  /*
   * Global high-impact flags.
   */
  for (
    const arg of args
  ) {
    const hit =
      DANGEROUS_FLAGS.find(
        ({ flag }) =>
          flag.test(arg),
      );

    if (
      hit &&
      tier !==
        'high-impact'
    ) {
      tier =
        maxTier(
          tier,
          'high-impact',
        );

      reason =
        `${reason} Escalated: ${hit.reason} (${arg}).`;

      layer =
        'argument-analysis';

      break;
    }
  }

  /*
   * Supplementary whole-command pattern analysis.
   */
  for (
    const {
      pattern,
      reason:
        patternReason,
    } of HIGH_RISK_PATTERNS
  ) {
    if (
      pattern.test(
        trimmed,
      ) &&
      tier !==
        'high-impact'
    ) {
      tier =
        'high-impact';

      reason =
        `${reason} Escalated by pattern: ${patternReason}.`;

      layer =
        'pattern-escalation';

      break;
    }
  }

  return {
    tier,
    executable,
    operation,
    reason,
    layer,
  };
}