import { STRUCTURED_REVIEW_SCHEMA, type StructuredReview } from './contract.js';

export type ParseOutcome =
  | { ok: true; review: StructuredReview }
  | { ok: false; error: string };

/**
 * Coerce model text into a StructuredReview, tolerating markdown fences and
 * stray leading/trailing prose. Anything that is not validatable JSON is
 * rejected — a malformed review is a measurement failure, not a pass.
 */
export function extractStructuredReview(raw: string): ParseOutcome {
  const candidates = extractBalancedObjects(raw);
  // Validate the LARGEST candidate object first; models often wrap the real
  // payload in a one-element array or an explanatory envelope.
  const byLength = candidates.sort((a, b) => stringify(a).length - stringify(b).length).reverse();
  for (const candidate of byLength) {
    const result = STRUCTURED_REVIEW_SCHEMA.safeParse(candidate);
    if (result.success) return { ok: true, review: result.data };
  }
  const detail = candidates.length
    ? 'None of the JSON objects matched the review schema.'
    : 'No JSON object could be located in the model response.';
  return { ok: false, error: detail };
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return ''; }
}

/** Returns all JSON objects balanced on braces, in order. */
function extractBalancedObjects(text: string): unknown[] {
  const cleaned = text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const slice = cleaned.slice(start, i + 1);
        try { found.push(JSON.parse(slice)); } catch { /* unbalanced or contains non-JSON */ }
        start = -1;
      }
    }
  }
  return found;
}