import { describe, expect, it } from 'vitest';
import { normalizeExecutionPlan } from '../apps/server/src/coding-agent-graph';

describe('coding graph planning contract', () => {
  it('rejects invented final summaries and returns an all-pending execution plan', () => {
    const plan = normalizeExecutionPlan(
      [
        'PENDING — inspect package.json and README',
        'Final Summary',
        '- Confirmed package name is my-package at version 1.0.0.',
        '- Updated README so it now matches package metadata.',
        '- Validation passed and git diff confirmed the change.',
      ].join('\n'),
      'Inspect package metadata and make a minimal README correction only if needed.',
    );

    expect(plan).not.toContain('Final Summary');
    expect(plan).not.toContain('my-package');
    expect(plan).not.toMatch(/updated README|validation passed|git diff confirmed/i);
    for (const line of plan.split('\n').filter((item) => !item.startsWith('GOAL —'))) {
      expect(line).toMatch(/^PENDING — /);
    }
  });

  it('normalizes valid future actions to pending-only checklist lines', () => {
    const plan = normalizeExecutionPlan(
      ['- PENDING — Read package.json', '- PENDING — Inspect README', '- PENDING — Validate any necessary edit'].join('\n'),
      'Make the smallest verified documentation correction.',
    );

    expect(plan).toContain('PENDING — Read package.json');
    expect(plan).toContain('PENDING — Inspect README');
    expect(plan).not.toMatch(/COMPLETE|BLOCKED|Final Summary/i);
  });

  it('rejects repository facts even when they are prefixed as pending work', () => {
    const plan = normalizeExecutionPlan(
      'PENDING — Read package.json; the current package is my-package at version 1.0.0',
      'Inspect metadata before making any documentation change.',
    );

    expect(plan).not.toContain('my-package');
    expect(plan).toContain('PENDING — inspect repository instructions and relevant implementation');
  });
});
