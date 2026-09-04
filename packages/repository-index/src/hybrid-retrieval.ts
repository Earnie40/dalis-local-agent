import { getPool } from '../../shared/src/db/pool';

const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL ??
  process.env.OLLAMA_URL ??
  'http://127.0.0.1:11434';

const EMBEDDING_MODEL =
  process.env.CODE_EMBEDDING_MODEL ??
  process.env.EMBEDDING_MODEL ??
  'nomic-embed-text';

async function queryEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
      truncate: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding query failed: ${response.status}`);
  }

  const body = (await response.json()) as { embeddings: number[][] };
  return body.embeddings[0];
}

export interface HybridSymbolResult {
  id: string;
  filePath?: string;
  name?: string;
  kind?: string;
  similarity: number;
  payload: Record<string, unknown>;
}

export async function hybridSymbolSearch(
  query: string,
  limit = 12,
): Promise<HybridSymbolResult[]> {
  const pool = getPool();
  const embedding = await queryEmbedding(query);
  const vector = `[${embedding.join(',')}]`;

  const result = await pool.query(`
    WITH semantic AS (
      SELECT
        id,
        to_jsonb(code_symbols) - 'embedding' - 'content' payload,
        1 - (embedding <=> $1::vector) similarity
      FROM code_symbols
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    ),
    lexical AS (
      SELECT
        id,
        to_jsonb(code_symbols) - 'embedding' - 'content' payload,
        0.55::double precision similarity
      FROM code_symbols
      WHERE to_jsonb(code_symbols)::text ILIKE '%' || $2 || '%'
      LIMIT $3
    ),
    combined AS (
      SELECT * FROM semantic
      UNION ALL
      SELECT * FROM lexical
    ),
    deduplicated AS (
      SELECT DISTINCT ON (id)
        id,
        payload,
        similarity
      FROM combined
      ORDER BY id, similarity DESC
    )
    SELECT id, payload, similarity
    FROM deduplicated
    ORDER BY similarity DESC, id
    LIMIT $3
  `, [vector, query, limit]);

  return result.rows.map((row) => ({
    id: String(row.id),
    filePath: row.payload.file_path ?? row.payload.path,
    name: row.payload.name ?? row.payload.symbol_name,
    kind: row.payload.kind ?? row.payload.symbol_kind ?? row.payload.symbol_type,
    similarity: Number(row.similarity),
    payload: row.payload,
  }));
}

export async function symbolEdges(symbol: string, workspaceRoot?: string) {
  const pool = getPool();

  const result = await pool.query(`
    SELECT e.*
    FROM symbol_edges e
    JOIN repositories r ON r.id = e.repository_id
    WHERE (e.source = $1 OR e.target = $1)
      AND ($2::text IS NULL OR lower(r.root_path) = lower($2))
    ORDER BY e.file_path, e.line
  `, [symbol, workspaceRoot ?? null]);

  return result.rows;
}

export async function symbolCallers(symbol: string, workspaceRoot?: string) {
  const pool = getPool();

  const result = await pool.query(`
    SELECT e.*
    FROM symbol_edges e
    JOIN repositories r ON r.id = e.repository_id
    WHERE e.target = $1
      AND e.relationship = 'CALLS'
      AND ($2::text IS NULL OR lower(r.root_path) = lower($2))
    ORDER BY e.file_path, e.line
  `, [symbol, workspaceRoot ?? null]);

  return result.rows;
}

export async function symbolCallees(symbol: string, workspaceRoot?: string) {
  const pool = getPool();

  const result = await pool.query(`
    SELECT e.*
    FROM symbol_edges e
    JOIN repositories r ON r.id = e.repository_id
    WHERE e.source = $1
      AND e.relationship = 'CALLS'
      AND ($2::text IS NULL OR lower(r.root_path) = lower($2))
    ORDER BY e.file_path, e.line
  `, [symbol, workspaceRoot ?? null]);

  return result.rows;
}
