import { describe, expect, it } from 'vitest';
import {
  LearningLoopCandidate,
  LearningLoopError,
  LineageError,
  LineageGraph,
  TemporalIntegrityError,
  assertNoLookAhead,
  assertTemporalOrder,
  assignSplit,
  availabilityLagMs,
  createDatasetVersion,
  createSplitPlan,
  hasHumanApproval,
  partition,
  visibleAt,
} from '@dacai-local-agent/datasets';

const source = { kind: 'public_transaction_feed', locator: 'base-mainnet' };

describe('temporal integrity', () => {
  const valid = {
    eventTime: '2026-01-01T00:00:00.000Z',
    availableAt: '2026-01-01T00:05:00.000Z',
    observedAt: '2026-01-01T00:06:00.000Z',
  };

  it('accepts eventTime <= availableAt <= observedAt', () => {
    expect(() => assertTemporalOrder(valid)).not.toThrow();
    expect(availabilityLagMs(valid)).toBe(5 * 60 * 1000);
  });

  it('rejects information that exists before its own event', () => {
    expect(() =>
      assertTemporalOrder({ ...valid, availableAt: '2025-12-31T23:00:00.000Z' }),
    ).toThrow(TemporalIntegrityError);
  });

  it('rejects an observation recorded before the information was available', () => {
    expect(() => assertTemporalOrder({ ...valid, observedAt: '2026-01-01T00:01:00.000Z' })).toThrow(
      /cannot observe information before it is available/,
    );
  });

  it('filters on availability, not on event time', () => {
    // The classic leak: an event that happened early but was published late.
    const records = [
      { id: 'early-event-late-publish', eventTime: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-05T00:00:00.000Z', observedAt: '2026-01-05T00:00:00.000Z' },
      { id: 'knowable', eventTime: '2026-01-02T00:00:00.000Z', availableAt: '2026-01-02T00:00:00.000Z', observedAt: '2026-01-02T00:00:00.000Z' },
    ];

    const visible = visibleAt(records, '2026-01-03T00:00:00.000Z');
    expect(visible.map((r) => r.id)).toEqual(['knowable']);
  });

  it('throws and names every leaked record rather than dropping it silently', () => {
    const records = [
      { id: 'leak-a', eventTime: '2026-01-01T00:00:00.000Z', availableAt: '2026-02-01T00:00:00.000Z', observedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'ok', eventTime: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:00:00.000Z' },
    ];

    try {
      assertNoLookAhead(records, '2026-01-15T00:00:00.000Z');
      expect.unreachable('expected a look-ahead violation');
    } catch (error) {
      expect(error).toBeInstanceOf(TemporalIntegrityError);
      expect((error as TemporalIntegrityError).violations.join()).toContain('leak-a');
      expect((error as TemporalIntegrityError).violations.join()).not.toContain('ok:');
    }
  });
});

describe('temporal splits', () => {
  const day = 24 * 60 * 60 * 1000;
  const plan = createSplitPlan({
    embargoMs: 2 * day,
    maxHorizonMs: day,
    windows: [
      { name: 'train', start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
      { name: 'validation', start: '2026-02-03T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' },
      { name: 'test', start: '2026-03-03T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' },
    ],
  });

  it('refuses an embargo shorter than the label horizon', () => {
    expect(() =>
      createSplitPlan({
        embargoMs: day,
        maxHorizonMs: 5 * day,
        windows: [
          { name: 'train', start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
          { name: 'validation', start: '2026-02-02T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' },
          { name: 'test', start: '2026-03-02T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' },
        ],
      }),
    ).toThrow(/shorter than the longest label horizon/);
  });

  it('refuses overlapping splits', () => {
    expect(() =>
      createSplitPlan({
        embargoMs: 0,
        maxHorizonMs: 0,
        windows: [
          { name: 'train', start: '2026-01-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' },
          { name: 'validation', start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' },
          { name: 'test', start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' },
        ],
      }),
    ).toThrow(/overlaps/);
  });

  it('excludes records that fall inside the embargo gap', () => {
    const stamps = (availableAt: string) => ({ eventTime: availableAt, availableAt, observedAt: availableAt });

    expect(assignSplit(plan, stamps('2026-01-15T00:00:00.000Z'))).toBe('train');
    expect(assignSplit(plan, stamps('2026-02-02T00:00:00.000Z'))).toBeNull();
    expect(assignSplit(plan, stamps('2026-03-15T00:00:00.000Z'))).toBe('test');
  });

  it('partitions records without losing any', () => {
    const stamps = (id: string, availableAt: string) => ({ id, eventTime: availableAt, availableAt, observedAt: availableAt });
    const records = [
      stamps('a', '2026-01-10T00:00:00.000Z'),
      stamps('b', '2026-02-02T00:00:00.000Z'),
      stamps('c', '2026-02-10T00:00:00.000Z'),
      stamps('d', '2026-03-10T00:00:00.000Z'),
    ];

    const result = partition(plan, records);
    expect(result.train.map((r) => r.id)).toEqual(['a']);
    expect(result.embargoed.map((r) => r.id)).toEqual(['b']);
    expect(result.validation.map((r) => r.id)).toEqual(['c']);
    expect(result.test.map((r) => r.id)).toEqual(['d']);
  });
});

describe('dataset lineage', () => {
  const version = (datasetId: string, v: number) =>
    createDatasetVersion({
      datasetId,
      version: v,
      domainId: 'market-events',
      purpose: 'training',
      title: datasetId,
      recordCount: 10,
      sources: [source],
    });

  it('refuses an unsourced dataset', () => {
    expect(() =>
      createDatasetVersion({
        datasetId: 'ds',
        version: 1,
        domainId: 'blockchain',
        purpose: 'retrieval',
        title: 'ds',
        recordCount: 1,
        sources: [],
      }),
    ).toThrow(/at least one source/);
  });

  it('treats a published version as immutable', () => {
    const graph = new LineageGraph();
    graph.register(version('raw', 1));

    const tampered = { ...version('raw', 1), contentHash: 'deadbeef' };
    expect(() => graph.register(tampered)).toThrow(/immutable/);
  });

  it('resolves inherited sources through the lineage chain', () => {
    const graph = new LineageGraph();
    const raw = createDatasetVersion({
      datasetId: 'raw',
      version: 1,
      domainId: 'onchain-intelligence',
      purpose: 'experience',
      title: 'raw swaps',
      recordCount: 100,
      sources: [{ kind: 'public_onchain_activity', locator: 'base:swaps' }],
    });
    const curated = createDatasetVersion({
      datasetId: 'curated',
      version: 1,
      domainId: 'onchain-intelligence',
      purpose: 'training',
      title: 'curated swaps',
      recordCount: 40,
      sources: [{ kind: 'annotation', locator: 'reviewer-pass-1' }],
    });

    graph.register(raw);
    graph.register(curated);
    graph.link({ fromDatasetId: 'raw', fromVersion: 1, toDatasetId: 'curated', toVersion: 1, relation: 'filtered_from' });

    const resolved = graph.resolvedSources('curated', 1).map((s) => s.locator).sort();
    expect(resolved).toEqual(['base:swaps', 'reviewer-pass-1']);
    expect(graph.descendantsOf('raw', 1).map((v) => v.datasetId)).toEqual(['curated']);
  });

  it('refuses a lineage cycle', () => {
    const graph = new LineageGraph();
    graph.register(version('a', 1));
    graph.register(version('b', 1));
    graph.link({ fromDatasetId: 'a', fromVersion: 1, toDatasetId: 'b', toVersion: 1, relation: 'derived_from' });

    expect(() =>
      graph.link({ fromDatasetId: 'b', fromVersion: 1, toDatasetId: 'a', toVersion: 1, relation: 'derived_from' }),
    ).toThrow(LineageError);
  });
});

describe('autonomous learning loop', () => {
  const walkTo = (candidate: LearningLoopCandidate, stage: string) => {
    while (candidate.stage !== stage) {
      candidate.advance(candidate.stage === 'training_candidate' ? { actor: 'kyle' } : {});
    }
  };

  it('cannot jump from an observation straight into a dataset', () => {
    const candidate = new LearningLoopCandidate('cand-1');
    expect(candidate.stage).toBe('observe');
    expect(() => candidate.advanceTo('dataset')).toThrow(/Stages advance one at a time/);
  });

  it('requires a named human to enter approval', () => {
    const candidate = new LearningLoopCandidate('cand-2');
    walkTo(candidate, 'training_candidate');

    expect(() => candidate.advance()).toThrow(/requires a named human actor/);
    expect(candidate.advance({ actor: 'kyle' })).toBe('approval');
    expect(hasHumanApproval(candidate)).toBe(true);
  });

  it('only promotes from evaluate, and only on a passing evaluation', () => {
    const candidate = new LearningLoopCandidate('cand-3');
    walkTo(candidate, 'dataset');
    expect(() => candidate.promote({ actor: 'kyle', evaluationPassed: true })).toThrow(
      /only reachable from "evaluate"/,
    );

    walkTo(candidate, 'evaluate');
    expect(() => candidate.promote({ actor: 'kyle', evaluationPassed: false })).toThrow(
      /evaluation did not pass/,
    );
    expect(candidate.promote({ actor: 'kyle', evaluationPassed: true })).toBe('promoted');
    expect(() => candidate.advance()).toThrow(LearningLoopError);
  });

  it('can be rejected at any stage and keeps the reason', () => {
    const candidate = new LearningLoopCandidate('cand-4');
    candidate.advance();
    expect(candidate.reject({ reason: 'source licence unclear' })).toBe('rejected');
    expect(candidate.history.at(-1)?.note).toBe('source licence unclear');
  });
});
