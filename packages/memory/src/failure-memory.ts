import { getPool } from '../../shared/src/db/pool';

export interface FailureLesson {
  operation: string;
  errorSignature: string;
  attemptedApproach?: string;
  rootCause?: string;
  correctiveAction?: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}

export async function rememberFailure(lesson: FailureLesson) {
  const pool = getPool();

  await pool.query(`
    INSERT INTO agent_failure_memory (
      operation,
      error_signature,
      attempted_approach,
      root_cause,
      corrective_action,
      outcome,
      metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [
    lesson.operation,
    lesson.errorSignature,
    lesson.attemptedApproach ?? null,
    lesson.rootCause ?? null,
    lesson.correctiveAction ?? null,
    lesson.outcome ?? null,
    JSON.stringify(lesson.metadata ?? {}),
  ]);
}

export async function recallFailures(
  operation: string,
  errorSignature?: string,
  limit = 8,
) {
  const pool = getPool();

  const result = await pool.query(`
    SELECT *
    FROM agent_failure_memory
    WHERE
      operation = $1
      OR ($2::text IS NOT NULL AND error_signature ILIKE '%' || $2 || '%')
    ORDER BY created_at DESC
    LIMIT $3
  `, [operation, errorSignature ?? null, limit]);

  return result.rows;
}
