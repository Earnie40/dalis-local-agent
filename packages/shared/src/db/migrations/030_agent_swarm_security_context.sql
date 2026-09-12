-- Forward-compatible completion of the swarm schema.
--
-- Development servers can apply a migration as soon as its file appears. Keep
-- this as a separate idempotent migration so databases that saw the initial 029
-- retain an honest migration ledger while fresh databases converge on the same
-- final schema.

ALTER TABLE agent_swarms
  ADD COLUMN IF NOT EXISTS engagement_id TEXT
    REFERENCES red_team_engagements (id) ON DELETE SET NULL;

ALTER TABLE agent_swarms
  ADD COLUMN IF NOT EXISTS sealed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_swarms_engagement_idx
  ON agent_swarms (engagement_id, created_at DESC)
  WHERE engagement_id IS NOT NULL;

DROP INDEX IF EXISTS agent_swarms_synthesis_idx;

CREATE INDEX agent_swarms_synthesis_idx
  ON agent_swarms (created_at)
  WHERE coordinator_task_id IS NULL AND cancelled_at IS NULL AND sealed_at IS NOT NULL;
