import { createId, getPool } from '@dacai-local-agent/shared';
import type { CodeEdge, RepositoryRecord, SymbolRecord, SymbolType } from './types.js';

/**
 * Minimal, vendor-agnostic query surface. `pg.Pool` is structurally compatible,
 * so production code injects the real pool while tests can pass an in-memory stub
 * that never touches Postgres. This keeps the store unit-testable in isolation.
 */
export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Adapts a `pg.Pool`-shape object (from shared) into the `DbClient` surface. */
export function pgClient(pool: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): DbClient {
  return {
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      return pool.query(sql, params ?? []) as unknown as Promise<{ rows: T[] }>;
    },
  };
}

/** Builds a `DbClient` from the shared PostgreSQL pool (lazy so module load never opens a connection). */
export function createPostgresClient(): DbClient {
  return pgClient(getPool());
}

interface RepositoryRow { id: string; root_path: string; branch: string | null; head_commit: string | null; indexed_at: Date | null; created_at: Date; }
interface FileRow { file_path: string; language: string; content_hash: string; }
interface SymbolRow {
  id: string; repository_id: string; file_path: string; language: string; symbol_name: string;
  symbol_type: string; signature: string | null; start_line: number; end_line: number;
  summary: string | null; content_hash: string;
}
interface EdgeRow { id: string; file_path: string; source: string; target: string; relationship: string; line: number | null; }

/** Persists repository, file, symbol, and edge state into the repository-intelligence schema (migration 010). */
export class SymbolStore {
  constructor(private readonly db: DbClient, public readonly repositoryId: string) {}

  /** Idempotent upsert of the owning repository; returns the resolved repository id. */
  async upsertRepository(repo: RepositoryRecord): Promise<string> {
    const result = await this.db.query<RepositoryRow>(
      `INSERT INTO repositories (id, root_path, branch, head_commit, indexed_at, created_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (root_path) DO UPDATE SET branch = EXCLUDED.branch, head_commit = EXCLUDED.head_commit, indexed_at = now()
       RETURNING id`,
      [repo.id ?? createId('rep'), repo.rootPath, repo.branch ?? null, repo.headCommit ?? null],
    );
    return (result.rows[0] as RepositoryRow).id;
  }

  /** Current persisted file hashes keyed by repository-relative path. */
  async fileHashes(): Promise<Map<string, { hash: string; language: string }>> {
    const result = await this.db.query<FileRow>(
      'SELECT file_path, language, content_hash FROM repository_files WHERE repository_id = $1',
      [this.repositoryId],
    );
    const map = new Map<string, { hash: string; language: string }>();
    for (const row of result.rows as FileRow[]) {
      map.set(row.file_path, { hash: row.content_hash, language: row.language });
    }
        return map;
  }

  async upsertFileHash(filePath: string, language: string, contentHash: string): Promise<void> {
    await this.db.query(
      `INSERT INTO repository_files (repository_id, file_path, language, content_hash, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (repository_id, file_path) DO UPDATE SET language = EXCLUDED.language, content_hash = EXCLUDED.content_hash, updated_at = now()`,
      [this.repositoryId, filePath, language, contentHash],
    );
  }

  /** Removes a file and all of its symbols/edges so stale symbols cannot linger. */
  async deleteFile(filePath: string): Promise<void> {
    await this.db.query('DELETE FROM code_symbols WHERE repository_id = $1 AND file_path = $2', [this.repositoryId, filePath]);
    await this.db.query('DELETE FROM symbol_edges WHERE repository_id = $1 AND file_path = $2', [this.repositoryId, filePath]);
    await this.db.query('DELETE FROM repository_files WHERE repository_id = $1 AND file_path = $2', [this.repositoryId, filePath]);
  }

  async upsertSymbol(symbol: SymbolRecord & { edges?: CodeEdge[] }): Promise<void> {
    await this.db.query(
      `INSERT INTO code_symbols (id, repository_id, file_path, language, symbol_name, symbol_type, signature, start_line, end_line, summary, content, content_hash, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, '{}'::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         symbol_name = EXCLUDED.symbol_name, symbol_type = EXCLUDED.symbol_type, signature = EXCLUDED.signature,
         start_line = EXCLUDED.start_line, end_line = EXCLUDED.end_line, summary = EXCLUDED.summary,
         content_hash = EXCLUDED.content_hash, updated_at = now()`,
      [
        symbol.id, this.repositoryId, symbol.filePath, symbol.language, symbol.symbolName,
        symbol.symbolType, symbol.signature ?? null, symbol.startLine, symbol.endLine, symbol.summary ?? null, symbol.contentHash,
      ],
    );
    if (symbol.edges && symbol.edges.length) {
      const values: unknown[] = [];
      const tuples: string[] = [];
      let idx = 1;
      for (const edge of symbol.edges) {
        const id = createId('edg');
        values.push(id, this.repositoryId, edge.filePath, edge.source, edge.target, edge.relationship, edge.line ?? null);
        tuples.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, '{}'::jsonb, now())`);
      }
      await this.db.query(
        `INSERT INTO symbol_edges (id, repository_id, file_path, source, target, relationship, line, metadata, updated_at)
         VALUES ${tuples}
         ON CONFLICT (id) DO UPDATE SET line = EXCLUDED.line`,
        values,
      );
    }
  }

    /** Stable symbol id scoped to repository/file/type/startline. */
  symbolId(filePath: string, name: string, type: SymbolType, startLine: number): string {
    return `sym:${this.repositoryId}:${filePath}:${type}:${startLine}`;
  }

  async findSymbolsByName(name: string, opts?: { type?: SymbolType; file?: string; limit?: number }): Promise<SymbolRecord[]> {
    const params: unknown[] = [this.repositoryId, name];
    const clauses: string[] = [];
    if (opts?.type) { params.push(opts.type); clauses.push(`symbol_type = $${params.length}`); }
    if (opts?.file) { params.push(opts.file); clauses.push(`file_path = $${params.length}`); }
    params.push(opts?.limit ?? 50);
    const result = await this.db.query<SymbolRow>(
      `SELECT id, repository_id, file_path, language, symbol_name, symbol_type, signature, start_line, end_line, summary, content_hash
       FROM code_symbols WHERE repository_id = $1 AND symbol_name = $2${clauses.length ? ' AND ' + clauses.join(' AND ') : ''}
       ORDER BY start_line LIMIT $${params.length}`,
      params,
    );
    return (result.rows as SymbolRow[]).map(toSymbolRecord);
  }

  async findCallers(target: string, opts?: { file?: string; limit?: number }): Promise<CodeEdge[]> {
    const params: unknown[] = [this.repositoryId, target];
    const clauses = ['relationship = $3'];
    params.push('CALLS');
    if (opts?.file) { params.push(opts.file); clauses.push(`file_path = $${params.length}`); }
    params.push(opts?.limit ?? 50);
    const result = await this.db.query<EdgeRow>(
      `SELECT id, file_path, source, target, relationship, line FROM symbol_edges
       WHERE repository_id = $1 AND target = $2 AND ${clauses.join(' AND ')} ORDER BY line LIMIT $${params.length}`,
      params,
    );
    return (result.rows as EdgeRow[]).map(toEdgeRecord);
  }

  async findCallees(source: string, opts?: { file?: string; limit?: number }): Promise<CodeEdge[]> {
    const params: unknown[] = [this.repositoryId, source];
    const clauses = ['relationship = $3'];
    params.push('CALLS');
    if (opts?.file) { params.push(opts.file); clauses.push(`file_path = $${params.length}`); }
    params.push(opts?.limit ?? 50);
    const result = await this.db.query<EdgeRow>(
      `SELECT id, file_path, source, target, relationship, line FROM symbol_edges
       WHERE repository_id = $1 AND source = $2 AND ${clauses.join(' AND ')} ORDER BY line LIMIT $${params.length}`,
      params,
    );
    return (result.rows as EdgeRow[]).map(toEdgeRecord);
  }
}

function toSymbolRecord(row: SymbolRow): SymbolRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    filePath: row.file_path,
    language: row.language,
    symbolName: row.symbol_name,
    symbolType: row.symbol_type as SymbolType,
    signature: row.signature ?? undefined,
    startLine: row.start_line,
    endLine: row.end_line,
    summary: row.summary ?? undefined,
    contentHash: row.content_hash,
  };
}

function toEdgeRecord(row: EdgeRow): CodeEdge {
  return {
    filePath: row.file_path,
    source: row.source,
    target: row.target,
    relationship: row.relationship as CodeEdge['relationship'],
    line: row.line ?? 0,
  };
}

