import { createHash } from 'node:crypto';

/**
 * Minimal unified diff.
 *
 * File edits are stored as structured patches rather than two complete copies
 * of a file. SHA-256 hashes make the before/after states independently
 * verifiable.
 */

export function sha256(content: string): string {
  return createHash('sha256')
    .update(content, 'utf8')
    .digest('hex');
}

interface DiffLine {
  text: string;

  /**
   * Whether this logical line ended with "\n" in the source content.
   *
   * Keeping this separately lets the diff distinguish:
   *
   *   "hello"
   *
   * from:
   *
   *   "hello\n"
   */
  terminated: boolean;
}

interface Op {
  type: 'equal' | 'delete' | 'insert';
  line: DiffLine;
}

/**
 * Split source text into logical lines without inventing a phantom line for an
 * empty file.
 */
function splitLines(content: string): DiffLine[] {
  if (content.length === 0) {
    return [];
  }

  const parts = content.split('\n');
  const endsWithNewline = content.endsWith('\n');

  /*
   * String.split() creates an empty final element when the source ends in "\n".
   * That element represents the terminator of the previous line, not another
   * logical line.
   */
  if (endsWithNewline) {
    parts.pop();
  }

  return parts.map((text, index) => ({
    text,
    terminated:
      index < parts.length - 1 ||
      endsWithNewline,
  }));
}

function linesEqual(
  left: DiffLine,
  right: DiffLine,
): boolean {
  return (
    left.text === right.text &&
    left.terminated === right.terminated
  );
}

/**
 * Longest common subsequence over lines.
 *
 * Inputs used by the editing tools are bounded by their read limits, so an LCS
 * table is reasonable for ordinary files. Large inputs fall back to a complete
 * delete/insert representation rather than allocating an excessive matrix.
 */
function diffLines(
  before: DiffLine[],
  after: DiffLine[],
): Op[] {
  const MAX_CELLS = 4_000_000;

  if (
    before.length * after.length >
    MAX_CELLS
  ) {
    return [
      ...before.map(
        (line): Op => ({
          type: 'delete',
          line,
        }),
      ),

      ...after.map(
        (line): Op => ({
          type: 'insert',
          line,
        }),
      ),
    ];
  }

  const rows = before.length;
  const cols = after.length;

  /*
   * Uint32Array dramatically reduces the memory overhead compared with nested
   * JavaScript number arrays while still providing more than enough range for
   * the bounded files handled here.
   */
  const table: Uint32Array[] =
    Array.from(
      { length: rows + 1 },
      () => new Uint32Array(cols + 1),
    );

  for (
    let i = rows - 1;
    i >= 0;
    i -= 1
  ) {
    for (
      let j = cols - 1;
      j >= 0;
      j -= 1
    ) {
      if (
        linesEqual(
          before[i],
          after[j],
        )
      ) {
        table[i][j] =
          table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(
          table[i + 1][j],
          table[i][j + 1],
        );
      }
    }
  }

  const ops: Op[] = [];

  let i = 0;
  let j = 0;

  while (
    i < rows &&
    j < cols
  ) {
    if (
      linesEqual(
        before[i],
        after[j],
      )
    ) {
      ops.push({
        type: 'equal',
        line: before[i],
      });

      i += 1;
      j += 1;
      continue;
    }

    if (
      table[i + 1][j] >=
      table[i][j + 1]
    ) {
      ops.push({
        type: 'delete',
        line: before[i],
      });

      i += 1;
    } else {
      ops.push({
        type: 'insert',
        line: after[j],
      });

      j += 1;
    }
  }

  while (i < rows) {
    ops.push({
      type: 'delete',
      line: before[i],
    });

    i += 1;
  }

  while (j < cols) {
    ops.push({
      type: 'insert',
      line: after[j],
    });

    j += 1;
  }

  return ops;
}

export interface UnifiedDiff {
  patch: string;

  linesAdded: number;
  linesRemoved: number;

  beforeHash: string;
  afterHash: string;
}

/**
 * Appends one unified-diff operation.
 *
 * Standard diff output uses:
 *
 *   " " unchanged
 *   "-" removed
 *   "+" added
 *
 * A missing final newline is represented explicitly so the patch preserves the
 * exact text state.
 */
function appendOperation(
  output: string[],
  op: Op,
): void {
  const prefix =
    op.type === 'equal'
      ? ' '
      : op.type === 'delete'
        ? '-'
        : '+';

  output.push(
    `${prefix}${op.line.text}`,
  );

  if (!op.line.terminated) {
    output.push(
      '\\ No newline at end of file',
    );
  }
}

/**
 * Standard unified diff with three lines of surrounding context by default.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): UnifiedDiff {
  /*
   * A newline in the path could corrupt the textual diff header. File tools
   * should normally have rejected such a path already, but this utility protects
   * its own output as well.
   */
  if (
    path.includes('\n') ||
    path.includes('\r')
  ) {
    throw new Error(
      'Diff path cannot contain newline characters.',
    );
  }

  const hunkContext =
    Number.isFinite(context)
      ? Math.max(
          0,
          Math.floor(context),
        )
      : 3;

  const beforeHash =
    sha256(before);

  const afterHash =
    sha256(after);

  const beforeLines =
    splitLines(before);

  const afterLines =
    splitLines(after);

  const ops =
    diffLines(
      beforeLines,
      afterLines,
    );

  const linesAdded =
    ops.filter(
      (op) =>
        op.type === 'insert',
    ).length;

  const linesRemoved =
    ops.filter(
      (op) =>
        op.type === 'delete',
    ).length;

  if (
    linesAdded === 0 &&
    linesRemoved === 0
  ) {
    return {
      patch: '',
      linesAdded: 0,
      linesRemoved: 0,
      beforeHash,
      afterHash,
    };
  }

  /*
   * Find all changed operation indexes.
   */
  const changedIndexes =
    ops.flatMap(
      (op, index) =>
        op.type === 'equal'
          ? []
          : [index],
    );

  /*
   * Expand each changed operation by the requested context and merge
   * overlapping ranges.
   */
  const hunks: Array<
    [number, number]
  > = [];

  for (
    const index of
    changedIndexes
  ) {
    const start =
      Math.max(
        0,
        index - hunkContext,
      );

    const end =
      Math.min(
        ops.length - 1,
        index + hunkContext,
      );

    const last =
      hunks[
        hunks.length - 1
      ];

    if (
      last &&
      start <= last[1] + 1
    ) {
      last[1] =
        Math.max(
          last[1],
          end,
        );
    } else {
      hunks.push([
        start,
        end,
      ]);
    }
  }

  const output: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
  ];

  for (
    const [start, end]
    of hunks
  ) {
    let beforeConsumed = 0;
    let afterConsumed = 0;

    for (
      let index = 0;
      index < start;
      index += 1
    ) {
      const op = ops[index];

      if (
        op.type !== 'insert'
      ) {
        beforeConsumed += 1;
      }

      if (
        op.type !== 'delete'
      ) {
        afterConsumed += 1;
      }
    }

    const slice =
      ops.slice(
        start,
        end + 1,
      );

    const beforeCount =
      slice.filter(
        (op) =>
          op.type !== 'insert',
      ).length;

    const afterCount =
      slice.filter(
        (op) =>
          op.type !== 'delete',
      ).length;

    /*
     * Unified-diff zero-length ranges use the line immediately preceding the
     * insertion/deletion location.
     *
     * Examples:
     *
     *   empty -> first line
     *     -0,0 +1,1
     *
     *   append after line 5
     *     -5,0 +6,1
     */
    const beforeStart =
      beforeCount === 0
        ? beforeConsumed
        : beforeConsumed + 1;

    const afterStart =
      afterCount === 0
        ? afterConsumed
        : afterConsumed + 1;

    output.push(
      `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
    );

    for (
      const op of slice
    ) {
      appendOperation(
        output,
        op,
      );
    }
  }

  return {
    patch: output.join('\n'),
    linesAdded,
    linesRemoved,
    beforeHash,
    afterHash,
  };
}