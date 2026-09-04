import { z } from 'zod';
import { createId, getPool } from '@dacai-local-agent/shared';
import type { StructuredGenerator } from '@dacai-local-agent/providers';
import { INTELLIGENCE_ALIAS, INTELLIGENCE_FALLBACK_ALIAS } from './model-routing.js';
import { framingFor, type Capability } from './capabilities.js';
import type { ClaimRecord } from './evidence-agent.js';

/**
 * Mock investor diligence.
 *
 * The model plays a skeptical questioner and proposes an answer. Whether that
 * answer is STRONG is decided in code, against real evidence counts — a model
 * cannot grade its own answer STRONG, the same way a student cannot grade their
 * own exam. This is what makes the diligence backlog a genuine gap list rather
 * than a confidence exercise.
 */

export type DiligenceRole =
  | 'technical_partner'
  | 'investment_partner'
  | 'frontier_tech_partner'
  | 'skeptical_cto'
  | 'enterprise_buyer'
  | 'aerospace_technical_reviewer';

export const DILIGENCE_ROLES: readonly DiligenceRole[] = [
  'technical_partner', 'investment_partner', 'frontier_tech_partner',
  'skeptical_cto', 'enterprise_buyer', 'aerospace_technical_reviewer',
];

const ROLE_BRIEFS: Record<DiligenceRole, string> = {
  technical_partner:
    'A technical partner at a VC firm evaluating engineering substance. Probes for real complexity ' +
    'versus a thin wrapper, asks for specifics, is unimpressed by buzzwords.',
  investment_partner:
    'An investment partner assessing commercial viability, market size, and capital efficiency. ' +
    'Cares about traction and unit economics more than architecture.',
  frontier_tech_partner:
    'A frontier-tech investor who has seen many "physical AI" and "agentic" pitches. Distinguishes ' +
    'a genuine technical bet from a repackaged commodity model call.',
  skeptical_cto:
    'A CTO evaluating whether to actually deploy this. Asks about failure modes, on-call burden, ' +
    'and what happens when the model is wrong.',
  enterprise_buyer:
    'A buyer at a large organization. Cares about security, compliance, and what happens when the ' +
    'vendor is wrong or unavailable — not about the underlying architecture.',
  aerospace_technical_reviewer:
    'A technical reviewer from an aerospace or defense-adjacent organization. Applies the highest bar ' +
    'for anything claiming relevance to safety-critical or physical systems, and treats an unqualified ' +
    'capability claim in this space as disqualifying.',
};

const QuestionSchema = z.object({
  question: z.string().min(10).max(500),
  proposedAnswer: z.string().min(10).max(2_000),
  /** What the model believes it needs but was not given. Checked, not trusted. */
  claimedMissingEvidence: z.array(z.string().max(300)).max(10).default([]),
});

const SessionSchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(8),
});

const SESSION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          proposedAnswer: { type: 'string' },
          claimedMissingEvidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'proposedAnswer'],
      },
    },
  },
  required: ['questions'],
};

export type DiligenceScore = 'STRONG' | 'INCOMPLETE' | 'UNSUPPORTED' | 'DANGEROUS';

export interface GradedQuestion {
  id: string;
  question: string;
  answer: string;
  score: DiligenceScore;
  evidenceCount: number;
  betterAnswer?: string;
  missingEvidence?: string;
  requiredAction?: 'better_answer' | 'missing_evidence' | 'test_required' | 'metric_required' | 'documentation_required' | 'architectural_gap';
}

export interface DiligenceSession {
  id: string;
  role: DiligenceRole;
  questions: GradedQuestion[];
  strongCount: number;
  unsupportedCount: number;
  dangerousCount: number;
}

export class DiligenceAgent {
  constructor(private readonly generator: StructuredGenerator) {}

  async run(input: {
    role: DiligenceRole;
    focus: string;
    capabilities: readonly Capability[];
    claims: readonly ClaimRecord[];
    questionCount?: number;
    signal?: AbortSignal;
  }): Promise<DiligenceSession> {
    const result = await this.generator.generate({
      alias: INTELLIGENCE_ALIAS,
      fallbackAlias: INTELLIGENCE_FALLBACK_ALIAS,
      schema: SessionSchema,
      jsonSchema: SESSION_JSON_SCHEMA,
      system: buildSystemPrompt(input.role, input.questionCount ?? 5),
      user: buildUserPrompt(input.focus, input.capabilities, input.claims),
      workerRole: `intelligence:diligence:${input.role}`,
      temperature: 0.4,
      maxTokens: 2_000,
      signal: input.signal,
    });

    const graded = result.value.questions.map((entry) => grade(entry, input.claims));

    const sessionId = createId('dil');
    await getPool().query(
      `INSERT INTO mock_diligence_sessions
         (id, role, focus, model, provider_instance, question_count, strong_count, unsupported_count, dangerous_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sessionId, input.role, input.focus, result.model, result.providerInstanceId,
        graded.length,
        graded.filter((q) => q.score === 'STRONG').length,
        graded.filter((q) => q.score === 'UNSUPPORTED').length,
        graded.filter((q) => q.score === 'DANGEROUS').length,
      ],
    );

    for (const question of graded) {
      await getPool().query(
        `INSERT INTO mock_diligence_questions
           (id, session_id, question, answer, score, evidence_count, better_answer, missing_evidence, required_action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          question.id, sessionId, question.question, question.answer, question.score,
          question.evidenceCount, question.betterAnswer ?? null, question.missingEvidence ?? null,
          question.requiredAction ?? null,
        ],
      );
    }

    return {
      id: sessionId,
      role: input.role,
      questions: graded,
      strongCount: graded.filter((q) => q.score === 'STRONG').length,
      unsupportedCount: graded.filter((q) => q.score === 'UNSUPPORTED').length,
      dangerousCount: graded.filter((q) => q.score === 'DANGEROUS').length,
    };
  }

  /** The standing backlog: every non-STRONG question across every session. */
  async backlog(limit = 50): Promise<Array<GradedQuestion & { sessionRole: string }>> {
    const { rows } = await getPool().query(
      `SELECT q.*, s.role AS session_role FROM mock_diligence_questions q
         JOIN mock_diligence_sessions s ON s.id = q.session_id
        WHERE q.score <> 'STRONG'
        ORDER BY q.created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, 200))],
    );
    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      score: row.score,
      evidenceCount: row.evidence_count,
      betterAnswer: row.better_answer ?? undefined,
      missingEvidence: row.missing_evidence ?? undefined,
      requiredAction: row.required_action ?? undefined,
      sessionRole: row.session_role,
    }));
  }
}

/**
 * Grades one Q&A pair against real evidence.
 *
 * This is the enforcement point: no branch of this function can produce STRONG
 * without evidenceCount > 0, matching the database constraint exactly. A model
 * that writes a confident answer with nothing behind it is graded UNSUPPORTED
 * regardless of how the prose reads.
 */
function grade(
  entry: z.infer<typeof QuestionSchema>,
  claims: readonly ClaimRecord[],
): GradedQuestion {
  const answerTokens = new Set(
    entry.proposedAnswer.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 5),
  );

  const supportingClaims = claims.filter((claim) => {
    const claimTokens = claim.text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 5);
    return claim.supportingEvidenceCount > 0 && claimTokens.some((token) => answerTokens.has(token));
  });

  const evidenceCount = supportingClaims.reduce((total, claim) => total + claim.supportingEvidenceCount, 0);

  const containsFutureAsPresent = /\b(operates|runs in production|is deployed|handles production)\b/i.test(
    entry.proposedAnswer,
  ) && supportingClaims.some((claim) => claim.status !== 'PRODUCTION' && claim.status !== 'WORKING_PROTOTYPE');

  let score: DiligenceScore;
  let requiredAction: GradedQuestion['requiredAction'];
  let betterAnswer: string | undefined;

  if (containsFutureAsPresent) {
    score = 'DANGEROUS';
    requiredAction = 'better_answer';
    const overstated = supportingClaims.find((claim) => claim.status !== 'PRODUCTION' && claim.status !== 'WORKING_PROTOTYPE');
    betterAnswer = overstated
      ? `Reframe using intent language: ${framingFor(overstated.status as never).exampleVerb}...`
      : 'Reframe the capability using accurate present/intent tense.';
  } else if (evidenceCount === 0) {
    score = 'UNSUPPORTED';
    requiredAction = 'missing_evidence';
  } else if (evidenceCount === 1) {
    score = 'INCOMPLETE';
    requiredAction = 'test_required';
  } else {
    score = 'STRONG';
  }

  return {
    id: createId('dq'),
    question: entry.question,
    answer: entry.proposedAnswer,
    score,
    evidenceCount,
    betterAnswer,
    missingEvidence: entry.claimedMissingEvidence.join('; ') || undefined,
    requiredAction,
  };
}

function buildSystemPrompt(role: DiligenceRole, questionCount: number): string {
  return [
    `You are ${ROLE_BRIEFS[role]}`,
    '',
    `Ask ${questionCount} hard, specific questions someone in this role would actually ask, given the`,
    'capabilities and evidence you are shown. For each question, propose the best honest answer DACAIS',
    'could give USING ONLY what you were given below.',
    '',
    'Do not soften the questions to make them answerable. A diligence process that only asks easy',
    'questions is worthless, and this exercise exists to find the hard ones before a real investor does.',
    '',
    'If you cannot support an answer from what you were given, say so in claimedMissingEvidence rather',
    'than inventing a plausible-sounding answer.',
    '',
    'Return ONLY JSON: {"questions":[{"question":string,"proposedAnswer":string,',
    '"claimedMissingEvidence":string[]}]}',
  ].join('\n');
}

function buildUserPrompt(
  focus: string,
  capabilities: readonly Capability[],
  claims: readonly ClaimRecord[],
): string {
  const sections = [`FOCUS AREA: ${focus}`, '', 'CAPABILITIES AND THEIR REAL STATUS:'];
  for (const capability of capabilities) {
    sections.push(`  - ${capability.name} [${capability.status}]: ${capability.description}`);
  }
  sections.push('', 'CLAIMS ON RECORD, WITH EVIDENCE COUNT:');
  for (const claim of claims) {
    sections.push(`  - "${claim.text}" — ${claim.supportingEvidenceCount} evidence record(s), status ${claim.status}`);
  }
  return sections.join('\n');
}
