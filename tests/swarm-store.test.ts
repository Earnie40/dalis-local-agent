import { describe, expect, it } from 'vitest';
import { deriveSwarmStatus } from '../packages/orchestrator/src/swarm-store';

describe('AI swarm lifecycle', () => {
  it('derives member and coordinator phases without treating launch as completion', () => {
    expect(deriveSwarmStatus(['queued', 'queued'])).toBe('queued');
    expect(deriveSwarmStatus(['completed', 'running'])).toBe('running');
    expect(deriveSwarmStatus(['completed', 'failed'])).toBe('ready');
    expect(deriveSwarmStatus(['completed', 'failed'], 'queued')).toBe('synthesizing');
    expect(deriveSwarmStatus(['completed', 'failed'], 'completed')).toBe('completed');
  });

  it('reports failed synthesis and explicit cancellation honestly', () => {
    expect(deriveSwarmStatus(['completed', 'failed'], 'blocked')).toBe('partial');
    expect(deriveSwarmStatus(['failed', 'blocked'], 'failed')).toBe('failed');
    expect(deriveSwarmStatus(['completed', 'completed'], undefined, true)).toBe('cancelled');
  });
});
