-- Durable AI swarms built from the existing delegated-task runtime.
--
-- A swarm is coordination metadata around ordinary tasks. Members keep their
-- normal roles, workspace permissions, model routing, audit records and worker
-- limits; this table does not create a second execution or authorization path.

CREATE TABLE IF NOT EXISTS agent_swarms (
  id                    TEXT        PRIMARY KEY,
  workspace_id          TEXT        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  engagement_id         TEXT        REFERENCES red_team_engagements (id) ON DELETE SET NULL,
  objective             TEXT        NOT NULL,
  strategy              TEXT        NOT NULL,
  coordinator_task_id   TEXT        REFERENCES tasks (id) ON DELETE SET NULL,
  synthesis_claimed_by  TEXT,
  synthesis_claimed_at  TIMESTAMPTZ,
  sealed_at             TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_swarm_members (
  swarm_id   TEXT    NOT NULL REFERENCES agent_swarms (id) ON DELETE CASCADE,
  task_id    TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,
  objective  TEXT    NOT NULL,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (swarm_id, task_id),
  UNIQUE (swarm_id, ordinal)
);

CREATE INDEX IF NOT EXISTS agent_swarms_created_idx
  ON agent_swarms (created_at DESC);

CREATE INDEX IF NOT EXISTS agent_swarms_engagement_idx
  ON agent_swarms (engagement_id, created_at DESC)
  WHERE engagement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_swarm_members_task_idx
  ON agent_swarm_members (task_id);

CREATE INDEX IF NOT EXISTS agent_swarms_synthesis_idx
  ON agent_swarms (created_at)
  WHERE coordinator_task_id IS NULL AND cancelled_at IS NULL AND sealed_at IS NOT NULL;
