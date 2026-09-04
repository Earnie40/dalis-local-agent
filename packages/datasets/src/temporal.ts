/**
 * Temporal integrity — the defence against look-ahead bias.
 *
 * Every observation carries three timestamps, and they are not interchangeable:
 *
 *   eventTime    when the thing happened in the world
 *   availableAt  the earliest moment the information could legitimately be known
 *                (publication, block inclusion, disclosure filing)
 *   observedAt   when this platform actually recorded it
 *
 * A backtest or a training example reconstructing a decision at time T may read
 * only records whose availableAt <= T. Using eventTime for that filter is the
 * classic leak: an earnings figure is *about* Monday but is not knowable until
 * Thursday, and a model that trains on it as of Monday learns to see the future.
 */

export interface TemporalStamps {
  eventTime: string;
  availableAt: string;
  observedAt: string;
}

export interface TemporalRecord extends TemporalStamps {
  id: string;
}

export class TemporalIntegrityError extends Error {
  readonly violations: readonly string[];

  constructor(summary: string, violations: readonly string[] = []) {
    // Violations are folded into the message as well as kept structured: a
    // leak reported in a log as "Invalid split plan." is not actionable.
    super(violations.length ? `${summary} ${violations.join(' ')}` : summary);
    this.name = 'TemporalIntegrityError';
    this.violations = violations;
  }
}

function ms(iso: string, field: string, id?: string): number {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) {
    throw new TemporalIntegrityError(
      `Invalid ${field}${id ? ` on record ${id}` : ''}: ${JSON.stringify(iso)} is not an ISO timestamp.`,
    );
  }
  return value;
}

/**
 * Enforces eventTime <= availableAt <= observedAt.
 *
 * Information cannot be available before the event it describes, and this
 * platform cannot have observed it before it was available. A record that
 * violates either ordering is a data-pipeline bug, and admitting it would
 * silently corrupt every downstream split and backtest.
 */
export function assertTemporalOrder(stamps: TemporalStamps, id?: string): void {
  const event = ms(stamps.eventTime, 'eventTime', id);
  const available = ms(stamps.availableAt, 'availableAt', id);
  const observed = ms(stamps.observedAt, 'observedAt', id);

  const violations: string[] = [];
  if (available < event) {
    violations.push(
      `availableAt (${stamps.availableAt}) precedes eventTime (${stamps.eventTime}) — information cannot exist before its event.`,
    );
  }
  if (observed < available) {
    violations.push(
      `observedAt (${stamps.observedAt}) precedes availableAt (${stamps.availableAt}) — the platform cannot observe information before it is available.`,
    );
  }
  if (violations.length) {
    throw new TemporalIntegrityError(
      `Temporal ordering violated${id ? ` on record ${id}` : ''}.`,
      violations,
    );
  }
}

/** The subset of records knowable at `decisionTime`. */
export function visibleAt<T extends TemporalStamps>(
  records: readonly T[],
  decisionTime: string,
): T[] {
  const cutoff = ms(decisionTime, 'decisionTime');
  return records.filter((record) => ms(record.availableAt, 'availableAt') <= cutoff);
}

/**
 * Fail-closed check for the inputs of a simulated decision. Throws naming every
 * record that would not yet have been knowable, rather than filtering silently —
 * a leak in a backtest input set is a defect to fix, not a row to drop.
 */
export function assertNoLookAhead(
  records: readonly TemporalRecord[],
  decisionTime: string,
): void {
  const cutoff = ms(decisionTime, 'decisionTime');
  const leaked = records.filter((record) => ms(record.availableAt, 'availableAt', record.id) > cutoff);
  if (leaked.length) {
    throw new TemporalIntegrityError(
      `${leaked.length} record(s) would not have been available at ${decisionTime}.`,
      leaked.map(
        (record) => `${record.id}: availableAt ${record.availableAt} is after the decision time.`,
      ),
    );
  }
}

/**
 * Publication lag, in milliseconds. Worth monitoring per source: a lag that
 * suddenly drops to zero usually means a feed started stamping availableAt with
 * eventTime, which quietly removes the protection above.
 */
export function availabilityLagMs(stamps: TemporalStamps): number {
  return ms(stamps.availableAt, 'availableAt') - ms(stamps.eventTime, 'eventTime');
}
