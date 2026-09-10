-- Repair backfilled run titles.
--
-- 027 seeded agent_runs from the activity stream and took each run's title from
-- its first event. That first event is a routing notice, so historical runs all
-- read "Running on the RunPod GPU" or "Mode: interactive" — technically true and
-- completely useless for finding a run again.
--
-- agent_working_state.objective holds the actual prompt, keyed by thread_id,
-- which is the run id. Join against it and restore the real objective.
--
-- Scoped to rows where objective IS NULL: those are exactly the rows 027
-- backfilled. Runs recorded by the live writer already carry a real objective
-- and must not be rewritten.
UPDATE agent_runs AS r
   SET objective = source.objective,
       title     = CASE
                     WHEN length(source.first_line) > 80
                       THEN left(source.first_line, 77) || U&'\2026'
                     ELSE source.first_line
                   END
  FROM (
    SELECT
      w.thread_id,
      w.objective,
      btrim(split_part(w.objective, E'\n', 1)) AS first_line
    FROM agent_working_state w
    WHERE w.objective IS NOT NULL
      AND btrim(w.objective) <> ''
  ) AS source
 WHERE r.id = source.thread_id
   AND r.objective IS NULL
   AND source.first_line <> '';
