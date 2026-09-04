import { getPool } from '@dacai-local-agent/shared';
import { hashArtifact, type DomainId } from '@dacai-local-agent/domain-knowledge';

/**
 * Training candidates derived from verified agent work.
 *
 * The rule this enforces: **a successful answer is not automatically a training
 * example.** A candidate becomes training-eligible only with objective
 * validation evidence AND a named human approval — checked here, and again by
 * CHECK constraints in migration 014 so a direct SQL write cannot bypass it.
 */

export interface TrainingCandidateInput {
  domainId: DomainId;
  /** The trace this came from, so the candidate is traceable to its run. */
  sourceTraceId?: string;
  taskType: string;
  input: string;
  expectedBehavior: string;
  actualBehavior: string;
  /**
   * Objective evidence from the tool/evaluation layer — an exit code, a suite
   * score, a matched finding. Never a model's own claim about itself.
   */
  validationEvidence: Record<string, unknown>;
  qualityScore?: number;
}

export interface TrainingCandidate extends TrainingCandidateInput {
  id: string;
  candidateHash: string;
  humanApproval?: string;
  approvedAt?: string;
  trainingEligible: boolean;
  ineligibilityReason?: string;
  datasetId?: string;
  datasetVersion?: number;
  createdAt: string;
}

export class TrainingCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrainingCandidateError';
  }
}

/** Deterministic id so the same verified work does not produce duplicates. */
export function candidateHash(input: TrainingCandidateInput): string {
  return hashArtifact({
    domainId: input.domainId,
    taskType: input.taskType,
    input: input.input,
    expectedBehavior: input.expectedBehavior,
    actualBehavior: input.actualBehavior,
  });
}

export class TrainingCandidateStore {
  /**
   * Records a candidate. Always ineligible on creation, whatever the caller
   * passes — eligibility is earned through approve(), never asserted at write.
   */
  async record(input: TrainingCandidateInput): Promise<TrainingCandidate> {
    if (!input.input.trim() || !input.expectedBehavior.trim() || !input.actualBehavior.trim()) {
      throw new TrainingCandidateError('A candidate needs an input, an expected behaviour, and an actual behaviour.');
    }
    if (input.qualityScore !== undefined && !(input.qualityScore >= 0 && input.qualityScore <= 1)) {
      throw new TrainingCandidateError(`qualityScore must be within 0..1, received ${input.qualityScore}.`);
    }

    const hash = candidateHash(input);
    const id = `tc_${hash.slice(0, 12)}`;
    const noEvidence = Object.keys(input.validationEvidence).length === 0;

    await getPool().query(
      `INSERT INTO training_candidates (
         id, domain_id, source_trace_id, task_type, input, expected_behavior, actual_behavior,
         validation_evidence, quality_score, training_eligible, ineligibility_reason, candidate_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11)
       ON CONFLICT (candidate_hash) DO NOTHING`,
      [
        id, input.domainId, input.sourceTraceId ?? null, input.taskType, input.input,
        input.expectedBehavior, input.actualBehavior, JSON.stringify(input.validationEvidence),
        input.qualityScore ?? null,
        noEvidence ? 'No objective validation evidence recorded.' : 'Awaiting human approval.',
        hash,
      ],
    );

    const stored = await this.get(id);
    if (!stored) throw new TrainingCandidateError(`Candidate ${id} was not persisted.`);
    return stored;
  }

  /**
   * A named human marks the candidate as training material. Refused without
   * objective evidence — approval confirms a judgement, it does not substitute
   * for the evidence that judgement rests on.
   */
  async approve(id: string, approvedBy: string): Promise<TrainingCandidate> {
    if (!approvedBy.trim()) throw new TrainingCandidateError('Approval requires a named human.');

    const candidate = await this.get(id);
    if (!candidate) throw new TrainingCandidateError(`Unknown candidate ${id}.`);
    if (Object.keys(candidate.validationEvidence).length === 0) {
      throw new TrainingCandidateError(
        `Refusing to approve ${id}: it carries no objective validation evidence.`,
      );
    }

    await getPool().query(
      `UPDATE training_candidates
          SET human_approval = $2, approved_at = now(), training_eligible = true, ineligibility_reason = NULL
        WHERE id = $1`,
      [id, approvedBy],
    );
    return (await this.get(id)) as TrainingCandidate;
  }

  /** Withdraws eligibility. Available at any time, including after approval. */
  async reject(id: string, reason: string): Promise<TrainingCandidate> {
    await getPool().query(
      `UPDATE training_candidates
          SET training_eligible = false, ineligibility_reason = $2, human_approval = NULL, approved_at = NULL
        WHERE id = $1`,
      [id, reason],
    );
    return (await this.get(id)) as TrainingCandidate;
  }

  async get(id: string): Promise<TrainingCandidate | undefined> {
    const { rows } = await getPool().query('SELECT * FROM training_candidates WHERE id = $1', [id]);
    if (!rows.length) return undefined;
    const r = rows[0];
    return {
      id: r.id,
      domainId: r.domain_id as DomainId,
      sourceTraceId: r.source_trace_id ?? undefined,
      taskType: r.task_type,
      input: r.input,
      expectedBehavior: r.expected_behavior,
      actualBehavior: r.actual_behavior,
      validationEvidence: r.validation_evidence,
      qualityScore: r.quality_score === null ? undefined : Number(r.quality_score),
      humanApproval: r.human_approval ?? undefined,
      approvedAt: r.approved_at ? (r.approved_at as Date).toISOString() : undefined,
      trainingEligible: r.training_eligible,
      ineligibilityReason: r.ineligibility_reason ?? undefined,
      datasetId: r.dataset_id ?? undefined,
      datasetVersion: r.dataset_version === null ? undefined : r.dataset_version,
      candidateHash: r.candidate_hash,
      createdAt: (r.created_at as Date).toISOString(),
    };
  }

  /** Only approved candidates are exportable into a dataset version. */
  async eligibleFor(domainId: DomainId): Promise<TrainingCandidate[]> {
    const { rows } = await getPool().query<{ id: string }>(
      'SELECT id FROM training_candidates WHERE domain_id = $1 AND training_eligible = true',
      [domainId],
    );
    const found = await Promise.all(rows.map((r) => this.get(r.id)));
    return found.filter((c): c is TrainingCandidate => Boolean(c));
  }

  async sealIntoDataset(id: string, datasetId: string, version: number): Promise<void> {
    const candidate = await this.get(id);
    if (!candidate?.trainingEligible) {
      throw new TrainingCandidateError(
        `Refusing to seal ${id} into a dataset: it is not training-eligible.`,
      );
    }
    await getPool().query(
      'UPDATE training_candidates SET dataset_id = $2, dataset_version = $3 WHERE id = $1',
      [id, datasetId, version],
    );
  }
}
