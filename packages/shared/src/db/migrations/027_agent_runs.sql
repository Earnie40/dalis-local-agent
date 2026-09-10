-- Run-level agent history.
--
-- agent_activity_events already stores every event of every run, but it is
-- keyed by run_id with no way to enumerate runs: the activity endpoint can only
-- answer "what happened in this run" for a run_id the caller already holds.
-- The web client compensated by keeping its agent sessions in browser
-- localStorage, so history died with the browser profile and was invisible on
-- any other machine.
--
-- This is the run-level index that makes persisted activity reachable, and the
-- agent-side counterpart to `conversations`.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id           TEXT,
  title                TEXT NOT NULL,
  objective            TEXT,
  alias                TEXT,
  model                TEXT,
  provider_instance_id TEXT,
  role                 TEXT,
  run_mode             TEXT,
  status               TEXT NOT NULL CHECK (status IN ('running','completed','failed','blocked','cancelled')),
  answer               TEXT,
  error                TEXT,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_runs_workspace_idx
  ON agent_runs (workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_session_idx
  ON agent_runs (session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_started_idx
  ON agent_runs (started_at DESC);

-- Backfill from the activity stream already on disk. Without this the feature
-- ships with an empty list while the history it is meant to expose sits
-- unreachable in agent_activity_events.
--
-- Every backfilled run is terminal by definition: its process is long gone, so
-- a 'running' status would be a lie that no writer would ever resolve. The
-- final event's status decides between failed/blocked/completed.
INSERT INTO agent_runs (
  id, workspace_id, session_id, title, status, started_at, ended_at
)
SELECT
  grouped.run_id,
  grouped.workspace_id,
  grouped.session_id,
  COALESCE(NULLIF(BTRIM(grouped.first_title), ''), 'Agent run'),
  CASE grouped.last_status
    WHEN 'failed'  THEN 'failed'
    WHEN 'blocked' THEN 'blocked'
    ELSE 'completed'
  END,
  grouped.started_at,
  grouped.ended_at
FROM (
  SELECT
    e.run_id,
    MIN(e.workspace_id)                                    AS workspace_id,
    MIN(e.session_id)                                      AS session_id,
    (ARRAY_AGG(e.title  ORDER BY e.sequence ASC))[1]       AS first_title,
    (ARRAY_AGG(e.status ORDER BY e.sequence DESC))[1]      AS last_status,
    MIN(e.created_at)                                      AS started_at,
    MAX(e.created_at)                                      AS ended_at
  FROM agent_activity_events e
  GROUP BY e.run_id
) AS grouped
ON CONFLICT (id) DO NOTHING;
