import { analyzeSolidity, type Severity } from '../analyzer.js';
import type { HeldoutCase } from './heldout.js';
import type { StructuredReview } from './contract.js';
import { checkHonesty, type HonestyReport } from './honesty.js';

/**
 * Objective scoring for one mode/case run. Precision/recall/F1 are computed over
 * the non-ambiguous cases; ambiguous cases are reported separately so unproven
 * ground truth is never silently graded right or wrong.
 */

export interface ReviewResult {
  caseId: string;
  name: string;
  capability: string;
  ambiguous: boolean;
  expectClean: boolean;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  severityCorrect: number;
  matched: { expectedCategory: string; findingCategory: string; functionName?: string; severityCorrect: boolean }[];
  missed: string[];
  spurious: string[];
  honesty: HonestyReport;
  unsupportedClaimRate: number | null;
  parseFailed: boolean;
  parseError?: string;
  risk?: Severity;
}

export function scoreCaseReview(
  evalCase: HeldoutCase,
  review: StructuredReview,
  source: string,
  parseFailed = false,
  parseError?: string,
): ReviewResult {
  const remaining = [...review.findings];
  const matched: ReviewResult['matched'] = [];
  const missed: string[] = [];

  for (const exp of evalCase.expected) {
    const idx = remaining.findIndex(
      (f) => f.category === exp.category && (!exp.functionName || f.functionName === exp.functionName),
    );
    if (idx === -1) {
      missed.push(exp.category + (exp.functionName ? `/${exp.functionName}` : ''));
      continue;
    }
    const f = remaining[idx];
    matched.push({
      expectedCategory: exp.category,
      findingCategory: f.category,
      functionName: f.functionName,
      severityCorrect: f.severity === exp.severity,
    });
    remaining.splice(idx, 1);
  }

  const falsePositiveTail = remaining.filter(
    (f) => !(evalCase.ambiguous && (f.severity === 'medium' || f.severity === 'low')),
  );
  const spurious = falsePositiveTail.map((f) => f.category + (f.functionName ? `/${f.functionName}` : '') + `:${f.severity}`);

  const honesty = checkHonesty(source, review);
  const findingCount = review.findings.length;
  const unsupportedClaimRate = findingCount ? honesty.hallucinatedFindingCount / findingCount : 0;

  return {
    caseId: evalCase.id,
    name: evalCase.name,
    capability: evalCase.capability,
    ambiguous: evalCase.ambiguous ?? false,
    expectClean: evalCase.expectClean ?? false,
    truePositives: matched.length,
    falsePositives: spurious.length,
    falseNegatives: missed.length,
    severityCorrect: matched.filter((m) => m.severityCorrect).length,
    matched,
    missed,
    spurious,
    honesty,
    unsupportedClaimRate,
    parseFailed,
    parseError,
    risk: review.overallRisk,
  };
}
/** One claim, signed by who made it, used for disagreement analysis. */
export interface SignedSignal {
  category: string;
  functionName?: string;
  severity: Severity;
  status: string;
  basis: string;
}

export interface DisagreementRecord {
  caseId: string;
  category: string;
  detector: SignedSignal | null;
  model: SignedSignal | null;
  groundTruth: 'present' | 'absent' | 'ambiguous';
  winner: 'detector' | 'model' | 'neither' | 'tie';
  reason: string;
}

/**
 * Preserves detector-vs-model disagreement, never resolves it silently. Only
 * the objective evaluator decides a winner, and only against ground truth.
 */
export function analyzeDisagreements(evalCase: HeldoutCase, source: string, review: StructuredReview): DisagreementRecord[] {
  const analyzed = analyzeSolidity(source);
  const detectorCats = analyzed.findings.map((f) => ({
    category: f.category,
    functionName: f.functionName,
    severity: f.severity,
    status: f.status,
    basis: 'DETERMINISTIC_FINDING',
  } satisfies SignedSignal));
  const modelCats = review.findings.map((f) => ({
    category: f.category,
    functionName: f.functionName,
    severity: f.severity,
    status: f.status,
    basis: f.basis,
  } satisfies SignedSignal));

  const key = (s: SignedSignal) => s.category + (s.functionName ? `/${s.functionName}` : '');
  const allKeys = new Set<string>([...detectorCats.map(key), ...modelCats.map(key)]);
  const expectedKeys = new Set(evalCase.expected.map((e) => e.category + (e.functionName ? `/${e.functionName}` : '')));

  const records: DisagreementRecord[] = [];
  for (const k of allKeys) {
    const detector = detectorCats.find((s) => key(s) === k) ?? null;
    const model = modelCats.find((s) => key(s) === k) ?? null;
    const groundTruth: DisagreementRecord['groundTruth'] = evalCase.ambiguous
      ? 'ambiguous'
      : expectedKeys.has(k)
        ? 'present'
        : 'absent';
    const det = detector !== null;
    const mod = model !== null;
    const target = groundTruth === 'present';
    let winner: DisagreementRecord['winner'];
    if (groundTruth === 'ambiguous') winner = 'neither';
    else if (det === target && mod === target) winner = 'tie';
    else if (det === target) winner = 'detector';
    else if (mod === target) winner = 'model';
    else winner = 'neither';
    const reason =
      groundTruth === 'ambiguous'
        ? 'ground truth is ambiguous; disagreement preserved for future training data.'
        : `ground truth=${groundTruth} (${k}); detector=${det ? `${detector!.severity}/${detector!.status}` : 'none'}; model=${mod ? `${model!.severity}/${model!.status}/${model!.basis}` : 'no-finding'}.`;
    records.push({ caseId: evalCase.id, category: k, detector, model, groundTruth, winner, reason });
  }
  return records;
}

export interface ReviewMetrics {
  cases: number;
  scorable: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  severityAccuracy: number | null;
  safeContractAccuracy: number | null;
  unsupportedClaimRate: number | null;
  hallucinatedFindingCount: number;
  cleanClean: number;
  cleanTotal: number;
  totalFindingsMade: number;
}

export function aggregateResults(results: readonly ReviewResult[]): ReviewMetrics {
  const scorable = results.filter((r) => !r.ambiguous);
  const tp = sum(scorable, (r) => r.truePositives);
  const fp = sum(scorable, (r) => r.falsePositives);
  const fn = sum(scorable, (r) => r.falseNegatives);
  const severityCorrect = sum(scorable, (r) => r.severityCorrect);

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  const clean = scorable.filter((r) => r.expectClean);
  const cleanClean = clean.filter((r) => r.falsePositives === 0).length;

  const madeFindings = sum(scorable, (r) => r.matched.length + r.spurious.length);
  const hallucinated = sum(scorable, (r) => r.honesty.hallucinatedFindingCount);

  return {
    cases: results.length,
    scorable: scorable.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
    falsePositiveRate: tp + fp > 0 ? fp / (tp + fp) : null,
    falseNegativeRate: tp + fn > 0 ? fn / (tp + fn) : null,
    severityAccuracy: tp > 0 ? severityCorrect / tp : null,
    safeContractAccuracy: clean.length ? cleanClean / clean.length : null,
    unsupportedClaimRate: madeFindings > 0 ? hallucinated / madeFindings : null,
    hallucinatedFindingCount: hallucinated,
    cleanClean,
    cleanTotal: clean.length,
    totalFindingsMade: sum(results, (r) => r.matched.length + r.spurious.length),
  };
}

function sum(list: readonly ReviewResult[], pick: (r: ReviewResult) => number): number {
  return list.reduce((a, r) => a + pick(r), 0);
}

export function formatMetrics(mode: string, m: ReviewMetrics): string {
  const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  return [
    `=== ${mode} ===`,
    `scorable cases ${m.scorable} (${m.cases} total incl. ambiguous)`,
    `TP=${m.truePositives}  FP=${m.falsePositives}  FN=${m.falseNegatives}`,
    `precision=${pct(m.precision)}  recall=${pct(m.recall)}  F1=${pct(m.f1)}`,
    `FPR=${pct(m.falsePositiveRate)}  FNR=${pct(m.falseNegativeRate)}`,
    `severity accuracy=${pct(m.severityAccuracy)}`,
    `safe-contract accuracy=${pct(m.safeContractAccuracy)} (${m.cleanClean}/${m.cleanTotal} clean)`,
    `unsupported-claim rate=${pct(m.unsupportedClaimRate)} (${m.hallucinatedFindingCount} hallucinated claims)`,
    '',
  ].join('\n');
}