# Reentrancy and Checks-Effects-Interactions

## The mechanism

Reentrancy occurs when a contract makes an external call before it has finished
updating its own state. The callee — which may be an attacker-controlled contract —
can call back into the original function while the first invocation is still on the
stack and the state still reflects the pre-call world.

The canonical vulnerable shape is a withdrawal that sends funds before zeroing the
balance:

```solidity
function withdraw() external {
    uint256 amount = balances[msg.sender];
    (bool ok, ) = msg.sender.call{value: amount}("");   // INTERACTION
    require(ok, "transfer failed");
    balances[msg.sender] = 0;                            // EFFECT (too late)
}
```

Because `balances[msg.sender]` is still non-zero during the external call, a
malicious `receive()` can re-enter `withdraw()` and drain the contract.

## Checks-Effects-Interactions

The ordering rule that removes the class of bug:

1. **Checks** — validate inputs and preconditions (`require`, custom errors).
2. **Effects** — update all internal state.
3. **Interactions** — only then call out to other addresses.

Corrected:

```solidity
function withdraw() external {
    uint256 amount = balances[msg.sender];   // CHECK
    require(amount > 0, "nothing to withdraw");
    balances[msg.sender] = 0;                // EFFECT
    (bool ok, ) = msg.sender.call{value: amount}("");  // INTERACTION
    require(ok, "transfer failed");
}
```

## Reentrancy guards

A mutex (`nonReentrant`) is a defence in depth, not a substitute for correct
ordering. A guard protects a single function; it does not stop *cross-function*
reentrancy where the attacker re-enters a *different* function that shares the same
state. Ordering fixes the root cause; the guard catches what ordering missed.

## Read-only reentrancy

A view function can also be reentered. If an external protocol reads a price or a
share value from this contract mid-transaction, while state is temporarily
inconsistent, it receives a corrupted answer even though no state was written by the
view call itself. Contracts that expose state consumed by other protocols should
consider whether that state is consistent at every external-call boundary.

## What to look for in review

- Any `.call`, `.transfer`, `.send`, or call to an unknown contract address.
- State writes that appear *after* such a call in the same function.
- Token callbacks: ERC-777 `tokensReceived` and ERC-721/1155 `onERC*Received` hand
  control to the receiver and are common reentry points that `.transfer` alone does
  not suggest.
- Shared state reachable from more than one externally callable function.

## Severity guidance

Direct fund-draining reentrancy on a balance-bearing function is typically **high**
or **critical**. Reentrancy into a function that only affects non-financial
bookkeeping may be **medium**. Reentrancy that is unreachable because the external
address is a trusted, immutable, non-callback contract may be **informational** —
but the reasoning for that judgement must be stated, not assumed.
