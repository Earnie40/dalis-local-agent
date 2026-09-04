import type { Severity } from '../analyzer.js';

/**
 * HELD-OUT evaluation cases for the LLM-in-the-loop harness.
 *
 * These contracts are separate from the 12 deterministic fixtures used to
 * develop the analyzers (fixtures/contracts). They live in evaluation/heldout/
 * and are never ingested into the retrieval corpus, so neither the analyzer's
 * detectors nor the RAG store can have been tuned on their expected labels.
 *
 * The expected labels below are ground truth for scoring only. The runner never
 * concatenates them into the model prompt.
 */

export interface HeldoutExpectedFinding {
  /** Free-form category, aligned with the analyzer categories where possible. */
  category: string;
  /** The function the issue lives in, where function-specific. */
  functionName?: string;
  severity: Severity;
}

export interface HeldoutCase {
  id: string;
  name: string;
  /** The banner comment / capability this case probes. */
  capability: string;
  /** path relative to the repository root. */
  file: string;
  expected: HeldoutExpectedFinding[];
  /** True for deliberately safe contracts; a finding here is a false positive. */
  expectClean?: boolean;
  /**
   * True for risky-but-not-proven contracts. Ground truth is intentionally not
   * a crisp expectation, so these are excluded from aggregate precision/recall
   * and reported separately.
   */
  ambiguous?: boolean;
  note?: string;
}

export const HELDOUT_CASES: HeldoutCase[] = [
  {
    id: 'ho-01',
    name: 'DigitalRewardsVault',
    capability: 'reentrancy (CEI)',
    file: 'evaluation/heldout/ho-reentrancy.sol',
    expected: [{ category: 'reentrancy', functionName: 'claimReward', severity: 'high' }],
    note: 'External call before state update on a balance-bearing function.',
  },
  {
    id: 'ho-02',
    name: 'ProtocolAdmin',
    capability: 'access control',
    file: 'evaluation/heldout/ho-access-control.sol',
    expected: [
      { category: 'access-control', functionName: 'setFeeRecipient', severity: 'high' },
      { category: 'access-control', functionName: 'setFeeBps', severity: 'high' },
    ],
    note: 'Two privileged setters lack authorization.',
  },
  {
    id: 'ho-03',
    name: 'BatchAirdrop',
    capability: 'unsafe external call',
    file: 'evaluation/heldout/ho-unsafe-call.sol',
    expected: [{ category: 'unchecked-call', functionName: 'airdrop', severity: 'medium' }],
    note: 'Ignored transfer() return value / gas grief.',
  },
  {
    id: 'ho-04',
    name: 'SignedTransfer',
    capability: 'signature replay',
    file: 'evaluation/heldout/ho-replay.sol',
    expected: [{ category: 'signature-replay', functionName: 'transferWithSig', severity: 'high' }],
    note: 'No nonce / spent-marker, so a signature replays.',
  },
  {
    id: 'ho-05',
    name: 'RogueUpgradeableProxy',
    capability: 'proxy / storage layout',
    file: 'evaluation/heldout/ho-proxy-slot.sol',
    ambiguous: true,
    expected: [],
    note: 'Risky-but-not-proven storage-layout hazard; not a confirmed vulnerability.',
  },
  {
    id: 'ho-06',
    name: 'LidoShareVault',
    capability: 'fee-on-transfer accounting',
    file: 'evaluation/heldout/ho-fee-on-transfer.sol',
    expected: [{ category: 'token-accounting', functionName: 'mint', severity: 'high' }],
    note: 'Credits requested amount, not received amount -> insolvency with FoT tokens.',
  },
  {
    id: 'ho-07',
    name: 'SafePersonalEscrow',
    capability: 'recognize a safe contract',
    file: 'evaluation/heldout/ho-safe-escrow.sol',
    expected: [],
    expectClean: true,
    note: 'CEI ordering plus a reentrancy guard; must report no finding.',
  },
  {
    id: 'ho-08',
    name: 'AdminGuardedTokenStream',
    capability: 'recognize a safe contract',
    file: 'evaluation/heldout/ho-safe-token-stream.sol',
    expected: [],
    expectClean: true,
    note: 'Admin-guarded, checked transfer, idempotent; must report no finding.',
  },
  {
    id: 'ho-09',
    name: 'SpotOracleLoans',
    capability: 'oracle manipulation (ambiguous)',
    file: 'evaluation/heldout/ho-ambiguous-oracle.sol',
    ambiguous: true,
    expected: [{ category: 'oracle-manipulation', functionName: 'borrow', severity: 'medium' }],
    note: 'Single pull oracle without manipulation protection — risky, not proven critical.',
  },
];

/** Files to guard against any future ingestion of the held-out set. */
export const HELDOUT_FILES = HELDOUT_CASES.map((c) => c.file);