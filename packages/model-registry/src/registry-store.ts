import { createId, getPool } from '@dacai-local-agent/shared';
import type { DomainId } from '@dacai-local-agent/domain-knowledge';
import { AdapterRegistryError, type AdapterRecord, type EvaluationRun } from './adapters.js';

/**
 * Persistence for the adapter registry and its promotion evidence, over the
 * tables declared in migration 012.
 *
 * Promotion is recorded as an immutable evidence row (evaluation + named
 * approver + approval hash), not as a status flag alone, so "why was this
 * promoted" is answerable after the fact.
 */
export class AdapterRegistryStore {
  async save(record: AdapterRecord): Promise<void> {
    if (record.status === 'promoted') {
      throw new AdapterRegistryError(
        'Refusing to write an adapter directly as "promoted". Use recordPromotion(), which requires evaluation evidence and a named approver.',
      );
    }
    await getPool().query(
      `INSERT INTO model_adapters (
         adapter_id, version, domain_id, base_model, base_model_digest, status,
         trained_on, training_run_hash, model_adapter_hash, supersedes_adapter_id, rejection_reason, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (adapter_id, version) DO UPDATE SET
         status = $6, trained_on = $7, training_run_hash = $8,
         model_adapter_hash = $9, rejection_reason = $11`,
      [
        record.adapterId, record.version, record.domainId, record.baseModel,
        record.baseModelDigest ?? null, record.status, JSON.stringify(record.trainedOn),
        record.trainingRunHash ?? null, record.modelAdapterHash ?? null,
        record.supersedesAdapterId ?? null, record.rejectionReason ?? null, record.createdAt,
      ],
    );
  }

  async saveEvaluation(run: EvaluationRun): Promise<string> {
    const id = run.evaluationId || createId('ev');
    await getPool().query(
      `INSERT INTO adapter_evaluations (
         id, adapter_id, adapter_version, domain_id, suite_dataset_id, suite_dataset_version,
         score, general_delta, ran_at, evaluation_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        id, run.adapterId, run.adapterVersion, run.domainId, run.suiteDatasetId,
        run.suiteDatasetVersion, run.score, run.generalDelta, run.ranAt, run.evaluationHash ?? null,
      ],
    );
    return id;
  }

  /**
   * Writes the promotion evidence and flips the adapter status in one
   * transaction: a promoted adapter without its evidence row would be exactly
   * the untraceable state the registry exists to prevent.
   */
  async recordPromotion(promotion: {
    adapterId: string;
    adapterVersion: number;
    evaluationId: string;
    approvedBy: string;
    approvedAt: string;
    approvalHash: string;
  }): Promise<void> {
    if (!promotion.approvedBy.trim()) {
      throw new AdapterRegistryError('Promotion requires a named human approver.');
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO adapter_promotions (id, adapter_id, adapter_version, evaluation_id, approved_by, approved_at, approval_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [createId('prom'), promotion.adapterId, promotion.adapterVersion, promotion.evaluationId, promotion.approvedBy, promotion.approvedAt, promotion.approvalHash],
      );
      await client.query(
        `UPDATE model_adapters SET status = 'promoted' WHERE adapter_id = $1 AND version = $2`,
        [promotion.adapterId, promotion.adapterVersion],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(adapterId: string, version: number): Promise<AdapterRecord | undefined> {
    const { rows } = await getPool().query(
      'SELECT * FROM model_adapters WHERE adapter_id = $1 AND version = $2',
      [adapterId, version],
    );
    if (!rows.length) return undefined;
    const r = rows[0];
    return {
      adapterId: r.adapter_id,
      version: r.version,
      domainId: r.domain_id as DomainId,
      baseModel: r.base_model,
      baseModelDigest: r.base_model_digest ?? undefined,
      status: r.status,
      trainedOn: r.trained_on,
      trainingRunHash: r.training_run_hash ?? undefined,
      modelAdapterHash: r.model_adapter_hash ?? undefined,
      supersedesAdapterId: r.supersedes_adapter_id ?? undefined,
      rejectionReason: r.rejection_reason ?? undefined,
      createdAt: (r.created_at as Date).toISOString(),
    };
  }

  async routableFor(domainId: DomainId): Promise<AdapterRecord[]> {
    const { rows } = await getPool().query(
      `SELECT adapter_id, version FROM model_adapters WHERE domain_id = $1 AND status = 'promoted'`,
      [domainId],
    );
    const found = await Promise.all(rows.map((r) => this.get(r.adapter_id, r.version)));
    return found.filter((a): a is AdapterRecord => Boolean(a));
  }
}
