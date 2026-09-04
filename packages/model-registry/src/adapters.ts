import { hashArtifact, type DomainId } from '@dacai-local-agent/domain-knowledge';

/**
 * Domain adapter registry.
 *
 * DACAIS is intended to run a base agent with per-domain LoRA/QLoRA adapters
 * layered on it. No adapter has been trained. What exists here is the registry
 * and the promotion gate, so adapters can be added later without reshaping the
 * dataset, evaluation, or evidence layers around them.
 */

export type AdapterStatus =
  /** Registered intent to train. No weights. */
  | 'planned'
  /** Weights exist and are being evaluated. Not routable. */
  | 'candidate'
  /** Passed evaluation and human approval. Routable. */
  | 'promoted'
  /** Evaluated and refused. Retained so the decision is not repeated blindly. */
  | 'rejected'
  /** Superseded by a later version. */
  | 'retired';

export interface DatasetVersionRef {
  datasetId: string;
  version: number;
}

export interface AdapterRecord {
  adapterId: string;
  domainId: DomainId;
  baseModel: string;
  /** Ollama blob digest or equivalent. A tag is not an identity. */
  baseModelDigest?: string;
  version: number;
  status: AdapterStatus;
  /** Exact dataset versions this adapter was trained on. */
  trainedOn: readonly DatasetVersionRef[];
  trainingRunHash?: string;
  modelAdapterHash?: string;
  createdAt: string;
  supersedesAdapterId?: string;
  rejectionReason?: string;
}

export interface EvaluationThresholds {
  /** Minimum score on the domain's held-out suite, 0..1. */
  minScore: number;
  /** The promoted adapter must not regress the base model's general ability. */
  maxGeneralRegression: number;
}

export interface EvaluationRun {
  evaluationId: string;
  adapterId: string;
  adapterVersion: number;
  domainId: DomainId;
  /** Suite must be held out; see datasets/splits.ts. */
  suiteDatasetId: string;
  suiteDatasetVersion: number;
  score: number;
  /** Change in general-capability score vs the base model. Negative is regression. */
  generalDelta: number;
  ranAt: string;
  evaluationHash?: string;
}

export class AdapterRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

export interface PromotionRequest {
  evaluation: EvaluationRun;
  thresholds: EvaluationThresholds;
  /** Named human. Automated promotion is not permitted. */
  approvedBy: string;
  approvedAt: string;
}

export interface PromotionDecision {
  promoted: boolean;
  reasons: readonly string[];
  approvalHash?: string;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterRecord>();

  private static key(adapterId: string, version: number): string {
    return `${adapterId}@${version}`;
  }

  register(record: AdapterRecord): AdapterRecord {
    if (record.status === 'promoted') {
      throw new AdapterRegistryError(
        `Adapter ${record.adapterId}@${record.version} cannot be registered as "promoted". Promotion happens through promote(), which requires an evaluation and a named approver.`,
      );
    }
    if (record.status === 'candidate' && record.trainedOn.length === 0) {
      throw new AdapterRegistryError(
        `Adapter ${record.adapterId}@${record.version} is a candidate but names no dataset versions. An adapter with untraceable training data cannot be promoted later.`,
      );
    }
    const key = AdapterRegistry.key(record.adapterId, record.version);
    if (this.adapters.has(key)) {
      throw new AdapterRegistryError(`Adapter ${key} is already registered.`);
    }
    const stored = { ...record, trainedOn: [...record.trainedOn] };
    this.adapters.set(key, stored);
    return stored;
  }

  get(adapterId: string, version: number): AdapterRecord | undefined {
    return this.adapters.get(AdapterRegistry.key(adapterId, version));
  }

  /** Adapters eligible to serve traffic for a domain. */
  routableFor(domainId: DomainId): AdapterRecord[] {
    return [...this.adapters.values()].filter(
      (a) => a.domainId === domainId && a.status === 'promoted',
    );
  }

  /**
   * The promotion gate. Every condition is checked and all failures are
   * reported together, so a rejected promotion explains itself rather than
   * failing on the first problem found.
   */
  promote(adapterId: string, version: number, request: PromotionRequest): PromotionDecision {
    const adapter = this.get(adapterId, version);
    if (!adapter) {
      throw new AdapterRegistryError(`Unknown adapter ${adapterId}@${version}.`);
    }

    const reasons: string[] = [];
    if (adapter.status !== 'candidate') {
      reasons.push(`Adapter status is "${adapter.status}"; only a candidate may be promoted.`);
    }
    if (request.evaluation.adapterId !== adapterId || request.evaluation.adapterVersion !== version) {
      reasons.push(
        `Evaluation ${request.evaluation.evaluationId} belongs to ${request.evaluation.adapterId}@${request.evaluation.adapterVersion}, not ${adapterId}@${version}.`,
      );
    }
    if (request.evaluation.domainId !== adapter.domainId) {
      reasons.push(
        `Evaluation domain "${request.evaluation.domainId}" does not match adapter domain "${adapter.domainId}".`,
      );
    }
    if (request.evaluation.score < request.thresholds.minScore) {
      reasons.push(
        `Score ${request.evaluation.score} is below the required ${request.thresholds.minScore}.`,
      );
    }
    if (request.evaluation.generalDelta < -request.thresholds.maxGeneralRegression) {
      reasons.push(
        `General-capability regression ${request.evaluation.generalDelta} exceeds the permitted ${request.thresholds.maxGeneralRegression}.`,
      );
    }
    if (!request.approvedBy.trim()) {
      reasons.push('Promotion requires a named human approver.');
    }
    if (!adapter.trainingRunHash) {
      reasons.push('Adapter has no trainingRunHash; the run that produced it is not identifiable.');
    }

    if (reasons.length) {
      return { promoted: false, reasons };
    }

    const approvalHash = hashArtifact({
      adapterId,
      version,
      evaluationId: request.evaluation.evaluationId,
      score: request.evaluation.score,
      approvedBy: request.approvedBy,
      approvedAt: request.approvedAt,
    });

    this.adapters.set(AdapterRegistry.key(adapterId, version), {
      ...adapter,
      status: 'promoted',
    });

    if (adapter.supersedesAdapterId) {
      for (const [key, candidate] of this.adapters) {
        if (candidate.adapterId === adapter.supersedesAdapterId && candidate.status === 'promoted') {
          this.adapters.set(key, { ...candidate, status: 'retired' });
        }
      }
    }

    return { promoted: true, reasons: [], approvalHash };
  }

  reject(adapterId: string, version: number, reason: string): AdapterRecord {
    const adapter = this.get(adapterId, version);
    if (!adapter) throw new AdapterRegistryError(`Unknown adapter ${adapterId}@${version}.`);
    if (adapter.status === 'promoted') {
      throw new AdapterRegistryError(
        `Adapter ${adapterId}@${version} is promoted; retire it rather than rejecting it.`,
      );
    }
    const updated: AdapterRecord = { ...adapter, status: 'rejected', rejectionReason: reason };
    this.adapters.set(AdapterRegistry.key(adapterId, version), updated);
    return updated;
  }
}
