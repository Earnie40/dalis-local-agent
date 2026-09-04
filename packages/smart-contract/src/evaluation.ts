import type { Finding, FindingCategory, Severity } from './analyzer.js';
import { analyzeSolidity } from './analyzer.js';

/**
 * Objective evaluation for the smart-contract domain.
 *
 * The suite is HELD OUT: its contracts are never ingested into the retrieval
 * corpus and never used as training data. Scoring a system on material it has
 * memorised measures recall of the corpus, not capability.
 *
 * A domain is not "implemented" because retrieval returns something. It is
 * measured here, and the numbers are reported as they come out.
 */

export interface ExpectedFinding {
  category: FindingCategory;
  /** The function the issue lives in, where the case is function-specific. */
  functionName?: string;
  /** Severity the analyzer should assign, for severity accuracy. */
  severity: Severity;
}

export interface EvalCase {
  id: string;
  name: string;
  /** What capability this case probes, for per-capability reporting. */
  capability: string;
  source: string;
  expected: ExpectedFinding[];
  /**
   * True for deliberately safe contracts. A finding here is a false positive,
   * which is how the suite measures whether the analyzer over-reports.
   */
  expectClean?: boolean;
}

export interface CaseScore {
  caseId: string;
  name: string;
  capability: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Of the matched findings, how many carried the expected severity. */
  severityCorrect: number;
  matched: { expected: ExpectedFinding; finding: Finding }[];
  missed: ExpectedFinding[];
  spurious: Finding[];
}

export interface SuiteScore {
  cases: CaseScore[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Share of matched findings whose severity was right. */
  severityAccuracy: number | null;
  /** Clean contracts that produced no finding, over all clean contracts. */
  cleanContractAccuracy: number | null;
  byCapability: { capability: string; recall: number | null; cases: number }[];
}

function matchesExpected(finding: Finding, expected: ExpectedFinding): boolean {
  if (finding.category !== expected.category) return false;
  if (expected.functionName && finding.functionName !== expected.functionName) return false;
  return true;
}

export function scoreCase(evalCase: EvalCase): CaseScore {
  const { findings } = analyzeSolidity(evalCase.source);

  const remaining = [...findings];
  const matched: CaseScore['matched'] = [];
  const missed: ExpectedFinding[] = [];

  for (const expected of evalCase.expected) {
    const index = remaining.findIndex((f) => matchesExpected(f, expected));
    if (index === -1) {
      missed.push(expected);
      continue;
    }
    matched.push({ expected, finding: remaining[index] });
    remaining.splice(index, 1);
  }

  return {
    caseId: evalCase.id,
    name: evalCase.name,
    capability: evalCase.capability,
    truePositives: matched.length,
    falsePositives: remaining.length,
    falseNegatives: missed.length,
    severityCorrect: matched.filter((m) => m.finding.severity === m.expected.severity).length,
    matched,
    missed,
    spurious: remaining,
  };
}

export function scoreSuite(cases: readonly EvalCase[]): SuiteScore {
  const scored = cases.map(scoreCase);

  const truePositives = scored.reduce((s, c) => s + c.truePositives, 0);
  const falsePositives = scored.reduce((s, c) => s + c.falsePositives, 0);
  const falseNegatives = scored.reduce((s, c) => s + c.falseNegatives, 0);
  const severityCorrect = scored.reduce((s, c) => s + c.severityCorrect, 0);

  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : null;
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;

  const cleanCases = cases.filter((c) => c.expectClean);
  const cleanScored = scored.filter((s) => cleanCases.some((c) => c.id === s.caseId));
  const cleanContractAccuracy = cleanScored.length
    ? cleanScored.filter((s) => s.falsePositives === 0).length / cleanScored.length
    : null;

  const capabilities = [...new Set(cases.map((c) => c.capability))];
  const byCapability = capabilities.map((capability) => {
    const subset = scored.filter((s) => s.capability === capability);
    const tp = subset.reduce((s, c) => s + c.truePositives, 0);
    const fn = subset.reduce((s, c) => s + c.falseNegatives, 0);
    return {
      capability,
      recall: tp + fn > 0 ? tp / (tp + fn) : null,
      cases: subset.length,
    };
  });

  return {
    cases: scored,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    severityAccuracy: truePositives > 0 ? severityCorrect / truePositives : null,
    cleanContractAccuracy,
    byCapability,
  };
}

export function formatSuiteScore(score: SuiteScore): string {
  const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const lines = [
    `TP=${score.truePositives}  FP=${score.falsePositives}  FN=${score.falseNegatives}`,
    `precision=${pct(score.precision)}  recall=${pct(score.recall)}  f1=${pct(score.f1)}`,
    `severity accuracy=${pct(score.severityAccuracy)}  clean-contract accuracy=${pct(score.cleanContractAccuracy)}`,
    '',
    'By capability:',
  ];
  for (const c of score.byCapability) {
    lines.push(`  ${c.capability.padEnd(34)} recall=${pct(c.recall)}  (${c.cases} case${c.cases === 1 ? '' : 's'})`);
  }
  const problems = score.cases.filter((c) => c.falseNegatives || c.falsePositives);
  if (problems.length) {
    lines.push('', 'Cases with errors:');
    for (const c of problems) {
      if (c.falseNegatives) lines.push(`  ${c.name}: MISSED ${c.missed.map((m) => m.category).join(', ')}`);
      if (c.falsePositives) lines.push(`  ${c.name}: SPURIOUS ${c.spurious.map((f) => `${f.category}/${f.functionName}`).join(', ')}`);
    }
  }
  return lines.join('\n');
}
