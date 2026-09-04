import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database-backed integration tests for the content approval workflow.
 *
 * Needs the real PostgreSQL instance. When DATABASE_URL is unavailable the
 * suite skips rather than failing, so CI without a database stays green — but
 * a skip is visible in the output and is never reported as a pass. Follows the
 * same pattern as tests/domain-persistence.test.ts.
 */

function loadEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // No .env is fine; DATABASE_URL may come from the environment.
  }
}
loadEnv();

const { getPool, closePool } = await import('@dacai-local-agent/shared');
const { ContentStore, ContentWorkflowError, exportAsset } = await import('@dacai-local-agent/investor-intelligence');

let dbAvailable = false;
const RUN_ID = `intel${Date.now().toString(36)}`;
const createdAssetIds: string[] = [];

beforeAll(async () => {
  try {
    await getPool().query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  const pool = getPool();
  await pool.query('DELETE FROM content_asset_audit WHERE content_asset_id = ANY($1::text[])', [createdAssetIds]);
  await pool.query('DELETE FROM content_claims WHERE content_asset_id = ANY($1::text[])', [createdAssetIds]);
  await pool.query('DELETE FROM content_assets WHERE id = ANY($1::text[])', [createdAssetIds]);
  await closePool();
});

const dbIt = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!dbAvailable) {
      console.warn(`SKIPPED (no database): ${name}`);
      return;
    }
    await fn();
  });

describe('content approval workflow — publication requires a named human', () => {
  const store = new ContentStore();

  dbIt('a fresh draft cannot be exported', async () => {
    const asset = await store.create({
      assetType: 'technical_essay',
      body: `Test body ${RUN_ID}`,
      actor: 'test-suite',
    });
    createdAssetIds.push(asset.id);
    expect(() => exportAsset(asset)).toThrow(/exported only after human approval/);
  });

  dbIt('cannot skip straight from DRAFT to HUMAN_APPROVED', async () => {
    const asset = await store.create({
      assetType: 'technical_essay',
      body: `Test body ${RUN_ID}`,
      actor: 'test-suite',
    });
    createdAssetIds.push(asset.id);

    await expect(
      store.transition({ assetId: asset.id, to: 'HUMAN_APPROVED', action: 'approved', actor: 'test-suite' }),
    ).rejects.toThrow(ContentWorkflowError);
  });

  dbIt('a blocking risk finding prevents advancing to READY_FOR_REVIEW', async () => {
    const asset = await store.create({
      assetType: 'technical_essay',
      body: `Test body ${RUN_ID}`,
      riskFindings: [{ severity: 'blocking', code: 'unsupported-claim', message: 'test finding' }],
      actor: 'test-suite',
    });
    createdAssetIds.push(asset.id);
    await store.transition({ assetId: asset.id, to: 'EVIDENCE_CHECK', action: 'evidence_checked', actor: 'test-suite' });
    await store.transition({ assetId: asset.id, to: 'RISK_REVIEW', action: 'risk_reviewed', actor: 'test-suite' });

    await expect(
      store.transition({ assetId: asset.id, to: 'READY_FOR_REVIEW', action: 'submitted', actor: 'test-suite' }),
    ).rejects.toThrow(/blocking risk finding/);
  });

  dbIt('approval requires a non-empty actor', async () => {
    const asset = await store.create({ assetType: 'technical_essay', body: `Test body ${RUN_ID}`, actor: 'test-suite' });
    createdAssetIds.push(asset.id);
    await store.transition({ assetId: asset.id, to: 'EVIDENCE_CHECK', action: 'evidence_checked', actor: 'test-suite' });
    await store.transition({ assetId: asset.id, to: 'RISK_REVIEW', action: 'risk_reviewed', actor: 'test-suite' });
    await store.transition({ assetId: asset.id, to: 'READY_FOR_REVIEW', action: 'submitted', actor: 'test-suite' });

    await expect(
      store.transition({ assetId: asset.id, to: 'HUMAN_APPROVED', action: 'approved', actor: '' }),
    ).rejects.toThrow(/named actor is required/);
  });

  dbIt('the full clean path reaches HUMAN_APPROVED with a named approver, then exports', async () => {
    const asset = await store.create({ assetType: 'technical_essay', body: `Clean body ${RUN_ID}`, actor: 'test-suite' });
    createdAssetIds.push(asset.id);
    await store.transition({ assetId: asset.id, to: 'EVIDENCE_CHECK', action: 'evidence_checked', actor: 'test-suite' });
    await store.transition({ assetId: asset.id, to: 'RISK_REVIEW', action: 'risk_reviewed', actor: 'test-suite' });
    await store.transition({ assetId: asset.id, to: 'READY_FOR_REVIEW', action: 'submitted', actor: 'test-suite' });
    const approved = await store.transition({
      assetId: asset.id, to: 'HUMAN_APPROVED', action: 'approved', actor: 'kyle',
    });

    expect(approved.approvedBy).toBe('kyle');
    expect(approved.approvedAt).toBeDefined();
    expect(exportAsset(approved)).toContain(`Clean body ${RUN_ID}`);

    const audit = await store.auditTrail(asset.id);
    expect(audit.some((entry) => entry.action === 'approved' && entry.actor === 'kyle')).toBe(true);
  });

  dbIt('rejecting content requires a reason', async () => {
    const asset = await store.create({ assetType: 'technical_essay', body: `Test body ${RUN_ID}`, actor: 'test-suite' });
    createdAssetIds.push(asset.id);

    await expect(
      store.transition({ assetId: asset.id, to: 'REJECTED', action: 'rejected', actor: 'test-suite' }),
    ).rejects.toThrow(/requires a reason/);

    const rejected = await store.transition({
      assetId: asset.id, to: 'REJECTED', action: 'rejected', actor: 'test-suite', rejectedReason: 'Overclaimed.',
    });
    expect(rejected.state).toBe('REJECTED');
    expect(rejected.rejectedReason).toBe('Overclaimed.');
  });

  dbIt('editing a submitted asset returns it to DRAFT so checks re-run', async () => {
    const asset = await store.create({ assetType: 'technical_essay', body: `Original ${RUN_ID}`, actor: 'test-suite' });
    createdAssetIds.push(asset.id);
    await store.transition({ assetId: asset.id, to: 'EVIDENCE_CHECK', action: 'evidence_checked', actor: 'test-suite' });
    await store.transition({ assetId: asset.id, to: 'RISK_REVIEW', action: 'risk_reviewed', actor: 'test-suite' });

    const edited = await store.edit({ assetId: asset.id, actor: 'kyle', body: `Edited ${RUN_ID}` });
    expect(edited.state).toBe('DRAFT');
    expect(edited.body).toBe(`Edited ${RUN_ID}`);
  });
});
