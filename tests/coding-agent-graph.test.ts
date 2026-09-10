import { describe, expect, it } from 'vitest';
import { fallbackPlan, isVerifiedTerminalState, normalizeExecutionPlan, toolObservationFromEvent } from '../apps/server/src/coding-agent-graph';

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

  it('a personal fallback plan does not begin with repository inspection', () => {
    const plan = fallbackPlan('research public facts about a person and a business', 'personal');
    expect(plan.split('\n')[0]).toMatch(/do not inspect this repository/i);
    expect(plan).not.toMatch(/inspect repository|validate mutations/);
  });

  it('an invalid planner draft for an operational goal falls back to the operational checklist', () => {
    const plan = normalizeExecutionPlan('Final Summary: the command was run and succeeded.', 'use WSL and run uname -a', 'operational');
    expect(plan.split('\n')[0]).toMatch(/^PENDING — run the requested operation/);
    expect(plan).not.toContain('inspect repository instructions');
  });
});

describe('reviewer evidence from observed tool results', () => {
  it('records a successful live-system result with its arguments and output', () => {
    const line = toolObservationFromEvent({
      type: 'tool_result',
      turn: 1,
      toolCall: { id: 'c1', name: 'wsl.run', arguments: { command: 'uname -a' } },
      result: { output: '{\n  "exitCode": 0,\n  "stdout": "Linux host 6.6.0 GNU/Linux"\n}', success: true },
    });
    expect(line).toBe('wsl.run {"command":"uname -a"} succeeded: { "exitCode": 0, "stdout": "Linux host 6.6.0 GNU/Linux" }');
  });

  it('distinguishes denied and failed results and truncates long output', () => {
    const denied = toolObservationFromEvent({
      type: 'tool_result', turn: 1,
      toolCall: { id: 'c1', name: 'wsl.run', arguments: { command: 'rm -rf /' } },
      result: { output: 'Denied: approval was not granted.', success: false, denied: true, error: 'approval-denied' },
    });
    expect(denied).toMatch(/^wsl\.run .* was denied: Denied: approval was not granted\.$/);

    const failed = toolObservationFromEvent({
      type: 'tool_result', turn: 1,
      toolCall: { id: 'c2', name: 'shell.run', arguments: { command: 'exit 1' } },
      result: { output: 'x'.repeat(5000), success: false, error: 'tool-error' },
    });
    expect(failed).toMatch(/ failed: x+ …\[truncated\]$/);
    expect(failed!.length).toBeLessThan(1300);
  });

  it('ignores events that are not tool results', () => {
    expect(toolObservationFromEvent({ type: 'model_response', turn: 1, content: 'TASK_COMPLETE' })).toBeUndefined();
    expect(toolObservationFromEvent({ type: 'tool_call', turn: 1, toolCall: { id: 'c1', name: 'wsl.run', arguments: {} } })).toBeUndefined();
  });
});

describe('verified terminal states stop execution immediately', () => {
  it('treats a blocker, a wait-for-user, and a cancellation as terminal', () => {
    expect(isVerifiedTerminalState('BLOCKED')).toBe(true);
    expect(isVerifiedTerminalState('WAITING_FOR_USER')).toBe(true);
    expect(isVerifiedTerminalState('CANCELLED')).toBe(true);
  });

  it('does not treat a completion or a recoverable stall as terminal', () => {
    // Completed runs go through the normal review path; stalls/budget exhaustion
    // may take one bounded corrective cycle, so neither is a hard stop here.
    expect(isVerifiedTerminalState('GOAL_COMPLETE')).toBe(false);
    expect(isVerifiedTerminalState('VERIFICATION_COMPLETE')).toBe(false);
    expect(isVerifiedTerminalState('IN_PROGRESS')).toBe(false);
    expect(isVerifiedTerminalState('HARD_BUDGET_EXHAUSTED')).toBe(false);
    expect(isVerifiedTerminalState('FAILED')).toBe(false);
  });
});
