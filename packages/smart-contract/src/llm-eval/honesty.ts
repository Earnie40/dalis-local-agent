// Honesty / hallucination checks: does the model's review stay grounded in the
// actual source text?
import { parseSolidity } from '../parser.js';
import type { StructuredReview } from './contract.js';

export interface HonestyReport {
  /** Findings the model itself marked unsupported (basis honesty). */
  modelSelfReportedUnsupported: number;
  /** Functions the model cited that do not exist in the source. */
  inventedFunctions: string[];
  /** State variables the model cited that do not exist in the source. */
  inventedStateVariables: string[];
  /** Claimed source lines that fall outside the source's line count. */
  wrongLineCitations: number;
  /** Total distinct hallucinated claims across classes. */
  hallucinatedFindingCount: number;
  /** Findings that could not be substantiated at all (empty evidence/lines). */
  findingsWithUnsupportedSource: string[];
  concerns: string[];
}

const STATE_LIKE = /^(total|balances|shares|issued|last|earned|rewards|fee|amount|price|principal|collateral)\w*$/i;

/**
 * Heuristic honesty check: every cited function, state variable, and source
 * line must actually exist in the parsed contract. Exists to catch the common
 * failure modes (invented functions, invented state, wrong line citations).
 */
export function checkHonesty(source: string, review: StructuredReview): HonestyReport {
  const parsed = parseSolidity(source);
  const fnNames = new Set(parsed.functions.map((f) => f.name));
  const stateNames = new Set(parsed.stateVariables);
  const lineCount = source.split('\n').length;

  const inventedFunctions = new Set<string>();
  const inventedStateVariables = new Set<string>();
  let wrongLineCitations = 0;
  let modelSelfReportedUnsupported = 0;
  const unsubstantiated: string[] = [];

  for (const finding of review.findings) {
    if (finding.unsupported) modelSelfReportedUnsupported += 1;

    if (finding.functionName && !fnNames.has(finding.functionName)) {
      inventedFunctions.add(finding.functionName);
    }

    // State-variable heuristics from the evidence/rationale text.
    const words = (finding.evidence + ' ' + finding.rationale + ' ' + finding.remediation).match(/\b([A-Za-z_]\w*)\b/g) || [];
    for (const word of new Set(words.map((w) => w.replace(/^e?/, '')))) {
      if (STATE_LIKE.test(word) && stateNames.size > 0 && !stateNames.has(word)) {
        inventedStateVariables.add(word);
      }
    }

    const cited = finding.sourceLines ?? [];
    for (const line of cited) {
      if (line < 1 || line > lineCount) wrongLineCitations += 1;
    }

    if ((finding.status === 'confirmed' || finding.status === 'likely') && !cited.length) {
      unsubstantiated.push(finding.id);
    }
  }

  const concerns: string[] = [];
  if (inventedFunctions.size) concerns.push(`claims functions absent from source: ${[...inventedFunctions].join(', ')}`);
  if (inventedStateVariables.size) concerns.push(`cites state absent from source: ${[...inventedStateVariables].join(', ')}`);
  if (wrongLineCitations > 0) concerns.push(`${wrongLineCitations} source-line citation(s) out of range`);
  if (unsubstantiated.length) concerns.push(`confirmed/likely finding(s) without source-line evidence: ${unsubstantiated.join(', ')}`);

  return {
    modelSelfReportedUnsupported,
    inventedFunctions: [...inventedFunctions],
    inventedStateVariables: [...inventedStateVariables],
    wrongLineCitations,
    hallucinatedFindingCount: inventedFunctions.size + inventedStateVariables.size + wrongLineCitations,
    findingsWithUnsupportedSource: unsubstantiated,
    concerns,
  };
}