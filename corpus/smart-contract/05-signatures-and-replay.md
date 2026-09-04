# Signatures, Replay Protection, and Authorization

## What a signature proves

`ecrecover` proves that the holder of a private key signed a particular 32-byte
digest. It proves nothing about *when*, *how often*, *on which chain*, or *for which
contract* that signature may be used. Every one of those must be bound into the
digest by the application.

## The four bindings

A signed message intended to authorize an action should commit to:

1. **A nonce** — so the same signature cannot be replayed a second time.
2. **The chain id** — so a signature valid on a testnet is not valid on mainnet.
3. **The verifying contract address** — so a signature for contract A is not
   accepted by contract B with the same code.
4. **An expiry / deadline** — so an old authorization does not remain live forever.

EIP-712 typed data provides the standard structure for (2) and (3) through its
domain separator, and makes the signed payload human-readable in wallets.

```solidity
bytes32 private constant SETTLE_TYPEHASH =
    keccak256("Settle(address to,uint256 amount,uint256 nonce,uint256 deadline)");

function settleWithSig(
    address to, uint256 amount, uint256 nonce, uint256 deadline,
    uint8 v, bytes32 r, bytes32 s
) external {
    require(block.timestamp <= deadline, "expired");
    require(!usedNonces[nonce], "nonce used");

    bytes32 structHash = keccak256(abi.encode(SETTLE_TYPEHASH, to, amount, nonce, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

    address signer = ecrecover(digest, v, r, s);
    require(signer != address(0), "invalid signature");
    require(hasRole(SETTLER_ROLE, signer), "signer not authorized");

    usedNonces[nonce] = true;          // EFFECT before INTERACTION
    _settle(to, amount);
}
```

## Specific hazards

**`ecrecover` returns `address(0)` on malformed input.** If the code then compares
the result against an uninitialized `signer` variable — also zero — the check
passes. Always reject `address(0)` explicitly.

**Signature malleability.** For any valid `(v, r, s)` there is a second valid
`(v', r, s')` producing the same signer. Code that uses the signature *bytes* as a
uniqueness key (rather than a nonce) can therefore be replayed with the malleable
twin. Restrict `s` to the lower half-order and `v` to {27, 28}, or key replay
protection on the nonce rather than the signature.

**Cached domain separator.** A `DOMAIN_SEPARATOR` computed once in the constructor
becomes wrong after a chain fork changes `block.chainid`. Recompute when
`block.chainid` differs from the cached value.

**`abi.encodePacked` collisions.** Packing two dynamic types
(`abi.encodePacked(a, b)` with two `string`/`bytes` arguments) can produce identical
bytes for different inputs — `("ab","c")` and `("a","bc")` collide. Use `abi.encode`
for hashing structured data.

**Signer authorization is separate from signature validity.** A correctly recovered
signer must still be checked against the role or allowlist that permits the action.
Verifying the maths but not the authority is a complete bypass.

**Contract signers.** Smart-contract wallets cannot produce ECDSA signatures.
Systems intended to accept them need EIP-1271 (`isValidSignature`) support;
otherwise account-abstraction users are silently excluded.

## Severity guidance

A missing nonce on a value-moving signed action is **critical** — every
authorization becomes infinitely replayable. A missing chain-id or verifying-contract
binding is **high** (cross-deployment replay). A missing deadline is **medium**. A
missing `address(0)` check is **high** when it yields a bypass.
