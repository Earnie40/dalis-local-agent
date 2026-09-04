import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  extractProtectedVariables,
  isProtectedSecretPath,
  REDACTED,
  resolveWithinWorkspace,
  sanitizeText,
  summarizeProtectedFile,
} from '@dacai-local-agent/security';
import { unifiedDiff } from './diff';
import type { ToolDefinition, ToolExecutionContext } from './types';

/**
 * Filesystem tools. Every path argument is resolved through
 * resolveWithinWorkspace() before any I/O, so a traversal, an absolute path,
 * a symlink pointing outside, or a UNC path is rejected before it can touch
 * the disk — the containment check is not advisory.
 */

const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 200;

/** Directories that are never worth walking and would swamp any result. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.pnpm-store', 'target',
]);

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) {
    throw new Error('No workspace is selected. Register and select a workspace first.');
  }
  return ctx.workspaceRoot;
}

/** Paths are reported workspace-relative; absolute paths leak host layout. */
function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

/** Models often use the pod convention `/workspace`; DACAIS tools expose the
 * selected workspace instead, so translate only these exact safe aliases. */
function workspaceAlias(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  if (normalized === '/' || normalized === '/workspace') return '.';
  if (normalized.startsWith('/workspace/')) return normalized.slice('/workspace/'.length);
  if (normalized.startsWith('/')) return normalized.slice(1);
  return value;
}

export const listFilesTool: ToolDefinition = {
  name: 'filesystem.list',
  description:
    'List files and directories inside the active workspace so the agent can discover repository structure. ' +
    'Use this for directory/file discovery before guessing paths. This reads workspace structure for the agent; ' +
    'it does not open files in the human editor. Returns workspace-relative paths.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
      recursive: { type: 'boolean', description: 'Walk subdirectories. Defaults to false.' },
    },
  },
  permissionTier: 'safe',
  requiresRead: true,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const target = resolveWithinWorkspace(root, workspaceAlias(typeof input.path === 'string' ? input.path : '.'));
    const recursive = input.recursive === true;

    const entries: string[] = [];
    let truncated = false;

    async function walk(dir: string): Promise<void> {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }

      const found = await readdir(dir, { withFileTypes: true });
      for (const entry of found) {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

        const absolute = join(dir, entry.name);
        entries.push(`${toRelative(root, absolute)}${entry.isDirectory() ? '/' : ''}`);
        if (recursive && entry.isDirectory()) await walk(absolute);
      }
    }

    await walk(target);
    entries.sort();

    return {
      path: toRelative(root, target),
      count: entries.length,
      truncated,
      entries,
    };
  },
};

export const readFileTool: ToolDefinition = {
  name: 'filesystem.read',
  description:
    'Read TEXT CONTENTS from a workspace file into the agent context. Use this when the agent needs to inspect ' +
    'source code, configuration, documentation, logs, or other text. Returns 1-based line numbers. ' +
    'Do not use workspace.open-file for inspection; that only opens the file visually for the human operator.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path to read into agent context.' },
      startLine: { type: 'number', description: 'First line to return (1-based).' },
      endLine: { type: 'number', description: 'Last line to return, inclusive.' },
    },
    required: ['path'],
  },
  permissionTier: 'safe',
  requiresRead: true,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const target = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'path')));

    let info;
    try {
      info = await stat(target);
    } catch {
      // A bare ENOENT tells the model nothing and invites another guess.
      // Observed: a worker guessed src/main.rs in a TypeScript repo, got
      // ENOENT, and gave up. Show what is actually in the nearest real
      // directory so the next attempt is informed rather than another guess.
      const siblings = await nearestListing(root, target);
      throw new Error(
        `No such file: "${toRelative(root, target)}". ${siblings} ` +
          'Use filesystem.list or filesystem.search to find the real path — do not guess.',
      );
    }

    if (info.isDirectory()) {
      throw new Error(`"${toRelative(root, target)}" is a directory. Use filesystem.list instead.`);
    }
    if (info.size > MAX_READ_BYTES) {
      throw new Error(
        `File is ${Math.round(info.size / 1024)} KB, over the ${MAX_READ_BYTES / 1024} KB limit. ` +
          'Read a line range instead.',
      );
    }

    const content = await readFile(target, 'utf8');
    const reportedPath = toRelative(root, target);
    if (isProtectedSecretPath(reportedPath)) {
      return summarizeProtectedFile(reportedPath, content, info.size);
    }

    const lines = content.split('\n');
    const start = typeof input.startLine === 'number' ? Math.max(1, input.startLine) : 1;
    const end = typeof input.endLine === 'number' ? Math.min(lines.length, input.endLine) : lines.length;
    const slice = lines.slice(start - 1, end);

    return {
      path: reportedPath,
      totalLines: lines.length,
      startLine: start,
      endLine: start + slice.length - 1,
      content: sanitizeText(slice.map((line, index) => `${start + index}: ${line}`).join('\n')),
    };
  },
};

export const searchTool: ToolDefinition = {
  name: 'filesystem.search',
  description:
    'Search TEXT AND SOURCE CODE inside files across the active workspace using a regular expression. ' +
    'Use this to find functions, classes, identifiers, imports, SQL table names, configuration keys, strings, ' +
    'and other repository content. Returns matching file paths with line numbers. ' +
    'Do NOT use ToolSearch/tool discovery to find source-code identifiers; tool discovery searches callable tools, not files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression matched against file contents, e.g. RepositoryStore, code_symbols|symbol_edges, or MemoryStore\\.save.' },
      path: { type: 'string', description: 'Workspace-relative directory to search under. Defaults to the workspace root.' },
      filePattern: { type: 'string', description: 'Only search files whose name matches this regex.' },
      caseSensitive: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  permissionTier: 'safe',
  requiresRead: true,
  timeoutMs: 30_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const target = resolveWithinWorkspace(root, workspaceAlias(typeof input.path === 'string' ? input.path : '.'));

    let regex: RegExp;
    try {
      regex = new RegExp(requireString(input, 'pattern'), input.caseSensitive === true ? '' : 'i');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }

    const nameFilter =
      typeof input.filePattern === 'string' && input.filePattern
        ? new RegExp(input.filePattern, 'i')
        : undefined;

    const matches: Array<{
      path: string;
      line: number;
      text?: string;
      variable?: string;
      value?: typeof REDACTED;
    }> = [];
    let filesScanned = 0;
    let truncated = false;

    async function walk(dir: string): Promise<void> {
      if (truncated) return;
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (truncated) return;
        if (ctx.signal?.aborted) return;

        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await walk(absolute);
          continue;
        }
        if (nameFilter && !nameFilter.test(entry.name)) continue;

        let content: string;
        try {
          const info = await stat(absolute);
          if (info.size > MAX_READ_BYTES) continue;
          content = await readFile(absolute, 'utf8');
        } catch {
          continue; // Unreadable or binary — skip rather than fail the search.
        }

        filesScanned += 1;
        const reportedPath = toRelative(root, absolute);
        if (isProtectedSecretPath(reportedPath)) {
          for (const variable of extractProtectedVariables(content)) {
            const safeLine = `${variable.name}=${REDACTED}`;
            if (!regex.test(variable.name) && !regex.test(safeLine)) continue;
            matches.push({
              path: reportedPath,
              line: variable.line,
              variable: variable.name,
              value: REDACTED,
            });
            if (matches.length >= MAX_SEARCH_MATCHES) {
              truncated = true;
              return;
            }
          }
          continue;
        }

        const lines = content.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (!regex.test(lines[index])) continue;
          matches.push({
            path: reportedPath,
            line: index + 1,
            text: sanitizeText(lines[index].trim().slice(0, 200)),
          });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true;
            return;
          }
        }
      }
    }

    await walk(target);

    // A zero-file scan means the filter excluded everything, which is a very
    // different problem from "the pattern did not match" — and one a model
    // will otherwise misread as "this codebase has no such code". Observed:
    // a worker filtered to .py in a TypeScript repo, scanned 0 files, and
    // concluded the feature did not exist. Say what is actually here instead.
    let hint: string | undefined;
    if (filesScanned === 0) {
      const extensions = await sampleExtensions(target);
      hint = nameFilter
        ? `No file matched filePattern ${String(input.filePattern)}. File types present here: ${extensions}. ` +
          'Retry without filePattern, or use one that matches these.'
        : `No readable files were found under "${toRelative(root, target)}". Try filesystem.list first.`;
    } else if (matches.length === 0) {
      hint =
        `Scanned ${filesScanned} files; the pattern matched none. Try a broader pattern — ` +
        'search for an identifier or a distinctive word rather than a phrase from prose.';
    }

    return {
      pattern: String(input.pattern),
      filesScanned,
      matchCount: matches.length,
      truncated,
      hint,
      matches,
    };
  },
};

/** Lists the closest existing ancestor of a missing path, for a useful error. */
async function nearestListing(root: string, missing: string): Promise<string> {
  let current = dirname(missing);

  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const entries = await readdir(current, { withFileTypes: true });
      const names = entries
        .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
        .slice(0, 25)
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);

      return `"${toRelative(root, current)}" contains: ${names.join(', ') || '(empty)'}.`;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return '';
}

/** The file extensions actually present, so a failed filter can be corrected. */
async function sampleExtensions(dir: string, limit = 400): Promise<string> {
  const counts = new Map<string, number>();
  let seen = 0;

  async function walk(current: string): Promise<void> {
    if (seen >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (seen >= limit) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(current, entry.name));
        continue;
      }
      seen += 1;
      const dot = entry.name.lastIndexOf('.');
      const ext = dot > 0 ? entry.name.slice(dot) : '(no extension)';
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
  }

  await walk(dir);
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ext, n]) => `${ext} (${n})`)
      .join(', ') || 'none'
  );
}

export const writeFileTool: ToolDefinition = {
  name: 'filesystem.write',
  description:
    'Create or overwrite a workspace file as an agent mutation. This replaces the whole file. ' +
    'Use filesystem.read first unless full replacement is intentional; prefer filesystem.edit for targeted changes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path to read into agent context.' },
      content: { type: 'string', description: 'Full new contents of the file.' },
    },
    required: ['path', 'content'],
  },
  permissionTier: 'mutation',
  requiresRead: true,
  requiresWrite: true,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const target = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'path')));
    const content = typeof input.content === 'string' ? input.content : '';

    // Read the prior contents so the change can be recorded as a patch rather
    // than as two copies of the file.
    let previous: string | undefined;
    try {
      previous = await readFile(target, 'utf8');
    } catch {
      previous = undefined;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');

    const relativePath = toRelative(root, target);
    const diff = unifiedDiff(relativePath, previous ?? '', content);

    return {
      path: relativePath,
      created: previous === undefined,
      bytes: Buffer.byteLength(content, 'utf8'),
      beforeHash: previous === undefined ? null : diff.beforeHash,
      afterHash: diff.afterHash,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
      diff: diff.patch,
    };
  },
};

export const editFileTool: ToolDefinition = {
  name: 'filesystem.edit',
  description:
    'Make a targeted agent edit by replacing one exact string in a workspace file while leaving the rest untouched. ' +
    'Prefer this over filesystem.write for focused changes. The old string must appear exactly once.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string', description: 'Exact text to replace, including indentation.' },
      newString: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldString', 'newString'],
  },
  permissionTier: 'mutation',
  requiresRead: true,
  requiresWrite: true,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const target = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'path')));
    const oldString = requireString(input, 'oldString');
    const newString = typeof input.newString === 'string' ? input.newString : '';

    const content = await readFile(target, 'utf8');
    const occurrences = content.split(oldString).length - 1;

    // An ambiguous edit is refused rather than guessed at.
    if (occurrences === 0) {
      throw new Error(`Text not found in ${toRelative(root, target)}. It must match exactly, including whitespace.`);
    }
    if (occurrences > 1) {
      throw new Error(
        `Text appears ${occurrences} times in ${toRelative(root, target)}; the edit would be ambiguous. ` +
          'Include more surrounding context to make it unique.',
      );
    }

    const updated = content.replace(oldString, newString);
    await writeFile(target, updated, 'utf8');

    // The change is recorded as a structured patch with both sides hashed, so
    // a training trace holds a verifiable diff rather than two copies of a file.
    const relativePath = toRelative(root, target);
    const diff = unifiedDiff(relativePath, content, updated);

    return {
      path: relativePath,
      replaced: 1,
      beforeHash: diff.beforeHash,
      afterHash: diff.afterHash,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
      diff: diff.patch,
    };
  },
};

export const moveFileTool: ToolDefinition = {
  name: 'filesystem.move',
  description: 'Move or rename a file inside the workspace.',
  inputSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
  },
  permissionTier: 'mutation',
  requiresRead: true,
  requiresWrite: true,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    // Both ends are contained: moving a file out of the workspace is an escape.
    const from = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'from')));
    const to = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'to')));

    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    return { from: toRelative(root, from), to: toRelative(root, to) };
  },
};

export const copyFileTool: ToolDefinition = {
  name: 'filesystem.copy',
  description: 'Copy a file inside the workspace.',
  inputSchema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
  },
  permissionTier: 'mutation',
  requiresRead: true,
  requiresWrite: true,
  timeoutMs: 15_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const from = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'from')));
    const to = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'to')));

    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`${toRelative(root, to)} already exists. Move or remove it first.`);
    });

    return { from: toRelative(root, from), to: toRelative(root, to) };
  },
};

export const statTool: ToolDefinition = {
  name: 'filesystem.stat',
  description: 'Check workspace path metadata without reading file contents. Use filesystem.read to inspect text and filesystem.list to inspect directories.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permissionTier: 'safe',
  requiresRead: true,
  timeoutMs: 10_000,
  async execute(input, ctx) {
    const root = requireRoot(ctx);
    const target = resolveWithinWorkspace(root, workspaceAlias(requireString(input, 'path')));

    try {
      await access(target, constants.F_OK);
    } catch {
      return { path: toRelative(root, target), exists: false };
    }

    const info = await stat(target);
    return {
      path: toRelative(root, target),
      exists: true,
      type: info.isDirectory() ? 'directory' : 'file',
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  },
};

export const FILESYSTEM_TOOLS: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  searchTool,
  statTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  copyFileTool,
];

/** Read-only subset, for explorer and reviewer roles. */
export const READ_ONLY_FILESYSTEM_TOOLS: ToolDefinition[] = [
  listFilesTool,
  readFileTool,
  searchTool,
  statTool,
];
