-- PostgreSQL-backed knowledge documents for local RAG.
-- Requires pgvector, installed by scripts/provision-db.mjs.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  title         TEXT,
  content       TEXT NOT NULL,
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  workspace_id  TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  engagement_id TEXT,
  agent_id      TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_documents_workspace_idx
  ON knowledge_documents (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_documents_engagement_idx
  ON knowledge_documents (engagement_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  content        TEXT NOT NULL,
  embedding      vector(768) NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx ON knowledge_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
