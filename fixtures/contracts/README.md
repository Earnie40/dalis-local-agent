# Held-out smart-contract evaluation fixtures

These contracts are the **evaluation set** for the `smart-contract` domain.

## They are NEVER ingested

They are deliberately excluded from `corpus/smart-contract/` and from the
ingestion script. Scoring the system on material it has memorised measures recall
of the corpus, not capability. `tests/smart-contract-evaluation.test.ts` asserts
these files are absent from the knowledge store.

## They are local test material only

They are deliberately vulnerable, exist only to exercise defensive analysis, and
are never deployed. Do not deploy them anywhere.
