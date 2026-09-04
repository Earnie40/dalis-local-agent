import { describe, expect, it } from 'vitest';
import { computeNextRun, MIN_INTERVAL_SECONDS } from '../packages/orchestrator/src/task-schedule-store';

const at = (iso: string) => new Date(iso);

describe('schedule recurrence', () => {
  it('advances an interval schedule by exactly one period', () => {
    const next = computeNextRun(
      { kind: 'interval', intervalSeconds: 3600, nextRunAt: '2026-08-21T10:00:00.000Z' },
      at('2026-08-21T10:00:01.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-08-21T11:00:00.000Z');
  });

  it('advances a daily schedule by 24 hours, keeping its time of day', () => {
    const next = computeNextRun(
      { kind: 'daily', nextRunAt: '2026-08-21T02:00:00.000Z' },
      at('2026-08-21T02:00:05.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-08-22T02:00:00.000Z');
  });

  it('disables a one-shot schedule instead of rescheduling it', () => {
    expect(computeNextRun({ kind: 'once', nextRunAt: '2026-08-21T10:00:00.000Z' })).toBeUndefined();
  });

  it('skips missed runs rather than firing once per elapsed period', () => {
    // The server was down for three days. A daily schedule should resume its
    // cadence, not fire three times to "catch up".
    const next = computeNextRun(
      { kind: 'daily', nextRunAt: '2026-08-18T02:00:00.000Z' },
      at('2026-08-21T09:30:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-08-22T02:00:00.000Z');
  });

  it('always lands in the future, however long the outage was', () => {
    const now = at('2026-12-25T00:00:00.000Z');
    for (const intervalSeconds of [MIN_INTERVAL_SECONDS, 900, 3600, 21_600]) {
      const next = computeNextRun(
        { kind: 'interval', intervalSeconds, nextRunAt: '2026-01-01T00:00:00.000Z' },
        now,
      );
      expect(next!.getTime()).toBeGreaterThan(now.getTime());
      // And no further ahead than a single period, so cadence is preserved.
      expect(next!.getTime() - now.getTime()).toBeLessThanOrEqual(intervalSeconds * 1000);
    }
  });

  it('treats a schedule due exactly now as due, not overdue', () => {
    const next = computeNextRun(
      { kind: 'interval', intervalSeconds: 600, nextRunAt: '2026-08-21T10:00:00.000Z' },
      at('2026-08-21T10:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-08-21T10:10:00.000Z');
  });
});
