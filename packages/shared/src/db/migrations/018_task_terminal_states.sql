-- Agent completion is authoritative: a budget ceiling or genuine blocker must
-- not be stored as a successful task merely because the worker returned text.
ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check CHECK (
    status IN (
      'queued', 'running', 'completed', 'failed', 'cancelled',
      'waiting_for_approval', 'waiting_for_user', 'blocked'
    )
  );
