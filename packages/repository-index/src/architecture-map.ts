import { createHash } from 'node:crypto';
import { getPool } from '../../shared/src/db/pool';

export async function buildRepositoryArchitectureMap(repositoryId?: string) {
  const pool = getPool();

  const repo = repositoryId
    ? { rows: [{ id: repositoryId }] }
    : await pool.query(`SELECT id FROM repositories ORDER BY created_at DESC LIMIT 1`);

  if (!repo.rows.length) {
    throw new Error('No indexed repository found.');
  }

  const id = String(repo.rows[0].id);

  const files = await pool.query(`
    SELECT to_jsonb(repository_files) payload
    FROM repository_files
    WHERE repository_id = $1
  `, [id]);

  const symbols = await pool.query(`
    SELECT to_jsonb(code_symbols) payload
    FROM code_symbols
    WHERE repository_id = $1
  `, [id]);

  const edges = await pool.query(`
    SELECT source, target, relationship, file_path, line
    FROM symbol_edges
    WHERE repository_id = $1
  `, [id]);

  const paths = files.rows
    .map((row) => row.payload.file_path ?? row.payload.path)
    .filter(Boolean);

  const packages = Array.from(
    new Set(
      paths
        .filter((path) => String(path).startsWith('packages/'))
        .map((path) => String(path).split('/').slice(0, 2).join('/')),
    ),
  ).sort();

  const applications = Array.from(
    new Set(
      paths
        .filter((path) => String(path).startsWith('apps/'))
        .map((path) => String(path).split('/').slice(0, 2).join('/')),
    ),
  ).sort();

  const importantFiles = paths.filter((path) =>
    /(index|server|route|config|schema|migration|provider|registry|agent|tool)/i.test(
      String(path),
    ),
  );

  const architecture = {
    repositoryId: id,
    generatedAt: new Date().toISOString(),
    packages,
    applications,
    importantFiles,
    fileCount: files.rows.length,
    symbolCount: symbols.rows.length,
    edgeCount: edges.rows.length,
    symbols: symbols.rows.slice(0, 500).map((row) => row.payload),
    edges: edges.rows.slice(0, 1000),
  };

  const serialized = JSON.stringify(architecture);
  const hash = createHash('sha256').update(serialized).digest('hex');

  await pool.query(`
    INSERT INTO repository_architecture_maps
      (repository_id, architecture, content_hash, updated_at)
    VALUES ($1, $2::jsonb, $3, now())
    ON CONFLICT (repository_id)
    DO UPDATE SET
      architecture = EXCLUDED.architecture,
      content_hash = EXCLUDED.content_hash,
      updated_at = now()
  `, [id, serialized, hash]);

  return architecture;
}

export async function getRepositoryArchitectureMap(repositoryId?: string) {
  const pool = getPool();

  const result = repositoryId
    ? await pool.query(`
        SELECT architecture
        FROM repository_architecture_maps
        WHERE repository_id = $1
      `, [repositoryId])
    : await pool.query(`
        SELECT architecture
        FROM repository_architecture_maps
        ORDER BY updated_at DESC
        LIMIT 1
      `);

  return result.rows[0]?.architecture ?? null;
}

