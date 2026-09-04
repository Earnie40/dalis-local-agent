import { describe, expect, it } from 'vitest';
import {
  KnowledgeRoutingError,
  ProvenanceError,
  anchorFor,
  asFact,
  atLeast,
  assertTrainable,
  canonicalize,
  classifyKnowledge,
  combineClaims,
  describeClaim,
  domainsInFamily,
  getDomain,
  hashArtifact,
  isDomainId,
  listDomains,
  makeClaim,
  multimodalDomains,
  verifyAnchor,
} from '@dacai-local-agent/domain-knowledge';

describe('domain taxonomy', () => {
  it('registers every declared DACAIS domain exactly once', () => {
    const ids = listDomains().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('blockchain');
    expect(ids).toContain('smart-contract');
    expect(ids).toContain('robotics');
    expect(ids).toEqual(expect.arrayContaining([
      'computer-science',
      'software-engineering',
      'backend-development',
      'frontend-development',
      'biology',
      'chemistry',
      'mathematics',
      'physics',
      'astrophysics',
      'aerospace-engineering',
      'nanotechnology',
      'claytronics',
      'spatial-edge-technology',
      'nuclear-technology',
      'metamaterials-and-cloaking',
      'intelligence-surveillance-technology',
      'engineering',
    ]));
    expect(ids).toContain('cross-domain');
  });

  it('rejects unknown domain ids rather than defaulting', () => {
    expect(isDomainId('blockchain')).toBe(true);
    expect(isDomainId('not-a-domain')).toBe(false);
    expect(() => getDomain('not-a-domain' as never)).toThrow(/Unknown domain/);
  });

  it('does not overstate operational status', () => {
    // The ladder is the single source of truth. Only smart-contract has an
    // ingested corpus, working tools, and a held-out suite that has been run.
    const advanced = listDomains().filter((d) => d.status !== 'REGISTERED');
    expect(advanced.map((d) => d.id)).toEqual(['smart-contract']);
    expect(advanced[0].status).toBe('EVALUATED');
  });

  it('never claims a domain is trained or production-approved', () => {
    // No adapter has been trained. If this ever fails, either an adapter really
    // was trained or a status was inflated -- both need a human to look.
    for (const domain of listDomains()) {
      expect(atLeast(domain.status, 'ADAPTER_TRAINED')).toBe(false);
    }
  });

  it('orders the ladder so a weaker status never satisfies a stronger gate', () => {
    expect(atLeast('EVALUATED', 'RAG_ENABLED')).toBe(true);
    expect(atLeast('RAG_ENABLED', 'EVALUATED')).toBe(false);
    expect(atLeast('TRAINING_DATA_READY', 'ADAPTER_TRAINED')).toBe(false);
  });

  it('records native modalities so multimodal data is not flattened to text', () => {
    const spatial = getDomain('spatial');
    expect(spatial.modalities).toContain('pointcloud');
    expect(spatial.modalities).toContain('depth');
    expect(multimodalDomains().map((d) => d.id)).toContain('robotics');
  });

  it('groups broad disciplines without overstating their implementation state', () => {
    expect(domainsInFamily('life-sciences').map((domain) => domain.id)).toEqual(
      expect.arrayContaining(['biology', 'radiation-biology', 'anatomy-and-physiology', 'psychology']),
    );
    expect(domainsInFamily('physical-sciences').map((domain) => domain.id)).toEqual(
      expect.arrayContaining(['mathematics', 'physics', 'chemistry', 'electromagnetism', 'astrophysics']),
    );
    for (const domainId of ['biology', 'physics', 'engineering', 'nuclear-technology'] as const) {
      expect(getDomain(domainId).status).toBe('REGISTERED');
    }
  });

  it('marks speculative and regulated areas with explicit evidence or safety boundaries', () => {
    expect(getDomain('gravitation-and-relativity').evidenceNotes).toMatch(/unverified|reproducible/i);
    expect(getDomain('metamaterials-and-cloaking').evidenceNotes).toMatch(/not treated as an established capability/i);
    expect(getDomain('nuclear-technology').safetyNotes).toMatch(/no weapon design/i);
    expect(getDomain('intelligence-surveillance-technology').safetyNotes).toMatch(/no unauthorized intrusion/i);
    expect(getDomain('engineering').subdisciplines).toContain('mechanical');
    expect(getDomain('engineering').subdisciplines).toContain('quantum');
  });
});

describe('knowledge policy — RAG versus weights', () => {
  it('routes volatile facts to retrieval and refuses to train them', () => {
    const result = classifyKnowledge({ domainId: 'blockchain', kind: 'fact' });
    expect(result.route).toBe('rag');
    expect(result.trainingEligible).toBe(false);
  });

  it('routes stable procedures to weights', () => {
    const result = classifyKnowledge({ domainId: 'smart-contract', kind: 'procedure' });
    expect(result.route).toBe('weights');
    expect(result.trainingEligible).toBe(true);
  });

  it('keeps facts on the retrieval path even when they are slow-moving', () => {
    // A fact should be correctable without retraining regardless of volatility.
    const result = classifyKnowledge({ domainId: 'spatial', kind: 'fact', volatile: false });
    expect(result.route).toBe('rag');
    expect(result.trainingEligible).toBe(false);
  });

  it('throws when a caller tries to put a fact into a training set', () => {
    expect(() => assertTrainable({ domainId: 'market-intelligence', kind: 'fact' })).toThrow(
      KnowledgeRoutingError,
    );
    expect(() => assertTrainable({ domainId: 'market-intelligence', kind: 'procedure' })).not.toThrow();
  });
});

describe('assertion provenance', () => {
  const source = { kind: 'ethereum-rpc', locator: '0xabc' };

  it('requires confidence on inferred claims', () => {
    expect(() =>
      makeClaim({ value: 'momentum chase', assertionClass: 'inferred', sources: [source] }),
    ).toThrow(ProvenanceError);
  });

  it('requires a source on observed claims', () => {
    expect(() => makeClaim({ value: 42, assertionClass: 'observed', sources: [] })).toThrow(
      ProvenanceError,
    );
  });

  it('refuses to read an inference as a fact', () => {
    const inferred = makeClaim({
      value: 'liquidity expansion drove the buy',
      assertionClass: 'inferred',
      confidence: 0.4,
      sources: [source],
    });
    expect(() => asFact(inferred)).toThrow(/Refusing to read a "inferred" claim as fact/);

    const observed = makeClaim({ value: 'buy at block 21', assertionClass: 'observed', sources: [source] });
    expect(asFact(observed)).toBe('buy at block 21');
  });

  it('keeps a stated rationale distinct from an inferred one', () => {
    const stated = makeClaim({ value: 'I bought the dip', assertionClass: 'stated', sources: [source] });
    expect(() => asFact(stated)).toThrow(ProvenanceError);
    expect(describeClaim(stated, 'rationale')).toContain('STATED');
  });

  it('marks combined cross-domain conclusions as inference, never fact', () => {
    const a = makeClaim({ value: 1, assertionClass: 'observed', sources: [source] });
    const b = makeClaim({ value: 2, assertionClass: 'observed', sources: [{ kind: 'market', locator: 'ETH' }] });
    const combined = combineClaims('the treasury rebalanced', [a, b], { confidence: 0.55 });

    expect(combined.assertionClass).toBe('inferred');
    expect(combined.sources).toHaveLength(2);
    expect(() => asFact(combined)).toThrow(ProvenanceError);
  });
});

describe('evidence anchoring', () => {
  it('hashes independently of key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(hashArtifact({ b: 1, a: [{ z: 1, y: 2 }] })).toBe(hashArtifact({ a: [{ y: 2, z: 1 }], b: 1 }));
  });

  it('detects a modified artifact', () => {
    const dataset = { datasetId: 'ds', records: 10 };
    const anchor = anchorFor('datasetHash', dataset);

    expect(verifyAnchor(anchor, dataset)).toBe(true);
    expect(verifyAnchor(anchor, { ...dataset, records: 11 })).toBe(false);
  });

  it('does not claim to have anchored anything on-chain', () => {
    expect(anchorFor('trainingRunHash', { run: 1 }).anchoredTxHash).toBeUndefined();
  });
});
