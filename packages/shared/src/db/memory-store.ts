import { createId } from '../utils.js';
import { getPool } from './pool.js';

/**
 * Durable memory: facts or context that persist across sessions. Distinct
 * from ConversationStore (verbatim message transcript for one conversation)
 * and RAG (semantic retrieval over ingested documents).
 *
 * Backed by the `memory_entries` table already defined in
 * 001_initial_schema.sql — no new migration needed. That table has no
 * uniqueness constraint on (scope, scope_key): it is an append log, not an
 * upsert KV store, so `save()` always inserts a new row and `list()` returns
 * most-recent-first. A caller wanting "the current value for a key" takes
 * the first match.
 */

export type MemoryScope = 'conversation' | 'workspace' | 'agent' | 'global';

export interface MemoryEntryRecord {
  id: string;
  scope: MemoryScope;
  /** Required for conversation/workspace/agent scope; absent for global. */
  scopeKey?: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface MemoryEntryRow {
  id: string;
  scope: MemoryScope;
  scope_key: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const GLOBAL_SCOPE_KEY = '';

function toRecord(row: MemoryEntryRow): MemoryEntryRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeKey: row.scope === 'global' ? undefined : row.scope_key,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

export class MemoryEntryStore {
  async save(entry: { scope: MemoryScope; scopeKey?: string; content: string; metadata?: Record<string, unknown> }): Promise<MemoryEntryRecord> {
    if (entry.scope !== 'global' && !entry.scopeKey) {
      throw new Error(`Memory scope "${entry.scope}" requires a scopeKey.`);
    }

    const pool = getPool();
    const result = await pool.query<MemoryEntryRow>(
      `
      INSERT INTO memory_entries (id, scope, scope_key, content, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, now())
      RETURNING *
      `,
      [createId('mem'), entry.scope, entry.scopeKey ?? GLOBAL_SCOPE_KEY, entry.content, JSON.stringify(entry.metadata ?? {})],
    );

    return toRecord(result.rows[0]);
  }

  async list(scope: MemoryScope, scopeKey?: string, limit = 100): Promise<MemoryEntryRecord[]> {
    const pool = getPool();
    const result = await pool.query<MemoryEntryRow>(
      'SELECT * FROM memory_entries WHERE scope = $1 AND scope_key = $2 ORDER BY created_at DESC LIMIT $3',
      [scope, scope === 'global' ? GLOBAL_SCOPE_KEY : scopeKey, limit],
    );
    return result.rows.map(toRecord);
  }
}
