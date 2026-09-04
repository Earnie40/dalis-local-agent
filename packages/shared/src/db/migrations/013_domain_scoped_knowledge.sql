-- Domain-scoped retrieval over the EXISTING knowledge store.
--
-- This deliberately extends knowledge_documents / knowledge_chunks rather than
-- introducing a second vector store. There is exactly one pgvector corpus in
-- this platform, and domain scoping is a filter on it.
--
-- Additive only. Every column is nullable or defaulted, so rows written before
-- this migration remain valid and existing unscoped queries keep working.

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS domain_id          TEXT,
  ADD COLUMN IF NOT EXISTS organization_id    TEXT,
  ADD COLUMN IF NOT EXISTS source_id          TEXT,
  ADD COLUMN IF NOT EXISTS content_hash       TEXT,
  ADD COLUMN IF NOT EXISTS provenance         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS license            TEXT,
  -- Retrieval knowledge is facts, so it is NOT training material by default.
  -- See packages/domain-knowledge/src/knowledge-policy.ts: a fact is served by
  -- RAG so it can be corrected without retraining.
  ADD COLUMN IF NOT EXISTS retrieval_eligible BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS training_eligible  BOOLEAN NOT NULL DEFAULT false,
  -- Set where the knowledge is temporally sensitive (market/chain state), so a
  -- historical query can filter on what was actually knowable at the time.
  ADD COLUMN IF NOT EXISTS available_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS knowledge_documents_domain_idx
  ON knowledge_documents (domain_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_documents_org_idx
  ON knowledge_documents (organization_id, domain_id);
CREATE INDEX IF NOT EXISTS knowledge_documents_content_hash_idx
  ON knowledge_documents (content_hash);
CREATE INDEX IF NOT EXISTS knowledge_documents_available_at_idx
  ON knowledge_documents (available_at);

-- ---------------------------------------------------------------------------
-- Chunks
--
-- domain_id is denormalized onto the chunk so a domain-scoped vector search
-- filters without joining back to the document. The HNSW index stays exactly as
-- it was; this only narrows the candidate set.
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS domain_id       TEXT,
  ADD COLUMN IF NOT EXISTS organization_id TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id    TEXT,
  ADD COLUMN IF NOT EXISTS content_hash    TEXT;

CREATE INDEX IF NOT EXISTS knowledge_chunks_domain_idx ON knowledge_chunks (domain_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_idx
  ON knowledge_chunks (organization_id, workspace_id);

-- Backfill the denormalized columns for any rows that predate this migration,
-- so an existing corpus does not silently drop out of tenant-filtered queries.
UPDATE knowledge_chunks c
   SET domain_id       = d.domain_id,
       organization_id = d.organization_id,
       workspace_id    = d.workspace_id
  FROM knowledge_documents d
 WHERE d.id = c.document_id
   AND c.domain_id IS NULL
   AND c.organization_id IS NULL
   AND c.workspace_id IS NULL;

-- ---------------------------------------------------------------------------
-- Ingestion audit
--
-- One row per ingestion attempt, including rejected ones. A corpus you cannot
-- explain the origin of is not auditable, and a silently dropped ingestion is
-- indistinguishable from one that never happened.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_ingestions (
  id                    TEXT PRIMARY KEY,
  document_id           TEXT REFERENCES knowledge_documents (id) ON DELETE SET NULL,
  domain_id             TEXT,
  assigned_domain       TEXT,
  -- 'explicit' when the caller named the domain; 'classified' when inferred.
  classification_method TEXT NOT NULL DEFAULT 'explicit',
  classification_confidence DOUBLE PRECISION,
  source_kind           TEXT NOT NULL,
  source_locator        TEXT NOT NULL,
  license               TEXT,
  content_hash          TEXT,
  bytes                 INTEGER,
  chunk_count           INTEGER,
  status                TEXT NOT NULL,
  rejection_reason      TEXT,
  secrets_redacted      INTEGER NOT NULL DEFAULT 0,
  ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_ingestions_status_check
    CHECK (status IN ('ingested', 'rejected', 'duplicate')),
  CONSTRAINT knowledge_ingestions_method_check
    CHECK (classification_method IN ('explicit', 'classified', 'human-corrected')),
  CONSTRAINT knowledge_ingestions_classified_needs_confidence
    CHECK (classification_method <> 'classified' OR classification_confidence IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS knowledge_ingestions_domain_idx
  ON knowledge_ingestions (domain_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_ingestions_hash_idx
  ON knowledge_ingestions (content_hash);
