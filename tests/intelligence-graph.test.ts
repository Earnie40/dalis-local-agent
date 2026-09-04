import { describe, expect, it } from 'vitest';
import { publicFact, inference, internalClaim, GraphError, describeEdges } from '@dacai-local-agent/investor-intelligence';

describe('ecosystem relationship graph — statement kinds cannot mix', () => {
  it('publicFact requires at least one supporting signal', () => {
    expect(() =>
      publicFact({
        fromEntityId: 'ent_1',
        toEntityId: 'ent_2',
        relationship: 'invested_in',
        supportingSignalIds: [],
      }),
    ).toThrow(/no supporting signal/);
  });

  it('publicFact is classified PUBLIC_FACT / observed with sources attached', () => {
    const edge = publicFact({
      fromEntityId: 'ent_1',
      toEntityId: 'ent_2',
      relationship: 'invested_in',
      supportingSignalIds: ['sig_1'],
    });
    expect(edge.statementKind).toBe('PUBLIC_FACT');
    expect(edge.assertionClass).toBe('observed');
    expect(edge.sourceCount).toBe(1);
  });

  it('inference requires a confidence value', () => {
    expect(() =>
      inference({
        fromEntityId: 'ent_1',
        toTopicId: 'top_1',
        relationship: 'interested_in',
        // @ts-expect-error -- confidence intentionally omitted for the test
        confidence: undefined,
        rationale: 'test',
      }),
    ).toThrow();
  });

  it('inference requires a rationale', () => {
    expect(() =>
      inference({
        fromEntityId: 'ent_1',
        toTopicId: 'top_1',
        relationship: 'interested_in',
        confidence: 0.5,
        rationale: '',
      }),
    ).toThrow(/rationale/);
  });

  it('inference is classified INFERENCE / inferred', () => {
    const edge = inference({
      fromEntityId: 'ent_1',
      toTopicId: 'top_1',
      relationship: 'interested_in',
      confidence: 0.7,
      rationale: 'Derived from three signals.',
    });
    expect(edge.statementKind).toBe('INFERENCE');
    expect(edge.assertionClass).toBe('inferred');
  });

  it('an internalClaim for a working capability is DACAIS_INTERNAL_CLAIM', () => {
    const edge = internalClaim({
      dacaisEntityId: 'ent_dacais',
      toTopicId: 'top_1',
      relationship: 'demonstrates',
      capabilityStatus: 'WORKING_PROTOTYPE',
      rationale: 'Working prototype exists.',
    });
    expect(edge.statementKind).toBe('DACAIS_INTERNAL_CLAIM');
    expect(edge.assertionClass).toBe('stated');
  });

  it('an internalClaim for a horizon capability is PROPOSED_FUTURE_CAPABILITY, never a plain claim', () => {
    const edge = internalClaim({
      dacaisEntityId: 'ent_dacais',
      toTopicId: 'top_1',
      relationship: 'demonstrates',
      capabilityStatus: 'HORIZON',
      rationale: 'Strategic direction only.',
    });
    expect(edge.statementKind).toBe('PROPOSED_FUTURE_CAPABILITY');
    expect(edge.relationship).toBe('horizon_for');
  });

  it('rejects an edge naming both an entity and a topic target', () => {
    expect(() =>
      publicFact({
        fromEntityId: 'ent_1',
        toEntityId: 'ent_2',
        toTopicId: 'top_1',
        relationship: 'invested_in',
        supportingSignalIds: ['sig_1'],
      }),
    ).toThrow(GraphError);
  });

  it('rejects an edge naming neither an entity nor a topic target', () => {
    expect(() =>
      publicFact({
        fromEntityId: 'ent_1',
        relationship: 'invested_in',
        supportingSignalIds: ['sig_1'],
      }),
    ).toThrow(GraphError);
  });

  it('describeEdges groups by statement kind so a fact and an inference render separately', () => {
    const fact = publicFact({
      fromEntityId: 'ent_1', toEntityId: 'ent_2', relationship: 'invested_in', supportingSignalIds: ['sig_1'],
    });
    const inferred = inference({
      fromEntityId: 'ent_1', toTopicId: 'top_1', relationship: 'interested_in', confidence: 0.6, rationale: 'x',
    });
    const rendered = describeEdges(
      [{ ...fact, targetLabel: 'Acme Robotics' }, { ...inferred, targetLabel: 'physical AI' }],
      'Future Ventures',
    );
    expect(rendered).toContain('PUBLIC_FACT:');
    expect(rendered).toContain('INFERENCE:');
    const factIndex = rendered.indexOf('PUBLIC_FACT:');
    const inferenceIndex = rendered.indexOf('INFERENCE:');
    // Each block only contains its own lines -- an inference must never appear
    // inside the PUBLIC_FACT block or vice versa.
    expect(rendered.slice(factIndex, inferenceIndex)).not.toContain('physical AI');
  });
});
