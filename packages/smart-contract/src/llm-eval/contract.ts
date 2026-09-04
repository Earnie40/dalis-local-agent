import { z } from 'zod';
import type { Severity } from '../analyzer.js';

/**
 * The machine-evaluable review contract the model must return.
 *
 * qwen3:8b cannot reliably honor a strict JSON schema even when asked, so the
 * harness asks for JSON in a constrained shape and parses/validates it with zod
 * on the way back in. A review that does not conform is rejected rather than
 * graded, which keeps the model honest about the output format.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type ReviewSeverity = Severity;

/** Model-review finding status. Not every concern is a confirmed vulnerability. */
export const FINDING_STATUS = ['confirmed', 'likely', 'possible', 'not_supported'] as const;
export type ReviewFindingStatus = (typeof FINDING_STATUS)[number];

/** Provenance of a claim. The model must keep these separate and never merge them. */
export const BASIS = ['DETERMINISTIC_FINDING', 'RETRIEVED_KNOWLEDGE', 'MODEL_INFERENCE'] as const;
export type FindingBasis = (typeof BASIS)[number];

const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1),
  sourceLines: z.array(z.number().int().positive()).default([]),
  functionName: z.string().optional(),
  rationale: z.string().min(1),
  remediation: z.string().min(1),
  status: z.enum(FINDING_STATUS),
  basis: z.enum(BASIS),
  unsupported: z.boolean().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

const ReviewSchema = z.object({
  contractId: z.string().min(1),
  findings: z.array(ReviewFindingSchema).default([]),
  safeAreas: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
  overallRisk: z.enum(SEVERITIES).optional(),
});
export type StructuredReview = z.infer<typeof ReviewSchema>;

export const STRUCTURED_REVIEW_SCHEMA = ReviewSchema;