import { getPool } from '@dacai-local-agent/shared';
import { computeEligibility } from './capture';
import type { TrainingFeedback, TrainingTrace, TrainingStep } from './types';

/**
 * Persists trajectories to `training_traces` / `training_trace_steps`.
 *
 * Two invariants live here, not in the caller:
 *   1. Eligibility is recomputed on write. A caller cannot mark a trace
 *      training-eligible by asserting it.
 *   2. Capture respects the workspace's `training_trace_capture` flag, and
 *      export is gated separately by `training_export_allowed`.
 */
export class TraceStore {
  /** Workspaces can opt out of capture entirely. */
  async captureEnabled(workspaceId?: string): Promise<boolean> {
    if (!workspaceId) return true;

    const { rows } = await getPool().query<{ training_trace_capture: boolean }>(
      'SELECT training_trace_capture FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    return rows[0]?.training_trace_capture ?? true;
  }

  async save(trace: TrainingTrace): Promise<{ saved: boolean; eligible: boolean; reason: string }> {
    if (!(await this.captureEnabled(trace.workspaceId))) {
      return { saved: false, eligible: false, reason: 'Capture is disabled for this workspace.' };
    }

    // Recomputed here so the stored flag always reflects the stored trace.
    const eligibility = computeEligibility(trace);
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO training_traces
           (trace_id, task_id, session_id, workspace_id, agent_role, task_type, objective,
            constraints, source, provider_instance_id, usage_class, model, model_digest,
            agent_prompt_version, tool_schema_version, router_version, config_hash,
            classification, outcome, sanitization_passed, sanitization_notes,
            eligible_for_training, eligibility_reason, eligibility_override,
            supervisor_disposition, started_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (trace_id) DO UPDATE SET
           classification        = EXCLUDED.classification,
           outcome               = EXCLUDED.outcome,
           sanitization_passed   = EXCLUDED.sanitization_passed,
           eligible_for_training = EXCLUDED.eligible_for_training,
           eligibility_reason    = EXCLUDED.eligibility_reason,
           completed_at          = EXCLUDED.completed_at`,
        [
          trace.traceId,
          trace.taskId,
          trace.sessionId ?? null,
          trace.workspaceId || null,
          trace.agentRole,
          trace.taskType,
          trace.objective,
          JSON.stringify(trace.constraints ?? []),
          trace.source,
          trace.provenance.providerInstanceId,
          trace.provenance.usageClass,
          trace.provenance.model,
          trace.provenance.modelDigest ?? null,
          trace.provenance.agentPromptVersion,
          trace.provenance.toolSchemaVersion,
          trace.provenance.routerVersion,
          trace.provenance.configHash ?? null,
          trace.classification,
          JSON.stringify(trace.outcome ?? {}),
          trace.sanitizationPassed,
          trace.sanitizationNotes ?? null,
          eligibility.eligible,
          eligibility.reason,
          trace.eligibilityOverride ?? null,
          trace.supervisorDisposition ?? null,
          trace.startedAt,
          trace.completedAt ?? null,
        ],
      );

      await client.query('DELETE FROM training_trace_steps WHERE trace_id = $1', [trace.traceId]);
      for (const step of trace.steps) {
        await client.query(
          `INSERT INTO training_trace_steps
             (trace_id, sequence, step_type, tool_name, arguments, result_summary,
              context_refs, files, evidence, artifact_sha256, artifact_bytes)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)`,
          [
            trace.traceId,
            step.sequence,
            step.type,
            'toolName' in step ? step.toolName : null,
            JSON.stringify('arguments' in step ? step.arguments : null),
            summaryOf(step),
            JSON.stringify(step.contextRefs ?? []),
            JSON.stringify(step.files ?? []),
            JSON.stringify(step.evidence ?? []),
            'diffArtifactSha256' in step ? (step.diffArtifactSha256 ?? null) : null,
            null,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { saved: true, eligible: eligibility.eligible, reason: eligibility.reason };
  }

  async recordFeedback(traceId: string, feedback: TrainingFeedback): Promise<void> {
    const pool = getPool();
    await pool.query(
      'INSERT INTO training_feedback (trace_id, rating, comment, rated_by) VALUES ($1,$2,$3,$4)',
      [traceId, feedback.rating, feedback.comment ?? null, feedback.ratedBy ?? null],
    );

    // Negative feedback withdraws eligibility immediately; it is not a label
    // applied only at export time.
    if (feedback.rating === 'bad') {
      await pool.query(
        `UPDATE training_traces
            SET eligible_for_training = FALSE,
                eligibility_reason = 'Human feedback was negative.'
          WHERE trace_id = $1 AND eligibility_override IS DISTINCT FROM TRUE`,
        [traceId],
      );
    }
  }

  /**
   * The full step record for a run, looked up by either task id or trace id
   * (a supervisor has the task id; only the worker knows the trace id).
   * Answers "did it find nothing, or was something lost?".
   */
  async getByTaskOrTraceId(id: string): Promise<{
    trace: Record<string, unknown>;
    steps: Array<Record<string, unknown>>;
  } | undefined> {
    const pool = getPool();
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT trace_id, task_id, agent_role, task_type, model, classification,
              eligible_for_training, eligibility_reason, sanitization_passed,
              outcome, started_at, completed_at
         FROM training_traces
        WHERE trace_id = $1 OR task_id = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [id],
    );

    const trace = rows[0];
    if (!trace) return undefined;

    const { rows: steps } = await pool.query<Record<string, unknown>>(
      `SELECT sequence, step_type, tool_name, arguments, result_summary, evidence
         FROM training_trace_steps
        WHERE trace_id = $1
        ORDER BY sequence`,
      [trace.trace_id as string],
    );

    return { trace, steps };
  }

  /** Counts for the dataset quality report — split, never collapsed. */
  async stats(): Promise<{
    total: number;
    byClassification: Record<string, number>;
    eligible: number;
    humanRated: number;
    byTaskType: Record<string, number>;
  }> {
    const pool = getPool();
    const [totals, classes, types] = await Promise.all([
      pool.query<{ total: string; eligible: string; rated: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE eligible_for_training) AS eligible,
                count(DISTINCT f.trace_id) AS rated
           FROM training_traces t
           LEFT JOIN training_feedback f ON f.trace_id = t.trace_id`,
      ),
      pool.query<{ classification: string; n: string }>(
        'SELECT classification, count(*) AS n FROM training_traces GROUP BY classification',
      ),
      pool.query<{ task_type: string; n: string }>(
        'SELECT task_type, count(*) AS n FROM training_traces GROUP BY task_type',
      ),
    ]);

    return {
      total: Number(totals.rows[0]?.total ?? 0),
      eligible: Number(totals.rows[0]?.eligible ?? 0),
      humanRated: Number(totals.rows[0]?.rated ?? 0),
      byClassification: Object.fromEntries(classes.rows.map((r) => [r.classification, Number(r.n)])),
      byTaskType: Object.fromEntries(types.rows.map((r) => [r.task_type, Number(r.n)])),
    };
  }
}

function summaryOf(step: TrainingStep): string | null {
  if (step.type === 'model_response') return step.content.slice(0, 4000);
  if (step.type === 'error') return step.message;
  if (step.type === 'runtime_event') return `${step.event}${step.phase ? `:${step.phase}` : ''} — ${step.message}`;
  if (step.type === 'file_edit') return step.unifiedDiff?.slice(0, 4000) ?? null;
  if (step.type === 'test' || step.type === 'verification') {
    return `${step.command} → exit ${step.exitCode}`;
  }
  return step.resultSummary ?? null;
}
