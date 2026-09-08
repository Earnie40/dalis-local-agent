/**
 * RiskClassifier: resolves an explicitly declared risk level.
 *
 * Natural-language action text is deliberately opaque here. Security words,
 * synonyms, and inferred intent must not silently change authorization. A
 * trusted caller that needs a non-default tier supplies `riskLevel` as
 * structured data.
 */

import type { RiskClassification, RiskLevel } from './red-team-types.js';

export interface RiskClassificationContext {
  riskLevel?: RiskLevel;
  category?: string;
  affectsProduction?: boolean;
}

const DESCRIPTION_BY_LEVEL: Record<RiskLevel, string> = {
  LEVEL_1_SAFE: 'Default risk tier; no higher tier was explicitly declared.',
  LEVEL_2_CONTROLLED: 'Controlled tier explicitly declared by the caller.',
  LEVEL_3_HIGH_IMPACT: 'High-impact tier explicitly declared by the caller.',
  LEVEL_4_RESTRICTED: 'Restricted tier explicitly declared by the caller.',
};

export class RiskClassifier {
  /** Resolves structured risk metadata without inspecting the action wording. */
  classify(_action: string, context: RiskClassificationContext = {}): RiskClassification {
    const level = context.riskLevel ?? 'LEVEL_1_SAFE';
    const requiresApproval =
      level === 'LEVEL_4_RESTRICTED' ||
      level === 'LEVEL_3_HIGH_IMPACT' ||
      (level === 'LEVEL_2_CONTROLLED' && context.affectsProduction === true);

    return {
      level,
      description: DESCRIPTION_BY_LEVEL[level],
      requiresApproval,
      category: context.category ?? 'general',
    };
  }
}
