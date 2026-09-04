import { hashArtifact } from '@dacai-local-agent/domain-knowledge';

/**
 * Probabilistic forecasting.
 *
 * A prediction is a probability with a horizon and stated invalidating
 * conditions — never "it will go up". Records are immutable and content-hashed
 * at creation, and outcomes are written as separate records referencing that
 * hash, so the system cannot rewrite its own forecast history once results are
 * known.
 */

export interface PredictionInput {
  predictionId: string;
  /** What is being forecast, e.g. 'ETH-USD closes above 3000'. */
  statement: string;
  instrument: string;
  /** P(statement is true) at resolution. Must be in (0,1) exclusive. */
  probability: number;
  /** The model's confidence in its own probability estimate, 0..1. */
  confidence: number;
  horizonMs: number;
  /** Conditions assumed to hold. */
  conditions: readonly string[];
  /** Observations that would make this forecast void rather than merely wrong. */
  invalidatingConditions: readonly string[];
  /** What the forecast was based on. */
  evidence: readonly string[];
  modelId: string;
  modelVersion: string;
  /** When the forecast was made. Resolution time is issuedAt + horizonMs. */
  issuedAt: string;
}

export interface PredictionRecord extends PredictionInput {
  resolvesAt: string;
  /** sha256 over the canonical prediction. Any edit changes it. */
  predictionHash: string;
}

export type ResolutionStatus = 'true' | 'false' | 'invalidated';

export interface PredictionOutcome {
  predictionId: string;
  /** Binds the outcome to the exact forecast that was made. */
  predictionHash: string;
  status: ResolutionStatus;
  resolvedAt: string;
  /** Realised return over the horizon, where applicable. */
  realizedReturn?: number;
  notes?: string;
}

export class PredictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PredictionError';
  }
}

export function createPrediction(input: PredictionInput): PredictionRecord {
  if (!(input.probability > 0 && input.probability < 1)) {
    throw new PredictionError(
      `Probability must be strictly between 0 and 1 (received ${input.probability}). A forecast of 0 or 1 claims certainty.`,
    );
  }
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    throw new PredictionError(`Confidence must be within 0..1, received ${input.confidence}.`);
  }
  if (input.horizonMs <= 0) {
    throw new PredictionError(`A prediction must have a positive horizon.`);
  }
  if (input.invalidatingConditions.length === 0) {
    throw new PredictionError(
      `Prediction "${input.predictionId}" must state at least one invalidating condition; an unfalsifiable forecast cannot be evaluated.`,
    );
  }

  const issued = Date.parse(input.issuedAt);
  if (Number.isNaN(issued)) {
    throw new PredictionError(`Invalid issuedAt: ${JSON.stringify(input.issuedAt)}.`);
  }

  const record = {
    ...input,
    conditions: [...input.conditions],
    invalidatingConditions: [...input.invalidatingConditions],
    evidence: [...input.evidence],
    resolvesAt: new Date(issued + input.horizonMs).toISOString(),
  };

  return Object.freeze({ ...record, predictionHash: hashArtifact(record) });
}

export function resolvePrediction(
  record: PredictionRecord,
  outcome: Omit<PredictionOutcome, 'predictionId' | 'predictionHash'>,
): PredictionOutcome {
  if (Date.parse(outcome.resolvedAt) < Date.parse(record.resolvesAt)) {
    throw new PredictionError(
      `Refusing to resolve "${record.predictionId}" at ${outcome.resolvedAt}, before its horizon ends at ${record.resolvesAt}.`,
    );
  }
  return {
    ...outcome,
    predictionId: record.predictionId,
    predictionHash: record.predictionHash,
  };
}

export interface ScoredPrediction {
  record: PredictionRecord;
  outcome: PredictionOutcome;
}

/**
 * Only resolved true/false pairs are scoreable. Invalidated forecasts are
 * excluded rather than counted as wrong — their stated assumptions failed, and
 * scoring them would punish honest condition-setting.
 */
function scoreable(pairs: readonly ScoredPrediction[]): ScoredPrediction[] {
  return pairs.filter((p) => p.outcome.status !== 'invalidated');
}

/** Mean squared error of the probability against the realised binary outcome. Lower is better. */
export function brierScore(pairs: readonly ScoredPrediction[]): number | null {
  const valid = scoreable(pairs);
  if (!valid.length) return null;
  const total = valid.reduce((sum, { record, outcome }) => {
    const actual = outcome.status === 'true' ? 1 : 0;
    return sum + (record.probability - actual) ** 2;
  }, 0);
  return total / valid.length;
}

/** Share of forecasts on the correct side of 0.5. */
export function directionalAccuracy(pairs: readonly ScoredPrediction[]): number | null {
  const valid = scoreable(pairs).filter((p) => p.record.probability !== 0.5);
  if (!valid.length) return null;
  const correct = valid.filter(({ record, outcome }) =>
    record.probability > 0.5 ? outcome.status === 'true' : outcome.status === 'false',
  ).length;
  return correct / valid.length;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedFrequency: number;
}

/**
 * Calibration: among forecasts made at ~70%, did ~70% happen? This is the
 * measure that catches a confidently wrong model, which accuracy alone misses.
 */
export function calibrationBins(
  pairs: readonly ScoredPrediction[],
  binCount = 10,
): CalibrationBin[] {
  const valid = scoreable(pairs);
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i += 1) {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    const members = valid.filter(
      ({ record }) =>
        record.probability >= lower && (i === binCount - 1 ? record.probability <= upper : record.probability < upper),
    );
    if (!members.length) continue;
    bins.push({
      lower,
      upper,
      count: members.length,
      meanPredicted: members.reduce((s, m) => s + m.record.probability, 0) / members.length,
      observedFrequency:
        members.filter((m) => m.outcome.status === 'true').length / members.length,
    });
  }
  return bins;
}

/**
 * Share of high-confidence forecasts that were wrong. A model may be
 * well-calibrated on average and still fail badly exactly where it was surest,
 * which is the failure mode that matters most downstream.
 */
export function falseConfidenceRate(
  pairs: readonly ScoredPrediction[],
  threshold = 0.8,
): number | null {
  const confident = scoreable(pairs).filter(
    ({ record }) => record.probability >= threshold || record.probability <= 1 - threshold,
  );
  if (!confident.length) return null;
  const wrong = confident.filter(({ record, outcome }) =>
    record.probability >= threshold ? outcome.status === 'false' : outcome.status === 'true',
  ).length;
  return wrong / confident.length;
}
