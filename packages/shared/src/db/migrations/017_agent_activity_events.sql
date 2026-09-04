-- Ordered, redacted, observable agent activity. This is intentionally
-- separate from training traces: it powers run replay and operational UI.
CREATE TABLE IF NOT EXISTS agent_activity_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id   TEXT,
  run_id       TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','success','failed','blocked','info')),
  title        TEXT NOT NULL,
  message      TEXT,
  tool_name    TEXT,
  command      TEXT,
  file_path    TEXT,
  duration_ms  INTEGER,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_activity_events_run_idx
  ON agent_activity_events (run_id, sequence, created_at, id);
CREATE INDEX IF NOT EXISTS agent_activity_events_workspace_idx
  ON agent_activity_events (workspace_id, created_at DESC);
