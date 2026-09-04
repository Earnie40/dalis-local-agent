import { parseSolidity, type ParsedContract, type SolidityFunction } from './parser.js';

/**
 * Defensive static analysis for Solidity source.
 *
 * Scope: source-code review only. This never deploys, never sends a transaction,
 * and never targets a remote address. It is a review aid for code you are
 * authorized to analyse.
 *
 * Every finding carries a `status` separating what was observed from what is
 * suspected. Reporting a possible risk as a confirmed vulnerability is itself a
 * defect in the analysis, so the distinction is a required field rather than a
 * matter of wording.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type FindingStatus =
  /** The defect is visible in the source and the path to impact is identified. */
  | 'confirmed'
  /** A risk indicator is present but reachability depends on unreviewed context. */
  | 'possible';

export type FindingCategory =
  | 'access-control'
  | 'reentrancy'
  | 'unchecked-call'
  | 'signature-replay'
  | 'oracle-manipulation'
  | 'upgradeability'
  | 'delegatecall'
  | 'token-accounting'
  | 'denial-of-service'
  | 'authorization';

export interface Finding {
  id: string;
  category: FindingCategory;
  status: FindingStatus;
  severity: Severity;
  /** 0..1 — how confident the detector is, kept separate from severity. */
  confidence: number;
  title: string;
  /** What was literally observed in the source. */
  observed: string;
  /** What the analyzer infers from it. Never stated as fact. */
  inference: string;
  functionName?: string;
  line?: number;
  remediation: string;
  /** A defensive test that should fail before the fix and pass after. */
  suggestedTest: string;
  /** Retrieval query used to attach supporting knowledge. */
  knowledgeQuery: string;
}

export interface AnalysisLimitations {
  /** True when the source contains assembly this reader cannot analyse. */
  assemblyPresent: boolean;
  /** Base contracts whose modifiers/state were not available. */
  unresolvedBaseContracts: string[];
  notes: string[];
}

export interface AnalysisResult {
  contractName?: string;
  findings: Finding[];
  functionsAnalyzed: number;
  limitations: AnalysisLimitations;
}

const PRIVILEGED_NAME = /^(set|update|withdraw|mint|burn|pause|unpause|upgrade|transfer|settle|anchor|grant|revoke|rescue|sweep|initialize|configure|add|remove|enable|disable)/i;
const GUARD_HINT = /\b(only[A-Z]\w*|require\s*\(\s*msg\.sender|_checkRole|hasRole|_checkOwner|authorized|onlyRole|initializer|reinitializer)\b/;
const EXTERNAL_CALL = /(\.call\s*\{|\.call\s*\(|\.delegatecall\s*\(|\.transfer\s*\(|\.send\s*\(|safeTransfer|safeTransferFrom|\.transferFrom\s*\(|\.onERC721Received|\.functionCall)/;
const STATE_WRITE = /(\w+\s*\[[^\]]*\]\s*(?:=|\+=|-=)|^\s*\w+\s*=\s|delete\s+\w+)/m;

function isStateChanging(fn: SolidityFunction): boolean {
  return fn.stateMutability !== 'view' && fn.stateMutability !== 'pure';
}

function isExternallyReachable(fn: SolidityFunction): boolean {
  return fn.visibility === 'public' || fn.visibility === 'external';
}

/**
 * A function that moves value to `msg.sender`, sized from state keyed by
 * `msg.sender`, is self-service — a user acting on their own balance. Such
 * functions are *correctly* permissionless, so requiring access control on them
 * produces exactly the kind of false positive that trains a reviewer to ignore
 * the tool.
 */
function isSelfService(fn: SolidityFunction): boolean {
  const paysCaller = /(msg\.sender\s*\.\s*call|payable\s*\(\s*msg\.sender\s*\)|_mint\s*\(\s*msg\.sender|safeTransfer\s*\(\s*msg\.sender)/.test(fn.body);
  const readsCallerState = /\w+\s*\[\s*msg\.sender\s*\]/.test(fn.body);
  return paysCaller && readsCallerState;
}

/**
 * Whether the function has *some* authorization mechanism — not whether it is a
 * correct one.
 *
 * A defective guard (tx.origin, a replayable signature) is reported by its own
 * detector with the right category and severity. Also emitting "no access
 * control" for the same function would be double-reporting: two findings for one
 * defect, which inflates the count and trains a reviewer to skim.
 */
function hasGuard(fn: SolidityFunction, contract: ParsedContract): boolean {
  if (GUARD_HINT.test(fn.attributes) || GUARD_HINT.test(fn.body)) return true;

  // tx.origin is a broken check, reported separately as an authorization finding.
  if (/require\s*\(\s*tx\.origin/.test(fn.body)) return true;

  // Signature-based authorization: the recovered signer is compared against
  // something. Weaknesses in that scheme are reported as signature-replay.
  if (/\becrecover\s*\(/.test(fn.body) && /\bsigner\b\s*(?:==|!=)|require\s*\(\s*\w*[Ss]igner/.test(fn.body)) {
    return true;
  }

  // A modifier defined in this file or plausibly inherited counts as a guard
  // indicator; correctness of that modifier is a separate question.
  return fn.modifiers.some((m) => contract.definedModifiers.includes(m) || /^only/i.test(m));
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Resets finding ids so analyses are deterministic across runs. */
export function resetFindingIds(): void {
  counter = 0;
}

export function analyzeSolidity(source: string): AnalysisResult {
  resetFindingIds();
  const contract = parseSolidity(source);
  const findings: Finding[] = [];

  for (const fn of contract.functions) {
    // --- access control -------------------------------------------------
    if (isExternallyReachable(fn) && isStateChanging(fn) && !fn.isConstructor && !hasGuard(fn, contract)) {
      const privileged = PRIVILEGED_NAME.test(fn.name);
      const movesValue = /(\.call\s*\{|\.transfer\s*\(|safeTransfer|_mint|_burn)/.test(fn.body);
      if ((privileged || movesValue) && !isSelfService(fn)) {
        findings.push({
          id: nextId('AC'),
          category: 'access-control',
          status: 'confirmed',
          severity: movesValue ? 'critical' : 'high',
          confidence: privileged && movesValue ? 0.9 : 0.7,
          title: `\`${fn.name}\` is externally callable with no access control`,
          observed: `Function \`${fn.name}\` is ${fn.visibility}, changes state, and carries no modifier or msg.sender check.`,
          inference: movesValue
            ? 'Any address appears able to call this and move value.'
            : 'Any address appears able to change privileged configuration.',
          functionName: fn.name,
          line: fn.line,
          remediation: `Restrict \`${fn.name}\` to the role that should hold this authority, e.g. \`onlyRole(SETTLER_ROLE)\` or \`onlyOwner\`. Prefer a narrow role over contract-wide ownership.`,
          suggestedTest: `Assert that a call to \`${fn.name}\` from an unprivileged address reverts, and that a call from the privileged role succeeds.`,
          knowledgeQuery: 'access control missing modifier privileged function ownership roles',
        });
      }
    }

    // --- unprotected initializer ---------------------------------------
    if (/^initialize/i.test(fn.name) && isExternallyReachable(fn) && !/\b(initializer|reinitializer)\b/.test(fn.attributes)) {
      findings.push({
        id: nextId('UP'),
        category: 'upgradeability',
        status: 'confirmed',
        severity: 'critical',
        confidence: 0.85,
        title: `\`${fn.name}\` is not protected by an initializer modifier`,
        observed: `\`${fn.name}\` is ${fn.visibility} and its attributes do not include \`initializer\`.`,
        inference: 'If this contract sits behind a proxy, an unprotected initializer may let any address claim administrative roles.',
        functionName: fn.name,
        line: fn.line,
        remediation: 'Add the `initializer` modifier, and call `_disableInitializers()` in the implementation constructor so the logic contract cannot be initialized directly.',
        suggestedTest: 'Assert that a second call to initialize() reverts, and that the implementation contract cannot be initialized directly.',
        knowledgeQuery: 'upgradeable initializer proxy unprotected initialize disableInitializers',
      });
    }

    // --- reentrancy / CEI ordering --------------------------------------
    const callMatch = fn.body.match(EXTERNAL_CALL);
    if (callMatch && isStateChanging(fn)) {
      const callIndex = fn.body.indexOf(callMatch[0]);
      const after = fn.body.slice(callIndex + callMatch[0].length);
      const writesAfter = STATE_WRITE.test(after);
      const guarded = /nonReentrant/.test(fn.attributes);

      if (writesAfter) {
        findings.push({
          id: nextId('RE'),
          category: 'reentrancy',
          status: guarded ? 'possible' : 'confirmed',
          severity: guarded ? 'medium' : 'high',
          confidence: guarded ? 0.5 : 0.8,
          title: `\`${fn.name}\` writes state after an external call`,
          observed: `In \`${fn.name}\`, \`${callMatch[0].trim()}\` occurs before a subsequent state assignment.`,
          inference: guarded
            ? 'A nonReentrant guard is present, so single-function reentrancy is mitigated, but the ordering still permits cross-function reentrancy against shared state.'
            : 'The callee may re-enter while state still reflects the pre-call world.',
          functionName: fn.name,
          line: fn.line,
          remediation: 'Reorder to Checks-Effects-Interactions: validate, then update all state, then make the external call. Keep any reentrancy guard as defence in depth rather than as the fix.',
          suggestedTest: 'Add an attacker contract whose receive() re-enters this function, and assert the reentrant call reverts and balances are unchanged.',
          knowledgeQuery: 'reentrancy checks effects interactions external call before state update',
        });
      }
    }

    // --- unchecked low-level call ---------------------------------------
    const lowLevel = fn.body.match(/(\w+)\.call\s*\{[^}]*\}\s*\(/);
    if (lowLevel && !/\b(bool\s+\w+\s*,|require\s*\(\s*\w*(ok|success)|if\s*\(\s*!?\s*\w*(ok|success))/i.test(fn.body)) {
      findings.push({
        id: nextId('UC'),
        category: 'unchecked-call',
        status: 'confirmed',
        severity: 'medium',
        confidence: 0.7,
        title: `Return value of a low-level call in \`${fn.name}\` is not checked`,
        observed: `\`${fn.name}\` performs a low-level \`.call{...}(...)\` without capturing or checking the success boolean.`,
        inference: 'A failed transfer would be treated as success, so accounting may diverge from actual value movement.',
        functionName: fn.name,
        line: fn.line,
        remediation: 'Capture the success flag and revert on failure: `(bool ok, ) = to.call{value: amount}(""); require(ok, "transfer failed");`',
        suggestedTest: 'Send to a recipient that reverts on receive and assert the whole transaction reverts rather than silently succeeding.',
        knowledgeQuery: 'unchecked low level call return value require success transfer failed',
      });
    }

    // --- ecrecover / replay ---------------------------------------------
    if (/\becrecover\s*\(/.test(fn.body)) {
      if (!/address\s*\(\s*0\s*\)|!=\s*address\(0\)/.test(fn.body)) {
        findings.push({
          id: nextId('SIG'),
          category: 'signature-replay',
          status: 'confirmed',
          severity: 'high',
          confidence: 0.8,
          title: `\`${fn.name}\` does not reject a zero-address ecrecover result`,
          observed: `\`${fn.name}\` calls \`ecrecover\` and does not compare the result against \`address(0)\`.`,
          inference: 'ecrecover returns address(0) on malformed input; comparing that against an uninitialized address would pass.',
          functionName: fn.name,
          line: fn.line,
          remediation: 'Reject the zero address explicitly: `require(signer != address(0), "invalid signature");`',
          suggestedTest: 'Submit a malformed signature and assert the call reverts.',
          knowledgeQuery: 'ecrecover address zero invalid signature check malleability',
        });
      }
      if (!/nonce/i.test(fn.body) && !/nonce/i.test(fn.params)) {
        findings.push({
          id: nextId('SIG'),
          category: 'signature-replay',
          status: 'confirmed',
          severity: 'critical',
          confidence: 0.75,
          title: `\`${fn.name}\` verifies a signature without replay protection`,
          observed: `\`${fn.name}\` recovers a signer but no nonce appears in its parameters or body.`,
          inference: 'Without a consumed nonce, the same signature appears replayable indefinitely.',
          functionName: fn.name,
          line: fn.line,
          remediation: 'Bind a nonce into the signed digest and mark it consumed before any external interaction. Also bind chain id, the verifying contract address, and a deadline (EIP-712).',
          suggestedTest: 'Submit the same valid signature twice and assert the second call reverts.',
          knowledgeQuery: 'signature replay nonce EIP-712 domain separator chain id deadline',
        });
      }
    }

    // --- oracle: spot price ---------------------------------------------
    if (/getReserves\s*\(|\bslot0\s*\(/.test(fn.body)) {
      findings.push({
        id: nextId('OR'),
        category: 'oracle-manipulation',
        status: 'confirmed',
        severity: 'critical',
        confidence: 0.75,
        title: `\`${fn.name}\` derives a value from instantaneous pool state`,
        observed: `\`${fn.name}\` reads pool reserves or slot0 directly.`,
        inference: 'Spot pool state is controllable within a single transaction via a flash loan, so any value derived from it is attacker-influenced.',
        functionName: fn.name,
        line: fn.line,
        remediation: 'Use a TWAP over a meaningful window, or an external feed with staleness and sanity validation, ideally corroborated by a second independent source.',
        suggestedTest: 'Simulate a large swap that skews the pool within one transaction and assert the dependent operation does not misprice.',
        knowledgeQuery: 'oracle manipulation spot price getReserves flash loan TWAP staleness',
      });
    }

    // --- delegatecall ----------------------------------------------------
    if (/\.delegatecall\s*\(/.test(fn.body)) {
      const immutableTarget = /\b(immutable|constant)\b/.test(source) && /_IMPLEMENTATION|implementation\(\)/.test(fn.body);
      findings.push({
        id: nextId('DC'),
        category: 'delegatecall',
        status: immutableTarget ? 'possible' : 'confirmed',
        severity: immutableTarget ? 'medium' : 'critical',
        confidence: immutableTarget ? 0.45 : 0.8,
        title: `\`${fn.name}\` performs a delegatecall`,
        observed: `\`${fn.name}\` contains a \`delegatecall\`.`,
        inference: immutableTarget
          ? 'The target appears to be a fixed implementation, so risk depends on that implementation, which was not reviewed here.'
          : 'If the target address is caller-influenced, this is arbitrary code execution against this contract’s storage.',
        functionName: fn.name,
        line: fn.line,
        remediation: 'Restrict delegatecall to a hard-coded, immutable, audited implementation. Never derive the target from user input.',
        suggestedTest: 'Assert that delegatecall cannot be pointed at an attacker-supplied address, and that the owner/implementation slots are unchanged after a call.',
        knowledgeQuery: 'delegatecall arbitrary target storage collision proxy implementation',
      });
    }

    // --- unbounded loop --------------------------------------------------
    if (/for\s*\([^)]*<\s*(\w+)\.length/.test(fn.body) && isExternallyReachable(fn) && EXTERNAL_CALL.test(fn.body)) {
      findings.push({
        id: nextId('DOS'),
        category: 'denial-of-service',
        status: 'possible',
        severity: 'medium',
        confidence: 0.55,
        title: `\`${fn.name}\` makes external calls inside an unbounded loop`,
        observed: `\`${fn.name}\` iterates over a dynamic array and performs an external call within the loop.`,
        inference: 'One reverting recipient, or a sufficiently long array, could make the whole operation permanently uncallable.',
        functionName: fn.name,
        line: fn.line,
        remediation: 'Switch to a pull-payment pattern so each recipient withdraws independently, or paginate the operation with an explicit bound.',
        suggestedTest: 'Include a recipient that reverts on receive and assert other recipients are still able to obtain their funds.',
        knowledgeQuery: 'pull over push payments denial of service unbounded loop gas limit',
      });
    }

    // --- token accounting -------------------------------------------------
    // Crediting the *requested* amount after an ERC-20 pull assumes the amount
    // sent equals the amount received. Fee-on-transfer and rebasing tokens
    // break that, and the shortfall makes the contract insolvent.
    const pullsTokens = /\.(?:safeTransferFrom|transferFrom)\s*\(/.test(fn.body);
    if (pullsTokens && isStateChanging(fn)) {
      const creditsRequestedAmount = /\w+\s*\[[^\]]*\]\s*\+=\s*(\w+)/.exec(fn.body);
      const measuresDelta = /balanceOf\s*\(\s*address\s*\(\s*this\s*\)\s*\)/.test(fn.body);
      const amountParam = /\b(amount|value|amountIn|assets)\b/.test(fn.params);

      if (creditsRequestedAmount && !measuresDelta && amountParam) {
        findings.push({
          id: nextId('TA'),
          category: 'token-accounting',
          status: 'confirmed',
          severity: 'high',
          confidence: 0.65,
          title: `\`${fn.name}\` credits the requested amount rather than the amount received`,
          observed: `\`${fn.name}\` pulls tokens and credits \`${creditsRequestedAmount[1]}\` without measuring the contract's balance before and after.`,
          inference: 'With a fee-on-transfer or rebasing token the amount received is less than the amount sent, so internal accounting would exceed real holdings.',
          functionName: fn.name,
          line: fn.line,
          remediation: 'Measure the actual delta: record `balanceOf(address(this))` before and after the transfer and credit the difference.',
          suggestedTest: 'Deposit a fee-on-transfer token and assert credited balance equals tokens actually received, and that the sum of credits never exceeds the contract balance.',
          knowledgeQuery: 'ERC-20 accounting fee on transfer rebasing balance delta insolvency invariant',
        });
      }
    }

    // --- tx.origin -------------------------------------------------------
    if (/\btx\.origin\b/.test(fn.body)) {
      findings.push({
        id: nextId('AUTH'),
        category: 'authorization',
        status: 'confirmed',
        severity: 'high',
        confidence: 0.85,
        title: `\`${fn.name}\` uses tx.origin`,
        observed: `\`${fn.name}\` references \`tx.origin\`.`,
        inference: 'tx.origin identifies the transaction initiator, not the caller, so a malicious intermediate contract can act on a user’s behalf.',
        functionName: fn.name,
        line: fn.line,
        remediation: 'Use `msg.sender` for authorization decisions.',
        suggestedTest: 'Call through an intermediate contract and assert the authorization check rejects it.',
        knowledgeQuery: 'tx.origin phishing authorization msg.sender',
      });
    }
  }

  const notes: string[] = [];
  if (contract.hasAssembly) {
    notes.push('Source contains an assembly block. This analyzer does not read assembly, so behaviour inside it was not assessed.');
  }
  if (contract.inherits.length) {
    notes.push(`Base contracts were not resolved: ${contract.inherits.join(', ')}. A modifier or state variable defined there was not visible to this analysis.`);
  }
  notes.push('Source-only analysis: deployment configuration, constructor arguments, and the identity of privileged addresses were not reviewed.');

  return {
    contractName: contract.name,
    findings,
    functionsAnalyzed: contract.functions.length,
    limitations: {
      assemblyPresent: contract.hasAssembly,
      unresolvedBaseContracts: contract.inherits,
      notes,
    },
  };
}
