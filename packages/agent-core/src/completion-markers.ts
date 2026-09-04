/**
 * Terminal-state markers a model emits to end a run.
 *
 * The runtime, the durable coding graph, and every reviewer path must agree on
 * what counts as a declaration, otherwise a marker the loop accepts is later
 * treated as "no completion" (or the reverse) and the run re-enters execution
 * and repeats tool calls it already made. This module is the single parser.
 *
 * Local models format the marker loosely: `**TASK_COMPLETE**`, `TASK_COMPLETE.`,
 * `` `TASK_BLOCKED` ``, `## TASK_COMPLETE`, or `**TASK_COMPLETE:** result`.
 * All of those are declarations. An incidental mention inside prose is not:
 * "I will emit TASK_COMPLETE when done" or "TASK_COMPLETE is the signal" must
 * never end a run.
 *
 * A declaration therefore has to
 *   - start a line (optionally after a Markdown heading or emphasis run), and
 *   - be followed by nothing, by sentence punctuation, or by a separator
 *     (`:`, an em/en dash, or a spaced hyphen) that introduces the summary.
 */

export const COMPLETION_MARKERS = ['TASK_COMPLETE', 'TASK_BLOCKED', 'TASK_WAITING_FOR_USER'] as const;

export type CompletionMarker = (typeof COMPLETION_MARKERS)[number];

/** Markdown emphasis or code delimiters that may wrap the marker. */
const EMPHASIS = '[*_~`]{0,3}';
const GAP = '[ \\t]*';
/**
 * End of the current line, tolerant of CRLF content. Spelled with a lookahead
 * rather than `$` so the anchored (non-multiline) strip pattern still stops at
 * a line break instead of demanding the end of the whole text.
 */
const LINE_END = '[ \\t\\r]*(?=\\n|$)';
const AFTER = '(?=[ \\t\\r\\n]|$)';

function markerAlternatives(marker?: CompletionMarker): string {
  return marker ? marker : COMPLETION_MARKERS.join('|');
}

/**
 * Builds the declaration pattern. With `anchored` the pattern matches only a
 * declaration at the very start of the text (used to strip a leading marker);
 * otherwise it matches a declaration at the start of any line.
 */
function declarationPattern(marker: CompletionMarker | undefined, anchored: boolean): RegExp {
  const lead = anchored ? '^\\s*' : `^${GAP}`;
  const tail =
    '(?:' +
    // `TASK_COMPLETE: summary`, `**TASK_COMPLETE**: summary`, `**TASK_COMPLETE:** summary`,
    // `TASK_COMPLETE — summary`. Emphasis closing right after the separator is
    // part of the marker only when a gap follows it, so `: **bold**` is left alone.
    `${EMPHASIS}${GAP}(?::|—|–|-${AFTER})(?:${GAP}${EMPHASIS}${AFTER})?` +
    '|' +
    // `TASK_COMPLETE.` / `TASK_COMPLETE!` optionally closed by emphasis, then a gap
    `[.!]${GAP}${EMPHASIS}${AFTER}` +
    '|' +
    // bare marker, optionally closed by emphasis, ending the line
    `${EMPHASIS}${LINE_END}` +
    ')';
  // The marker must end as a token: `TASK_COMPLETED` and `TASK_COMPLETE_V2` are
  // other words. A following `_` is allowed only so `__TASK_COMPLETE__` can
  // close its emphasis; the tail then rejects `_V2`-style continuations.
  const source =
    `${lead}(?:#{1,6}[ \\t]+)?${EMPHASIS}${GAP}(${markerAlternatives(marker)})(?![A-Za-z0-9])${GAP}${tail}`;
  return new RegExp(source, anchored ? 'i' : 'im');
}

const LINE_PATTERNS: Record<CompletionMarker, RegExp> = {
  TASK_COMPLETE: declarationPattern('TASK_COMPLETE', false),
  TASK_BLOCKED: declarationPattern('TASK_BLOCKED', false),
  TASK_WAITING_FOR_USER: declarationPattern('TASK_WAITING_FOR_USER', false),
};

const LEADING_PATTERN = declarationPattern(undefined, true);

/** True when `content` declares the given marker on any line. */
export function hasCompletionMarker(content: string, marker: CompletionMarker): boolean {
  if (!content) return false;
  const pattern = LINE_PATTERNS[marker];
  pattern.lastIndex = 0;
  return pattern.test(content);
}

/**
 * The terminal state `content` declares, if any. When several markers appear
 * the most conservative wins: a request for the user outranks a blocker, and a
 * blocker outranks completion, matching the runtime's historical precedence.
 */
export function detectCompletionMarker(content: string): CompletionMarker | undefined {
  if (hasCompletionMarker(content, 'TASK_WAITING_FOR_USER')) return 'TASK_WAITING_FOR_USER';
  if (hasCompletionMarker(content, 'TASK_BLOCKED')) return 'TASK_BLOCKED';
  if (hasCompletionMarker(content, 'TASK_COMPLETE')) return 'TASK_COMPLETE';
  return undefined;
}

/** True when `content` declares either verified completion or a blocker. */
export function hasCompletionSignal(content: string): boolean {
  return hasCompletionMarker(content, 'TASK_COMPLETE') || hasCompletionMarker(content, 'TASK_BLOCKED');
}

/**
 * Removes a marker declaration that opens `content`, including any emphasis
 * and separator around it, leaving the human-readable summary.
 */
export function stripCompletionMarker(content: string): string {
  return content.replace(LEADING_PATTERN, '').trim();
}
