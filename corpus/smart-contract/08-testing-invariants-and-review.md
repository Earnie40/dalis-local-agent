# Testing, Invariants, Fuzzing, and Defensive Review

## The evidence hierarchy

A claim that a contract is correct should be backed by the strongest evidence
available, and the analysis should say which level it reached:

1. **Static inspection** — the code was read. Weakest; catches obvious omissions.
2. **Type/compilation** — it builds under the intended compiler version.
3. **Unit tests** — specific behaviours hold for specific inputs.
4. **Invariant/fuzz tests** — a property holds across many generated inputs.
5. **Integration tests** — it behaves correctly against real dependencies.
6. **Formal verification** — a property is proved for all reachable states.

"I read the code and it looks right" is level 1 and should be labelled as such.

## Unit tests for a security fix

A regression test for a vulnerability must fail against the *unfixed* code.
A test that passes both before and after the fix proves nothing about the fix.

```solidity
function test_withdraw_isNotReentrant() public {
    Attacker attacker = new Attacker(vault);
    vm.deal(address(attacker), 1 ether);
    attacker.deposit{value: 1 ether}();

    vm.expectRevert();
    attacker.attack();

    assertEq(address(vault).balance, initialVaultBalance);
}
```

## Invariants

An invariant is a property that must hold in **every** reachable state, regardless of
the order or number of operations. Good invariants for a value-holding contract:

- `sum(userBalances) <= token.balanceOf(address(this))` — the contract is solvent.
- `totalSupply == sum(balanceOf(holder))` for all holders.
- A paused contract permits no state-changing user operation.
- Only an address holding `SETTLER_ROLE` can cause `settled[id]` to become true.
- No sequence of operations lets an account withdraw more than it deposited.

Invariant testing drives random sequences of calls from random actors and asserts the
property after each one. It finds *ordering* bugs that example-based unit tests miss,
because the failing sequence is usually one nobody thought to write.

```solidity
function invariant_solvency() public view {
    assertLe(vault.totalCredited(), token.balanceOf(address(vault)));
}
```

## Fuzzing

Fuzzing generates inputs for a single function to find values that break an
assertion — boundary values, zero, `type(uint256).max`, and the arithmetic edges
around them. It is most valuable on functions doing arithmetic, share conversion, or
bounds-checking.

Useful practice: constrain inputs with `bound()` rather than `vm.assume()` where
possible, so the fuzzer spends its budget on reachable values instead of discarding
most candidates.

## Gas and denial of service

- **Unbounded loops over user-controlled arrays** can exceed the block gas limit,
  making a function permanently uncallable. Paginate, or use pull payments.
- **Storage growth an attacker controls** is a cost the protocol pays forever.
- Gas analysis is also a correctness tool: an unexpected gas profile often reveals an
  unintended storage write or an unexpected external call.

## Defensive review workflow

1. **Inspect** — read the contract; list every externally callable state-changing
   function and every external call.
2. **Identify risks** — for each, ask the access-control, reentrancy, arithmetic,
   and oracle questions. Record which are confirmed and which are possible.
3. **Rate** — severity by impact and reachability; confidence separately from
   severity. A high-impact issue behind an unproven precondition is a high-severity,
   low-confidence finding, and saying so is more useful than picking one number.
4. **Recommend remediation** — the minimal change that removes the cause, not a
   rewrite.
5. **Write tests** — a regression test that fails before the fix and passes after.
6. **Verify** — run the suite; report what actually ran and what did not.

## Reporting discipline

- Separate **observed fact** ("the function has no access modifier") from
  **inference** ("this is likely exploitable by any address").
- State what was *not* checked. An analysis of source without deployment
  configuration cannot rule out that a privileged address is a timelocked multisig.
- Do not report a finding whose exploit path you cannot describe. "Possible
  reentrancy" without naming the reachable callback is a hypothesis, not a finding.
- A clean review is a valid result. Manufacturing findings to appear thorough
  degrades every subsequent report.
