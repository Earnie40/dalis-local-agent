-- Core persistence for DacaiLocalAgent.
-- All identifiers are application-generated text ids (see createId()).

CREATE TABLE IF NOT EXISTS workspaces (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT        NOT NULL,
  root_path           TEXT        NOT NULL,
  read_access         BOOLEAN     NOT NULL DEFAULT TRUE,
  write_access        BOOLEAN     NOT NULL DEFAULT FALSE,
  shell_access        BOOLEAN     NOT NULL DEFAULT FALSE,
  network_access      BOOLEAN     NOT NULL DEFAULT FALSE,
  project_instructions TEXT,
  memory_namespace    TEXT,
  git_detected        BOOLEAN     NOT NULL DEFAULT FALSE,
  detected_languages  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_root_path_key ON workspaces (root_path);

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  title        TEXT        NOT NULL DEFAULT 'New conversation',
  workspace_id TEXT        REFERENCES workspaces (id) ON DELETE SET NULL,
  agent_id     TEXT,
  provider_instance_id TEXT,
  model        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT        NOT NULL,
  tool_calls      JSONB,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT        REFERENCES tasks (id) ON DELETE SET NULL,
  session_id   TEXT,
  workspace_id TEXT        REFERENCES workspaces (id) ON DELETE SET NULL,
  agent_id     TEXT        NOT NULL,
  provider_instance_id TEXT NOT NULL,
  model        TEXT        NOT NULL,
  objective    TEXT        NOT NULL,
  -- 'mcp' marks work delegated by a supervising Claude Code session.
  source       TEXT        NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','mcp','internal')),
  status       TEXT        NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','waiting_for_approval')),
  depth        INTEGER     NOT NULL DEFAULT 0,
  tool_calls   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  result       TEXT,
  evidence     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence   REAL,
  errors       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  usage        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_id);

CREATE TABLE IF NOT EXISTS permission_audit (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT,
  task_id      TEXT,
  tool_name    TEXT        NOT NULL,
  operation    TEXT,
  tier         TEXT        NOT NULL CHECK (tier IN ('safe','mutation','high-impact')),
  decision     TEXT        NOT NULL CHECK (decision IN ('allowed','denied','approval-required','approved','rejected')),
  reason       TEXT        NOT NULL,
  input        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS permission_audit_created_idx ON permission_audit (created_at DESC);

-- Usage is keyed by provider INSTANCE and stamped with a usage class, so local,
-- remote-GPU, remote-API and paid inference stay distinguishable. This is the
-- evidence that a delegated MCP task ran entirely on local inference.
CREATE TABLE IF NOT EXISTS usage_events (
  id             BIGSERIAL PRIMARY KEY,
  conversation_id TEXT,
  task_id        TEXT,
  workspace_id   TEXT,
  provider_instance_id TEXT  NOT NULL,
  usage_class    TEXT        NOT NULL DEFAULT 'LOCAL_OLLAMA'
                 CHECK (usage_class IN ('LOCAL_OLLAMA','REMOTE_GPU_OLLAMA','HUGGING_FACE_REMOTE','FUTURE_PAID_PROVIDER')),
  model          TEXT        NOT NULL,
  model_digest   TEXT,
  source         TEXT        NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','mcp','internal')),
  worker_role    TEXT,
  input_tokens   INTEGER     NOT NULL DEFAULT 0,
  output_tokens  INTEGER     NOT NULL DEFAULT 0,
  tool_calls     INTEGER     NOT NULL DEFAULT 0,
  duration_ms    INTEGER     NOT NULL DEFAULT 0,
  estimated_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  -- Set when a remote instance failed and a LOCAL fallback served the request.
  fallback_from_instance_id TEXT,
  rate_limited   BOOLEAN     NOT NULL DEFAULT FALSE,
  provider_error TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_usage_class_idx ON usage_events (usage_class);
CREATE INDEX IF NOT EXISTS usage_events_source_idx ON usage_events (source, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_task_idx ON usage_events (task_id);

CREATE TABLE IF NOT EXISTS memory_entries (
  id           TEXT PRIMARY KEY,
  scope        TEXT        NOT NULL CHECK (scope IN ('conversation','workspace','agent','global')),
  scope_key    TEXT        NOT NULL,
  content      TEXT        NOT NULL,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_entries_scope_idx ON memory_entries (scope, scope_key);

CREATE TABLE IF NOT EXISTS escalation_records (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT,
  task_id        TEXT,
  mode           TEXT        NOT NULL,
  reason         TEXT        NOT NULL,
  approved       BOOLEAN     NOT NULL DEFAULT FALSE,
  provider_instance_id TEXT,
  model          TEXT,
  estimated_cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goal_executions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT,
  objective           TEXT        NOT NULL,
  completion_criteria JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT        NOT NULL CHECK (status IN ('running','completed','failed','cancelled','exhausted')),
  iterations          INTEGER     NOT NULL DEFAULT 0,
  max_iterations      INTEGER     NOT NULL DEFAULT 10,
  evidence            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS benchmark_records (
  id          BIGSERIAL PRIMARY KEY,
  task_type   TEXT        NOT NULL,
  provider_instance_id TEXT NOT NULL,
  model       TEXT        NOT NULL,
  model_digest TEXT,
  success     BOOLEAN     NOT NULL,
  duration_ms INTEGER     NOT NULL DEFAULT 0,
  turn_count  INTEGER     NOT NULL DEFAULT 0,
  tool_calls  INTEGER     NOT NULL DEFAULT 0,
  retries     INTEGER     NOT NULL DEFAULT 0,
  usage       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  human_rating INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
