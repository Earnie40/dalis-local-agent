-- Widens provider_capabilities to the richer capability set PostgresCapabilityStore
-- reads and writes. Every column is nullable: capability-probe.ts currently
-- establishes only toolCalling/streaming/toolCallChannel, so the rest stay NULL
-- ("not probed") rather than being defaulted to a value that would claim an
-- unverified capability.

ALTER TABLE provider_capabilities
  ADD COLUMN IF NOT EXISTS model_digest    TEXT,
  ADD COLUMN IF NOT EXISTS provider_version TEXT,

  ADD COLUMN IF NOT EXISTS parallel_tool_calls  TEXT,
  ADD COLUMN IF NOT EXISTS streaming_tool_calls TEXT,
  ADD COLUMN IF NOT EXISTS tool_choice          TEXT,
  ADD COLUMN IF NOT EXISTS required_tool_choice TEXT,

  ADD COLUMN IF NOT EXISTS structured_output  TEXT,
  ADD COLUMN IF NOT EXISTS json_mode          TEXT,
  ADD COLUMN IF NOT EXISTS json_schema        TEXT,
  ADD COLUMN IF NOT EXISTS strict_json_schema TEXT,

  ADD COLUMN IF NOT EXISTS system_prompt  TEXT,
  ADD COLUMN IF NOT EXISTS multi_turn     TEXT,
  ADD COLUMN IF NOT EXISTS stop_sequences TEXT,

  ADD COLUMN IF NOT EXISTS reasoning             TEXT,
  ADD COLUMN IF NOT EXISTS configurable_thinking TEXT,

  ADD COLUMN IF NOT EXISTS text_input  TEXT,
  ADD COLUMN IF NOT EXISTS image_input TEXT,
  ADD COLUMN IF NOT EXISTS audio_input TEXT,
  ADD COLUMN IF NOT EXISTS file_input  TEXT,

  ADD COLUMN IF NOT EXISTS text_output  TEXT,
  ADD COLUMN IF NOT EXISTS image_output TEXT,
  ADD COLUMN IF NOT EXISTS audio_output TEXT,

  ADD COLUMN IF NOT EXISTS max_tools               INTEGER,
  ADD COLUMN IF NOT EXISTS max_tool_argument_bytes INTEGER,

  ADD COLUMN IF NOT EXISTS tool_call_reliability         REAL,
  ADD COLUMN IF NOT EXISTS structured_output_reliability REAL,
  ADD COLUMN IF NOT EXISTS average_latency_ms            REAL;
