# DACAIS Smart Contract Test Knowledge

This is a controlled document used to prove that domain-scoped retrieval works
end to end. It describes a fictional internal contract and exists so a query can
be answered from retrieval rather than from model priors.

## Treasury contract ALPHA

Treasury contract ALPHA requires the SETTLER_ROLE before a settlement may be
executed. Any call to `settle()` from an address that does not hold SETTLER_ROLE
reverts.

Settlement events emitted by ALPHA include the evidence hash. The evidence hash
commits to an off-chain settlement record; the record itself is never written on
chain.

ALPHA additionally enforces:

- settlement is idempotent — an obligation id may be settled at most once
- the PAUSER_ROLE may halt settlement without blocking user withdrawals
- the DEFAULT_ADMIN_ROLE for ALPHA is held by a timelocked multisig
