/**
 * Ingests the curated smart-contract corpus through the real ingestion service.
 *
 * Content-hashed and idempotent: a second run reports duplicates rather than
 * creating second copies.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { KnowledgeIngestionService } = await import('../packages/rag/src/index.ts');
const { closePool } = await import('../packages/shared/src/db/pool.ts');

const CORPUS_DIR = 'corpus/smart-contract';
const LICENSE = 'DACAIS-internal-original';

const service = new KnowledgeIngestionService();
const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();

let ingested = 0;
let duplicate = 0;
let rejected = 0;

for (const file of files) {
  const content = readFileSync(join(CORPUS_DIR, file), 'utf8');
  const title = content.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim() ?? file;

  const result = await service.ingest({
    content,
    format: 'md',
    source: `${CORPUS_DIR}/${file}`,
    title,
    license: LICENSE,
    domainId: 'smart-contract',
    tags: ['smart-contract', 'defensive-review'],
  });

  if (result.status === 'ingested') ingested += 1;
  else if (result.status === 'duplicate') duplicate += 1;
  else rejected += 1;

  const detail = result.status === 'ingested'
    ? `${result.chunkCount} chunks · sha256 ${result.contentHash.slice(0, 12)}… · secrets redacted ${result.secretsRedacted}`
    : result.rejectionReason ?? `doc ${result.documentId}`;
  console.log(`${result.status.toUpperCase().padEnd(9)} ${file.padEnd(42)} ${detail}`);
}

console.log(`\ningested=${ingested} duplicate=${duplicate} rejected=${rejected}`);
await closePool();
process.exit(rejected ? 1 : 0);
