import { getPool } from '../../shared/src/db/pool';

export interface AgentWorkingState {
  threadId: string;
  objective?: string;
  plan?: unknown[];
  completedSteps?: unknown[];
  pendingSteps?: unknown[];
  inspectedFiles?: string[];
  relevantSymbols?: string[];
  changedFiles?: string[];
  knownErrors?: unknown[];
  architectureFacts?: unknown[];
  validationState?: Record<string, unknown>;
}

export async function saveWorkingState(state: AgentWorkingState) {
  const pool = getPool();

  await pool.query(`
    INSERT INTO agent_working_state (
      thread_id,
      objective,
      plan,
      completed_steps,
      pending_steps,
      inspected_files,
      relevant_symbols,
      changed_files,
      known_errors,
      architecture_facts,
      validation_state,
      updated_at
    )
    VALUES (
      $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,
      $7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,now()
    )
    ON CONFLICT (thread_id)
    DO UPDATE SET
      objective = EXCLUDED.objective,
      plan = EXCLUDED.plan,
      completed_steps = EXCLUDED.completed_steps,
      pending_steps = EXCLUDED.pending_steps,
      inspected_files = EXCLUDED.inspected_files,
      relevant_symbols = EXCLUDED.relevant_symbols,
      changed_files = EXCLUDED.changed_files,
      known_errors = EXCLUDED.known_errors,
      architecture_facts = EXCLUDED.architecture_facts,
      validation_state = EXCLUDED.validation_state,
      updated_at = now()
  `, [
    state.threadId,
    state.objective ?? null,
    JSON.stringify(state.plan ?? []),
    JSON.stringify(state.completedSteps ?? []),
    JSON.stringify(state.pendingSteps ?? []),
    JSON.stringify(state.inspectedFiles ?? []),
    JSON.stringify(state.relevantSymbols ?? []),
    JSON.stringify(state.changedFiles ?? []),
    JSON.stringify(state.knownErrors ?? []),
    JSON.stringify(state.architectureFacts ?? []),
    JSON.stringify(state.validationState ?? {}),
  ]);
}

export async function loadWorkingState(threadId: string) {
  const pool = getPool();

  const result = await pool.query(`
    SELECT *
    FROM agent_working_state
    WHERE thread_id = $1
  `, [threadId]);

  return result.rows[0] ?? null;
}
