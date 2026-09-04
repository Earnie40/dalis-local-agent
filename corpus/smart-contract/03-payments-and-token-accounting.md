# Payments, Pull vs Push, and ERC-20 Accounting

## Pull over push

**Push payment** — the contract sends funds to recipients during its own logic.
**Pull payment** — the contract credits an internal balance and recipients withdraw.

Push has two failure modes. A recipient that reverts on receive can block the whole
operation (a denial of service for everyone in the batch), and every send is an
external call that opens a reentrancy surface.

```solidity
// FRAGILE: one reverting recipient blocks all payouts
for (uint256 i = 0; i < winners.length; i++) {
    payable(winners[i]).transfer(prize);
}
```

```solidity
// ROBUST: credit now, let each recipient withdraw independently
for (uint256 i = 0; i < winners.length; i++) {
    owed[winners[i]] += prize;
}
```

Pull confines a failure to the account that caused it.

## Do not rely on `transfer` / `send` gas stipends

`address.transfer()` forwards 2300 gas. That figure was never a guarantee, and gas
costs of opcodes have changed with hard forks. A recipient that is a smart-contract
wallet — increasingly the norm under account abstraction — may legitimately need more
than 2300 gas to accept funds. Prefer `call` with an explicit success check, combined
with Checks-Effects-Interactions and, where appropriate, a reentrancy guard.

```solidity
(bool ok, ) = payable(to).call{value: amount}("");
require(ok, "transfer failed");
```

## ERC-20 accounting hazards

**Non-standard return values.** Some widely-used tokens do not return a boolean.
Calling `token.transfer(...)` and checking the return value naively either reverts or
silently mis-reads. Use a safe wrapper that tolerates both shapes.

**Fee-on-transfer and rebasing tokens.** The amount received is not necessarily the
amount sent. Accounting that assumes `balanceAfter == balanceBefore + amount` breaks.
Measure the delta:

```solidity
uint256 before = token.balanceOf(address(this));
token.safeTransferFrom(msg.sender, address(this), amount);
uint256 received = token.balanceOf(address(this)) - before;   // credit `received`
```

**Approval race.** Changing a non-zero allowance to another non-zero value allows a
spender to front-run and spend both. Set to zero first, or use
`increaseAllowance`/`decreaseAllowance` semantics.

**Internal accounting vs actual balance.** If the contract tracks deposits in a
mapping, the invariant `sum(balances) <= token.balanceOf(address(this))` must hold.
A direct token transfer into the contract (which no function observed) makes actual
balance exceed internal accounting — usually benign. Internal accounting exceeding
actual balance means the contract is insolvent, which is critical.

## Invariants worth asserting in tests

- Total credited never exceeds tokens actually held.
- A withdrawal reduces both internal balance and actual balance by the same amount.
- No sequence of deposits and withdrawals lets an account withdraw more than it
  deposited (absent an explicit yield mechanism).
- Sum of all user balances plus protocol fees equals tracked total supply of claims.

## Severity guidance

Internal accounting that can exceed real holdings is **critical** — it is
insolvency. Unchecked transfer return values are **high** where funds are credited on
the assumption of success. Fee-on-transfer mishandling is **high** or **medium**
depending on whether the shortfall is borne by the protocol or by the next user.
