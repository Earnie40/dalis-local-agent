import { getPool } from '../../shared/src/db/pool';

const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL ??
  process.env.OLLAMA_URL ??
  'http://127.0.0.1:11434';

const EMBEDDING_MODEL =
  process.env.CODE_EMBEDDING_MODEL ??
  process.env.EMBEDDING_MODEL ??
  'nomic-embed-text';

const EXPECTED_DIMENSIONS = 768;
const DEFAULT_BATCH_SIZE = 16;

type SymbolRow = {
  id: string;
  payload: Record<string, unknown>;
};

function value(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const current = obj[key];
    if (typeof current === 'string' && current.trim()) {
      return current.trim();
    }
  }
  return '';
}

function symbolText(payload: Record<string, unknown>): string {
  const parts = [
    `name: ${value(payload, 'name', 'symbol_name')}`,
    `kind: ${value(payload, 'kind', 'symbol_kind')}`,
    `file: ${value(payload, 'file_path', 'path')}`,
    `signature: ${value(payload, 'signature')}`,
    `definition: ${value(payload, 'definition', 'source', 'content')}`,
  ];

  return parts.filter((part) => !part.endsWith(': ')).join('\n').slice(0, 12000);
}

async function embed(inputs: string[]): Promise<number[][]> {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      truncate: true,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama embedding request failed: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { embeddings?: number[][] };

  if (!Array.isArray(body.embeddings)) {
    throw new Error('Ollama did not return embeddings.');
  }

  for (const embedding of body.embeddings) {
    if (embedding.length !== EXPECTED_DIMENSIONS) {
      throw new Error(
        `Expected ${EXPECTED_DIMENSIONS} dimensions from ${EMBEDDING_MODEL}, received ${embedding.length}.`,
      );
    }
  }

  return body.embeddings;
}

export async function enrichMissingSymbolEmbeddings(
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const pool = getPool();
  let total = 0;

  for (;;) {
    const result = await pool.query<SymbolRow>(`
      SELECT
        id,
        to_jsonb(code_symbols) AS payload
      FROM code_symbols
      WHERE embedding IS NULL
      ORDER BY id
      LIMIT $1
    `, [batchSize]);

    if (!result.rows.length) break;

    const texts = result.rows.map((row) => symbolText(row.payload));
    const embeddings = await embed(texts);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (let i = 0; i < result.rows.length; i += 1) {
        const vector = `[${embeddings[i].join(',')}]`;

        await client.query(
          `UPDATE code_symbols SET embedding = $2::vector WHERE id = $1`,
          [result.rows[i].id, vector],
        );

        total += 1;
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log(`Embedded ${total} symbols`);
  }

  return total;
}
