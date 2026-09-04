import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  editFileTool,
  listFilesTool,
  moveFileTool,
  readFileTool,
  searchTool,
  statTool,
  writeFileTool,
} from '../packages/tools/src/filesystem-tools';
import { PathContainmentError } from '../packages/security/src/path-containment';

let root: string;
let ctx: { workspaceRoot: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dacai-fs-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(root, 'src', 'config.ts'), 'export const PORT = 8080;\nexport const RETRIES = 3;\n');
  writeFileSync(join(root, 'src', 'server.ts'), "import { PORT } from './config';\n");
  writeFileSync(join(root, 'README.md'), '# Demo\n');
  writeFileSync(
    join(root, '.env'),
    'DEEPBRAIN_APP_ID=synthetic-app-id\nDEEPBRAIN_USER_KEY=synthetic-user-key\nRUNPOD_CONNECTION=ssh synthetic-host\n',
  );
  writeFileSync(join(root, '.env.backup'), 'OPENAI_API_KEY=sk-syntheticbackupcredential123456789\n');
  writeFileSync(
    join(root, 'id_ed25519'),
    '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-private-material\n-----END OPENSSH PRIVATE KEY-----\n',
  );
  writeFileSync(
    join(root, 'src', 'references.ts'),
    'export const key = process.env.DEEPBRAIN_USER_KEY;\nexport const PORT = 3001;\n',
  );
  writeFileSync(
    join(root, 'src', 'leaky.log'),
    'RUNPOD_API_KEY=rpa_syntheticcredential12345\npostgresql://user:syntheticDbPassword@db.example/test\n',
  );
  writeFileSync(join(root, 'node_modules', 'junk', 'huge.js'), 'PORT = 1;\n');
  ctx = { workspaceRoot: root };
});

describe('filesystem.list', () => {
  it('lists the workspace root with directories marked', async () => {
    const result = (await listFilesTool.execute({}, ctx)) as { entries: string[] };
    expect(result.entries).toContain('README.md');
    expect(result.entries).toContain('src/');
  });

  it('maps / and /workspace to the selected workspace root', async () => {
    const rootResult = (await listFilesTool.execute({ path: '/' }, ctx)) as { path: string };
    const workspaceResult = (await listFilesTool.execute({ path: '/workspace' }, ctx)) as { path: string };
    expect(rootResult.path).toBe('.');
    expect(workspaceResult.path).toBe('.');
  });

  it('maps POSIX absolute-looking child paths into the workspace', async () => {
    const result = (await listFilesTool.execute({ path: '/src' }, ctx)) as { path: string };
    expect(result.path).toBe('src');
  });

  it('walks subdirectories when asked', async () => {
    const result = (await listFilesTool.execute({ recursive: true }, ctx)) as { entries: string[] };
    expect(result.entries).toContain('src/config.ts');
  });

  it('skips node_modules so results stay useful', async () => {
    const result = (await listFilesTool.execute({ recursive: true }, ctx)) as { entries: string[] };
    expect(result.entries.some((e) => e.includes('node_modules'))).toBe(false);
  });

  it('reports paths relative to the workspace, never absolute', async () => {
    const result = (await listFilesTool.execute({ recursive: true }, ctx)) as { entries: string[] };
    expect(result.entries.every((e) => !e.includes(root))).toBe(true);
  });
});

describe('filesystem.read', () => {
  it('returns contents with 1-based line numbers', async () => {
    const result = (await readFileTool.execute({ path: 'src/config.ts' }, ctx)) as {
      content: string;
      totalLines: number;
    };
    expect(result.content).toContain('1: export const PORT = 8080;');
    expect(result.totalLines).toBe(3);
  });

  it('honours a line range', async () => {
    const result = (await readFileTool.execute({ path: 'src/config.ts', startLine: 2, endLine: 2 }, ctx)) as {
      content: string;
    };
    expect(result.content).toBe('2: export const RETRIES = 3;');
  });

  it('refuses a directory with a usable message', async () => {
    await expect(readFileTool.execute({ path: 'src' }, ctx)).rejects.toThrow(/directory/i);
  });

  it('returns only safe metadata and variable names for .env files', async () => {
    const result = (await readFileTool.execute({ path: '.env' }, ctx)) as {
      path: string;
      protected: boolean;
      variables: string[];
      content?: string;
    };
    expect(result).toMatchObject({ path: '.env', protected: true });
    expect(result.variables).toEqual(['DEEPBRAIN_APP_ID', 'DEEPBRAIN_USER_KEY', 'RUNPOD_CONNECTION']);
    expect(result.content).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(?:app|user|host)/);
  });

  it.each(['.env.backup', 'id_ed25519'])('protects %s without returning its contents', async (path) => {
    const result = await readFileTool.execute({ path }, ctx);
    expect(result).toMatchObject({ path, protected: true });
    expect(JSON.stringify(result)).not.toMatch(/synthetic|BEGIN OPENSSH/);
  });

  it('redacts secret values in an ordinary file while preserving normal code', async () => {
    const leaked = (await readFileTool.execute({ path: 'src/leaky.log' }, ctx)) as { content: string };
    expect(leaked.content).not.toContain('rpa_syntheticcredential12345');
    expect(leaked.content).not.toContain('syntheticDbPassword');
    expect(leaked.content).toContain('[REDACTED]');

    const references = (await readFileTool.execute({ path: 'src/references.ts' }, ctx)) as { content: string };
    expect(references.content).toContain('process.env.DEEPBRAIN_USER_KEY');
    expect(references.content).toContain('PORT = 3001');
  });
});

describe('filesystem.search', () => {
  it('finds matches with file and line', async () => {
    const result = (await searchTool.execute({ pattern: 'PORT' }, ctx)) as {
      matches: Array<{ path: string; line: number }>;
    };
    expect(result.matches.some((m) => m.path === 'src/config.ts' && m.line === 1)).toBe(true);
  });

  it('excludes skipped directories from search too', async () => {
    const result = (await searchTool.execute({ pattern: 'PORT' }, ctx)) as {
      matches: Array<{ path: string }>;
    };
    expect(result.matches.some((m) => m.path.includes('node_modules'))).toBe(false);
  });

  it('filters by file name pattern', async () => {
    const result = (await searchTool.execute({ pattern: 'PORT', filePattern: 'server' }, ctx)) as {
      matches: Array<{ path: string }>;
    };
    expect(result.matches.every((m) => m.path.includes('server'))).toBe(true);
  });

  it('reports an invalid regex instead of crashing', async () => {
    await expect(searchTool.execute({ pattern: '([' }, ctx)).rejects.toThrow(/Invalid regular expression/);
  });

  it('searches protected files using variable names without exposing values', async () => {
    const result = (await searchTool.execute({ pattern: 'DEEPBRAIN|RUNPOD' }, ctx)) as {
      matches: Array<{ path: string; line: number; variable?: string; value?: string; text?: string }>;
    };
    const envMatches = result.matches.filter((match) => match.path === '.env');
    expect(envMatches).toEqual([
      { path: '.env', line: 1, variable: 'DEEPBRAIN_APP_ID', value: '[REDACTED]' },
      { path: '.env', line: 2, variable: 'DEEPBRAIN_USER_KEY', value: '[REDACTED]' },
      { path: '.env', line: 3, variable: 'RUNPOD_CONNECTION', value: '[REDACTED]' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-(?:app|user|host)/);
  });

  it('redacts secret-like matches from ordinary files', async () => {
    const result = (await searchTool.execute({ pattern: 'RUNPOD_API_KEY|postgresql' }, ctx)) as {
      matches: Array<{ path: string; text?: string }>;
    };
    const serialized = JSON.stringify(result.matches.filter((match) => match.path === 'src/leaky.log'));
    expect(serialized).not.toContain('rpa_syntheticcredential12345');
    expect(serialized).not.toContain('syntheticDbPassword');
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('filesystem.write and edit', () => {
  it('creates a file and reports it as created', async () => {
    const result = (await writeFileTool.execute({ path: 'src/new.ts', content: 'export {};\n' }, ctx)) as {
      created: boolean;
    };
    expect(result.created).toBe(true);
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('export {};\n');
  });

  it('reports an overwrite as not-created, with a diff of the change', async () => {
    const result = (await writeFileTool.execute({ path: 'README.md', content: '# Changed\n' }, ctx)) as {
      created: boolean;
      beforeHash: string | null;
      afterHash: string;
      diff: string;
    };

    expect(result.created).toBe(false);
    // A prior version existed, so both sides are hashed and the patch is real.
    expect(result.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.afterHash).not.toBe(result.beforeHash);
    expect(result.diff).toContain('+# Changed');
  });

  it('records a structured patch for a targeted edit', async () => {
    const result = (await editFileTool.execute(
      { path: 'src/config.ts', oldString: 'PORT = 8080', newString: 'PORT = 3000' },
      ctx,
    )) as { diff: string; linesAdded: number; linesRemoved: number; beforeHash: string; afterHash: string };

    expect(result.diff).toContain('-export const PORT = 8080;');
    expect(result.diff).toContain('+export const PORT = 3000;');
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(1);
    expect(result.beforeHash).not.toBe(result.afterHash);
  });

  it('replaces an exact unique string', async () => {
    await editFileTool.execute(
      { path: 'src/config.ts', oldString: 'PORT = 8080', newString: 'PORT = 3000' },
      ctx,
    );
    expect(readFileSync(join(root, 'src', 'config.ts'), 'utf8')).toContain('PORT = 3000');
  });

  it('refuses an ambiguous edit rather than guessing', async () => {
    writeFileSync(join(root, 'dup.ts'), 'const a = 1;\nconst a = 1;\n');
    await expect(
      editFileTool.execute({ path: 'dup.ts', oldString: 'const a = 1;', newString: 'const b = 2;' }, ctx),
    ).rejects.toThrow(/appears 2 times/);
  });

  it('refuses an edit whose target text is absent', async () => {
    await expect(
      editFileTool.execute({ path: 'README.md', oldString: 'nope', newString: 'x' }, ctx),
    ).rejects.toThrow(/not found/i);
  });
});

describe('workspace containment', () => {
  const escapes = [
    ['traversal', '../../etc/passwd'],
    ['absolute outside', 'C:/Windows/System32/drivers/etc/hosts'],
    ['UNC path', '\\\\server\\share\\file.txt'],
  ] as const;

  it.each(escapes)('read rejects %s', async (_label, path) => {
    await expect(readFileTool.execute({ path }, ctx)).rejects.toThrow(PathContainmentError);
  });

  it.each(escapes)('write rejects %s', async (_label, path) => {
    await expect(writeFileTool.execute({ path, content: 'x' }, ctx)).rejects.toThrow(PathContainmentError);
  });

  it('rejects a move whose destination leaves the workspace', async () => {
    await expect(
      moveFileTool.execute({ from: 'README.md', to: '../escaped.md' }, ctx),
    ).rejects.toThrow(PathContainmentError);
  });

  it('rejects reading through a symlink that points outside', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dacai-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');

    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file');
    } catch {
      return; // Symlink creation needs privileges on Windows; skip if unavailable.
    }

    await expect(readFileTool.execute({ path: 'link.txt' }, ctx)).rejects.toThrow(PathContainmentError);
  });

  it('refuses to operate with no workspace selected', async () => {
    await expect(listFilesTool.execute({}, {})).rejects.toThrow(/No workspace/);
  });
});

describe('permission tiers', () => {
  it('classifies reads as safe and writes as mutation', () => {
    expect(listFilesTool.permissionTier).toBe('safe');
    expect(readFileTool.permissionTier).toBe('safe');
    expect(searchTool.permissionTier).toBe('safe');
    expect(statTool.permissionTier).toBe('safe');

    expect(writeFileTool.permissionTier).toBe('mutation');
    expect(editFileTool.permissionTier).toBe('mutation');
    expect(writeFileTool.requiresWrite).toBe(true);
    expect(editFileTool.requiresWrite).toBe(true);
  });
});

describe('dead-end feedback', () => {
  it('says which file types exist when a filePattern excludes everything', async () => {
    // The exact failure observed live: a worker filtered to .py in a TypeScript
    // repo, scanned zero files, and concluded the feature did not exist.
    const result = (await searchTool.execute({ pattern: 'PORT', filePattern: '.*\\.py$' }, ctx)) as {
      filesScanned: number;
      hint?: string;
    };

    expect(result.filesScanned).toBe(0);
    expect(result.hint).toContain('No file matched filePattern');
    expect(result.hint).toContain('.ts');
  });

  it('distinguishes "pattern matched nothing" from "nothing was scanned"', async () => {
    const result = (await searchTool.execute({ pattern: 'zzz_no_such_symbol_zzz' }, ctx)) as {
      filesScanned: number;
      hint?: string;
    };

    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.hint).toContain('the pattern matched none');
  });

  it('omits the hint when the search actually found something', async () => {
    const result = (await searchTool.execute({ pattern: 'PORT' }, ctx)) as { hint?: string };
    expect(result.hint).toBeUndefined();
  });

  it('shows the real directory contents when a guessed path does not exist', async () => {
    // Observed: a worker guessed src/main.rs, got a bare ENOENT, and gave up.
    await expect(readFileTool.execute({ path: 'src/main.rs' }, ctx)).rejects.toThrow(/config\.ts/);
    await expect(readFileTool.execute({ path: 'src/main.rs' }, ctx)).rejects.toThrow(/do not guess/);
  });

  it('walks up to the nearest existing directory for a deep missing path', async () => {
    await expect(
      readFileTool.execute({ path: 'src/deeply/nested/missing.ts' }, ctx),
    ).rejects.toThrow(/contains:/);
  });
});

