/**
 * Assertion provenance.
 *
 * The platform must never present an inferred motive, a simulated result, or a
 * forecast as an observed fact. Rather than relying on prose discipline, every
 * durable claim is wrapped in a Claim<T> carrying its assertion class, and the
 * only way to read one as fact is asFact(), which refuses anything else.
 */

export type AssertionClass =
  /** Directly recorded from a source: a chain event, a market print, a sensor reading. */
  | 'observed'
  /** Something a participant said about their own action or intent. */
  | 'stated'
  /** The platform's own interpretation. Never presentable as fact. */
  | 'inferred'
  /** Produced by a simulation or backtest, not by the world. */
  | 'simulated'
  /** A forward-looking probabilistic statement. */
  | 'predicted'
  /** An estimate derived from observations (e.g. a filtered pose). */
  | 'estimated'
  /** A confirmed physical result reported back by an actuated system. */
  | 'confirmed-physical';

const FACTUAL: ReadonlySet<AssertionClass> = new Set<AssertionClass>([
  'observed',
  'confirmed-physical',
]);

/** Classes that require a confidence value, because they are not certain. */
const REQUIRES_CONFIDENCE: ReadonlySet<AssertionClass> = new Set<AssertionClass>([
  'inferred',
  'predicted',
  'estimated',
]);

export interface SourceRef {
  /** Where this came from: 'ethereum-rpc', 'exchange-export', 'public-post', 'sensor'. */
  kind: string;
  /** Stable identifier within that source: a tx hash, a URL, a file hash, a topic. */
  locator: string;
  /** sha256 of the raw payload. Raw data stays off-chain; only the hash travels. */
  sha256?: string;
  retrievedAt?: string;
}

export interface Claim<T> {
  value: T;
  assertionClass: AssertionClass;
  /** 0..1. Required for inferred / predicted / estimated claims. */
  confidence?: number;
  sources: readonly SourceRef[];
  /** Free-text justification. Never treated as evidence on its own. */
  rationale?: string;
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvenanceError';
  }
}

export function makeClaim<T>(claim: Claim<T>): Claim<T> {
  if (REQUIRES_CONFIDENCE.has(claim.assertionClass)) {
    if (claim.confidence === undefined) {
      throw new ProvenanceError(
        `A "${claim.assertionClass}" claim must carry a confidence value.`,
      );
    }
    if (!(claim.confidence >= 0 && claim.confidence <= 1)) {
      throw new ProvenanceError(`Confidence must be within 0..1, received ${claim.confidence}.`);
    }
  }
  if (FACTUAL.has(claim.assertionClass) && claim.sources.length === 0) {
    throw new ProvenanceError(
      `A "${claim.assertionClass}" claim must cite at least one source.`,
    );
  }
  return { ...claim, sources: [...claim.sources] };
}

export function isFactual<T>(claim: Claim<T>): boolean {
  return FACTUAL.has(claim.assertionClass);
}

/**
 * The only way to consume a claim as a fact. An inference, a simulation, or a
 * forecast throws here instead of silently hardening into a fact downstream.
 */
export function asFact<T>(claim: Claim<T>): T {
  if (!isFactual(claim)) {
    throw new ProvenanceError(
      `Refusing to read a "${claim.assertionClass}" claim as fact. Use claim.value explicitly and preserve its assertion class.`,
    );
  }
  return claim.value;
}

/**
 * Renders a claim with its provenance attached, for prompts and reports. The
 * assertion class is always visible, so a model or a reader is never handed an
 * inference that looks like an observation.
 */
export function describeClaim<T>(claim: Claim<T>, label: string): string {
  const head = `${claim.assertionClass.toUpperCase()}: ${label}`;
  const confidence =
    claim.confidence === undefined ? '' : ` (confidence ${claim.confidence.toFixed(2)})`;
  const sources = claim.sources.length
    ? `\n  sources: ${claim.sources.map((s) => `${s.kind}:${s.locator}`).join(', ')}`
    : '';
  const rationale = claim.rationale ? `\n  rationale: ${claim.rationale}` : '';
  return `${head}${confidence}${sources}${rationale}`;
}

/**
 * Cross-domain conclusions keep every contributing claim's provenance.
 *
 * The result is always `inferred`, even when every input was observed: drawing
 * a conclusion is a step the platform took, not something the world reported.
 * Fail-closed here is what stops a speculative cross-domain conclusion from
 * being trained as a fact.
 */
export function combineClaims<T>(
  value: T,
  inputs: readonly Claim<unknown>[],
  options: { confidence: number; rationale?: string },
): Claim<T> {
  return makeClaim({
    value,
    assertionClass: 'inferred',
    confidence: options.confidence,
    sources: inputs.flatMap((input) => input.sources),
    rationale: options.rationale,
  });
}
