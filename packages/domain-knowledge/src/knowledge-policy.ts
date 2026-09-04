import { getDomain, type DomainId } from './taxonomy.js';

/**
 * The knowledge-vs-weights split, enforced rather than documented.
 *
 * Facts that change faster than a fine-tuning cycle (protocol versions, prices,
 * deployed contract addresses, current APIs, current regulations, live chain
 * state) must be retrieved. Only stable *procedures* may be trained into
 * weights. Every dataset in the platform is routed through classifyKnowledge()
 * before it can be marked training-eligible.
 */

export type KnowledgeKind =
  /** A statement about the world that can become untrue without the model changing. */
  | 'fact'
  /** A repeatable way of working: how to analyse, plan, verify, or recover. */
  | 'procedure';

export type KnowledgeRoute = 'rag' | 'weights';

export interface KnowledgeClassificationInput {
  domainId: DomainId;
  kind: KnowledgeKind;
  /**
   * Overrides the domain default. A domain whose facts are generally stable can
   * still hold a volatile one, and vice versa.
   */
  volatile?: boolean;
}

export interface KnowledgeClassification {
  route: KnowledgeRoute;
  /** True only when this material may enter a fine-tuning dataset. */
  trainingEligible: boolean;
  reason: string;
}

export function classifyKnowledge(input: KnowledgeClassificationInput): KnowledgeClassification {
  const domain = getDomain(input.domainId);
  const volatile = input.volatile ?? domain.factsAreVolatile;

  if (input.kind === 'fact') {
    if (volatile) {
      return {
        route: 'rag',
        trainingEligible: false,
        reason: `Volatile fact in domain "${domain.id}" — retrieval only; weights would go stale.`,
      };
    }
    return {
      route: 'rag',
      trainingEligible: false,
      reason: `Facts are served by retrieval so they can be corrected without retraining.`,
    };
  }

  return {
    route: 'weights',
    trainingEligible: true,
    reason: `Stable procedure in domain "${domain.id}" — behavioural skill, eligible for an adapter.`,
  };
}

export class KnowledgeRoutingError extends Error {
  constructor(
    message: string,
    readonly classification: KnowledgeClassification,
  ) {
    super(message);
    this.name = 'KnowledgeRoutingError';
  }
}

/**
 * Fail-closed guard for the training path. Callers building a fine-tuning
 * dataset call this per item; a volatile fact throws instead of quietly
 * becoming a frozen weight.
 */
export function assertTrainable(input: KnowledgeClassificationInput): KnowledgeClassification {
  const classification = classifyKnowledge(input);
  if (!classification.trainingEligible) {
    throw new KnowledgeRoutingError(
      `Refusing to route ${input.kind} from domain "${input.domainId}" into training: ${classification.reason}`,
      classification,
    );
  }
  return classification;
}
