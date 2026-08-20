import { getPool } from '../../shared/src/db/pool';

export async function dependencyImpact(target: string) {
  const pool = getPool();

  const edges = await pool.query(`
    SELECT
      source,
      target,
      relationship,
      file_path,
      line
    FROM symbol_edges
    WHERE source = $1 OR target = $1
    ORDER BY file_path, line
  `, [target]);

  const references = await pool.query(`
    SELECT
      id,
      to_jsonb(code_symbols) AS symbol
    FROM code_symbols
    WHERE to_jsonb(code_symbols)::text ILIKE '%' || $1 || '%'
    LIMIT 100
  `, [target]);

  const relatedTests = await pool.query(`
    SELECT DISTINCT
      COALESCE(
        to_jsonb(code_symbols)->>'file_path',
        to_jsonb(code_symbols)->>'path'
      ) AS file_path
    FROM code_symbols
    WHERE
      COALESCE(
        to_jsonb(code_symbols)->>'file_path',
        to_jsonb(code_symbols)->>'path',
        ''
      ) ~* '(test|spec)'
      AND to_jsonb(code_symbols)::text ILIKE '%' || $1 || '%'
    LIMIT 50
  `, [target]);

  return {
    target,
    edges: edges.rows,
    references: references.rows,
    relatedTests: relatedTests.rows
      .map((row) => row.file_path)
      .filter(Boolean),
  };
}
