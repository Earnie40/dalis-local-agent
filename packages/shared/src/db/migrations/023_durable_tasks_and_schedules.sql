-- Durable delegated work.
--
-- Task rows lived in Postgres while the queue that drove them lived in process
-- memory, and nothing reconciled the two at startup. A restart therefore left
-- rows in 'running' or 'queued' that no worker would ever touch again — a
-- silent leak rather than an honest failure. These columns let a task name the
-- process that owns it, so an unowned row is recognisable and recoverable.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

-- 'interrupted' is deliberately distinct from 'failed': the agent did not fail,
-- its process disappeared. Collapsing the two would misattribute infrastructure
-- restarts to the worker and poison training-trace outcome statistics.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check CHECK (
    status IN (
      'queued', 'running', 'completed', 'failed', 'cancelled',
      'waiting_for_approval', 'waiting_for_user', 'blocked', 'interrupted'
    )
  );

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS runner_id    TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- Claiming scans queued rows oldest-first; running rows are swept by heartbeat.
CREATE INDEX IF NOT EXISTS tasks_claimable_idx ON tasks (status, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS tasks_heartbeat_idx ON tasks (status, heartbeat_at)
  WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- Recurring and future-dated work
-- ---------------------------------------------------------------------------
--
-- Scheduling previously lived entirely in Windows Task Scheduler, which meant
-- it was invisible to the application, unmanageable from the UI, and tied to
-- one operator's machine. A schedule here is a row: the server owns it, any
-- client can list it, and the next fire time survives a restart.
--
-- Recurrence is intentionally narrow rather than a cron dialect. 'once' fires
-- at a date and time and then disables itself; 'interval' repeats every N
-- seconds; 'daily' repeats every 24 hours from its first fire time.

CREATE TABLE IF NOT EXISTS task_schedules (
  id               TEXT        PRIMARY KEY,
  name             TEXT        NOT NULL,
  objective        TEXT        NOT NULL,
  role             TEXT        NOT NULL,
  workspace_id     TEXT        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  alias            TEXT,
  run_mode         TEXT,
  kind             TEXT        NOT NULL CHECK (kind IN ('once', 'interval', 'daily')),
  interval_seconds INTEGER     CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
  next_run_at      TIMESTAMPTZ NOT NULL,
  last_run_at      TIMESTAMPTZ,
  last_task_id     TEXT,
  run_count        INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An interval schedule without a period would fire in a tight loop.
  CONSTRAINT task_schedules_interval_required
    CHECK (kind <> 'interval' OR interval_seconds IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS task_schedules_due_idx ON task_schedules (next_run_at)
  WHERE enabled;

-- Which schedule produced a task, so a run history is attributable.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id TEXT
  REFERENCES task_schedules (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_schedule_idx ON tasks (schedule_id, created_at DESC)
  WHERE schedule_id IS NOT NULL;
