/**
 * Every balanced top-level JSON object in a block of model text.
 *
 * Models wrap payloads in prose, markdown fences, or one-element arrays even
 * when told not to. Scanning for balanced braces recovers the payload without
 * accepting whatever the model said around it.
 */
export function extractJsonCandidates(raw: string): unknown[] {
  const cleaned = raw.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          found.push(JSON.parse(cleaned.slice(start, index + 1)));
        } catch {
          // Braces balanced but the span is not JSON. Skip it rather than guess.
        }
        start = -1;
      }
    }
  }

  return found;
}

export class StructuredJsonParseError extends SyntaxError {
  constructor(
    readonly initialParseError: string,
    readonly recoveryError: string,
  ) {
    super(`Initial JSON parse error: ${initialParseError}. Recovery failed: ${recoveryError}`);
    this.name = 'StructuredJsonParseError';
  }
}

/**
 * Repair formatting only. A single complete object can be recovered from prose
 * or fences, and trailing commas can be removed outside strings. Multiple
 * objects, missing values, mismatched delimiters, and truncation require a new
 * model response: choosing an object or inventing content would change meaning.
 * Schema and semantic validation remain the caller's responsibility.
 */
export function parseStructuredJson(raw: string): { value: unknown; repairs: string[] } {
  let initialParseError: string;
  try {
    return { value: JSON.parse(raw), repairs: [] };
  } catch (error) {
    initialParseError = error instanceof Error ? error.message : String(error);
  }

  const repairs: string[] = [];
  const withoutBom = raw.replace(/^\uFEFF/, '');
  if (withoutBom !== raw) repairs.push('removed leading BOM');
  const cleaned = withoutBom.trim();

  try {
    // Preserve arrays and primitives as written; the caller's schema decides
    // whether those types are appropriate. Do not unwrap an array into an object.
    try {
      return { value: JSON.parse(cleaned), repairs };
    } catch {
      // Continue with bounded formatting repair.
    }

    const commaRepaired = removeTrailingCommas(cleaned);
    if (commaRepaired !== cleaned) {
      try {
        return { value: JSON.parse(commaRepaired), repairs: [...repairs, 'removed trailing commas'] };
      } catch {
        // A prose wrapper can still surround the complete JSON object.
      }
    }

    const span = findSingleObject(cleaned);
    let candidate = cleaned.slice(span.start, span.end);
    if (candidate !== cleaned) repairs.push('extracted single JSON object from surrounding text');
    const repairedCandidate = removeTrailingCommas(candidate);
    if (repairedCandidate !== candidate) repairs.push('removed trailing commas');
    candidate = repairedCandidate;

    // Reuse the provider's existing extractor only after checking uniqueness and
    // completeness. Its historical fence stripping would change string values
    // containing backticks, so those values are parsed directly instead.
    if (!candidate.includes('```')) {
      const candidates = extractJsonCandidates(candidate);
      if (candidates.length === 1) return { value: candidates[0], repairs };
    }
    return { value: JSON.parse(candidate), repairs };
  } catch (error) {
    throw new StructuredJsonParseError(
      initialParseError,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function removeTrailingCommas(raw: string): string {
  let inString = false;
  let escaped = false;
  let result = '';
  let previousToken = '';

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        inString = false;
        previousToken = '"';
      }
      continue;
    }
    if (character === '"') inString = true;
    if (character === ',') {
      let next = index + 1;
      while (next < raw.length && /\s/.test(raw[next]!)) next += 1;
      // Removing a comma after [, {, another comma, or a colon could hide a
      // missing value. Only remove one following a completed value token.
      if ((raw[next] === '}' || raw[next] === ']') &&
          previousToken && !'[{,:'.includes(previousToken)) continue;
    }
    result += character;
    if (!/\s/.test(character)) previousToken = character;
  }
  return result;
}

function findSingleObject(raw: string): { start: number; end: number } {
  const spans: Array<{ start: number; end: number }> = [];
  const delimiters: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      if (!delimiters.length) start = index;
      delimiters.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (delimiters.pop() !== expected) throw new SyntaxError('Mismatched JSON delimiters');
      if (!delimiters.length) spans.push({ start, end: index + 1 });
    }
  }
  if (inString || delimiters.length) throw new SyntaxError('Truncated or unterminated JSON content');
  if (spans.length > 1) throw new SyntaxError('Ambiguous output contains multiple JSON values');
  if (spans.length !== 1 || raw[spans[0]!.start] !== '{') {
    throw new SyntaxError('No single complete JSON object found');
  }
  return spans[0]!;
}
