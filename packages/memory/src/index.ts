import { MemoryEntryStore, type MemoryEntryRecord, type MemoryScope } from '@dacai-local-agent/shared';

export type { MemoryScope };

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  /** Required for conversation/workspace/agent scope; absent for global. */
  scopeKey?: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function toEntry(record: MemoryEntryRecord): MemoryEntry {
  return record;
}

const SECRET_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]|password\s*[:=]|private[_ -]?key|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@)/i;

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((token) => token.length >= 3),
  );
}

function relevance(entry: MemoryEntry, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const text = `${entry.content} ${JSON.stringify(entry.metadata)}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) score += token.includes('/') || token.includes('.') ? 3 : 1;
  }
  return score;
}

/**
 * Postgres-backed durable memory facade.
 *
 * Long-term memory stays in the DACAIS memory_entries store rather than being
 * duplicated inside the orchestration framework. Retrieval is deliberately
 * relevance-ranked before context injection so a local model is not flooded
 * with every remembered fact from a workspace.
 */
export class MemoryStore {
  private readonly store = new MemoryEntryStore();

  async save(entry: { scope: MemoryScope; scopeKey?: string; content: string; metadata?: Record<string, unknown> }): Promise<MemoryEntry> {
    return toEntry(await this.store.save(entry));
  }

  /**
   * Refuses obvious credentials/connection secrets before they enter durable
   * memory. This is a second line of defence; callers should still redact at
   * the tool/audit boundary.
   */
  async saveSafe(entry: { scope: MemoryScope; scopeKey?: string; content: string; metadata?: Record<string, unknown> }): Promise<MemoryEntry | undefined> {
    const content = entry.content.trim();
    if (!content || SECRET_PATTERN.test(content) || SECRET_PATTERN.test(JSON.stringify(entry.metadata ?? {}))) {
      return undefined;
    }
    return this.save({ ...entry, content });
  }

  async list(scope: MemoryScope, scopeKey?: string, limit?: number): Promise<MemoryEntry[]> {
    const records = await this.store.list(scope, scopeKey, limit);
    return records.map(toEntry);
  }

  /**
   * Ranked retrieval over the existing append-log memory table. The schema has
   * no embedding column, so this intentionally uses deterministic lexical
   * ranking instead of creating a second vector store.
   */
  async search(scope: MemoryScope, scopeKey: string | undefined, query: string, limit = 8): Promise<MemoryEntry[]> {
    const scanLimit = Math.max(limit * 6, 40);
    const entries = await this.list(scope, scopeKey, scanLimit);
    const queryTokens = tokenize(query);

    return entries
      .map((entry, index) => ({ entry, score: relevance(entry, queryTokens), recency: entries.length - index }))
      .sort((a, b) => b.score - a.score || b.recency - a.recency)
      .slice(0, Math.max(1, Math.min(limit, 30)))
      .map(({ entry }) => entry);
  }
}

export * from './failure-memory';
