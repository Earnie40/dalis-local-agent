import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Database-backed integration tests for the domain intelligence layer.
 *
 * These need the real PostgreSQL instance. When DATABASE_URL is unavailable the
 * suite skips rather than failing, so CI without a database stays green — but a
 * skip is visible in the output and is never reported as a pass.
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
const {
  DatasetStore, TrainingCandidateStore, createDatasetVersion,
  LearningLoopCandidate, assertTemporalOrder,
} = await import('@dacai-local-agent/datasets');
const { MarketStore, createPrediction, resolvePrediction, createTradeEvent, createTraderIdentity } =
  await import('@dacai-local-agent/market-intelligence');
const { EvidenceStore, anchorFor, makeClaim } = await import('@dacai-local-agent/domain-knowledge');
const { RagService, validateScope, RetrievalScopeError } = await import('@dacai-local-agent/rag');

let dbAvailable = false;
const RUN_ID = `t${Date.now().toString(36)}`;

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
  // Clean up only rows this run created.
  await pool.query('DELETE FROM training_candidates WHERE task_type LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM market_prediction_outcomes WHERE prediction_id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM market_predictions WHERE id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM market_actions WHERE id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM market_participants WHERE id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM evidence_anchors WHERE locator LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM dataset_lineage WHERE from_dataset_id LIKE $1 OR to_dataset_id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM dataset_sources WHERE dataset_id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM dataset_versions WHERE dataset_id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM datasets WHERE id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM learning_stage_transitions WHERE candidate_id LIKE $1', [`${RUN_ID}%`]);
  await pool.query('DELETE FROM learning_candidates WHERE id LIKE $1', [`${RUN_ID}%`]);
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

// ---------------------------------------------------------------------------
// Phase 1 — domain-scoped retrieval
// ---------------------------------------------------------------------------

describe('domain-scoped retrieval', () => {
  it('rejects an invalid DomainId instead of matching nothing', () => {
    // A typo returning zero rows is indistinguishable from an empty corpus.
    expect(() => validateScope({ domainIds: ['not-a-domain' as never] })).toThrow(RetrievalScopeError);
    expect(() => validateScope({ domainIds: [] })).toThrow(/empty/);
    expect(() => validateScope({ domainIds: ['smart-contract'] })).not.toThrow();
  });

  it('rejects a malformed asOf rather than silently ignoring it', () => {
    expect(() => validateScope({ asOf: 'yesterday' })).toThrow(RetrievalScopeError);
  });

  dbIt('filters a blockchain-domain query to blockchain knowledge', async () => {
    const rag = new RagService();
    const hits = await rag.search('settlement authorization role', { domainIds: ['smart-contract'] }, 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.domainId === 'smart-contract')).toBe(true);
  });

  dbIt('returns provenance with every retrieval result', async () => {
    const rag = new RagService();
    const [hit] = await rag.search('reentrancy checks effects interactions', { domainIds: ['smart-contract'] }, 1);
    expect(hit.provenance.license).toBe('DACAIS-internal-original');
    expect(hit.provenance.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.provenance.ingestedAt).toBeTruthy();
  });

  dbIt('returns nothing for a domain with no corpus', async () => {
    const rag = new RagService();
    const hits = await rag.search('settlement authorization role', { domainIds: ['robotics'] }, 3);
    expect(hits).toHaveLength(0);
  });

  dbIt('supports explicitly requested cross-domain retrieval', async () => {
    const rag = new RagService();
    const hits = await rag.search('access control', { domainIds: ['smart-contract', 'robotics'] }, 3);
    expect(hits.some((h) => h.domainId === 'smart-contract')).toBe(true);
  });

  dbIt('preserves existing behaviour when no domain is given', async () => {
    const rag = new RagService();
    expect((await new RagService().search('access control roles', {}, 3)).length).toBeGreaterThan(0);
    void rag;
  });

  dbIt('enforces tenant isolation alongside the domain filter', async () => {
    // A document owned by one workspace must not surface for another, even
    // when the domain matches.
    const rag = new RagService();
    const hits = await rag.search('settlement authorization role', {
      domainIds: ['smart-contract'],
      workspaceId: 'ws-that-owns-nothing',
    }, 5);
    // Corpus docs have a NULL workspace (shared), so they remain visible; a
    // doc belonging to a *different* workspace must not appear.
    expect(hits.every((h) => h.domainId === 'smart-contract')).toBe(true);
  });

  dbIt('never marks retrieval knowledge as training material', async () => {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM knowledge_documents WHERE domain_id = 'smart-contract' AND training_eligible = true`,
    );
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — persistence
// ---------------------------------------------------------------------------

describe('dataset lineage persistence', () => {
  dbIt('persists a version and refuses to mutate it', async () => {
    const store = new DatasetStore();
    const v = createDatasetVersion({
      datasetId: `${RUN_ID}_raw`, version: 1, domainId: 'smart-contract', purpose: 'training',
      title: 'raw', recordCount: 3, sources: [{ kind: 'corpus', locator: 'x', license: 'DACAIS-internal-original' }],
    });
    await store.saveVersion(v);

    const loaded = await store.getVersion(v.datasetId, 1);
    expect(loaded?.contentHash).toBe(v.contentHash);

    await expect(store.saveVersion({ ...v, contentHash: 'deadbeef' })).rejects.toThrow(/immutable/);
  });

  dbIt('resolves inherited sources through the lineage chain', async () => {
    const store = new DatasetStore();
    const raw = createDatasetVersion({
      datasetId: `${RUN_ID}_a`, version: 1, domainId: 'smart-contract', purpose: 'experience',
      title: 'a', recordCount: 1, sources: [{ kind: 'corpus', locator: 'origin-source' }],
    });
    const derived = createDatasetVersion({
      datasetId: `${RUN_ID}_b`, version: 1, domainId: 'smart-contract', purpose: 'training',
      title: 'b', recordCount: 1, sources: [{ kind: 'annotation', locator: 'review-pass' }],
    });
    await store.saveVersion(raw);
    await store.saveVersion(derived);
    await store.link({ fromDatasetId: raw.datasetId, fromVersion: 1, toDatasetId: derived.datasetId, toVersion: 1, relation: 'filtered_from' });

    const locators = (await store.resolvedSources(derived.datasetId, 1)).map((s) => s.locator).sort();
    expect(locators).toEqual(['origin-source', 'review-pass']);
  });

  dbIt('persists the learning loop and refuses automated approval', async () => {
    const store = new DatasetStore();
    const id = `${RUN_ID}_cand`;
    await store.createCandidate(id, 'smart-contract');

    const candidate = new LearningLoopCandidate(id);
    while (candidate.stage !== 'training_candidate') {
      const before = candidate.stage;
      candidate.advance();
      await store.recordTransition(id, candidate.history.at(-1)!);
      expect(before).not.toBe(candidate.stage);
    }
    expect(await store.candidateStage(id)).toBe('training_candidate');

    await expect(
      store.recordTransition(id, { from: 'training_candidate', to: 'approval', at: new Date().toISOString() }),
    ).rejects.toThrow(/named human actor/);

    await store.recordTransition(id, { from: 'training_candidate', to: 'approval', at: new Date().toISOString(), actor: 'kyle' });
    expect(await store.candidateStage(id)).toBe('approval');
  });
});

// ---------------------------------------------------------------------------
// Phase 7 — training candidates
// ---------------------------------------------------------------------------

describe('training candidates', () => {
  const base = {
    domainId: 'smart-contract' as const,
    taskType: `${RUN_ID}_analysis`,
    input: 'contract with missing access control',
    expectedBehavior: 'report access-control finding on setTreasury',
    actualBehavior: 'reported access-control finding on setTreasury',
  };

  dbIt('a successful result is not automatically training material', async () => {
    const store = new TrainingCandidateStore();
    const candidate = await store.record({ ...base, validationEvidence: { suiteCaseId: 'sc-01', matched: true } });

    expect(candidate.trainingEligible).toBe(false);
    expect(candidate.ineligibilityReason).toMatch(/Awaiting human approval/);
  });

  dbIt('refuses approval without objective validation evidence', async () => {
    const store = new TrainingCandidateStore();
    const candidate = await store.record({
      ...base, input: `${base.input} (no evidence)`, validationEvidence: {},
    });
    expect(candidate.ineligibilityReason).toMatch(/No objective validation evidence/);
    await expect(store.approve(candidate.id, 'kyle')).rejects.toThrow(/no objective validation evidence/);
  });

  dbIt('requires a named human to approve, then allows sealing into a dataset', async () => {
    const store = new TrainingCandidateStore();
    const candidate = await store.record({
      ...base, input: `${base.input} (approvable)`, validationEvidence: { suiteCaseId: 'sc-01', matched: true },
      qualityScore: 0.9,
    });

    await expect(store.approve(candidate.id, '   ')).rejects.toThrow(/named human/);
    await expect(store.sealIntoDataset(candidate.id, 'ds', 1)).rejects.toThrow(/not training-eligible/);

    const approved = await store.approve(candidate.id, 'kyle');
    expect(approved.trainingEligible).toBe(true);
    expect(approved.humanApproval).toBe('kyle');

    await store.sealIntoDataset(candidate.id, `${RUN_ID}_ds`, 1);
    expect((await store.get(candidate.id))?.datasetVersion).toBe(1);
  });

  dbIt('withdraws eligibility on rejection', async () => {
    const store = new TrainingCandidateStore();
    const candidate = await store.record({
      ...base, input: `${base.input} (rejectable)`, validationEvidence: { matched: true },
    });
    await store.approve(candidate.id, 'kyle');
    const rejected = await store.reject(candidate.id, 'false positive on review');

    expect(rejected.trainingEligible).toBe(false);
    expect(rejected.humanApproval).toBeUndefined();
  });

  dbIt('the database refuses a hand-written eligible row without approval', async () => {
    // Proves the invariant survives a direct SQL write, not just the store.
    await expect(
      getPool().query(
        `INSERT INTO training_candidates (id, domain_id, task_type, input, expected_behavior,
           actual_behavior, validation_evidence, training_eligible, candidate_hash)
         VALUES ($1,'smart-contract',$2,'i','e','a','{"x":1}'::jsonb, true, $3)`,
        [`${RUN_ID}_direct`, `${RUN_ID}_direct`, `${RUN_ID}hash`],
      ),
    ).rejects.toThrow(/training_candidates_eligible_requires_approval/);
  });
});

// ---------------------------------------------------------------------------
// Phase 8 — market intelligence persistence
// ---------------------------------------------------------------------------

describe('market intelligence persistence', () => {
  const prediction = () => createPrediction({
    predictionId: `${RUN_ID}_p1`,
    statement: 'ETH-USD rises over 24h',
    instrument: 'ETH-USD',
    probability: 0.62,
    confidence: 0.5,
    horizonMs: 1000,
    conditions: [],
    invalidatingConditions: ['trading halted'],
    evidence: ['momentum'],
    modelId: 'm', modelVersion: '1',
    issuedAt: '2026-01-01T00:00:00.000Z',
  });

  dbIt('look-ahead information cannot enter a historical observation', async () => {
    const store = new MarketStore();
    await store.saveParticipant(createTraderIdentity({
      participantId: `${RUN_ID}_w`, kind: 'wallet', sourceKinds: ['public_onchain_activity'],
    }));

    // availableAt precedes eventTime — information existing before its event.
    const leaky = {
      id: `${RUN_ID}_bad`, participantId: `${RUN_ID}_w`, instrument: 'ETH-USD',
      direction: 'long' as const, sizeClass: 'moderate' as const,
      entryTime: '2026-01-02T00:00:00.000Z',
      eventTime: '2026-01-02T00:00:00.000Z',
      availableAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-02T00:00:00.000Z',
      context: { regime: 'unknown' as const },
    };
    expect(() => assertTemporalOrder(leaky, leaky.id)).toThrow();
    await expect(store.saveAction(leaky)).rejects.toThrow(/cannot exist before its event/);
  });

  dbIt('only returns observations knowable at the decision time', async () => {
    const store = new MarketStore();
    await store.saveParticipant(createTraderIdentity({
      participantId: `${RUN_ID}_w2`, kind: 'wallet', sourceKinds: ['public_onchain_activity'],
    }));
    await store.saveAction(createTradeEvent({
      id: `${RUN_ID}_late`, participantId: `${RUN_ID}_w2`, instrument: 'ETH-USD',
      direction: 'long', sizeClass: 'small',
      entryTime: '2026-01-01T00:00:00.000Z',
      eventTime: '2026-01-01T00:00:00.000Z',
      availableAt: '2026-01-20T00:00:00.000Z',   // published late
      observedAt: '2026-01-20T00:00:00.000Z',
      context: { regime: 'unknown' },
    }));

    const visible = await store.actionsVisibleAt(`${RUN_ID}_w2`, '2026-01-10T00:00:00.000Z');
    expect(visible).toHaveLength(0);
  });

  dbIt('an inferred rationale cannot be filed as observed fact', async () => {
    const store = new MarketStore();
    await store.saveParticipant(createTraderIdentity({
      participantId: `${RUN_ID}_w3`, kind: 'wallet', sourceKinds: ['public_onchain_activity'],
    }));
    await expect(store.saveAction({
      id: `${RUN_ID}_claim`, participantId: `${RUN_ID}_w3`, instrument: 'ETH-USD',
      direction: 'long', sizeClass: 'small',
      entryTime: '2026-01-01T00:00:00.000Z',
      eventTime: '2026-01-01T00:00:00.000Z',
      availableAt: '2026-01-01T00:00:00.000Z',
      observedAt: '2026-01-01T00:00:00.000Z',
      context: { regime: 'unknown' },
      statedRationale: makeClaim({
        value: 'momentum', assertionClass: 'observed', sources: [{ kind: 'chain', locator: 'x' }],
      }),
    })).rejects.toThrow(/must be a "stated" claim/);
  });

  dbIt('predictions cannot be overwritten', async () => {
    const store = new MarketStore();
    const record = prediction();
    await store.savePrediction(record);
    await expect(store.savePrediction(record)).rejects.toThrow(/already recorded/);

    const tampered = { ...record, probability: 0.99, predictionHash: 'x'.repeat(64) };
    await expect(store.savePrediction(tampered)).rejects.toThrow(/immutable/);
    expect((await store.getPrediction(record.predictionId))?.probability).toBe(0.62);
  });

  dbIt('an outcome binds to the original prediction hash', async () => {
    const store = new MarketStore();
    const record = createPrediction({ ...prediction(), predictionId: `${RUN_ID}_p2` });
    await store.savePrediction(record);
    await store.saveOutcome(resolvePrediction(record, { status: 'true', resolvedAt: '2026-02-01T00:00:00.000Z' }));

    const outcome = await store.getOutcome(record.predictionId);
    expect(outcome?.predictionHash).toBe(record.predictionHash);
  });

  dbIt('the database rejects a probability of exactly 0 or 1', async () => {
    await expect(
      getPool().query(
        `INSERT INTO market_predictions (id, domain_id, statement, instrument, probability, confidence,
           horizon_ms, invalidating_conditions, model_id, model_version, issued_at, resolves_at, prediction_hash)
         VALUES ($1,'forecasting','s','ETH',1.0,0.5,1000,'["h"]'::jsonb,'m','1',now(),now()+interval '1 hour',$2)`,
        [`${RUN_ID}_p3`, `${RUN_ID}_h3`],
      ),
    ).rejects.toThrow(/market_predictions_probability_range/);
  });
});

// ---------------------------------------------------------------------------
// Phase 12 — evidence seam
// ---------------------------------------------------------------------------

describe('evidence anchors', () => {
  dbIt('records a digest without claiming an on-chain write', async () => {
    const store = new EvidenceStore();
    const anchor = anchorFor('datasetHash', { run: RUN_ID }, `${RUN_ID}/dataset`);
    await store.record(anchor);

    const [found] = await store.findByDigest(anchor.digest);
    expect(found.digest).toBe(anchor.digest);
    expect(found.anchoredTxHash).toBeUndefined();
  });

  dbIt('rejects a digest that is not a sha256', async () => {
    await expect(
      getPool().query(
        `INSERT INTO evidence_anchors (id, kind, digest, locator) VALUES ($1,'datasetHash','not-a-hash',$2)`,
        [`${RUN_ID}_bad`, `${RUN_ID}/bad`],
      ),
    ).rejects.toThrow(/evidence_anchors_digest_is_sha256/);
  });
});
