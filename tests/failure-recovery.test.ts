import { describe, expect, it } from 'vitest';
import { classifyToolFailure } from '../apps/server/src/failure-recovery';

const base = {
  arguments: {},
  threadId: 't1',
  turn: 1,
};

describe('tool-failure classification — timeout recovery', () => {
  it('a timed-out expensive scan is not classified as a blind-retry candidate', () => {
    const classified = classifyToolFailure({
      ...base,
      tool: 'shell.run',
      output: 'nmap scan timed out after 120s',
      error: 'ETIMEDOUT',
    });

    expect(classified.category).toBe('timeout');
    // The corrective action must steer away from repeating the same expensive
    // call and toward reducing scope / choosing a more targeted approach.
    expect(classified.correctiveAction).toMatch(/do not blindly repeat/i);
    expect(classified.correctiveAction).toMatch(/reduce scope|more targeted/i);
  });

  it('a plain "timed out" message with no error field still classifies as timeout', () => {
    const classified = classifyToolFailure({
      ...base,
      tool: 'shell.run',
      output: 'operation timed out',
    });
    expect(classified.category).toBe('timeout');
  });
});

describe('tool-failure classification — WSL user-mapping (getpwuid) handling', () => {
  it('getpwuid(1000) failed is handled as a WSL user-mapping issue, not a retry', () => {
    const classified = classifyToolFailure({
      ...base,
      tool: 'wsl.run',
      output: 'getpwuid(1000) failed: No such file or directory\nQUITTING!',
      error: 'nmap-aborted',
    });

    expect(classified.category).toBe('wsl-user-mapping');
    // It must be recognized as a user-mapping fix, and must forbid an unchanged retry.
    expect(classified.correctiveAction).toMatch(/user id running the command has no \/etc\/passwd/i);
    expect(classified.correctiveAction).toMatch(/do not retry the same command unchanged/i);
    // It must point at repairing the mapping before re-running (e.g. a valid user / passwd entry).
    expect(classified.correctiveAction).toMatch(/passwd entry|wsl -u root|default user/i);
    expect(classified.correctiveAction).toMatch(/nmap/i);
  });

  it('the getpwuid branch wins over the path-not-found branch despite the "No such file" text', () => {
    // "No such file or directory" would otherwise be read as a missing path.
    const classified = classifyToolFailure({
      ...base,
      tool: 'wsl.run',
      output: 'getpwuid(1000) failed: No such file or directory',
    });
    expect(classified.category).toBe('wsl-user-mapping');
    expect(classified.category).not.toBe('path-not-found');
  });

  it('the "cannot find name for user ID" variant is also user-mapping', () => {
    const classified = classifyToolFailure({
      ...base,
      tool: 'wsl.run',
      output: 'id: cannot find name for user ID 1000',
    });
    expect(classified.category).toBe('wsl-user-mapping');
  });

  it('an ordinary missing path is still path-not-found, not user-mapping', () => {
    const classified = classifyToolFailure({
      ...base,
      tool: 'filesystem.read',
      output: 'ENOENT: no such file or directory, open "/tmp/does-not-exist"',
      error: 'ENOENT',
    });
    expect(classified.category).toBe('path-not-found');
  });
});
