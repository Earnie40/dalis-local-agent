/**
 * Model routing for intelligence work.
 *
 * Two aliases, declared in config/models/default.yaml:
 *
 *   intelligence        remote_gpu_ollama / ${RUNPOD_OLLAMA_MODEL}
 *   intelligence_local  local_ollama / qwen3:8b
 *
 * Every call in this package prefers the first and names the second as its
 * fallback. StructuredGenerator records `fellBackFrom` on the result when the
 * remote instance was unreachable, so a degraded run is visible in the output
 * and in usage_events rather than being inferred later from latency.
 *
 * What the model is allowed to decide is bounded on purpose. Qwen classifies,
 * summarizes, matches, drafts, and critiques. It does not compute a score, set
 * a threshold, decide a permission, choose a publishing state, or write an
 * audit record — all of which live in deterministic code elsewhere in this
 * package. The reason is not distrust of a particular model: a number produced
 * by generation cannot be reproduced, audited, or explained to an investor.
 */

export const INTELLIGENCE_ALIAS = 'intelligence';
export const INTELLIGENCE_FALLBACK_ALIAS = 'intelligence_local';

/** Work this package routes to the model. */
export const MODEL_RESPONSIBILITIES = [
  'classification',
  'theme extraction',
  'evidence-bounded investment fact extraction',
  'summarization',
  'semantic matching',
  'content opportunity analysis',
  'mock diligence questioning',
  'memo drafting',
  'content drafting',
  'risk detection (advisory, alongside the deterministic guard)',
  'claim comparison',
] as const;

/** Work this package never routes to the model. */
export const DETERMINISTIC_RESPONSIBILITIES = [
  'scores and weights',
  'database operations',
  'permissions and source admission',
  'deduplication',
  'entity resolution',
  'evidence quote validation',
  'co-investment derivation',
  'date and decay arithmetic',
  'URL validation',
  'publishing state transitions',
  'audit logging',
  'metric retrieval',
  'thresholds',
  'authorization',
] as const;
