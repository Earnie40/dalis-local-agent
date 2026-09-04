import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeSolidity,
  formatSuiteScore,
  parseSolidity,
  scoreSuite,
  stripCommentsAndStrings,
  type EvalCase,
} from '@dacai-local-agent/smart-contract';

const FIXTURES = join(process.cwd(), 'fixtures', 'contracts');
const load = (file: string) => readFileSync(join(FIXTURES, file), 'utf8');

/**
 * The held-out evaluation suite. These contracts are never ingested into the
 * retrieval corpus — see fixtures/contracts/README.md and the contamination
 * test at the bottom of this file.
 */
const SUITE: EvalCase[] = [
  {
    id: 'sc-01',
    name: 'VulnerableTreasury',
    capability: 'access-control + reentrancy',
    source: load('VulnerableTreasury.sol'),
    expected: [
      { category: 'access-control', functionName: 'setTreasury', severity: 'high' },
      { category: 'reentrancy', functionName: 'withdraw', severity: 'high' },
    ],
  },
  {
    id: 'sc-02',
    name: 'UnsafeSettlement',
    capability: 'signature / replay',
    source: load('UnsafeSettlement.sol'),
    expected: [
      { category: 'signature-replay', functionName: 'settleWithSig', severity: 'high' },
      { category: 'signature-replay', functionName: 'settleWithSig', severity: 'critical' },
    ],
  },
  {
    id: 'sc-03',
    name: 'SpotPriceLending',
    capability: 'oracle manipulation',
    source: load('SpotPriceLending.sol'),
    // `borrow` is legitimately permissionless; the defect here is the oracle,
    // not access control. Expecting an access-control finding would reward the
    // analyzer for over-reporting.
    expected: [
      { category: 'oracle-manipulation', functionName: 'borrow', severity: 'critical' },
    ],
  },
  {
    id: 'sc-04',
    name: 'UnprotectedUpgradeable',
    capability: 'proxy / initializer',
    source: load('UnprotectedUpgradeable.sol'),
    expected: [
      { category: 'upgradeability', functionName: 'initialize', severity: 'critical' },
      { category: 'access-control', functionName: 'initialize', severity: 'high' },
    ],
  },
  {
    id: 'sc-05',
    name: 'TxOriginAuth',
    capability: 'authorization',
    source: load('TxOriginAuth.sol'),
    expected: [{ category: 'authorization', functionName: 'sweep', severity: 'high' }],
  },
  {
    id: 'sc-06',
    name: 'SafeTreasury',
    capability: 'recognize a safe contract',
    source: load('SafeTreasury.sol'),
    expected: [],
    expectClean: true,
  },
  {
    id: 'sc-07',
    name: 'UncheckedPayout',
    capability: 'unsafe external-call handling',
    source: load('UncheckedPayout.sol'),
    expected: [{ category: 'unchecked-call', functionName: 'payout', severity: 'medium' }],
  },
  {
    id: 'sc-08',
    name: 'ArbitraryDelegatecall',
    capability: 'proxy / initializer',
    source: load('ArbitraryDelegatecall.sol'),
    expected: [{ category: 'delegatecall', functionName: 'execute', severity: 'critical' }],
  },
  {
    id: 'sc-09',
    name: 'BatchPushPayments',
    capability: 'denial of service',
    source: load('BatchPushPayments.sol'),
    expected: [{ category: 'denial-of-service', functionName: 'distribute', severity: 'medium' }],
  },
  {
    id: 'sc-10',
    name: 'SafeUpgradeable',
    capability: 'recognize a safe contract',
    source: load('SafeUpgradeable.sol'),
    expected: [],
    expectClean: true,
  },
  {
    id: 'sc-11',
    name: 'SafeSignedSettlement',
    capability: 'recognize a safe contract',
    source: load('SafeSignedSettlement.sol'),
    expected: [],
    expectClean: true,
  },
  {
    // Deliberately included even though NO detector exists for token accounting.
    // A suite that only contains what the analyzer already handles reports a
    // flattering number and measures nothing. This case is expected to be a
    // false negative, and it is what keeps overall recall honest.
    id: 'sc-12',
    name: 'FeeOnTransferVault',
    capability: 'token accounting / invariants',
    source: load('FeeOnTransferVault.sol'),
    expected: [
      { category: 'token-accounting', functionName: 'deposit', severity: 'high' },
      // Also a genuine CEI violation: transferFrom can hand control to the
      // sender with a callback-capable token, before `credited` is updated.
      { category: 'reentrancy', functionName: 'deposit', severity: 'high' },
    ],
  },
];

describe('Solidity structural reader', () => {
  it('blanks comments without shifting line numbers', () => {
    const source = 'line1\n// a comment\nline3';
    const stripped = stripCommentsAndStrings(source);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).not.toContain('comment');
  });

  it('does not treat commented-out code as real code', () => {
    const source = `contract C {
      // function ghost() external { selfdestruct(payable(msg.sender)); }
      function real() external {}
    }`;
    expect(parseSolidity(source).functions.map((f) => f.name)).toEqual(['real']);
  });

  it('isolates function bodies including nested braces', () => {
    const parsed = parseSolidity(load('VulnerableTreasury.sol'));
    const withdraw = parsed.functions.find((f) => f.name === 'withdraw');
    expect(withdraw?.body).toContain('balances[msg.sender] = 0');
    expect(withdraw?.body).not.toContain('function deposit');
  });

  it('skips bodyless interface declarations', () => {
    expect(parseSolidity(load('VulnerableTreasury.sol')).functions.map((f) => f.name)).not.toContain('transfer');
  });
});

describe('smart-contract analyzer', () => {
  it('separates observed fact from inference on every finding', () => {
    const { findings } = analyzeSolidity(load('VulnerableTreasury.sol'));
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.observed).toBeTruthy();
      expect(finding.inference).toBeTruthy();
      expect(finding.observed).not.toBe(finding.inference);
      expect(finding.remediation).toBeTruthy();
      expect(finding.suggestedTest).toBeTruthy();
    }
  });

  it('marks a finding as possible rather than confirmed when reachability is unproven', () => {
    // A guarded reentrancy ordering issue is real but mitigated, so it must not
    // be reported with the same status as an unguarded one.
    const guarded = `contract G {
      mapping(address=>uint) bal;
      function withdraw() external nonReentrant {
        (bool ok,) = msg.sender.call{value: bal[msg.sender]}("");
        require(ok);
        bal[msg.sender] = 0;
      }
    }`;
    const finding = analyzeSolidity(guarded).findings.find((f) => f.category === 'reentrancy');
    expect(finding?.status).toBe('possible');
    expect(finding?.severity).toBe('medium');
  });

  it('always reports what it could not analyse', () => {
    const result = analyzeSolidity(load('VulnerableTreasury.sol'));
    expect(result.limitations.notes.join(' ')).toContain('deployment configuration');
  });

  it('flags assembly as unanalysed rather than passing over it silently', () => {
    const result = analyzeSolidity('contract A { function f() external { assembly { sstore(0, 1) } } }');
    expect(result.limitations.assemblyPresent).toBe(true);
    expect(result.limitations.notes.join(' ')).toContain('assembly');
  });

  it('does not report findings on a safe contract', () => {
    expect(analyzeSolidity(load('SafeTreasury.sol')).findings).toHaveLength(0);
  });
});

describe('held-out evaluation suite', () => {
  const score = scoreSuite(SUITE);

  it('prints an objective score', () => {
    // Surfaced in test output so the numbers are visible, not buried.
    console.log('\n' + formatSuiteScore(score) + '\n');
    expect(score.cases).toHaveLength(SUITE.length);
  });

  it('detects the access-control mistake', () => {
    const c = score.cases.find((x) => x.caseId === 'sc-01')!;
    expect(c.matched.some((m) => m.expected.category === 'access-control')).toBe(true);
  });

  it('detects reentrancy risk from unsafe external-call ordering', () => {
    const c = score.cases.find((x) => x.caseId === 'sc-01')!;
    expect(c.matched.some((m) => m.expected.category === 'reentrancy')).toBe(true);
  });

  it('identifies signature / replay issues', () => {
    const c = score.cases.find((x) => x.caseId === 'sc-02')!;
    expect(c.truePositives).toBeGreaterThanOrEqual(1);
  });

  it('reasons about oracle manipulation', () => {
    const c = score.cases.find((x) => x.caseId === 'sc-03')!;
    expect(c.matched.some((m) => m.expected.category === 'oracle-manipulation')).toBe(true);
  });

  it('reasons about proxy / initializer risk', () => {
    const c = score.cases.find((x) => x.caseId === 'sc-04')!;
    expect(c.matched.some((m) => m.expected.category === 'upgradeability')).toBe(true);
  });

  it('recognizes a safe contract without inventing findings', () => {
    const c = score.cases.find((x) => x.caseId === 'sc-06')!;
    expect(c.falsePositives).toBe(0);
    expect(score.cleanContractAccuracy).toBe(1);
  });

  it('meets the recall and precision thresholds the domain gate requires', () => {
    // These are the numbers the promotion gate reads. They are asserted so a
    // regression in the analyzer fails the build rather than quietly lowering
    // the domain's measured capability.
    expect(score.recall).not.toBeNull();
    expect(score.precision).not.toBeNull();
    // Precision must stay high: over-reporting trains a reviewer to skim.
    expect(score.precision!).toBeGreaterThanOrEqual(0.9);
    // Recall is deliberately NOT 1.0 -- the suite contains a defect class with
    // no detector (sc-12, token accounting). Asserting a floor rather than a
    // perfect score keeps the gap visible instead of tuning it away.
    expect(score.recall!).toBeGreaterThanOrEqual(0.8);
    expect(score.cleanContractAccuracy).toBe(1);
  });
});
