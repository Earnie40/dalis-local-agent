# Anatomy and Physiology Knowledge Corpus

A curated, domain-scoped knowledge corpus for human anatomy (female and male),
comparative animal anatomy, and spatial visual entity grounding.

## Provenance

Every document here is **original educational and reference material authored for DACAIS**
as part of this repository.

- **License:** `DACAIS-internal-original` — original work, internal use.
- **Domain:** `anatomy-and-physiology`
- **Purpose:** Domain-scoped retrieval (RAG) and factual grounding.

## Knowledge Policy Compliance

Per the platform's knowledge policy (`packages/domain-knowledge/src/knowledge-policy.ts`):
- Factual anatomical locations, morphological descriptions, and structural relations are served
  by retrieval so they can be continuously updated, corrected, and verified without retraining.
- Ingestion sets `training_eligible = false`.
- Procedural skills ("how to identify and localize anatomical landmarks", "how to distinguish
  sexually dimorphic structures") are extracted into approved training candidates under
  `packages/datasets/` for model adapter training.

## Ingesting

    node --import tsx scripts/ingest-anatomy-corpus.mjs

Ingestion is content-hashed and idempotent.
