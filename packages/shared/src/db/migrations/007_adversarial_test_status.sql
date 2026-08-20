-- Adds a status column to adversarial_test_results so a run that was blocked
-- by the safety envelope (scope/limits/approval) or failed with an
-- unexpected error is persisted as evidence, not silently dropped. Existing
-- rows default to 'passed'/'failed' based on their existing `passed` value.

ALTER TABLE adversarial_test_results
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'passed'
    CHECK (status IN ('passed', 'failed', 'error', 'blocked'));

UPDATE adversarial_test_results
  SET status = CASE WHEN passed THEN 'passed' ELSE 'failed' END
  WHERE status = 'passed' AND passed = FALSE;

CREATE INDEX IF NOT EXISTS adversarial_test_results_status_idx ON adversarial_test_results (status);
