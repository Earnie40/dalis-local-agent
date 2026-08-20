#!/usr/bin/env node
/**
 * One-time PostgreSQL provisioning for DacaiLocalAgent.
 *
 * Creates a dedicated least-privileged role + database. The superuser password
 * is read from PGSUPERPASSWORD for this invocation only and is never written to
 * disk, logged, or stored in runtime configuration. The generated application
 * password is printed once as a DATABASE_URL for you to place in .env.
 *
 * Usage (PowerShell):
 *   $env:PGSUPERPASSWORD="<superuser password>"; node scripts/provision-db.mjs
 *   Remove-Item Env:PGSUPERPASSWORD
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

const PG_HOST = process.env.PGHOST ?? 'localhost';
const PG_PORT = process.env.PGPORT ?? '5433';
const PG_SUPERUSER = process.env.PGSUPERUSER ?? 'postgres';
const DB_NAME = process.env.DACAI_DB_NAME ?? 'dacai_local_agent';
const DB_ROLE = process.env.DACAI_DB_ROLE ?? 'dacai_local_agent';

const superPassword = process.env.PGSUPERPASSWORD;
if (!superPassword) {
  console.error('PGSUPERPASSWORD is not set. Set it for this invocation only, then clear it.');
  process.exit(1);
}

function isRunnable(candidate) {
  if (!candidate) return false;
  if (candidate !== 'psql' && !existsSync(candidate)) return false;
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

const psql = [
  process.env.PSQL_PATH,
  'psql',
  'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
  'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
].find(isRunnable);

if (!psql) {
  console.error('Could not locate a runnable psql. Set PSQL_PATH to its full path.');
  process.exit(1);
}

function runSql(sql, { database = 'postgres', password = superPassword, user = PG_SUPERUSER } = {}) {
  const result = spawnSync(
    psql,
    ['-h', PG_HOST, '-p', PG_PORT, '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { env: { ...process.env, PGPASSWORD: password }, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    // Avoid echoing the SQL, which may contain the generated password.
    console.error('psql command failed:', (result.stderr ?? '').trim());
    process.exit(1);
  }

  return (result.stdout ?? '').trim();
}

const roleExists = runSql(`SELECT 1 FROM pg_roles WHERE rolname = '${DB_ROLE}'`) === '1';
const appPassword = randomBytes(24).toString('base64url');

if (roleExists) {
  console.log(`Role "${DB_ROLE}" already exists — rotating its password.`);
  runSql(`ALTER ROLE ${DB_ROLE} WITH LOGIN PASSWORD '${appPassword}'`);
} else {
  console.log(`Creating role "${DB_ROLE}".`);
  runSql(`CREATE ROLE ${DB_ROLE} WITH LOGIN PASSWORD '${appPassword}'`);
}

const dbExists = runSql(`SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`) === '1';

if (dbExists) {
  console.log(`Database "${DB_NAME}" already exists — leaving it in place.`);
} else {
  console.log(`Creating database "${DB_NAME}" owned by "${DB_ROLE}".`);
  runSql(`CREATE DATABASE ${DB_NAME} OWNER ${DB_ROLE}`);
}

runSql(`GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_ROLE}`);
runSql(`GRANT ALL ON SCHEMA public TO ${DB_ROLE}`, { database: DB_NAME });

// pgvector lives in the dedicated database only; requires superuser to install.
let vectorAvailable = false;
try {
  runSql('CREATE EXTENSION IF NOT EXISTS vector', { database: DB_NAME });
  vectorAvailable = true;
} catch {
  vectorAvailable = false;
}

const databaseUrl = `postgresql://${DB_ROLE}:${appPassword}@${PG_HOST}:${PG_PORT}/${DB_NAME}`;

console.log('\nProvisioning complete.');
console.log(`pgvector extension: ${vectorAvailable ? 'enabled' : 'NOT enabled (retrieval will fall back to keyword search)'}`);
console.log('\nAdd this line to your .env file (it is the only copy of this password):\n');
console.log(`DATABASE_URL=${databaseUrl}`);
console.log('\nThen clear the superuser password from your shell:');
console.log('  Remove-Item Env:PGSUPERPASSWORD');
