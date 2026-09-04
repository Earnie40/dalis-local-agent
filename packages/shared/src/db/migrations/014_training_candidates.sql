-- Training candidates produced from verified agent work.
--
-- A successful answer is NOT automatically a training example. A candidate
-- reaches training eligibility only through the learning-loop gate: quality
-- review, then a named human approval. The CHECK constraints below make that
-- structural rather than procedural.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS training_candidates (
  id                  TEXT PRIMARY KEY,
  domain_id           TEXT NOT NULL,
  -- The trace this was derived from, so a candidate is always traceable back to
  -- the run that produced it.
  source_trace_id     TEXT,
  task_type           TEXT NOT NULL,
  input               TEXT NOT NULL,
  expected_behavior   TEXT NOT NULL,
  actual_behavior     TEXT NOT NULL,
  -- Objective evidence produced by the tool/evaluation layer, never a model claim.
  validation_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_score       DOUBLE PRECISION,
  -- Named human. NULL means not approved.
  human_approval      TEXT,
  approved_at         TIMESTAMPTZ,
  training_eligible   BOOLEAN NOT NULL DEFAULT false,
  ineligibility_reason TEXT,
  candidate_hash      TEXT NOT NULL,
  -- Set once the candidate has been sealed into an immutable dataset version.
  dataset_id          TEXT,
  dataset_version     INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT training_candidates_quality_range
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),

  -- Eligibility requires BOTH a named human approver and objective evidence.
  -- Neither alone is sufficient, and no code path can set the flag without them.
  CONSTRAINT training_candidates_eligible_requires_approval CHECK (
    training_eligible = false
    OR (
      human_approval IS NOT NULL
      AND length(btrim(human_approval)) > 0
      AND approved_at IS NOT NULL
      AND validation_evidence <> '{}'::jsonb
    )
  ),

  -- An approved candidate must record when it was approved.
  CONSTRAINT training_candidates_approval_has_timestamp
    CHECK (human_approval IS NULL OR approved_at IS NOT NULL),

  CONSTRAINT training_candidates_dataset_pair
    CHECK ((dataset_id IS NULL) = (dataset_version IS NULL))
);

CREATE INDEX IF NOT EXISTS training_candidates_domain_idx
  ON training_candidates (domain_id, created_at DESC);
CREATE INDEX IF NOT EXISTS training_candidates_eligible_idx
  ON training_candidates (domain_id, training_eligible);
CREATE UNIQUE INDEX IF NOT EXISTS training_candidates_hash_key
  ON training_candidates (candidate_hash);
