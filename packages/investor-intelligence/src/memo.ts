import { z } from 'zod';
import { createId, getPool } from '@dacai-local-agent/shared';
import type { StructuredGenerator } from '@dacai-local-agent/providers';
import { INTELLIGENCE_ALIAS, INTELLIGENCE_FALLBACK_ALIAS } from './model-routing.js';
import type { Capability } from './capabilities.js';
import type { ClaimRecord } from './evidence-agent.js';
import type { MetricRecord } from './metrics.js';
import { renderMetric } from './metrics.js';

/**
 * The investment memo generator.
 *
 * The system prompt's central instruction is the one in section 18 of the
 * design: the model must write as an independent investor evaluating DACAIS,
 * not as a DACAIS marketing writer. That framing is what produces a bear case
 * worth reading. There is no scoring pressure toward INVEST anywhere in this
 * module — the recommendation is exactly one of three enum values and nothing
 * rewards the model for choosing one over another.
 */

const MemoSchema = z.object({
  executiveSummary: z.string().min(20),
  investmentThesis: z.string().min(20),
  whyNow: z.string().min(10),
  product: z.string().min(10),
  technology: z.string().min(10),
  commercialWedge: z.string().min(10),
  longTermPlatform: z.string().min(10),
  market: z.string().min(10),
  businessModel: z.string().min(10),
  competition: z.string().min(10),
  defensibility: z.string().min(10),
  founderTeam: z.string().min(10),
  technicalRisks: z.string().min(10),
  commercialRisks: z.string().min(10),
  capitalRequirements: z.string().min(5),
  bullCase: z.string().min(10),
  bearCase: z.string().min(10),
  unresolvedQuestions: z.array(z.string().min(5)).min(1).max(15),
  recommendation: z.enum(['INVEST', 'CONTINUE_DILIGENCE', 'PASS']),
  recommendationRationale: z.string().min(20),
});

export type MemoContent = z.infer<typeof MemoSchema>;

const MEMO_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: Object.fromEntries(
    Object.keys(MemoSchema.shape).map((key) => [key, key === 'unresolvedQuestions'
      ? { type: 'array', items: { type: 'string' } }
      : key === 'recommendation' ? { type: 'string', enum: ['INVEST', 'CONTINUE_DILIGENCE', 'PASS'] }
      : { type: 'string' }]),
  ),
  required: Object.keys(MemoSchema.shape),
};

export interface MemoRecord {
  id: string;
  title: string;
  sections: MemoContent;
  recommendation: MemoContent['recommendation'];
  evidenceIds: string[];
  publicSourceUrls: string[];
  missingEvidence: string[];
  createdAt: string;
}

export class MemoGenerator {
  constructor(private readonly generator: StructuredGenerator) {}

  async generate(input: {
    subjectName: string;
    capabilities: readonly Capability[];
    claims: readonly ClaimRecord[];
    metrics: readonly MetricRecord[];
    publicSourceUrls: readonly string[];
    signal?: AbortSignal;
  }): Promise<MemoRecord> {
    const result = await this.generator.generate({
      alias: INTELLIGENCE_ALIAS,
      fallbackAlias: INTELLIGENCE_FALLBACK_ALIAS,
      schema: MemoSchema,
      jsonSchema: MEMO_JSON_SCHEMA,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(input),
      workerRole: 'intelligence:memo',
      temperature: 0.35,
      maxTokens: 4_000,
      signal: input.signal,
    });

    const evidenceIds = input.claims.flatMap((claim) =>
      claim.supportingEvidenceCount > 0 ? [claim.id] : [],
    );
    const missingEvidence = input.capabilities
      .filter((capability) => capability.evidenceCount === 0)
      .map((capability) => `${capability.name}: no evidence attached`);

    const id = createId('memo');
    await getPool().query(
      `INSERT INTO investment_memos
         (id, title, sections, recommendation, bull_case, bear_case, evidence_ids,
          public_source_urls, unresolved_questions, missing_evidence, model, provider_instance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        `${input.subjectName} — Investment Memo`,
        JSON.stringify(result.value),
        result.value.recommendation,
        result.value.bullCase,
        result.value.bearCase,
        JSON.stringify(evidenceIds),
        JSON.stringify(input.publicSourceUrls),
        JSON.stringify(result.value.unresolvedQuestions),
        JSON.stringify(missingEvidence),
        result.model,
        result.providerInstanceId,
      ],
    );

    return {
      id,
      title: `${input.subjectName} — Investment Memo`,
      sections: result.value,
      recommendation: result.value.recommendation,
      evidenceIds,
      publicSourceUrls: [...input.publicSourceUrls],
      missingEvidence,
      createdAt: new Date().toISOString(),
    };
  }

  async byId(id: string): Promise<MemoRecord | undefined> {
    const { rows } = await getPool().query('SELECT * FROM investment_memos WHERE id = $1', [id]);
    if (!rows[0]) return undefined;
    const row = rows[0];
    return {
      id: row.id,
      title: row.title,
      sections: row.sections,
      recommendation: row.recommendation,
      evidenceIds: row.evidence_ids ?? [],
      publicSourceUrls: row.public_source_urls ?? [],
      missingEvidence: row.missing_evidence ?? [],
      createdAt: (row.created_at as Date).toISOString(),
    };
  }
}

const SYSTEM_PROMPT = [
  'You are an independent venture investor writing an internal investment committee memo about DACAIS.',
  'You do NOT work for DACAIS. Write with the skepticism and rigor of someone whose fund loses money if',
  'this analysis is wrong. A memo that reads like marketing has failed at its purpose.',
  '',
  'Ground every substantive claim in the evidence and metrics you are given below. Where evidence is',
  'thin or absent, say so explicitly in that section AND list it in unresolvedQuestions — do not paper',
  'over a gap with confident prose.',
  '',
  'The bear case must be a real bear case: the strongest honest argument against investing, not a token',
  'paragraph. If you cannot construct one, that itself is worth stating.',
  '',
  'The recommendation must follow from the analysis, not the other way around. PASS and CONTINUE_DILIGENCE',
  'are complete, legitimate outputs — do not default to INVEST because it reads better.',
  '',
  'Never describe a capability as more mature than its stated status. A HORIZON or RESEARCH capability',
  'belongs in longTermPlatform or technicalRisks, never in product or technology as if it exists.',
].join('\n');

function buildUserPrompt(input: {
  subjectName: string;
  capabilities: readonly Capability[];
  claims: readonly ClaimRecord[];
  metrics: readonly MetricRecord[];
  publicSourceUrls: readonly string[];
}): string {
  const sections = [`SUBJECT: ${input.subjectName}`, '', 'DACAIS CAPABILITIES, WITH REAL STATUS:'];
  for (const capability of input.capabilities) {
    sections.push(
      `  - ${capability.name} [${capability.status}, evidence: ${capability.evidenceCount} record(s)]: ${capability.description}`,
    );
  }

  sections.push('', 'CLAIMS ON RECORD:');
  for (const claim of input.claims) {
    sections.push(`  - "${claim.text}" [${claim.status}] — ${claim.supportingEvidenceCount} supporting evidence record(s)`);
  }

  const measured = input.metrics.filter((metric) => metric.status === 'MEASURED');
  sections.push('', 'MEASURED METRICS:');
  if (measured.length) {
    for (const metric of measured) sections.push(`  - ${renderMetric(metric)}`);
  } else {
    sections.push('  (none measured)');
  }

  sections.push('', 'PUBLIC SOURCES (ecosystem context):');
  for (const url of input.publicSourceUrls.slice(0, 20)) sections.push(`  - ${url}`);

  return sections.join('\n');
}

/** Renders a memo section-by-section, matching the required document structure. */
export function renderMemo(memo: MemoRecord): string {
  const s = memo.sections;
  return [
    `# ${memo.title}`,
    '',
    '## Executive Summary', s.executiveSummary,
    '## Investment Thesis', s.investmentThesis,
    '## Why Now', s.whyNow,
    '## Product', s.product,
    '## Technology', s.technology,
    '## Commercial Wedge', s.commercialWedge,
    '## Long-Term Platform', s.longTermPlatform,
    '## Market', s.market,
    '## Business Model', s.businessModel,
    '## Competition', s.competition,
    '## Defensibility', s.defensibility,
    '## Founder / Team', s.founderTeam,
    '## Technical Risks', s.technicalRisks,
    '## Commercial Risks', s.commercialRisks,
    '## Capital Requirements', s.capitalRequirements,
    '## Evidence Supporting Claims', memo.evidenceIds.length ? memo.evidenceIds.join(', ') : '(none cited)',
    '## Evidence Missing', memo.missingEvidence.length ? memo.missingEvidence.join('\n') : '(none identified)',
    '## Questions Still Unresolved', s.unresolvedQuestions.map((q) => `- ${q}`).join('\n'),
    '## Bull Case', s.bullCase,
    '## Bear Case', s.bearCase,
    `## Recommendation: ${s.recommendation}`, s.recommendationRationale,
  ].join('\n\n');
}
