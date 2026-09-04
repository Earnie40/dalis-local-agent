import { TemporalIntegrityError, assertNoLookAhead, type TemporalRecord } from '@dacai-local-agent/datasets';

/**
 * Backtest / paper-trading specification.
 *
 * This is the simulation layer that must exist before any live execution. It
 * defines walk-forward windows, a mandatory cost model, and the leak check that
 * runs on every decision's inputs. It executes nothing and connects to no venue.
 */

export interface CostModel {
  /** Proportional fee per side, e.g. 0.001 for 10bps. */
  feeRate: number;
  /** Proportional slippage assumption per side. */
  slippageRate: number;
  /** Delay between decision and fill. Fills before this are not achievable. */
  latencyMs: number;
  /** Maximum fraction of observed volume the simulation may assume it can take. */
  maxParticipationRate: number;
}

export class BacktestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestConfigError';
  }
}

/**
 * A zero-cost, zero-latency backtest is not a conservative simplification — it
 * is the single most common way a strategy looks profitable and is not. The
 * config refuses to be constructed without explicit assumptions.
 */
export function createCostModel(model: CostModel): CostModel {
  const problems: string[] = [];
  if (model.feeRate < 0) problems.push('feeRate must not be negative.');
  if (model.slippageRate < 0) problems.push('slippageRate must not be negative.');
  if (model.latencyMs < 0) problems.push('latencyMs must not be negative.');
  if (!(model.maxParticipationRate > 0 && model.maxParticipationRate <= 1)) {
    problems.push('maxParticipationRate must be within (0,1].');
  }
  if (problems.length) throw new BacktestConfigError(problems.join(' '));
  return { ...model };
}

export interface WalkForwardWindow {
  index: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
}

export interface WalkForwardSpec {
  start: string;
  end: string;
  trainMs: number;
  testMs: number;
  /** Gap between train end and test start, at least the longest label horizon. */
  embargoMs: number;
  /** Advance per step. Defaults to testMs (non-overlapping test windows). */
  stepMs?: number;
}

/**
 * Rolling train/test windows moving forward in time. Test windows never overlap
 * their own training window, and the embargo separates them so a label horizon
 * spanning the boundary cannot leak.
 */
export function walkForwardWindows(spec: WalkForwardSpec): WalkForwardWindow[] {
  const start = Date.parse(spec.start);
  const end = Date.parse(spec.end);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new BacktestConfigError('start and end must be ISO timestamps.');
  }
  if (end <= start) throw new BacktestConfigError('end must be after start.');
  if (spec.trainMs <= 0 || spec.testMs <= 0) {
    throw new BacktestConfigError('trainMs and testMs must be positive.');
  }
  if (spec.embargoMs < 0) throw new BacktestConfigError('embargoMs must not be negative.');

  const step = spec.stepMs ?? spec.testMs;
  if (step <= 0) throw new BacktestConfigError('stepMs must be positive.');

  const windows: WalkForwardWindow[] = [];
  let trainStart = start;
  let index = 0;
  while (true) {
    const trainEnd = trainStart + spec.trainMs;
    const testStart = trainEnd + spec.embargoMs;
    const testEnd = testStart + spec.testMs;
    if (testEnd > end) break;
    windows.push({
      index,
      trainStart: new Date(trainStart).toISOString(),
      trainEnd: new Date(trainEnd).toISOString(),
      testStart: new Date(testStart).toISOString(),
      testEnd: new Date(testEnd).toISOString(),
    });
    trainStart += step;
    index += 1;
  }
  return windows;
}

export interface SimulatedDecision {
  decisionId: string;
  decisionTime: string;
  /** Every record the decision was allowed to read. */
  inputs: readonly TemporalRecord[];
}

/**
 * Gate every simulated decision through this. It throws on any input that would
 * not have been knowable, so a leak surfaces as a failing run rather than as an
 * unusually good result.
 */
export function validateDecisionInputs(decision: SimulatedDecision): void {
  try {
    assertNoLookAhead(decision.inputs, decision.decisionTime);
  } catch (error) {
    if (error instanceof TemporalIntegrityError) {
      throw new TemporalIntegrityError(
        `Decision ${decision.decisionId} read information from the future.`,
        error.violations,
      );
    }
    throw error;
  }
}

/** Round-trip cost as a fraction of notional, both sides included. */
export function roundTripCost(model: CostModel): number {
  return 2 * (model.feeRate + model.slippageRate);
}

/** Largest peak-to-trough decline in an equity curve, as a positive fraction. */
export function maxDrawdown(equityCurve: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const value of equityCurve) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.max(worst, (peak - value) / peak);
  }
  return worst;
}
