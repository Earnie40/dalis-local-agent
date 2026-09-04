import { createId, getPool } from '@dacai-local-agent/shared';
import type { EvidenceAnchor, EvidenceKind } from './evidence.js';

/**
 * Persistence for evidence anchors (migration 012).
 *
 * Raw data stays off-chain: only the digest and a local locator are stored.
 * `anchored_tx_hash` remains NULL until an anchor is actually submitted to the
 * DACAIS Evidence Registry, which nothing in this repository does — the write
 * path is deliberately absent rather than stubbed.
 */
export class EvidenceStore {
  async record(anchor: EvidenceAnchor): Promise<string> {
    const id = createId('anch');
    await getPool().query(
      `INSERT INTO evidence_anchors (id, kind, digest, locator, anchored_tx_hash, created_at)
       VALUES ($1,$2,$3,$4,NULL,$5)`,
      [id, anchor.kind, anchor.digest, anchor.locator ?? null, anchor.createdAt],
    );
    return id;
  }

  async findByDigest(digest: string): Promise<EvidenceAnchor[]> {
    const { rows } = await getPool().query(
      'SELECT kind, digest, locator, anchored_tx_hash, created_at FROM evidence_anchors WHERE digest = $1',
      [digest],
    );
    return rows.map((r) => ({
      kind: r.kind as EvidenceKind,
      digest: r.digest,
      locator: r.locator ?? undefined,
      anchoredTxHash: r.anchored_tx_hash ?? undefined,
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }

  async countByKind(kind: EvidenceKind): Promise<number> {
    const { rows } = await getPool().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM evidence_anchors WHERE kind = $1',
      [kind],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
