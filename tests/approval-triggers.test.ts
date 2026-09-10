import { describe, expect, it } from 'vitest';
import { derivePromptGrant } from '../apps/server/src/approval-triggers';

const AVAILABLE = [
  'filesystem.read',
  'filesystem.list',
  'filesystem.search',
  'filesystem.stat',
  'filesystem.edit',
  'filesystem.write',
  'git.run',
  'tests.run',
  'shell.run',
  'web.search',
  'web.fetch',
];

describe('approval triggers', () => {
  it('grants the tools the instruction actually asked for', () => {
    const grant = derivePromptGrant('Run the tests and commit the fix', AVAILABLE);

    expect(grant?.tools).toEqual(expect.arrayContaining(['tests.run', 'git.run', 'shell.run']));
    expect(grant?.reasons).toEqual(expect.arrayContaining(['tests', 'git-write']));
  });

  it('grants nothing when the prompt asks for nothing in particular', () => {
    expect(derivePromptGrant('What does the permission engine do?', AVAILABLE)).toBeUndefined();
    expect(derivePromptGrant('', AVAILABLE)).toBeUndefined();
    expect(derivePromptGrant('   ', AVAILABLE)).toBeUndefined();
  });

  it('never grants a tool the run does not have', () => {
    // Shell is not enabled for this workspace, so no instruction can add it.
    const grant = derivePromptGrant('Run the tests and commit', ['git.run']);

    expect(grant?.tools).toEqual(['git.run']);
    expect(grant?.tools).not.toContain('shell.run');
    expect(grant?.tools).not.toContain('tests.run');
  });

  it('treats a negated instruction as withheld, not given', () => {
    for (const prompt of [
      'Fix the bug but do not commit anything',
      "Update the file, don't run the tests",
      'Refactor this without committing',
    ]) {
      const grant = derivePromptGrant(prompt, AVAILABLE);
      const negated = /commit/i.test(prompt) ? 'git-write' : 'tests';
      expect(grant?.reasons ?? []).not.toContain(negated);
    }
  });

  it('does not let a negation elsewhere cancel a plain instruction', () => {
    // The "don't break anything" must not suppress the tests it asks for.
    const grant = derivePromptGrant("Don't break anything, but run the tests", AVAILABLE);

    expect(grant?.reasons).toContain('tests');
  });

  it('grants read tools for an inspection request', () => {
    const grant = derivePromptGrant('Find where the approval gate is implemented', AVAILABLE);

    expect(grant?.tools).toEqual(expect.arrayContaining(['filesystem.search', 'filesystem.read']));
  });

  it('returns a deduplicated tool list when several rules overlap', () => {
    const grant = derivePromptGrant('Search the repo, fix the bug, run the tests, and commit', AVAILABLE);

    expect(grant).toBeDefined();
    expect(new Set(grant!.tools).size).toBe(grant!.tools.length);
  });
});
