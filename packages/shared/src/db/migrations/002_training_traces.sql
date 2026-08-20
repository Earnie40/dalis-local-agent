-- Training traces: sanitized, reproducible coding-agent trajectories captured
-- for future LoRA/QLoRA fine-tuning. Separate from telemetry by design.
--
-- Never stored here: hidden chain-of-thought. Model turns hold only the final
-- visible output, with <think> blocks stripped before persistence.

-- Capture and export are independent grants: a workspace may allow operational
-- capture while forbidding any training export.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS training_trace_capture  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS training_export_allowed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS training_traces (
  trace_id      TEXT PRIMARY KEY,
  task_id       TEXT        NOT NULL,
  session_id    TEXT,
  workspace_id  TEXT        REFERENCES workspaces (id) ON DELETE SET NULL,
  agent_role    TEXT        NOT NULL,
  task_type     TEXT        NOT NULL,
  objective     TEXT        NOT NULL,
  constraints   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source        TEXT        NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','mcp','internal')),

  -- Provenance: which behaviour produced this trajectory. The Ollama blob
  -- digest is recorded alongside the tag — a tag alone is not an identity.
  provider_instance_id  TEXT NOT NULL,
  usage_class           TEXT NOT NULL
                        CHECK (usage_class IN ('LOCAL_OLLAMA','REMOTE_GPU_OLLAMA','HUGGING_FACE_REMOTE','FUTURE_PAID_PROVIDER')),
  model                 TEXT NOT NULL,
  model_digest          TEXT,
  agent_prompt_version  TEXT NOT NULL DEFAULT 'unversioned',
  tool_schema_version   TEXT NOT NULL DEFAULT 'unversioned',
  router_version        TEXT NOT NULL DEFAULT 'unversioned',
  config_hash           TEXT,

  classification TEXT       NOT NULL DEFAULT 'aborted'
                 CHECK (classification IN ('successful','failed','partial','reverted','aborted')),
  outcome        JSONB      NOT NULL DEFAULT '{}'::jsonb,

  -- Fail-closed: ineligible until sanitization has actually passed.
  sanitization_passed   BOOLEAN NOT NULL DEFAULT FALSE,
  sanitization_notes    TEXT,
  eligible_for_training BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_reason    TEXT,
  eligibility_override  BOOLEAN,

  -- Observable at the MCP boundary only; never the supervisor's reasoning.
  supervisor_disposition TEXT
                 CHECK (supervisor_disposition IS NULL
                        OR supervisor_disposition IN ('accepted','retry_requested','redelegated','unknown')),

  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS training_traces_task_idx ON training_traces (task_id);
CREATE INDEX IF NOT EXISTS training_traces_eligible_idx ON training_traces (eligible_for_training, classification);
CREATE INDEX IF NOT EXISTS training_traces_type_idx ON training_traces (task_type, started_at DESC);
CREATE INDEX IF NOT EXISTS training_traces_model_idx ON training_traces (model, model_digest);

CREATE TABLE IF NOT EXISTS training_trace_steps (
  id            BIGSERIAL PRIMARY KEY,
  trace_id      TEXT        NOT NULL REFERENCES training_traces (trace_id) ON DELETE CASCADE,
  sequence      INTEGER     NOT NULL,
  step_type     TEXT        NOT NULL
                CHECK (step_type IN ('model_response','tool_call','tool_result','file_edit','test','verification','error')),
  tool_name     TEXT,
  arguments     JSONB,
  result_summary TEXT,
  -- What was actually supplied to the model: path/range/hash references, not
  -- repository dumps.
  context_refs  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  files         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Objective evidence only ever written by the tool-execution layer.
  evidence      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Large diffs and logs live on local disk, content-addressed.
  artifact_sha256 TEXT,
  artifact_bytes  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trace_id, sequence)
);

CREATE INDEX IF NOT EXISTS training_trace_steps_trace_idx ON training_trace_steps (trace_id, sequence);
CREATE INDEX IF NOT EXISTS training_trace_steps_type_idx ON training_trace_steps (step_type);

CREATE TABLE IF NOT EXISTS training_feedback (
  id         BIGSERIAL PRIMARY KEY,
  trace_id   TEXT        NOT NULL REFERENCES training_traces (trace_id) ON DELETE CASCADE,
  rating     TEXT        NOT NULL CHECK (rating IN ('good','bad','partial')),
  comment    TEXT,
  rated_by   TEXT,
  rated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_feedback_trace_idx ON training_feedback (trace_id, rated_at DESC);

CREATE TABLE IF NOT EXISTS training_exports (
  export_id     TEXT PRIMARY KEY,
  format        TEXT        NOT NULL CHECK (format IN ('jsonl_trajectory','sft_messages','tool_use_trajectory')),
  filters       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  trace_count   INTEGER     NOT NULL DEFAULT 0,
  excluded_trace_count INTEGER NOT NULL DEFAULT 0,
  output_path   TEXT        NOT NULL,
  output_sha256 TEXT        NOT NULL,
  -- Sanitization is re-run at export time; an export never trusts the
  -- capture-time result.
  sanitization_rerun_passed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
