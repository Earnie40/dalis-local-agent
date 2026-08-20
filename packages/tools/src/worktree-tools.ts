import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { runProcess } from './shell-tools';

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('This tool requires an active workspace root.');
  return resolve(ctx.workspaceRoot);
}

function slug(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!normalized) throw new Error('name must contain letters or numbers.');
  return normalized;
}

function safeBranch(value: string): string {
  if (
    !value ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.includes('@{') ||
    // eslint-disable-next-line no-control-regex -- intentionally rejects control chars (\x00-\x1f) to block crafted/injected branch names
    /[\s~^:?*[\\\x00-\x1f]/.test(value)
  ) {
    throw new Error(`Unsafe Git branch name "${value}".`);
  }
  return value;
}

function worktreeTarget(root: string, name: string): { base: string; target: string } {
  const base = resolve(root, '.dacai', 'worktrees');
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Worktree path escaped .dacai/worktrees.');
  }
  return { base, target };
}

export const gitWorktreeListTool: ToolDefinition = {
  name: 'git.worktree.list',
  description: 'List Git worktrees for the active repository using porcelain output.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  permissionTier: 'safe',
  requiresShell: true,
  timeoutMs: 20_000,
  async execute(_input, ctx) {
    return runProcess('git', ['worktree', 'list', '--porcelain'], {
      cwd: requireRoot(ctx),
      timeoutMs: 20_000,
      signal: ctx.signal,
      useShell: false,
    });
  },
};

export const gitWorktreeCreateTool: ToolDefinition = {
  name: 'git.worktree.create',
  description:
    'Create an isolated Git worktree below .dacai/worktrees on a new dacai/* branch. ' +
    'Use for independent mutating subagent work.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 },
      branch: { type: 'string', minLength: 1, maxLength: 180 },
      baseRef: { type: 'string', minLength: 1, maxLength: 180 },
    },
    required: ['name'],
    additionalProperties: false,
  },
  permissionTier: 'mutation',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 60_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const name = slug(input.name);
    const { base, target } = worktreeTarget(root, name);
    await mkdir(base, { recursive: true });

    try {
      await stat(target);
      throw new Error(`Worktree destination already exists: ${target}`);
    } catch (error) {
      if (error instanceof Error && !('code' in error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const branch = safeBranch(
      typeof input.branch === 'string' && input.branch.trim()
        ? input.branch.trim()
        : `dacai/${name}-${Date.now().toString(36)}`,
    );
    const baseRef = typeof input.baseRef === 'string' && input.baseRef.trim() ? input.baseRef.trim() : 'HEAD';
    if (baseRef.startsWith('-') || /[\r\n\0]/.test(baseRef)) throw new Error('Unsafe baseRef.');

    const result = await runProcess('git', ['worktree', 'add', '-b', branch, target, baseRef], {
      cwd: root,
      timeoutMs: 60_000,
      signal: ctx.signal,
      useShell: false,
    });
    if (result.exitCode !== 0) return result;
    return { ...result, name, branch, path: target, baseRef };
  },
};

export const gitWorktreeRemoveTool: ToolDefinition = {
  name: 'git.worktree.remove',
  description:
    'Remove a clean DACAIS-managed worktree below .dacai/worktrees. This does not force removal and does not delete the branch.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
    required: ['name'],
    additionalProperties: false,
  },
  permissionTier: 'high-impact',
  requiresWrite: true,
  requiresShell: true,
  timeoutMs: 60_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const name = slug(input.name);
    const { target } = worktreeTarget(root, name);
    return runProcess('git', ['worktree', 'remove', target], {
      cwd: root,
      timeoutMs: 60_000,
      signal: ctx.signal,
      useShell: false,
    });
  },
};

export const WORKTREE_TOOLS: ToolDefinition[] = [
  gitWorktreeListTool,
  gitWorktreeCreateTool,
  gitWorktreeRemoveTool,
];
