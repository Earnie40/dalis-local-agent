-- DACAIS domain intelligence: domain-scoped dataset lineage, the temporal
-- market-event architecture, immutable predictions, and the adapter registry.
--
-- Additive only. Nothing in the application writes to these tables yet — the
-- corresponding TypeScript primitives live in packages/domain-knowledge,
-- packages/datasets, packages/market-intelligence, and packages/model-registry
-- and are currently pure/in-memory. This migration declares the schema so those
-- layers can be persisted without a later reshaping.
--
-- The CHECK constraints are the point: the look-ahead-bias and immutability
-- invariants are enforced by the database as well as by application code, so a
-- direct SQL insert cannot bypass them.

-- ---------------------------------------------------------------------------
-- Dataset lineage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT datasets_purpose_check
    CHECK (purpose IN ('retrieval', 'training', 'evaluation', 'experience'))
);

CREATE INDEX IF NOT EXISTS datasets_domain_idx ON datasets (domain_id);

-- A dataset version is immutable once written; corrections publish a new
-- version rather than editing this row.
CREATE TABLE IF NOT EXISTS dataset_versions (
  dataset_id    TEXT    NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  record_count  INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, version),
  CONSTRAINT dataset_versions_version_check CHECK (version >= 1),
  CONSTRAINT dataset_versions_count_check   CHECK (record_count >= 0)
);

-- A dataset with no source cannot be audited, so at least one row must exist
-- per version. Enforced on write by packages/datasets.
CREATE TABLE IF NOT EXISTS dataset_sources (
  id                TEXT PRIMARY KEY,
  dataset_id        TEXT    NOT NULL,
  version           INTEGER NOT NULL,
  kind              TEXT    NOT NULL,
  locator           TEXT    NOT NULL,
  sha256            TEXT,
  license           TEXT,
  -- Set when the source required explicit permission (authorized account
  -- export, consented voice/likeness). Private data must never arrive here.
  authorization_ref TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (dataset_id, version)
    REFERENCES dataset_versions (dataset_id, version) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS dataset_sources_version_idx ON dataset_sources (dataset_id, version);

CREATE TABLE IF NOT EXISTS dataset_lineage (
  id             TEXT PRIMARY KEY,
  from_dataset_id TEXT    NOT NULL,
  from_version    INTEGER NOT NULL,
  to_dataset_id   TEXT    NOT NULL,
  to_version      INTEGER NOT NULL,
  relation        TEXT    NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (from_dataset_id, from_version)
    REFERENCES dataset_versions (dataset_id, version) ON DELETE CASCADE,
  FOREIGN KEY (to_dataset_id, to_version)
    REFERENCES dataset_versions (dataset_id, version) ON DELETE CASCADE,
  CONSTRAINT dataset_lineage_relation_check
    CHECK (relation IN ('derived_from', 'filtered_from', 'merged_from', 'annotated_from', 'simulated_from')),
  -- Self-derivation would make provenance unresolvable. Deeper cycles are
  -- rejected by LineageGraph, which SQL cannot express here.
  CONSTRAINT dataset_lineage_no_self_edge
    CHECK (NOT (from_dataset_id = to_dataset_id AND from_version = to_version))
);

-- ---------------------------------------------------------------------------
-- Autonomous learning loop
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS learning_candidates (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'observe',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT learning_candidates_stage_check CHECK (stage IN (
    'observe', 'retrieve', 'analyze', 'hypothesize', 'simulate', 'compare',
    'store_experience', 'quality_review', 'training_candidate', 'approval',
    'dataset', 'fine_tune', 'evaluate', 'promoted', 'rejected'
  ))
);

CREATE TABLE IF NOT EXISTS learning_stage_transitions (
  id            TEXT PRIMARY KEY,
  candidate_id  TEXT NOT NULL REFERENCES learning_candidates (id) ON DELETE CASCADE,
  from_stage    TEXT NOT NULL,
  to_stage      TEXT NOT NULL,
  -- Mandatory for the approval stage: automated approval is not permitted.
  actor         TEXT,
  note          TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT learning_transitions_approval_needs_actor
    CHECK (to_stage <> 'approval' OR (actor IS NOT NULL AND length(btrim(actor)) > 0))
);

CREATE INDEX IF NOT EXISTS learning_transitions_candidate_idx
  ON learning_stage_transitions (candidate_id, at);

-- ---------------------------------------------------------------------------
-- Temporal market architecture
--
-- Every observation carries three timestamps and the ordering is enforced:
--   event_time   when it happened
--   available_at earliest moment it could legitimately be known
--   observed_at  when this platform recorded it
--
-- Backtests and training examples filter on available_at. Filtering on
-- event_time is the classic look-ahead leak.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market_participants (
  id                TEXT PRIMARY KEY,
  participant_kind  TEXT NOT NULL,
  -- Pseudonymous by default. A real-world name may only be attached with cited
  -- public evidence, and never inferred from an address alone.
  attributed_name   TEXT,
  attribution_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_kinds      JSONB NOT NULL DEFAULT '[]'::jsonb,
  authorization_ref TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_participants_kind_check
    CHECK (participant_kind IN ('wallet', 'account', 'strategy', 'institution-disclosure')),
  CONSTRAINT market_participants_attribution_needs_evidence
    CHECK (attributed_name IS NULL OR jsonb_array_length(attribution_evidence) > 0)
);

CREATE TABLE IF NOT EXISTS market_events (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL,
  instrument    TEXT NOT NULL,
  event_kind    TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_time    TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  source_hash   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_events_temporal_order
    CHECK (event_time <= available_at AND available_at <= observed_at)
);

CREATE INDEX IF NOT EXISTS market_events_availability_idx ON market_events (instrument, available_at);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id            TEXT PRIMARY KEY,
  instrument    TEXT NOT NULL,
  snapshot      JSONB NOT NULL,
  event_time    TIMESTAMPTZ NOT NULL,
  available_at  TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  snapshot_hash TEXT,
  CONSTRAINT market_snapshots_temporal_order
    CHECK (event_time <= available_at AND available_at <= observed_at)
);

CREATE INDEX IF NOT EXISTS market_snapshots_availability_idx ON market_snapshots (instrument, available_at);

CREATE TABLE IF NOT EXISTS market_actions (
  id                TEXT PRIMARY KEY,
  participant_id    TEXT NOT NULL REFERENCES market_participants (id) ON DELETE CASCADE,
  instrument        TEXT NOT NULL,
  direction         TEXT NOT NULL,
  -- A size class, not a notional: the research question is behavioural, and a
  -- raw size invites mirroring rather than understanding.
  size_class        TEXT NOT NULL,
  entry_time        TIMESTAMPTZ NOT NULL,
  exit_time         TIMESTAMPTZ,
  holding_period_ms BIGINT,
  regime            TEXT NOT NULL DEFAULT 'unknown',
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The three layers are separate columns so they can never collapse into one.
  stated_rationale  JSONB,
  inferred_rationale JSONB,
  outcome           JSONB,
  event_time        TIMESTAMPTZ NOT NULL,
  available_at      TIMESTAMPTZ NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL,
  CONSTRAINT market_actions_direction_check CHECK (direction IN ('long', 'short', 'flat')),
  CONSTRAINT market_actions_size_class_check
    CHECK (size_class IN ('minimal', 'small', 'moderate', 'large', 'dominant')),
  CONSTRAINT market_actions_exit_after_entry CHECK (exit_time IS NULL OR exit_time >= entry_time),
  CONSTRAINT market_actions_temporal_order
    CHECK (event_time <= available_at AND available_at <= observed_at)
);

CREATE INDEX IF NOT EXISTS market_actions_participant_idx ON market_actions (participant_id, available_at);

CREATE TABLE IF NOT EXISTS market_hypotheses (
  id            TEXT PRIMARY KEY,
  domain_id     TEXT NOT NULL,
  statement     TEXT NOT NULL,
  conditions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Assertion class is mandatory so an inference is never read as a fact.
  assertion_class TEXT NOT NULL,
  confidence    DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_hypotheses_assertion_check CHECK (assertion_class IN (
    'observed', 'stated', 'inferred', 'simulated', 'predicted', 'estimated', 'confirmed-physical'
  )),
  CONSTRAINT market_hypotheses_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT market_hypotheses_uncertain_needs_confidence
    CHECK (assertion_class NOT IN ('inferred', 'predicted', 'estimated') OR confidence IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Predictions — append-only by construction
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market_predictions (
  id                     TEXT PRIMARY KEY,
  domain_id              TEXT NOT NULL,
  statement              TEXT NOT NULL,
  instrument             TEXT NOT NULL,
  probability            DOUBLE PRECISION NOT NULL,
  confidence             DOUBLE PRECISION NOT NULL,
  horizon_ms             BIGINT NOT NULL,
  conditions             JSONB NOT NULL DEFAULT '[]'::jsonb,
  invalidating_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence               JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_id               TEXT NOT NULL,
  model_version          TEXT NOT NULL,
  issued_at              TIMESTAMPTZ NOT NULL,
  resolves_at            TIMESTAMPTZ NOT NULL,
  -- Content hash of the forecast as issued. An outcome row references this, so
  -- a forecast edited after the fact no longer matches its own result.
  prediction_hash        TEXT NOT NULL UNIQUE,
  -- A forecast of exactly 0 or 1 claims certainty and is refused.
  CONSTRAINT market_predictions_probability_range CHECK (probability > 0 AND probability < 1),
  CONSTRAINT market_predictions_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT market_predictions_horizon_check CHECK (horizon_ms > 0),
  CONSTRAINT market_predictions_resolves_after_issue CHECK (resolves_at > issued_at),
  -- An unfalsifiable forecast cannot be evaluated.
  CONSTRAINT market_predictions_falsifiable
    CHECK (jsonb_array_length(invalidating_conditions) > 0)
);

CREATE INDEX IF NOT EXISTS market_predictions_resolution_idx ON market_predictions (resolves_at);

CREATE TABLE IF NOT EXISTS market_prediction_outcomes (
  id              TEXT PRIMARY KEY,
  prediction_id   TEXT NOT NULL REFERENCES market_predictions (id) ON DELETE CASCADE,
  prediction_hash TEXT NOT NULL REFERENCES market_predictions (prediction_hash) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  realized_return DOUBLE PRECISION,
  resolved_at     TIMESTAMPTZ NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_prediction_outcomes_status_check
    CHECK (status IN ('true', 'false', 'invalidated')),
  -- One outcome per forecast; a result cannot be revised by appending another.
  CONSTRAINT market_prediction_outcomes_unique UNIQUE (prediction_id)
);

CREATE TABLE IF NOT EXISTS market_evaluations (
  id                   TEXT PRIMARY KEY,
  domain_id            TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  model_version        TEXT NOT NULL,
  window_start         TIMESTAMPTZ NOT NULL,
  window_end           TIMESTAMPTZ NOT NULL,
  prediction_count     INTEGER NOT NULL,
  brier_score          DOUBLE PRECISION,
  directional_accuracy DOUBLE PRECISION,
  false_confidence_rate DOUBLE PRECISION,
  calibration_bins     JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_drawdown         DOUBLE PRECISION,
  regime               TEXT,
  evaluation_hash      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT market_evaluations_window_check CHECK (window_end > window_start)
);

-- ---------------------------------------------------------------------------
-- Adapter registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS model_adapters (
  adapter_id            TEXT    NOT NULL,
  version               INTEGER NOT NULL,
  domain_id             TEXT    NOT NULL,
  base_model            TEXT    NOT NULL,
  base_model_digest     TEXT,
  status                TEXT    NOT NULL DEFAULT 'planned',
  trained_on            JSONB   NOT NULL DEFAULT '[]'::jsonb,
  training_run_hash     TEXT,
  model_adapter_hash    TEXT,
  supersedes_adapter_id TEXT,
  rejection_reason      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (adapter_id, version),
  CONSTRAINT model_adapters_status_check
    CHECK (status IN ('planned', 'candidate', 'promoted', 'rejected', 'retired')),
  -- A promoted adapter must be traceable to the run and the data that made it.
  CONSTRAINT model_adapters_promoted_is_traceable CHECK (
    status <> 'promoted'
    OR (training_run_hash IS NOT NULL AND jsonb_array_length(trained_on) > 0)
  )
);

CREATE TABLE IF NOT EXISTS adapter_evaluations (
  id                    TEXT PRIMARY KEY,
  adapter_id            TEXT    NOT NULL,
  adapter_version       INTEGER NOT NULL,
  domain_id             TEXT    NOT NULL,
  suite_dataset_id      TEXT    NOT NULL,
  suite_dataset_version INTEGER NOT NULL,
  score                 DOUBLE PRECISION NOT NULL,
  general_delta         DOUBLE PRECISION NOT NULL,
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluation_hash       TEXT,
  FOREIGN KEY (adapter_id, adapter_version)
    REFERENCES model_adapters (adapter_id, version) ON DELETE CASCADE,
  CONSTRAINT adapter_evaluations_score_range CHECK (score >= 0 AND score <= 1)
);

CREATE TABLE IF NOT EXISTS adapter_promotions (
  id              TEXT PRIMARY KEY,
  adapter_id      TEXT    NOT NULL,
  adapter_version INTEGER NOT NULL,
  evaluation_id   TEXT    NOT NULL REFERENCES adapter_evaluations (id) ON DELETE CASCADE,
  -- Automated promotion is not permitted.
  approved_by     TEXT    NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL,
  approval_hash   TEXT    NOT NULL,
  FOREIGN KEY (adapter_id, adapter_version)
    REFERENCES model_adapters (adapter_id, version) ON DELETE CASCADE,
  CONSTRAINT adapter_promotions_needs_named_approver CHECK (length(btrim(approved_by)) > 0)
);

-- ---------------------------------------------------------------------------
-- Evidence anchors
--
-- Raw data stays off-chain. Only content hashes are recorded here, and
-- anchored_tx_hash stays NULL until an anchor is actually submitted to a
-- registry — which nothing in this repository currently does.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS evidence_anchors (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  digest           TEXT NOT NULL,
  locator          TEXT,
  anchored_tx_hash TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_anchors_kind_check CHECK (kind IN (
    'sourceHash', 'datasetHash', 'marketSnapshotHash', 'predictionHash',
    'simulationHash', 'trainingRunHash', 'modelAdapterHash', 'evaluationHash',
    'approvalHash', 'physicalActionEvidenceHash'
  )),
  CONSTRAINT evidence_anchors_digest_is_sha256 CHECK (digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS evidence_anchors_digest_idx ON evidence_anchors (digest);
CREATE INDEX IF NOT EXISTS evidence_anchors_kind_idx ON evidence_anchors (kind, created_at DESC);
