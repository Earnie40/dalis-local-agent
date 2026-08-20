import { getPool } from '../packages/shared/src/db/pool.ts';

async function main(): Promise<void> {
  const pool = getPool();

  const result = await pool.query(`
    SELECT 'repositories' AS table_name, COUNT(*)::int AS count FROM repositories
    UNION ALL
    SELECT 'repository_files', COUNT(*)::int FROM repository_files
    UNION ALL
    SELECT 'code_symbols', COUNT(*)::int FROM code_symbols
    UNION ALL
    SELECT 'symbol_edges', COUNT(*)::int FROM symbol_edges
    ORDER BY table_name
  `);

  console.table(result.rows);

  const dimensions = await pool.query(`
    SELECT DISTINCT vector_dims(embedding)::int AS dimensions
      FROM code_symbols
     WHERE embedding IS NOT NULL
     ORDER BY 1
  `);

  console.log(
    'code_symbols embedding dimensions:',
    dimensions.rows.map((row) => row.dimensions),
  );

  if (!result.rows.some(
    (row) => row.table_name === 'repositories' && row.count > 0
  )) process.exitCode = 2;

  if (!result.rows.some(
    (row) => row.table_name === 'repository_files' && row.count > 0
  )) process.exitCode = 3;

  if (!result.rows.some(
    (row) => row.table_name === 'code_symbols' && row.count > 0
  )) process.exitCode = 4;

  if (
    dimensions.rows.length &&
    !dimensions.rows.every((row) => row.dimensions === 768)
  ) process.exitCode = 5;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

