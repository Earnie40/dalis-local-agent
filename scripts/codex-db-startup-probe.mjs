const url = new URL(process.env.DATABASE_URL);
url.hostname = process.argv[2] ?? url.hostname;
process.env.DATABASE_URL = url.toString();

const { verifyConnection, runMigrations, closePool } = await import('../packages/shared/src/index.ts');
const started = Date.now();

try {
  await verifyConnection(process.env.DATABASE_URL);
  const verified = Date.now();
  const result = await runMigrations();
  console.log(JSON.stringify({
    ok: true,
    host: url.hostname,
    verifyMs: verified - started,
    migrationMs: Date.now() - verified,
    applied: result.applied.length,
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    host: url.hostname,
    elapsedMs: Date.now() - started,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
  }));
  process.exitCode = 1;
} finally {
  await closePool().catch(() => undefined);
}
