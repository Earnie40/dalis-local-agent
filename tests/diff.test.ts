import { describe, expect, it } from 'vitest';
import { sha256, unifiedDiff } from '../packages/tools/src/diff';

describe('unified diff', () => {
  it('produces a patch with hunk headers and change markers', () => {
    const before = 'line one\nline two\nline three\n';
    const after = 'line one\nline TWO\nline three\n';
    const diff = unifiedDiff('src/a.ts', before, after);

    expect(diff.patch).toContain('--- a/src/a.ts');
    expect(diff.patch).toContain('+++ b/src/a.ts');
    expect(diff.patch).toContain('@@');
    expect(diff.patch).toContain('-line two');
    expect(diff.patch).toContain('+line TWO');
    expect(diff.linesAdded).toBe(1);
    expect(diff.linesRemoved).toBe(1);
  });

  it('records hashes of both sides so a change is verifiable', () => {
    const diff = unifiedDiff('a.txt', 'old', 'new');
    expect(diff.beforeHash).toBe(sha256('old'));
    expect(diff.afterHash).toBe(sha256('new'));
    expect(diff.beforeHash).not.toBe(diff.afterHash);
  });

  it('returns an empty patch when nothing changed', () => {
    const diff = unifiedDiff('a.txt', 'same\n', 'same\n');
    expect(diff.patch).toBe('');
    expect(diff.linesAdded).toBe(0);
    expect(diff.linesRemoved).toBe(0);
    expect(diff.beforeHash).toBe(diff.afterHash);
  });

  it('treats a new file as pure insertion', () => {
    const diff = unifiedDiff('new.ts', '', 'a\nb\n');
    // The empty prior content and the new content's trailing newline share an
    // empty line, so nothing is reported as removed.
    expect(diff.linesRemoved).toBe(0);
    expect(diff.linesAdded).toBe(2);
    expect(diff.patch).toContain('+a');
  });

  it('keeps surrounding context rather than only changed lines', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line TEN');
    const diff = unifiedDiff('big.ts', before, after);

    expect(diff.patch).toContain(' line 8');
    expect(diff.patch).toContain(' line 12');
    // Far-away lines are omitted; a patch is not a copy of the file.
    expect(diff.patch).not.toContain('line 0\n');
  });

  it('emits separate hunks for distant changes', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 2', 'line TWO').replace('line 35', 'line THIRTYFIVE');
    const diff = unifiedDiff('big.ts', before, after);

    // Each header contains two '@@' markers, so count header lines instead.
    const hunkHeaders = diff.patch.split('\n').filter((line) => line.startsWith('@@'));
    expect(hunkHeaders).toHaveLength(2);
  });

  it('handles a whole-file rewrite without hanging', () => {
    const before = Array.from({ length: 300 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 300 }, (_, i) => `new ${i}`).join('\n');
    const diff = unifiedDiff('rewrite.ts', before, after);

    expect(diff.linesAdded).toBe(300);
    expect(diff.linesRemoved).toBe(300);
  });
});
