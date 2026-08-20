CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE code_symbols
  ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS code_symbols_embedding_hnsw_idx
  ON code_symbols
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS repository_architecture_maps (
  repository_id text PRIMARY KEY,
  architecture jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_working_state (
  thread_id text PRIMARY KEY,
  objective text,
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  inspected_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  relevant_symbols jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  known_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  architecture_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_failure_memory (
  id bigserial PRIMARY KEY,
  operation text NOT NULL,
  error_signature text NOT NULL,
  attempted_approach text,
  root_cause text,
  corrective_action text,
  outcome text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_failure_memory_signature_idx
  ON agent_failure_memory(error_signature);

CREATE INDEX IF NOT EXISTS agent_failure_memory_operation_idx
  ON agent_failure_memory(operation);
