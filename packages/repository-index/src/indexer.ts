import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, relative, sep } from 'node:path';
import { detectLanguage, extractSymbols } from './symbol-extractor.js';
import { SymbolStore } from './repository-store.js';
import type { CodeEdge, IndexPlan, IndexSummary, SymbolType } from './types.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.sql', '.rs', '.java', '.rb', '.kt', '.sh', '.ps1']);
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'coverage', '.venv', '__pycache__', '.prisma', 'vendor']);

/** Content hash used for incremental re-indexing (only re-extract when this changes). */
export function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface IndexFile {
  /** Absolute file path. */
  filePath: string;
  /** Repository-relative, slash-separated path (used as the DB key). */
  relativePath: string;
  /** Detected language id from the file extension. */
  language: string;
}

/** Walks `rootPath` and yields source files, skipping ignored directories. */
export async function listSourceFiles(rootPath: string): Promise<IndexFile[]> {
  const results: IndexFile[] = [];
  const stack: string[] = [rootPath];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = dir.endsWith(sep) ? `${dir}${sep}${entry}` : `${dir}${sep}${entry}`;
      let st;
      try { st = await stat(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && SOURCE_EXTENSIONS.has(extname(full).toLowerCase())) {
        results.push({ filePath: full, relativePath: relative(rootPath, full).split(sep).join('/'), language: detectLanguage(full) });
      }
    }
  }
  return results;
}

/**
 * Incremental indexer that synchronizes a repository's symbol graph from disk
 * into Postgres. Only re-extracts files whose content hash changed; only
 * writes symbols/edges for the changed files (callers/callees are derived per
 * file during extraction, so a changed file fully rewrites its own edges).
 */
export class RepositoryIndexer {
  constructor(private readonly rootPath: string, private readonly store: SymbolStore) {}

  /** Diff current on-disk files against the persisted file hashes. */
  async buildIndexPlan(files: IndexFile[]): Promise<IndexPlan> {
    const current = new Map<string, string>();
    for (const f of files) {
      let content: string;
      try { content = await readFile(f.filePath, 'utf8'); } catch { continue; }
      current.set(f.relativePath, computeFileHash(content));
    }
    const persisted = await this.store.fileHashes();
    const toIndex: string[] = [];
    const toDrop: string[] = [];
    let unchanged = 0;
    for (const [rel, hash] of current) {
      const prev = persisted.get(rel);
      if (!prev || prev.hash !== hash) toIndex.push(rel);
      else unchanged += 1;
    }
    for (const rel of persisted.keys()) if (!current.has(rel)) toDrop.push(rel);
    return { toIndex, toDrop, unchanged };
  }

  /** Extract + persist symbols/edges for a single file. */
  async indexFile(file: IndexFile): Promise<{ symbols: number; edges: number }> {
    const source = await readFile(file.filePath, 'utf8');
    const hash = computeFileHash(source);
    const result = extractSymbols(file.relativePath, source);
    await this.store.deleteFile(file.relativePath);
    const fileEdges = result.edges.filter((e) => e.filePath === file.relativePath);
    let symbolCount = 0;
    for (const sym of result.symbols) {
      const record: import('./types.js').SymbolRecord & { edges?: CodeEdge[] } = {
        id: this.store.symbolId(file.relativePath, sym.name, sym.type, sym.startLine),
        repositoryId: this.store.repositoryId,
        filePath: file.relativePath,
        language: sym.language,
        symbolName: sym.name,
        symbolType: sym.type as SymbolType,
        signature: sym.signature,
        startLine: sym.startLine,
        endLine: sym.endLine,
        summary: undefined,
        contentHash: hash,
        edges: symbolCount === 0 ? fileEdges : undefined,
      };
      await this.store.upsertSymbol(record);
      symbolCount += 1;
    }
    await this.store.upsertFileHash(file.relativePath, file.language, hash);
    return { symbols: symbolCount, edges: result.edges.length };
  }

  /** Walk, diff, drop removed, and index changed files. */
  async indexAll(): Promise<IndexSummary> {
    const files = await listSourceFiles(this.rootPath);
    const plan = await this.buildIndexPlan(files);
    for (const rel of plan.toDrop) await this.store.deleteFile(rel);
    let indexed = 0;
    for (const rel of plan.toIndex) {
      const file = files.find((f) => f.relativePath === rel);
      if (!file) continue;
      await this.indexFile(file);
      indexed += 1;
    }
    return { indexed, removed: plan.toDrop.length, unchanged: plan.unchanged };
  }
}

