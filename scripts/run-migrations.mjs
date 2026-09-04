/**
 * Applies pending SQL migrations without starting the server.
 *
 * The server already runs migrations at boot; this exists so schema changes can
 * be applied and verified independently of a running API process.
 */
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { runMigrations } = await import('../packages/shared/src/db/migrate.ts');
const { closePool, redactDatabaseUrl } = await import('../packages/shared/src/db/pool.ts');

console.log(`target: ${redactDatabaseUrl(process.env.DATABASE_URL ?? '')}`);

try {
  const result = await runMigrations();
  console.log(`applied:         ${result.applied.join(', ') || '(none)'}`);
  console.log(`already current: ${result.alreadyCurrent.length}`);
} catch (error) {
  console.error(`MIGRATION FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
