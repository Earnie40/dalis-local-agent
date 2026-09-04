/**
 * LLM-in-the-loop smart-contract evaluation harness.
 * source -> [deterministic analyzer] -> [smart-contract RAG] -> LLM -> structured review -> evaluator
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const argVal = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
};
const limit = Number(argVal('--limit', '1000')) || 1000;
const onlyMode = argVal('--mode', '');
const disableRag = process.argv.includes('--no-rag');

const {
  HELDOUT_CASES,
  buildReviewPrompt,
  extractStructuredReview,
  scoreCaseReview,
  aggregateResults,
  analyzeDisagreements,
  formatMetrics,
} = await import('../packages/smart-contract/src/index.ts');
const { analyzeSolidity } = await import('../packages/smart-contract/src/analyzer.ts');
const { RagService } = await import('../packages/rag/src/index.ts');
const { closePool } = await import('../packages/shared/src/db/pool.ts');

const OLLAMA_BASE = (process.env.OLLAMA_LOCAL_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = 'qwen3:8b';
const META = {
  modelAlias: 'coder',
  providerInstance: 'local_ollama',
  model: MODEL,
  temperature: 0.08,
  toolAvailability: 'none – advisory review path (no tools granted)',
  retrievalConfiguration: 'smart-contract domain RAG over curated corpus (detached from eval labels)',
  evaluationVersion: 'llm-in-loop-v1',
  runId: randomUUID(),
};
const rag = new RagService();

async function callModel(system, user) {
  const startedAt = Date.now();
  const res = await fetch(OLLAMA_BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.08, num_predict: 2200, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? 300_000)),
  });
  if (!res.ok) {
    throw new Error('Ollama HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
  const payload = await res.json();
  return {
    content: payload?.message?.content ?? '',
    latencyMs: Date.now() - startedAt,
    promptEval: payload?.prompt_eval_count,
    evalCount: payload?.eval_count,
  };
}

async function getRagContext(caseDef) {
  if (disableRag) return '(retrieval disabled by caller)';
  try {
    const context = await rag.contextFor(
      'solidity defensive review ' + caseDef.name + ' ' + caseDef.capability,
      { domainIds: ['smart-contract'] },
      4,
    );
    return context || '(no knowledge retrieved)';
  } catch (err) {
    return '(retrieval unavailable: ' + (err instanceof Error ? err.message : String(err)) + ')';
  }
}

async function runOne(caseDef, mode) {
  const source = readFileSync(join(process.cwd(), caseDef.file), 'utf8');
  const wantsAnalyzer = mode === 'analyzer-llm' || mode === 'analyzer-rag-llm';
  const wantsRag = mode === 'rag-llm' || mode === 'analyzer-rag-llm';
  const analysis = wantsAnalyzer ? analyzeSolidity(source) : undefined;
  const ragContext = wantsRag ? await getRagContext(caseDef) : undefined;
  const { system, user } = buildReviewPrompt(mode, source, { contractId: caseDef.id, analysis, ragContext });

  let raw = '';
  let latencyMs = 0;
  let promptEval;
  let evalCount;
  try {
    const r = await callModel(system, user);
    raw = r.content; latencyMs = r.latencyMs; promptEval = r.promptEval; evalCount = r.evalCount;
  } catch (err) {
    return { case: caseDef.id, mode, ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const parsed = extractStructuredReview(raw);
  if (!parsed.ok) return { case: caseDef.id, mode, ok: false, error: parsed.error, raw };

  return {
    case: caseDef.id,
    name: caseDef.name,
    mode,
    ok: true,
    review: parsed.review,
    score: scoreCaseReview(caseDef, parsed.review, source),
    disagreements: analyzeDisagreements(caseDef, source, parsed.review),
    latencyMs, promptEval, evalCount,
  };
}

function sha256(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function selectCandidates(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.ok || !r.score) continue;
    const c = r.score;
    const correctClean = c.expectClean && c.falsePositives === 0 && c.matched.length === 0;
    const trueDetect = c.truePositives > 0 && c.falsePositives === 0;
    const disagree = (r.disagreements ?? []).some((d) => d.winner === 'model');
    if (!correctClean && !trueDetect && !disagree) continue;
    const def = HELDOUT_CASES.find((x) => x.id === r.case);
    out.push({
      evaluationCaseId: r.case,
      sourceHash: def ? sha256(readFileSync(join(process.cwd(), def.file), 'utf8')) : null,
      model: MODEL, provider: { instance: 'local_ollama', alias: 'coder' },
      promptConfig: { mode: r.mode, temperature: 0.08, jsonFormat: true },
      retrievedEvidence: null,
      deterministicEvidence: null,
      modelResponse: r.review,
      groundTruth: def?.expected ?? [],
      score: { truePositives: c.truePositives, falsePositives: c.falsePositives, falseNegatives: c.falseNegatives, severityCorrect: c.severityCorrect, hallucinatedFindingCount: c.honesty.hallucinatedFindingCount },
      validationEvidence: [],
      status: 'AWAITING_HUMAN_APPROVAL',
      reason: correctClean ? 'model correctly reported no finding on a safe contract' : disagree ? 'model produced a defensible divergence from the deterministic analyzer' : 'model detected a held-out vulnerability with no false positive',
    });
  }
  return out;
}

async function remeasureResources() {
  const { evaluateResourceGate, formatResourceDecision } = await import('../packages/model-registry/src/index.ts');
  const { statfsSync } = await import('node:fs');
  let freeDiskBytes;
  try { const f = statfsSync(process.cwd()); freeDiskBytes = Number(f.bavail) * Number(f.bsize); } catch {}
  return formatResourceDecision(await evaluateResourceGate(undefined, { freeDiskBytes }));
}

const resourceReport = await remeasureResources();
console.log(resourceReport);
console.log('');

const modes = onlyMode ? [onlyMode] : ['llm-only', 'rag-llm', 'analyzer-llm', 'analyzer-rag-llm'];
const cases = HELDOUT_CASES.slice(0, limit);
const allRuns = [];
for (const caseDef of cases) {
  for (const mode of modes) {
    process.stdout.write('run ' + caseDef.id + '/' + mode + ' ... ');
    const result = await runOne(caseDef, mode);
    allRuns.push(result);
    process.stdout.write(result.ok ? 'ok\n' : 'FAIL\n');
  }
}

const summaries = {};
for (const mode of modes) {
  const ok = allRuns.filter((r) => r.mode === mode && r.ok);
  summaries[mode] = aggregateResults(ok.map((r) => r.score));
  console.log(formatMetrics(mode, summaries[mode]));
  for (const d of ok.flatMap((r) => r.disagreements ?? []).filter((x) => x.winner !== 'tie')) {
    console.log('  [disagree ' + d.caseId + ' ' + d.category + '] detector=' + (d.detector === null ? 'none' : d.detector.severity) + ' model=' + (d.model === null ? 'none' : d.model.severity) + ' ground=' + d.groundTruth + ' winner=' + d.winner);
  }
}

const candidates = selectCandidates(allRuns);
mkdirSync('evaluation/results', { recursive: true });
writeFileSync('evaluation/results/llm-in-loop-' + META.runId.slice(0, 8) + '.json', JSON.stringify({ model: META, resourceGate: resourceReport, cases: cases.map((c) => c.id), modes, metricsByMode: summaries, candidates }, null, 2));
writeFileSync('evaluation/results/candidates.json', JSON.stringify(candidates, null, 2));
console.log('');
console.log('Training candidates created: ' + candidates.length + ' (AWAITING_HUMAN_APPROVAL)');
console.log('report: evaluation/results/llm-in-loop-*.json');

await closePool();
process.exit(0);
