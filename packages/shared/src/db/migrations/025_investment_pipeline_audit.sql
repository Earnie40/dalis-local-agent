-- Preserve the provenance of topic links created by independent extraction
-- pipelines. An investment-sector claim must not make the general theme
-- extractor consider a signal complete (or vice versa).
ALTER TABLE signal_topics
  ADD COLUMN IF NOT EXISTS origins TEXT[] NOT NULL
  DEFAULT ARRAY['theme_extraction']::TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'signal_topics_origins_check'
       AND conrelid = 'signal_topics'::regclass
  ) THEN
    ALTER TABLE signal_topics
      ADD CONSTRAINT signal_topics_origins_check
      CHECK (
        cardinality(origins) > 0
        AND origins <@ ARRAY['theme_extraction', 'investment_fact']::TEXT[]
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE signal_topics VALIDATE CONSTRAINT signal_topics_origins_check;

-- Collection runs report investment extraction separately from retrieval.
-- This makes a run that found sources but yielded no usable VC facts visibly
-- distinct from one whose extraction failed.
ALTER TABLE intelligence_collection_runs
  ADD COLUMN IF NOT EXISTS investment_signals_processed INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS investment_claims_persisted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS investment_no_facts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS investment_ambiguous INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS investment_rejected INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS investment_failed INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'intelligence_collection_runs_investment_counts_check'
       AND conrelid = 'intelligence_collection_runs'::regclass
  ) THEN
    ALTER TABLE intelligence_collection_runs
      ADD CONSTRAINT intelligence_collection_runs_investment_counts_check
      CHECK (
        investment_signals_processed >= 0
        AND investment_claims_persisted >= 0
        AND investment_no_facts >= 0
        AND investment_ambiguous >= 0
        AND investment_rejected >= 0
        AND investment_failed >= 0
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE intelligence_collection_runs
  VALIDATE CONSTRAINT intelligence_collection_runs_investment_counts_check;
