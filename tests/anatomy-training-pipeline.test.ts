import { describe, expect, it } from 'vitest';
import {
  classifyKnowledge,
  assertTrainable,
  hashArtifact,
  type DomainId,
} from '@dacai-local-agent/domain-knowledge';
import {
  createDatasetVersion,
  LineageGraph,
  type DatasetSource,
  type DatasetVersion,
} from '@dacai-local-agent/datasets';
import {
  AdapterRegistry,
  type AdapterRecord,
  type EvaluationRun,
  type PromotionRequest,
} from '@dacai-local-agent/model-registry';

describe('Anatomy Agent Training and Adaptation Pipeline', () => {
  const domainId: DomainId = 'anatomy-and-physiology';

  describe('Knowledge Policy Split for Anatomy and Vision', () => {
    it('routes anatomical localization procedures into weights', () => {
      const classification = classifyKnowledge({
        domainId,
        kind: 'procedure',
      });
      expect(classification.route).toBe('weights');
      expect(classification.trainingEligible).toBe(true);
      expect(classification.reason).toContain('eligible for an adapter');

      expect(() =>
        assertTrainable({
          domainId,
          kind: 'procedure',
        }),
      ).not.toThrow();
    });

    it('routes volatile or empirical facts to retrieval (RAG) and refuses raw fact training', () => {
      const classification = classifyKnowledge({
        domainId,
        kind: 'fact',
      });
      expect(classification.route).toBe('rag');
      expect(classification.trainingEligible).toBe(false);

      expect(() =>
        assertTrainable({
          domainId,
          kind: 'fact',
        }),
      ).toThrow(/Refusing to route fact/);
    });
  });

  describe('Immutable Anatomy Dataset Versioning and Lineage', () => {
    it('creates an immutable sealed dataset version with sources and hash', () => {
      const sources: DatasetSource[] = [
        {
          kind: 'internal_curated',
          locator: 'corpus/anatomy-and-physiology/02-female-human-anatomy-and-morphology.md',
          license: 'DACAIS-internal-original',
          sha256: hashArtifact('female-anatomy-source'),
        },
        {
          kind: 'internal_curated',
          locator: 'corpus/anatomy-and-physiology/03-male-human-anatomy-and-morphology.md',
          license: 'DACAIS-internal-original',
          sha256: hashArtifact('male-anatomy-source'),
        },
        {
          kind: 'internal_curated',
          locator: 'corpus/anatomy-and-physiology/04-comparative-animal-anatomy-and-body-plans.md',
          license: 'DACAIS-internal-original',
          sha256: hashArtifact('comparative-animal-source'),
        },
      ];

      const version: DatasetVersion = createDatasetVersion({
        datasetId: 'ds_anatomy_vision_grounding',
        version: 1,
        domainId,
        purpose: 'training',
        title: 'Human Female and Male Anatomy and Vision AI Grounding Dataset',
        recordCount: 120,
        sources,
        notes: 'Verified procedural training examples for female/male anatomical landmarks, animal homologies, and spatial grounding.',
      });

      expect(version.datasetId).toBe('ds_anatomy_vision_grounding');
      expect(version.version).toBe(1);
      expect(version.contentHash).toBeDefined();
      expect(version.sources).toHaveLength(3);

      const graph = new LineageGraph();
      graph.register(version);
      expect(graph.get('ds_anatomy_vision_grounding', 1)).toBeDefined();
    });
  });

  describe('Model Adapter Registration and Promotion for Anatomy Agent', () => {
    it('registers a candidate adapter and promotes it after passing held-out evaluation', () => {
      const registry = new AdapterRegistry();

      const adapterId = 'dacais-anatomy-vision-adapter';
      const version = 1;
      const trainingRunHash = hashArtifact({
        adapterId,
        version,
        dataset: 'ds_anatomy_vision_grounding@1',
        epochs: 3,
        learningRate: 0.0002,
        baseModel: 'qwen2.5vl:7b',
      });

      const candidate: AdapterRecord = {
        adapterId,
        domainId,
        baseModel: 'qwen2.5vl:7b',
        version,
        status: 'candidate',
        trainedOn: [{ datasetId: 'ds_anatomy_vision_grounding', version: 1 }],
        trainingRunHash,
        createdAt: new Date().toISOString(),
      };

      // Register the candidate adapter
      registry.register(candidate);
      expect(registry.get(adapterId, version)?.status).toBe('candidate');

      // The adapter is NOT routable before promotion
      expect(registry.routableFor(domainId)).toHaveLength(0);

      // Objective evaluation run against held-out benchmark suite
      const evaluation: EvaluationRun = {
        evaluationId: 'eval_anat_20260906',
        adapterId,
        adapterVersion: version,
        domainId,
        suiteDatasetId: 'ds_anatomy_heldout_suite',
        suiteDatasetVersion: 1,
        score: 0.98, // 98% accuracy on anatomical localization and dimorphism discrimination
        generalDelta: -0.005, // Minimal general regression (within threshold)
        ranAt: new Date().toISOString(),
        evaluationHash: hashArtifact({ eval: 'anatomy-heldout-eval', score: 0.98 }),
      };

      const promotionRequest: PromotionRequest = {
        evaluation,
        thresholds: {
          minScore: 0.85,
          maxGeneralRegression: 0.02,
        },
        approvedBy: 'Kyleh (DACAIS Principal Lead)',
        approvedAt: new Date().toISOString(),
      };

      const decision = registry.promote(adapterId, version, promotionRequest);

      expect(decision.promoted).toBe(true);
      expect(decision.approvalHash).toBeDefined();
      expect(registry.get(adapterId, version)?.status).toBe('promoted');

      // The promoted adapter is now routable for the anatomy-and-physiology domain!
      const routable = registry.routableFor(domainId);
      expect(routable).toHaveLength(1);
      expect(routable[0].adapterId).toBe(adapterId);
    });

    it('refuses promotion if evaluation score is below the required threshold', () => {
      const registry = new AdapterRegistry();
      const adapterId = 'dacais-anatomy-failing-adapter';
      const version = 1;

      registry.register({
        adapterId,
        domainId,
        baseModel: 'qwen2.5vl:7b',
        version,
        status: 'candidate',
        trainedOn: [{ datasetId: 'ds_anatomy_vision_grounding', version: 1 }],
        trainingRunHash: hashArtifact('run-failing'),
        createdAt: new Date().toISOString(),
      });

      const failingEvaluation: EvaluationRun = {
        evaluationId: 'eval_failing',
        adapterId,
        adapterVersion: version,
        domainId,
        suiteDatasetId: 'ds_anatomy_heldout_suite',
        suiteDatasetVersion: 1,
        score: 0.65, // Below 0.85 requirement
        generalDelta: 0,
        ranAt: new Date().toISOString(),
      };

      const decision = registry.promote(adapterId, version, {
        evaluation: failingEvaluation,
        thresholds: { minScore: 0.85, maxGeneralRegression: 0.02 },
        approvedBy: 'Kyleh',
        approvedAt: new Date().toISOString(),
      });

      expect(decision.promoted).toBe(false);
      expect(decision.reasons.some((r) => r.includes('below the required'))).toBe(true);
      expect(registry.get(adapterId, version)?.status).toBe('candidate');
    });
  });
});
