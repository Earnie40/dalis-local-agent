# Upgradeability, Proxies, and Storage Layout

## The proxy model

A proxy holds the storage and delegates execution to an implementation contract via
`delegatecall`. Because `delegatecall` runs the implementation's *code* against the
proxy's *storage*, the two contracts must agree exactly on storage layout.

The consequence: **storage layout is part of the contract's ABI.** Changing it in an
upgrade is a breaking change even though the compiler will not complain.

## Storage-layout rules for upgrades

Safe:

- Appending new variables at the end of the layout.
- Renaming a variable (the slot is positional, not nominal).
- Changing a variable to a type of the same size where semantics permit.

Unsafe:

- Inserting a variable in the middle — every subsequent variable shifts by one slot,
  and the new code reads the old neighbour's bytes.
- Removing a variable, for the same reason.
- Reordering variables.
- Changing a type's size (`uint128` to `uint256`) where it shared a packed slot.
- Changing an inherited contract's layout, or reordering base contracts.

A storage gap (`uint256[50] private __gap;`) reserves slots in a base contract so
future versions can add variables without shifting a child's layout.

## Initializers instead of constructors

A constructor runs in the context of the implementation, so its effects never touch
the proxy's storage. Upgradeable contracts use an initializer instead:

```solidity
function initialize(address admin) external initializer {
    __AccessControl_init();
    _grantRole(DEFAULT_ADMIN_ROLE, admin);
}

constructor() { _disableInitializers(); }   // implementation cannot be initialized
```

Two failures follow from getting this wrong:

- An unprotected `initialize()` lets anyone claim admin (an access-control critical).
- An uninitialized *implementation* contract can sometimes be initialized directly by
  an attacker and, if it contains a `selfdestruct` or arbitrary `delegatecall`
  path, used to destroy or hijack the logic the proxy depends on.

## `delegatecall` hazards

`delegatecall` to an address the caller controls is arbitrary code execution against
your own storage — it can rewrite the owner slot, the implementation pointer, or any
balance. Any `delegatecall` whose target is not a hard-coded, immutable, audited
address deserves the highest scrutiny.

Function-selector clashes between proxy and implementation are a related hazard: if
the proxy defines a function whose selector matches one in the implementation, calls
silently hit the proxy instead of the logic.

## Upgrade authorization

The upgrade path itself is a privileged function. Review:

- Who may call `upgradeTo` / `_authorizeUpgrade`? An EOA is a single point of
  failure; a multisig plus timelock gives users time to exit.
- Is there a timelock, and is its delay meaningful?
- Is the new implementation address validated (non-zero, actually a contract)?
- UUPS specifically places the upgrade function *in the implementation* — shipping an
  implementation that omits it permanently freezes upgradeability.

## Severity guidance

An unprotected initializer or an attacker-controllable `delegatecall` target is
**critical**. A storage-layout incompatibility introduced by an upgrade is
**critical** if it corrupts balances or authorization, **high** otherwise. Upgrade
authorization held by a single EOA is typically **medium** as a centralization
finding — real, but a design risk rather than an exploitable defect.
