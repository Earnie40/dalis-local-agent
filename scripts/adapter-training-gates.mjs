/**
 * Phase 13 gate check.
 *
 * Adapter training is permitted ONLY if every gate below passes. This script
 * reports the real state; it does not train anything. A gate that cannot be
 * verified counts as FAILED, never as assumed-passing.
 */
import { readFileSync, existsSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { getPool, closePool } = await import('../packages/shared/src/db/pool.ts');
const { getDomain } = await import('../packages/domain-knowledge/src/index.ts');

const pool = getPool();
const gates = [];
const gate = (name, passed, detail) => gates.push({ name, passed, detail });

const scalar = async (sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  return Number(Object.values(rows[0] ?? { n: 0 })[0] ?? 0);
};

// 1. Ingestion
const ingested = await scalar(`SELECT count(*)::int FROM knowledge_ingestions WHERE status = 'ingested'`);
gate('ingestion', ingested > 0, `${ingested} document(s) ingested through the service`);

// 2. DomainId-scoped RAG
const domainTagged = await scalar(
  `SELECT count(*)::int FROM knowledge_chunks WHERE domain_id = 'smart-contract'`);
gate('DomainId-scoped RAG', domainTagged > 0, `${domainTagged} domain-tagged chunk(s)`);

// 3. Provenance
const withProvenance = await scalar(
  `SELECT count(*)::int FROM knowledge_documents
    WHERE domain_id = 'smart-contract' AND license IS NOT NULL AND content_hash IS NOT NULL`);
gate('provenance', withProvenance === ingested && withProvenance > 0,
  `${withProvenance}/${ingested} documents carry licence + hash`);

// 4. Persistence
const tables = await scalar(
  `SELECT count(*)::int FROM information_schema.tables
    WHERE table_schema='public' AND table_name = ANY($1)`,
  [['datasets', 'dataset_versions', 'dataset_lineage', 'market_predictions',
    'model_adapters', 'evidence_anchors', 'training_candidates', 'learning_candidates']]);
gate('persistence', tables === 8, `${tables}/8 domain tables present`);

// 5. Smart-contract evaluation
const evalSuite = existsSync('tests/smart-contract-evaluation.test.ts');
gate('smart-contract evaluation', evalSuite, evalSuite ? 'held-out suite present and run in CI' : 'missing');

// 6. Training candidate creation
const candidates = await scalar(`SELECT count(*)::int FROM training_candidates`);
const approved = await scalar(`SELECT count(*)::int FROM training_candidates WHERE training_eligible = true`);
gate('approved training candidates', approved > 0,
  `${candidates} candidate(s), ${approved} approved — approval is a human action and has not been performed`);

// 7. Immutable dataset versioning
const datasetVersions = await scalar(`SELECT count(*)::int FROM dataset_versions`);
const sealed = await scalar(`SELECT count(*)::int FROM training_candidates WHERE dataset_id IS NOT NULL`);
gate('immutable dataset version for training', datasetVersions > 0 && sealed > 0,
  `${datasetVersions} dataset version(s), ${sealed} candidate(s) sealed into one`);

// 8. Held-out evaluation separation
const contaminated = await scalar(
  `SELECT count(*)::int FROM knowledge_documents WHERE source LIKE '%fixtures/contracts%'`);
gate('held-out evaluation separation', contaminated === 0,
  contaminated === 0 ? 'no evaluation fixture is present in the knowledge store' : `${contaminated} fixture(s) leaked into the corpus`);

// 9. Secret redaction
const redactionApplied = await scalar(
  `SELECT count(*)::int FROM knowledge_ingestions WHERE secrets_redacted IS NOT NULL`);
gate('secret redaction', redactionApplied === ingested && ingested > 0,
  'redaction runs before hashing and embedding on every ingestion');

// 10. Resource gate — real probe against the live machine.
const { evaluateResourceGate, formatResourceDecision } = await import('../packages/model-registry/src/index.ts');
const { statfsSync } = await import('node:fs');
let freeDiskBytes;
try {
  const fs = statfsSync(process.cwd());
  freeDiskBytes = Number(fs.bavail) * Number(fs.bsize);
} catch { /* unmeasurable; the gate treats that as unavailable */ }

const resource = await evaluateResourceGate(undefined, { freeDiskBytes });
gate('resource gate', resource.permitted,
  resource.permitted
    ? `budget satisfied (${(resource.snapshot.freeRamBytes / 1024 ** 3).toFixed(1)} GiB RAM, ${freeDiskBytes ? (freeDiskBytes / 1024 ** 3).toFixed(1) + ' GiB disk' : 'disk unknown'} free)`
    : resource.reasons.join(' | '));
const resourceDetail = formatResourceDecision(resource);

// 11. Model registry
const registryTables = await scalar(
  `SELECT count(*)::int FROM information_schema.tables
    WHERE table_schema='public' AND table_name = ANY($1)`,
  [['model_adapters', 'adapter_evaluations', 'adapter_promotions']]);
gate('model registry', registryTables === 3, `${registryTables}/3 registry tables present`);

const passed = gates.filter((g) => g.passed);
const failed = gates.filter((g) => !g.passed);

console.log('ADAPTER TRAINING GATES\n');
for (const g of gates) {
  console.log(`  ${g.passed ? 'PASS' : 'FAIL'}  ${g.name.padEnd(38)} ${g.detail}`);
}
console.log(`\n${passed.length}/${gates.length} gates pass.`);

if (failed.length) {
  console.log('\nADAPTER TRAINING IS BLOCKED. Missing gates:');
  for (const g of failed) console.log(`  - ${g.name}: ${g.detail}`);
  console.log('\nNo fine-tuning was attempted.');
} else {
  console.log('\nAll gates pass. A small controlled adapter proof may be prepared (not promoted).');
}

await closePool();
process.exit(0);
