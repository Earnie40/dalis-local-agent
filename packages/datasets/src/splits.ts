import { TemporalIntegrityError, type TemporalStamps } from './temporal.js';

/**
 * Temporal splits for market and experience datasets.
 *
 * Random splits are wrong for time-series: a shuffled holdout lets the model
 * interpolate between rows that straddle the same event. Splits here are
 * strictly ordered in time — train, then validation, then test — separated by an
 * embargo gap that must be at least as long as the longest prediction horizon,
 * so a training label cannot overlap a validation input window.
 */

export type SplitName = 'train' | 'validation' | 'test';

export interface SplitWindow {
  name: SplitName;
  /** Inclusive. */
  start: string;
  /** Exclusive. */
  end: string;
}

export interface SplitPlan {
  windows: readonly SplitWindow[];
  embargoMs: number;
  /** Longest label horizon in the dataset; the embargo must cover it. */
  maxHorizonMs: number;
}

const ORDER: readonly SplitName[] = ['train', 'validation', 'test'];

function ms(iso: string, field: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    throw new TemporalIntegrityError(`Invalid ${field}: ${JSON.stringify(iso)}.`);
  }
  return value;
}

export function createSplitPlan(plan: SplitPlan): SplitPlan {
  const violations: string[] = [];

  const names = plan.windows.map((w) => w.name);
  for (const required of ORDER) {
    if (!names.includes(required)) violations.push(`Missing "${required}" window.`);
  }
  if (new Set(names).size !== names.length) {
    violations.push('Each split may appear at most once.');
  }

  if (plan.embargoMs < plan.maxHorizonMs) {
    violations.push(
      `Embargo (${plan.embargoMs}ms) is shorter than the longest label horizon (${plan.maxHorizonMs}ms); a training label would overlap the next window's inputs.`,
    );
  }

  const ordered = ORDER.map((name) => plan.windows.find((w) => w.name === name)).filter(
    (w): w is SplitWindow => Boolean(w),
  );

  for (const window of ordered) {
    if (ms(window.end, `${window.name}.end`) <= ms(window.start, `${window.name}.start`)) {
      violations.push(`Window "${window.name}" ends at or before it starts.`);
    }
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const gap = ms(current.start, `${current.name}.start`) - ms(previous.end, `${previous.name}.end`);
    if (gap < 0) {
      violations.push(
        `Window "${current.name}" overlaps "${previous.name}" — splits must be strictly ordered in time.`,
      );
    } else if (gap < plan.embargoMs) {
      violations.push(
        `Gap between "${previous.name}" and "${current.name}" is ${gap}ms, shorter than the ${plan.embargoMs}ms embargo.`,
      );
    }
  }

  if (violations.length) {
    throw new TemporalIntegrityError('Invalid split plan.', violations);
  }

  return { ...plan, windows: ordered };
}

/**
 * Which split a record belongs to, keyed on availableAt rather than eventTime.
 * A record inside an embargo gap belongs to no split and is excluded — that gap
 * is the point, not an inconvenience.
 */
export function assignSplit(plan: SplitPlan, stamps: TemporalStamps): SplitName | null {
  const at = ms(stamps.availableAt, 'availableAt');
  for (const window of plan.windows) {
    if (at >= ms(window.start, 'start') && at < ms(window.end, 'end')) return window.name;
  }
  return null;
}

export function partition<T extends TemporalStamps>(
  plan: SplitPlan,
  records: readonly T[],
): Record<SplitName, T[]> & { embargoed: T[] } {
  const result = { train: [] as T[], validation: [] as T[], test: [] as T[], embargoed: [] as T[] };
  for (const record of records) {
    const split = assignSplit(plan, record);
    if (split) result[split].push(record);
    else result.embargoed.push(record);
  }
  return result;
}
