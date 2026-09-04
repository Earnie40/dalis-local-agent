# Smart-contract knowledge corpus

A small curated corpus used to prove the domain-scoped RAG architecture.

## Provenance

Every document here is **original material authored for DACAIS** as part of this
repository. No third-party source code, documentation, or proprietary material is
included, so there is no external licence to honour and no attribution ambiguity.

- **License:** `DACAIS-internal-original` — original work, internal use.
- **Domain:** `smart-contract`
- **Purpose:** retrieval (RAG) knowledge.

## This corpus is NOT training data

These documents are facts and reference material. Per the platform's knowledge
policy, facts are served by retrieval so they can be corrected without retraining.
Ingestion sets `training_eligible = false` and no code path can flip it.

## Ingesting

    node --import tsx scripts/ingest-smart-contract-corpus.mjs

Ingestion is content-hashed and idempotent: re-running reports duplicates rather
than creating second copies.
