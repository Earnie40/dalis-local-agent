import { resolve } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { runProcess } from './shell-tools';

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('This tool requires an active workspace root.');
  return resolve(ctx.workspaceRoot);
}

function safeBranch(value: unknown): string {
  const branch = String(value ?? '').trim();
  if (
    !branch ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    // eslint-disable-next-line no-control-regex -- intentionally rejects control chars (\x00-\x1f) to block crafted/injected branch names
    /[\s~^:?*[\\\x00-\x1f]/.test(branch)
  ) throw new Error('Unsafe branch name.');
  return branch;
}

function safePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('paths must contain at least one repository-relative path.');
  const paths = value.map((item) => String(item));
  for (const path of paths) {
    if (
      !path ||
      path.startsWith('-') ||
      path.startsWith(':') ||
      path.includes('\0') ||
      path.includes('\r') ||
      path.includes('\n') ||
      path.replace(/\\/g, '/').split('/').includes('..')
    ) throw new Error(`Unsafe Git pathspec "${path}".`);
  }
  return paths.slice(0, 100);
}

export const gitBranchCreateTool: ToolDefinition = {
  name: 'git.branch.create',
  description: 'Create a new local branch without switching worktrees.',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', minLength: 1, maxLength: 180 },
      startPoint: { type: 'string', minLength: 1, maxLength: 180 },
    },
    required: ['branch'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 20_000,
  async execute(input, ctx) {
    const args = ['branch', safeBranch(input.branch)];
    if (typeof input.startPoint === 'string' && input.startPoint.trim()) {
      const start = input.startPoint.trim();
      if (start.startsWith('-') || /[\r\n\0]/.test(start)) throw new Error('Unsafe startPoint.');
      args.push(start);
    }
    return runProcess('git', args, { cwd: requireRoot(ctx), timeoutMs: 20_000, signal: ctx.signal, useShell: false });
  },
};

export const gitStageTool: ToolDefinition = {
  name: 'git.stage',
  description: 'Stage only explicitly named repository-relative paths.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 500 } },
    },
    required: ['paths'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 30_000,
  async execute(input, ctx) {
    return runProcess('git', ['add', '--', ...safePaths(input.paths)], {
      cwd: requireRoot(ctx), timeoutMs: 30_000, signal: ctx.signal, useShell: false,
    });
  },
};

export const gitCommitTool: ToolDefinition = {
  name: 'git.commit',
  description: 'Create a local Git commit from already staged changes. Does not push.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', minLength: 1, maxLength: 300 } },
    required: ['message'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 60_000,
  async execute(input, ctx) {
    const message = String(input.message ?? '').trim();
    if (!message || /[\0\r\n]/.test(message)) throw new Error('Commit message must be one line without control characters.');
    return runProcess('git', ['commit', '-m', message], {
      cwd: requireRoot(ctx), timeoutMs: 60_000, signal: ctx.signal, useShell: false,
    });
  },
};

export const gitPushCurrentTool: ToolDefinition = {
  name: 'git.push.current',
  description: 'Push only the current branch (HEAD) to origin and set upstream. Never force-pushes.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'high-impact',
  requiresWrite: true,
  requiresShell: true,
  requiresNetwork: true,
  timeoutMs: 120_000,
  async execute(_input, ctx) {
    return runProcess('git', ['push', '-u', 'origin', 'HEAD'], {
      cwd: requireRoot(ctx), timeoutMs: 120_000, signal: ctx.signal, useShell: false,
    });
  },
};

export const githubPrChecksTool: ToolDefinition = {
  name: 'github.pr.checks',
  description: 'Read GitHub checks for the pull request associated with the current branch using authenticated gh CLI.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'safe',
  requiresShell: true,
  requiresNetwork: true,
  timeoutMs: 60_000,
  async execute(_input, ctx) {
    return runProcess('gh', ['pr', 'checks'], {
      cwd: requireRoot(ctx), timeoutMs: 60_000, signal: ctx.signal, useShell: false,
    });
  },
};

export const githubPrCreateTool: ToolDefinition = {
  name: 'github.pr.create',
  description: 'Open a GitHub pull request for the current pushed branch using authenticated gh CLI. Draft by default.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 250 },
      body: { type: 'string', maxLength: 8000 },
      base: { type: 'string', minLength: 1, maxLength: 120 },
      draft: { type: 'boolean' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  permissionTier: 'high-impact',
  requiresWrite: true,
  requiresShell: true,
  requiresNetwork: true,
  timeoutMs: 120_000,
  async execute(input, ctx) {
    const title = String(input.title ?? '').trim();
    if (!title || /[\0\r\n]/.test(title)) throw new Error('PR title must be one line.');
    const args = ['pr', 'create', '--title', title, '--body', String(input.body ?? '')];
    if (typeof input.base === 'string' && input.base.trim()) args.push('--base', safeBranch(input.base));
    if (input.draft !== false) args.push('--draft');
    return runProcess('gh', args, {
      cwd: requireRoot(ctx), timeoutMs: 120_000, signal: ctx.signal, useShell: false,
    });
  },
};

export const GIT_MUTATION_TOOLS: ToolDefinition[] = [
  gitBranchCreateTool,
  gitStageTool,
  gitCommitTool,
  gitPushCurrentTool,
];

export const GITHUB_TOOLS: ToolDefinition[] = [
  githubPrChecksTool,
  githubPrCreateTool,
];
