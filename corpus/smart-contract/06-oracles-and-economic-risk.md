# Oracle Risk and Economic Attacks

## Spot price is not a price oracle

Reading a decentralised exchange's reserves at a single instant reports the price
*right now*, which an attacker controls for the duration of one transaction:

```solidity
// VULNERABLE: instantaneous, manipulable
(uint112 r0, uint112 r1, ) = pair.getReserves();
uint256 price = (uint256(r1) * 1e18) / uint256(r0);
```

Within one transaction an attacker can borrow a large sum via flash loan, swap to
skew the pool, call the victim contract while the skewed price is live, and unwind —
all atomically, with the loan repaid at the end. No capital is required beyond gas
and fees, so "an attacker would need millions" is not a mitigation.

## What flash loans changed

Flash loans did not create a new vulnerability class; they removed the capital
barrier that made price-manipulation attacks theoretical. Any logic whose outcome
depends on a value an attacker can move within one transaction should be treated as
attacker-controlled. This includes spot prices, pool share ratios, and any
`balanceOf`-derived valuation.

## Safer oracle patterns

- **Time-weighted average price (TWAP).** Averaging over a window raises the cost of
  manipulation from one transaction to sustained pressure across many blocks. The
  window is a trade-off: longer resists manipulation better but tracks real moves
  more slowly.
- **External oracle feeds** with multiple independent reporters. When using a push
  feed, validate freshness and sanity: check the update timestamp against a staleness
  threshold, reject non-positive answers, and confirm the round is complete.
- **Multiple independent sources** with a deviation check, so a single compromised
  feed does not move the system alone.

```solidity
(, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
require(answer > 0, "bad answer");
require(block.timestamp - updatedAt <= maxStaleness, "stale price");
```

## Related economic hazards

**Sandwich exposure / missing slippage limits.** A swap or liquidation without a
`minAmountOut` parameter lets a searcher move the price, let the victim trade at the
worse rate, and revert the move for profit. Slippage bounds and deadlines belong on
every user-facing trade path.

**First-depositor share inflation.** In a vault that mints shares proportional to
assets, the first depositor can deposit 1 wei, receive 1 share, then donate a large
amount directly to the vault. The share price becomes enormous and subsequent small
deposits round down to zero shares. Mitigations include seeding an initial deposit at
deployment, minting dead shares, or using virtual offsets in the conversion.

**Rounding direction.** Every division truncates. Rounding must consistently favour
the protocol: round *down* when computing what a user receives, *up* when computing
what a user owes. A single mis-rounded operation, repeated, drains value.

## Distinguishing confirmed from possible

An oracle finding should state which it is:

- **Confirmed** — the contract reads a manipulable spot value and uses it for a
  value-bearing decision, with the path from input to loss identified.
- **Possible risk** — the contract reads an external feed whose trust properties are
  outside the reviewed code. The dependency is real; whether it is exploitable
  depends on the deployment configuration, which must be checked separately.

Reporting a possible risk as a confirmed vulnerability is itself a defect in the
analysis.

## Severity guidance

Spot-price dependence in a lending, liquidation, or minting path is **critical**.
Missing staleness validation on an external feed is **high**. Missing slippage
protection on a user-facing swap is **high**. First-depositor inflation is
**high** in an empty vault, **informational** once meaningfully seeded.
