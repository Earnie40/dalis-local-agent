-- Runtime phases include bounded budget telemetry. They are observable system
-- events, not private model reasoning, and must be storable alongside the
-- existing objective tool and verification evidence.
ALTER TABLE training_trace_steps
  DROP CONSTRAINT IF EXISTS training_trace_steps_step_type_check;

ALTER TABLE training_trace_steps
  ADD CONSTRAINT training_trace_steps_step_type_check CHECK (
    step_type IN (
      'model_response', 'tool_call', 'tool_result', 'file_edit', 'test',
      'verification', 'error', 'runtime_event'
    )
  );
