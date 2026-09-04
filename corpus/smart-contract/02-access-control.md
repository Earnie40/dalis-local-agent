# Access Control, Ownership, and Roles

## The failure mode

An access-control failure is a state-changing function that any address may call
when only a privileged one should. It is the most common high-severity finding in
practice and the easiest to miss, because the vulnerable code looks *ordinary* — the
defect is the absence of a line, not the presence of a wrong one.

```solidity
// VULNERABLE: no restriction at all
function setTreasury(address newTreasury) external {
    treasury = newTreasury;
}
```

Anything that changes configuration, moves funds, mints, pauses, upgrades, or
assigns roles is privileged by default until proven otherwise.

## Ownership

`Ownable` gives a single `owner` address. It is simple and appropriate for early
deployments, but it is a single point of failure: one compromised key is total
compromise.

Two-step ownership transfer (`Ownable2Step`) prevents the most common operational
disaster — transferring ownership to an address that cannot act, permanently
bricking every privileged function. The recipient must accept.

```solidity
function transferOwnership(address newOwner) public virtual onlyOwner {
    pendingOwner = newOwner;            // step 1: propose
}
function acceptOwnership() public virtual {
    require(msg.sender == pendingOwner, "not pending owner");
    owner = pendingOwner;               // step 2: accept
    delete pendingOwner;
}
```

## Role-based permissions

Role-based access control separates duties so no single role can do everything:

```solidity
bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
bytes32 public constant PAUSER_ROLE  = keccak256("PAUSER_ROLE");

function settle(bytes32 evidenceHash, uint256 amount) external onlyRole(SETTLER_ROLE) {
    ...
}
```

Design points that matter in review:

- **Who administers each role?** A role whose admin is itself creates a lockout risk;
  a role administered by an over-broad admin defeats the separation.
- **Is `DEFAULT_ADMIN_ROLE` held by a multisig or timelock**, not an EOA?
- **Is role renunciation reachable** in a way that could leave the system with no
  administrator?

## Privileged-function checklist

For every externally callable state-changing function, ask:

1. Should an arbitrary address be able to call this? If no, where is the guard?
2. Is the guard the *right* one — `onlyOwner` where a narrower role belongs?
3. Is the modifier actually applied, or only declared elsewhere in the file?
4. Can the function be reached indirectly through a fallback, a proxy, or a
   `delegatecall` path that bypasses the modifier?
5. Is the privileged address changeable, and is *that* change itself protected?

## Initializer exposure

In upgradeable contracts, an unprotected `initialize()` is an access-control bug: if
it is callable after deployment, anyone can claim ownership. It must carry the
`initializer` modifier, and the implementation contract itself should be
disabled (`_disableInitializers()` in the constructor) so it cannot be initialized
directly.

## Severity guidance

Missing access control on a fund-moving or ownership-changing function is
**critical**. Missing control on a configuration setter is **high** when the
configuration influences funds or authorization, **medium** when it affects only
non-financial metadata. State the reasoning for the rating.
