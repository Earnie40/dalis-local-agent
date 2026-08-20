import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryIndexer, listSourceFiles } from '../packages/repository-index/src/indexer';
import { SymbolStore, type DbClient } from '../packages/repository-index/src/repository-store';
import type { SymbolRecord, SymbolType } from '../packages/repository-index/src/types';

function makeStore(repositoryId = 'repo-1') {
  const symbols: SymbolRecord[] = [];
  const files = new Map<string, { language: string; hash: string }>();
  const db: DbClient = {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      if (/^INSERT INTO code_symbols/.test(sql)) {
        const [id, rid, filePath, lang, name, type, sig, s, e, summary, hash] = params as unknown[];
        symbols.push({
          id: id as string, repositoryId: rid as string, filePath: filePath as string, language: lang as string,
          symbolName: name as string, symbolType: type as SymbolType, signature: sig ? (sig as string) : undefined,
          startLine: s as number, endLine: e as number, summary: summary ? (summary as string) : undefined, contentHash: hash as string,
        });
        return { rows: [] as T[] };
      }
      if (/^INSERT INTO repository_files/.test(sql)) {
        const [, filePath, language, hash] = params as unknown[];
        files.set(filePath as string, { language: language as string, hash: hash as string });
        return { rows: [] as T[] };
      }
      if (/^INSERT INTO symbol_edges/.test(sql) || /^DELETE/.test(sql)) return { rows: [] as T[] };
      if (/^SELECT/.test(sql) && sql.includes('FROM repository_files')) {
        return { rows: Array.from(files.entries()).map(([filePath, v]) => ({ file_path: filePath, language: v.language, content_hash: v.hash })) as unknown as T[] };
      }
      if (/^SELECT/.test(sql) && sql.includes('FROM code_symbols')) {
        return { rows: symbols.map((r) => ({
          id: r.id, repository_id: r.repositoryId, file_path: r.filePath, language: r.language,
          symbol_name: r.symbolName, symbol_type: r.symbolType, signature: r.signature ?? null,
          start_line: r.startLine, end_line: r.endLine, summary: r.summary ?? null, content_hash: r.contentHash,
        })) as unknown as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return new SymbolStore(db, repositoryId);
}

describe('RepositoryIndexer', () => {
  let root: string;
  beforeEach(async () => {
    root = join(tmpdir(), `repo-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('walks source files (ignoring node_modules), builds an incremental plan, and persists symbols', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), [
      'export function add(a: number, b: number): number { return a + b; }',
      'export const mul = (a: number, b: number): number => a * b;',
    ].join('\n'));
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'x.ts'), 'export const ignore = 1;');

    const store = makeStore();
    const indexer = new RepositoryIndexer(root, store);

    const files = await listSourceFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('src/a.ts');
    expect(files[0].language).toBe('typescript');

    const plan = await indexer.buildIndexPlan(files);
    expect(plan.toIndex).toEqual(['src/a.ts']);
    expect(plan.toDrop).toEqual([]);
    expect(plan.unchanged).toBe(0);

    const summary = await indexer.indexAll();
    expect(summary.indexed).toBe(1);
    expect(summary.removed).toBe(0);

    const add = await store.findSymbolsByName('add');
    expect(add).toHaveLength(1);
    expect(add[0].symbolType).toBe('function');
    const mul = await store.findSymbolsByName('mul');
    expect(mul).toHaveLength(1);
    expect(mul[0].symbolType).toBe('function');
  });

  it('skips unchanged files on a second index pass', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    const file = join(root, 'src', 'a.ts');
    await writeFile(file, 'export function add(a: number, b: number): number { return a + b; }');

    const store = makeStore();
    const indexer = new RepositoryIndexer(root, store);
    await indexer.indexAll();
    const second = await indexer.indexAll();
    expect(second.indexed).toBe(0);
    expect(second.unchanged).toBe(1);
  });
});