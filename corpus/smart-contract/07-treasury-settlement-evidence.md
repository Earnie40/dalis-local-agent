# Treasury, Settlement, and Evidence Registry Patterns

## Treasury controls

A treasury contract holds value on behalf of an organisation. The controls that
matter are separation of duties and bounded blast radius:

- **Roles, not an owner.** A `TREASURER_ROLE` that can move funds, a `PAUSER_ROLE`
  that can halt, and an admin role that can assign — held by different keys.
- **Timelock on outbound movement** above a threshold, so an unexpected withdrawal is
  observable before it settles.
- **Rate limits.** A per-period cap bounds the loss from a compromised key rather
  than relying on the key never being compromised.
- **Allowlisted destinations** for routine flows, with a separate, slower path for
  arbitrary addresses.
- **Emergency pause** that stops outflow without freezing user withdrawals of their
  own funds, so the emergency control is not itself a custody risk.

## Settlement contracts

A settlement contract records that an obligation was discharged. The properties that
make settlement auditable:

**Authorization before effect.** Settlement is a privileged action. The role check
comes first, then state, then any external transfer.

```solidity
bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

function settle(bytes32 obligationId, bytes32 evidenceHash, uint256 amount)
    external
    onlyRole(SETTLER_ROLE)
{
    require(!settled[obligationId], "already settled");
    require(evidenceHash != bytes32(0), "evidence required");

    settled[obligationId] = true;                    // EFFECT
    emit Settled(obligationId, evidenceHash, amount, msg.sender, block.timestamp);

    token.safeTransfer(payee[obligationId], amount); // INTERACTION
}
```

**Idempotency.** Settling the same obligation twice must be impossible, not merely
unlikely. The `settled` mapping is checked and set before the transfer.

**Evidence in the event.** The event carries the evidence hash, so an off-chain
record can be tied to the on-chain settlement without publishing the record itself.

## Evidence registries

An evidence registry anchors a content hash on chain while the underlying data stays
off chain. The chain provides tamper-evidence and ordering; it is not storage.

```solidity
event EvidenceAnchored(
    bytes32 indexed subjectId,
    bytes32 indexed digest,
    string  kind,
    address indexed submitter,
    uint256 timestamp
);

function anchor(bytes32 subjectId, bytes32 digest, string calldata kind)
    external
    onlyRole(ATTESTOR_ROLE)
{
    require(digest != bytes32(0), "empty digest");
    require(anchoredAt[digest] == 0, "already anchored");
    anchoredAt[digest] = block.timestamp;
    emit EvidenceAnchored(subjectId, digest, kind, msg.sender, block.timestamp);
}
```

Design notes:

- **Never write raw data on chain.** It is public, permanent, and expensive. Anchor
  the digest; keep the payload in controlled storage.
- **Anchoring is not verification.** The chain attests that *someone with the
  attestor role submitted this digest at this time*. It says nothing about whether
  the underlying data is true. Conflating the two is a reasoning error, not a coding
  one.
- **Index what will be queried.** Indexed event parameters are filterable; the rest
  are not. Getting this wrong is discovered only when an indexer needs the data.
- **Digest collisions and pre-images.** Use a 32-byte cryptographic hash. Anchoring a
  truncated or non-cryptographic digest weakens the tamper-evidence claim.

## Authorization contracts

A contract that grants machine or agent authority should bound it explicitly:

- **Scope** — which actions, which targets, which amounts.
- **Expiry** — authority that does not expire accumulates.
- **Revocability** — a single transaction must be able to withdraw authority.
- **Attestable use** — each exercise emits an event tying the action to the grant, so
  the record of what an automated system did is complete.

## Severity guidance

A settlement path without idempotency is **high** — double settlement is direct
loss. Missing role checks on `settle` or `anchor` is **critical**. An evidence
registry that stores payloads rather than digests is a **design** finding: correct
but costly and privacy-damaging.
