import { describe, expect, it } from 'vitest';
import { fallbackPlan, normalizeExecutionPlan } from '../apps/server/src/coding-agent-graph';

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

describe('coding graph task profiles', () => {
  it('an operational fallback plan does not begin with repository inspection', () => {
    const plan = fallbackPlan('use WSL and run uname -a', 'operational');
    const [first] = plan.split('\n');
    expect(first).toMatch(/^PENDING — run the requested operation through the required live-system tool/);
    expect(plan).not.toMatch(/inspect repository|repository work|diagnostics\/tests/);
    expect(plan).toContain('GOAL — use WSL and run uname -a');
  });

  it('a repository fallback plan keeps the inspect → edit → validate workflow', () => {
    const plan = fallbackPlan('fix the parser bug');
    expect(plan.split('\n')[0]).toBe('PENDING — inspect repository instructions and relevant implementation');
    expect(plan).toContain('PENDING — validate mutations with diagnostics/tests');
  });

  it('an invalid planner draft for an operational goal falls back to the operational checklist', () => {
    const plan = normalizeExecutionPlan('Final Summary: the command was run and succeeded.', 'use WSL and run uname -a', 'operational');
    expect(plan.split('\n')[0]).toMatch(/^PENDING — run the requested operation/);
    expect(plan).not.toContain('inspect repository instructions');
  });
});
