-- Durable tasks retain routing intent as well as the concrete provider chosen
-- at submission time. The alias is re-resolved when queued work starts, so a
-- RunPod GPU recovery or outage is handled without pinning stale infrastructure.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_alias TEXT;
