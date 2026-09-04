/**
 * Phase 10 live proof: DomainId actually affects retrieval.
 *
 * Same query, three scopes:
 *   1. scoped to smart-contract   -> ALPHA / SETTLER_ROLE found, with provenance
 *   2. scoped to robotics         -> no smart-contract knowledge returned
 *   3. unscoped                   -> existing behaviour preserved
 */
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { RagService } = await import('../packages/rag/src/index.ts');
const { closePool } = await import('../packages/shared/src/db/pool.ts');

const rag = new RagService();
const QUERY = 'What authorization is required before ALPHA can settle?';

const show = (label, hits) => {
  console.log(`\n--- ${label} ---`);
  if (!hits.length) {
    console.log('  (no results)');
    return;
  }
  for (const hit of hits) {
    console.log(`  [${hit.distance.toFixed(4)}] ${hit.title ?? hit.source}`);
    console.log(`     domain=${hit.domainId ?? '(none)'} license=${hit.provenance.license ?? '(none)'} sha256=${(hit.provenance.contentHash ?? '').slice(0, 12)}…`);
  }
};

let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
};

console.log(`QUERY: ${QUERY}`);

// 1. Correct domain
const scoped = await rag.search(QUERY, { domainIds: ['smart-contract'] }, 3);
show('scoped to smart-contract', scoped);
const top = scoped[0];
check('returns a result when scoped to smart-contract', scoped.length > 0);
check('top result contains SETTLER_ROLE', Boolean(top?.content.includes('SETTLER_ROLE')));
check('every result is tagged smart-contract', scoped.every((h) => h.domainId === 'smart-contract'));
check('provenance is returned with the result', Boolean(top?.provenance.license && top?.provenance.contentHash));

// 2. Unrelated domain — the actual isolation proof
const wrongDomain = await rag.search(QUERY, { domainIds: ['robotics'] }, 3);
show('scoped to robotics (unrelated)', wrongDomain);
check('unrelated domain returns no smart-contract knowledge',
  !wrongDomain.some((h) => h.domainId === 'smart-contract'),
  `${wrongDomain.length} result(s)`);

// 3. Cross-domain, explicitly requested
const cross = await rag.search(QUERY, { domainIds: ['smart-contract', 'robotics'] }, 3);
show('explicit cross-domain [smart-contract, robotics]', cross);
check('explicit cross-domain retrieval finds the knowledge', cross.some((h) => h.domainId === 'smart-contract'));

// 4. Unscoped — existing behaviour must not regress
const unscoped = await rag.search(QUERY, {}, 3);
show('unscoped (pre-domain behaviour)', unscoped);
check('unscoped query still returns results', unscoped.length > 0);

// 5. Invalid domain is rejected, not silently empty
let rejected = false;
try {
  await rag.search(QUERY, { domainIds: ['not-a-domain'] }, 3);
} catch (error) {
  rejected = error.name === 'RetrievalScopeError';
}
check('invalid DomainId is rejected', rejected);

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}`);
await closePool();
process.exit(failures ? 1 : 0);
