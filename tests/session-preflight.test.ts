import { describe, expect, it } from 'vitest';
import { beginSessionActivity, touchSessionActivity } from '../apps/server/src/session-preflight';

describe('session RunPod preflight gate', () => {
  it('refreshes on first activity and again after two hours, not on every message', () => {
    const start = Date.parse('2026-09-03T12:00:00.000Z');
    expect(beginSessionActivity('test-session', start).refreshPreflight).toBe(true);
    expect(beginSessionActivity('test-session', start + 60_000).refreshPreflight).toBe(false);
    expect(beginSessionActivity('test-session', start + 2 * 60 * 60 * 1000).refreshPreflight).toBe(true);
  });

  it('tracks the last completed agent action without forcing a new preflight', () => {
    const start = Date.parse('2026-09-03T12:00:00.000Z');
    beginSessionActivity('completed-session', start);
    touchSessionActivity('completed-session', start + 30 * 60_000);
    expect(beginSessionActivity('completed-session', start + 31 * 60_000).refreshPreflight).toBe(false);
  });
});