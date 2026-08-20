-- Persistent repository intelligence: tracked repositories, file-hash state, and
-- syntax-aware code symbols. Consumed by packages/repository-index.
--
-- Additive only. Requires pgvector (installed by scripts/provision-db.mjs).
-- Embedded symbol vectors are optional for now; the column exists so semantic
-- retrieval over symbols can be enabled without a schema change later.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS repositories (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
  root_path    TEXT NOT NULL,
  branch       TEXT,
  head_commit  TEXT,
  indexed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS repositories_root_path_key ON repositories (root_path);

-- File-level content hashes drive incremental re-indexing: a file is only
-- re-extracted and re-embedded when its hash changes.
CREATE TABLE IF NOT EXISTS repository_files (
  repository_id TEXT    NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  file_path     TEXT    NOT NULL,
  language      TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, file_path)
);

CREATE TABLE IF NOT EXISTS code_symbols (
  id            TEXT PRIMARY KEY,
  repository_id TEXT   NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  file_path     TEXT   NOT NULL,
  language      TEXT   NOT NULL,
  symbol_name   TEXT   NOT NULL,
  symbol_type   TEXT   NOT NULL,
  signature     TEXT,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  summary       TEXT,
  content       TEXT,
  content_hash  TEXT   NOT NULL,
  embedding     vector(768),
  metadata      JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS code_symbols_repository_idx ON code_symbols (repository_id, file_path);
CREATE INDEX IF NOT EXISTS code_symbols_name_idx ON code_symbols (symbol_name);
CREATE INDEX IF NOT EXISTS code_symbols_type_idx ON code_symbols (symbol_type);
-- Semantic lookup over symbols (Phase 6 hybrid retrieval), dormant until embeddings populated.
CREATE INDEX IF NOT EXISTS code_symbols_embedding_hnsw_idx
  ON code_symbols USING hnsw (embedding vector_cosine_ops);

-- Deterministic symbol graph edges (Phase 4 relationships).
CREATE TABLE IF NOT EXISTS symbol_edges (
  id              TEXT PRIMARY KEY,
  repository_id   TEXT   NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  file_path       TEXT   NOT NULL,
  source          TEXT   NOT NULL,
  target          TEXT   NOT NULL,
  relationship    TEXT   NOT NULL,
  line            INTEGER,
  metadata        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS symbol_edges_target_idx ON symbol_edges (relationship, target);
CREATE INDEX IF NOT EXISTS symbol_edges_source_idx ON symbol_edges (relationship, source);