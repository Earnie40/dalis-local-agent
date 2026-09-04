/**
 * Phase 11 live proof: the smart-contract analysis path end to end.
 *
 *   local vulnerable fixture -> static inspection -> domain-scoped retrieval ->
 *   findings (observed vs inferred) -> remediation -> defensive test -> evidence
 *
 * Source-code analysis only. Nothing is deployed and no transaction is sent.
 */
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { SmartContractReviewService, formatReport } = await import('../packages/smart-contract/src/index.ts');
const { closePool } = await import('../packages/shared/src/db/pool.ts');

const FIXTURE = 'fixtures/contracts/VulnerableTreasury.sol';
const source = readFileSync(FIXTURE, 'utf8');

console.log(`Analyzing ${FIXTURE} (local test fixture — never deployed)\n`);

const service = new SmartContractReviewService();
const report = await service.review(source);

console.log(formatReport(report));

console.log('\nEVIDENCE HASHES (computed locally; nothing anchored on chain):');
console.log(`  analysisInputHash  ${report.evidence.analysisInputHash.digest}`);
console.log(`  analysisResultHash ${report.evidence.analysisResultHash.digest}`);
console.log(`  anchoredTxHash     ${report.evidence.analysisInputHash.anchoredTxHash ?? '(none — never submitted)'}`);

let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
};

console.log('\n--- objective validation ---');
const ac = report.findings.find((f) => f.category === 'access-control');
const re = report.findings.find((f) => f.category === 'reentrancy');

check('identifies the missing access control', ac?.functionName === 'setTreasury', ac?.functionName);
check('identifies the reentrancy ordering issue', re?.functionName === 'withdraw', re?.functionName);
check('does not flag the self-service deposit function',
  !report.findings.some((f) => f.functionName === 'deposit'));
check('cites retrieved smart-contract knowledge',
  report.findings.every((f) => f.support.length > 0),
  `${report.findings.map((f) => f.support.length).join('/')} passages`);
check('retrieved knowledge carries a license and hash',
  report.findings.every((f) => f.support.every((s) => s.license && s.contentHash)));
check('separates observed fact from inference',
  report.findings.every((f) => f.observed && f.inference && f.observed !== f.inference));
check('proposes remediation for every finding', report.findings.every((f) => f.remediation));
check('recommends a defensive test for every finding', report.findings.every((f) => f.suggestedTest));
check('reports its own limitations', report.limitations.notes.length > 0);
check('produces deterministic evidence hashes',
  /^[0-9a-f]{64}$/.test(report.evidence.analysisResultHash.digest));

// The same source must hash identically on a second run.
const second = await service.review(source, { retrieveSupport: false });
check('analysis is deterministic across runs',
  second.evidence.analysisResultHash.digest === report.evidence.analysisResultHash.digest);

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}`);
await closePool();
process.exit(failures ? 1 : 0);
