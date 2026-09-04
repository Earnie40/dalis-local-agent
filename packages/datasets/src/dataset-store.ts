import { createId, getPool } from '@dacai-local-agent/shared';
import type { DomainId } from '@dacai-local-agent/domain-knowledge';
import { LineageError, type DatasetSource, type DatasetVersion, type LineageEdge } from './lineage.js';
import type { LoopStage, StageTransition } from './learning-loop.js';

/**
 * Persistence for dataset lineage and learning-loop candidates, over the tables
 * declared in migration 012.
 *
 * Two invariants live here rather than in callers, matching how TrainingTraceStore
 * already works in this repository:
 *
 *  - A dataset version is immutable. Re-writing one with a different content
 *    hash is refused at the store, not merely discouraged.
 *  - A stage transition into `approval` requires a named actor. The database
 *    enforces this too, but failing here produces a usable error message.
 */
export class DatasetStore {
  async saveVersion(version: DatasetVersion): Promise<void> {
    const pool = getPool();
    const existing = await pool.query<{ content_hash: string }>(
      'SELECT content_hash FROM dataset_versions WHERE dataset_id = $1 AND version = $2',
      [version.datasetId, version.version],
    );
    if (existing.rows.length && existing.rows[0].content_hash !== version.contentHash) {
      throw new LineageError(
        `Dataset version ${version.datasetId}@${version.version} is already published with a different content hash. Versions are immutable; publish a new version instead.`,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO datasets (id, domain_id, purpose, title)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET domain_id = $2, purpose = $3, title = $4`,
        [version.datasetId, version.domainId, version.purpose, version.title],
      );
      await client.query(
        `INSERT INTO dataset_versions (dataset_id, version, record_count, content_hash, notes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (dataset_id, version) DO NOTHING`,
        [version.datasetId, version.version, version.recordCount, version.contentHash, version.notes ?? null, version.createdAt],
      );
      await client.query('DELETE FROM dataset_sources WHERE dataset_id = $1 AND version = $2', [version.datasetId, version.version]);
      for (const source of version.sources) {
        await client.query(
          `INSERT INTO dataset_sources (id, dataset_id, version, kind, locator, sha256, license, authorization_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [createId('dsrc'), version.datasetId, version.version, source.kind, source.locator, source.sha256 ?? null, source.license ?? null, source.authorizationRef ?? null],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getVersion(datasetId: string, version: number): Promise<DatasetVersion | undefined> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT v.dataset_id, v.version, v.record_count, v.content_hash, v.notes, v.created_at,
              d.domain_id, d.purpose, d.title
         FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
        WHERE v.dataset_id = $1 AND v.version = $2`,
      [datasetId, version],
    );
    if (!rows.length) return undefined;
    const row = rows[0];
    const sources = await pool.query(
      'SELECT kind, locator, sha256, license, authorization_ref FROM dataset_sources WHERE dataset_id = $1 AND version = $2',
      [datasetId, version],
    );
    return {
      datasetId: row.dataset_id,
      version: row.version,
      domainId: row.domain_id as DomainId,
      purpose: row.purpose,
      title: row.title,
      recordCount: row.record_count,
      contentHash: row.content_hash,
      notes: row.notes ?? undefined,
      createdAt: (row.created_at as Date).toISOString(),
      sources: sources.rows.map((s): DatasetSource => ({
        kind: s.kind,
        locator: s.locator,
        sha256: s.sha256 ?? undefined,
        license: s.license ?? undefined,
        authorizationRef: s.authorization_ref ?? undefined,
      })),
    };
  }

  async link(edge: LineageEdge): Promise<void> {
    await getPool().query(
      `INSERT INTO dataset_lineage (id, from_dataset_id, from_version, to_dataset_id, to_version, relation)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [createId('lin'), edge.fromDatasetId, edge.fromVersion, edge.toDatasetId, edge.toVersion, edge.relation],
    );
  }

  /** Every source feeding a version, including inherited ones. */
  async resolvedSources(datasetId: string, version: number): Promise<DatasetSource[]> {
    const { rows } = await getPool().query(
      `WITH RECURSIVE ancestry(dataset_id, version) AS (
         SELECT $1::text, $2::int
         UNION
         SELECT l.from_dataset_id, l.from_version
           FROM dataset_lineage l JOIN ancestry a
             ON l.to_dataset_id = a.dataset_id AND l.to_version = a.version
       )
       SELECT DISTINCT s.kind, s.locator, s.sha256, s.license, s.authorization_ref
         FROM dataset_sources s JOIN ancestry a
           ON s.dataset_id = a.dataset_id AND s.version = a.version`,
      [datasetId, version],
    );
    return rows.map((s) => ({
      kind: s.kind,
      locator: s.locator,
      sha256: s.sha256 ?? undefined,
      license: s.license ?? undefined,
      authorizationRef: s.authorization_ref ?? undefined,
    }));
  }

  async createCandidate(candidateId: string, domainId: DomainId): Promise<void> {
    await getPool().query(
      `INSERT INTO learning_candidates (id, domain_id, stage) VALUES ($1,$2,'observe')
       ON CONFLICT (id) DO NOTHING`,
      [candidateId, domainId],
    );
  }

  async recordTransition(candidateId: string, transition: StageTransition): Promise<void> {
    if (transition.to === 'approval' && !transition.actor?.trim()) {
      throw new LineageError('Entering "approval" requires a named human actor.');
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO learning_stage_transitions (id, candidate_id, from_stage, to_stage, actor, note, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [createId('lst'), candidateId, transition.from, transition.to, transition.actor ?? null, transition.note ?? null, transition.at],
      );
      await client.query('UPDATE learning_candidates SET stage = $2, updated_at = now() WHERE id = $1', [candidateId, transition.to]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async candidateStage(candidateId: string): Promise<LoopStage | undefined> {
    const { rows } = await getPool().query<{ stage: LoopStage }>(
      'SELECT stage FROM learning_candidates WHERE id = $1',
      [candidateId],
    );
    return rows[0]?.stage;
  }

  async history(candidateId: string): Promise<StageTransition[]> {
    const { rows } = await getPool().query(
      'SELECT from_stage, to_stage, actor, note, at FROM learning_stage_transitions WHERE candidate_id = $1 ORDER BY at, id',
      [candidateId],
    );
    return rows.map((r) => ({
      from: r.from_stage,
      to: r.to_stage,
      actor: r.actor ?? undefined,
      note: r.note ?? undefined,
      at: (r.at as Date).toISOString(),
    }));
  }
}
