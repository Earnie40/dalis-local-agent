import { z } from 'zod';
import { createId, getPool } from '@dacai-local-agent/shared';
import type { StructuredGenerator } from '@dacai-local-agent/providers';
import { INTELLIGENCE_ALIAS, INTELLIGENCE_FALLBACK_ALIAS } from './model-routing.js';
import { framingFor, type Capability } from './capabilities.js';
import { RiskGuard, type RiskFinding } from './riskguard.js';
import type { AssetType, VisualKind } from './opportunity.js';
import type { MetricRecord } from './metrics.js';
import { renderMetric } from './metrics.js';
import type { EvidenceRecord } from './evidence-agent.js';
import type { SignalRow } from './signals.js';

/**
 * Draft generation.
 *
 * The model writes prose. It does not decide what is true: the capabilities it
 * is given already carry their real status, the evidence is already retrieved,
 * and the numbers it may cite are already measured. Its job is to say those
 * things well.
 *
 * After generation the deterministic risk guard runs. A draft that fails cannot
 * advance toward approval, regardless of how good it reads — which is the point,
 * because a fluent overclaim is more dangerous than a clumsy one.
 */

const DraftSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  body: z.string().min(40),
  /** Statements the draft asserts about DACAIS, for evidence checking. */
  claimsMade: z.array(z.string().min(4).max(500)).max(20).default([]),
  /** Anything the model could not support from what it was given. */
  unsupportedStatements: z.array(z.string().max(500)).max(20).default([]),
  suggestedVisualCaption: z.string().max(300).optional(),
});

export type Draft = z.infer<typeof DraftSchema>;

const DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
    claimsMade: { type: 'array', items: { type: 'string' } },
    unsupportedStatements: { type: 'array', items: { type: 'string' } },
    suggestedVisualCaption: { type: 'string' },
  },
  required: ['body', 'claimsMade'],
};

export interface DraftRequest {
  assetType: AssetType;
  audience: string;
  tone: string;
  opportunityHeadline: string;
  whyItMatters: string;
  capabilities: readonly Capability[];
  evidence: readonly EvidenceRecord[];
  signals: readonly SignalRow[];
  metrics: readonly MetricRecord[];
  visualKind?: VisualKind;
  visualSpec?: string;
  /** Claim texts the operator excluded. Passed as explicit prohibitions. */
  excludedClaims?: readonly string[];
  signal?: AbortSignal;
}

export interface GeneratedDraft {
  draft: Draft;
  findings: RiskFinding[];
  blocked: boolean;
  model: string;
  providerInstanceId: string;
  fellBackFrom?: string;
}

export class NarrativeAgent {
  constructor(
    private readonly generator: StructuredGenerator,
    private readonly guard = new RiskGuard(),
  ) {}

  async draft(request: DraftRequest): Promise<GeneratedDraft> {
    const result = await this.generator.generate({
      alias: INTELLIGENCE_ALIAS,
      fallbackAlias: INTELLIGENCE_FALLBACK_ALIAS,
      schema: DraftSchema,
      jsonSchema: DRAFT_JSON_SCHEMA,
      system: buildSystemPrompt(request),
      user: buildUserPrompt(request),
      workerRole: `intelligence:draft:${request.assetType}`,
      temperature: 0.3,
      maxTokens: 2_400,
      signal: request.signal,
    });

    // The guard runs on what was actually produced, never on what was asked
    // for. A prompt instructing the model not to overclaim is guidance; this is
    // enforcement.
    const report = this.guard.check({
      body: result.value.body,
      title: result.value.title,
      capabilities: request.capabilities,
      claims: result.value.claimsMade.map((text) => ({
        text,
        supportingEvidenceCount: countEvidenceFor(text, request.evidence),
      })),
      measuredMetrics: request.metrics
        .filter((metric) => metric.status === 'MEASURED')
        .map((metric) => ({
          label: metric.label,
          value: metric.valueText ?? String(metric.value ?? ''),
        })),
    });

    return {
      draft: result.value,
      findings: report.findings,
      blocked: report.blocked,
      model: result.model,
      providerInstanceId: result.providerInstanceId,
      fellBackFrom: result.fellBackFrom,
    };
  }
}

/**
 * Loose evidence attribution.
 *
 * Matches a claim to evidence by shared distinctive tokens. Deliberately
 * generous — its purpose is to catch a claim with *nothing* behind it, not to
 * grade how well-supported a well-supported claim is. A stricter matcher would
 * produce false alarms that train the operator to click through the guard.
 */
function countEvidenceFor(claim: string, evidence: readonly EvidenceRecord[]): number {
  const tokens = new Set(
    claim.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 5),
  );
  if (!tokens.size) return evidence.length;

  return evidence.filter((record) => {
    const haystack = [
      record.filePath ?? '',
      record.symbolName ?? '',
      record.testName ?? '',
      record.excerpt ?? '',
    ].join(' ').toLowerCase();
    return [...tokens].some((token) => haystack.includes(token));
  }).length;
}

function buildSystemPrompt(request: DraftRequest): string {
  const statusRules = request.capabilities.map((capability) => {
    const framing = framingFor(capability.status);
    return `  - "${capability.name}" is ${capability.status}. ${framing.guidance}`;
  });

  return [
    'You write technical content for DACAIS, an engineering company.',
    '',
    'You are writing for engineers and technical investors. They will check what you say against the',
    'repository, so accuracy is not a constraint on the writing — it is the writing.',
    '',
    'ABSOLUTE RULES:',
    '  1. Never describe a capability as existing unless you are told it is PRODUCTION or WORKING_PROTOTYPE.',
    '  2. Never state a number that is not in the MEASURED METRICS section. Not an estimate, not a',
    '     round figure, not "thousands of". If you want a number that is not provided, omit it.',
    '  3. Never claim a market position ("the first", "the only", "industry-leading"). You have no',
    '     evidence for those and a technical reader will discount everything else you wrote.',
    '  4. Every claim you make about DACAIS must trace to the evidence you were given.',
    '  5. Saying what does not exist yet makes the rest more credible, not less. Use that.',
    '',
    'CAPABILITY STATUS — how each may be described:',
    ...statusRules,
    '',
    ...(request.excludedClaims?.length
      ? ['EXCLUDED — the operator has removed these claims. Do not restate them in any form:',
         ...request.excludedClaims.map((claim) => `  - ${claim}`), '']
      : []),
    'List in claimsMade every factual statement you make about DACAIS.',
    'List in unsupportedStatements anything you wanted to say but could not support from what you were given.',
    'An honest unsupportedStatements list is valued; an empty one that hides a guess is not.',
    '',
    'Return ONLY a JSON object: {"title":string,"body":string,"claimsMade":string[],',
    '"unsupportedStatements":string[],"suggestedVisualCaption":string}',
  ].join('\n');
}

function buildUserPrompt(request: DraftRequest): string {
  const sections: string[] = [];

  sections.push(`ASSET TYPE: ${request.assetType.replace(/_/g, ' ')}`);
  sections.push(`AUDIENCE: ${request.audience}`);
  sections.push(`TONE: ${request.tone}`);
  sections.push('');
  sections.push(`TOPIC: ${request.opportunityHeadline}`);
  sections.push(`WHY IT MATTERS NOW: ${request.whyItMatters}`);
  sections.push('');

  sections.push('PUBLIC SIGNALS THAT PROMPTED THIS (context only — do not quote at length):');
  for (const signal of request.signals.slice(0, 5)) {
    sections.push(
      `  - [${signal.publishedAt?.slice(0, 10) ?? 'undated'}] ${signal.title ?? signal.sourceUrl}`,
    );
    sections.push(`    ${signal.summary ?? signal.excerpt.slice(0, 240)}`);
  }
  sections.push('');

  sections.push('DACAIS CAPABILITIES YOU MAY REFERENCE:');
  for (const capability of request.capabilities) {
    sections.push(`  - ${capability.name} [${capability.status}]: ${capability.description}`);
  }
  sections.push('');

  sections.push('EVIDENCE (this is what backs your claims — cite the substance, not the paths):');
  for (const record of request.evidence.slice(0, 12)) {
    const location = record.filePath
      ? `${record.filePath}${record.startLine ? `:${record.startLine}` : ''}`
      : record.locator ?? '(no location)';
    sections.push(`  - [${record.kind}] ${record.symbolName ?? record.testName ?? location}`);
    if (record.excerpt) sections.push(`    ${record.excerpt.slice(0, 300).replace(/\n/g, ' ')}`);
  }
  sections.push('');

  const measured = request.metrics.filter((metric) => metric.status === 'MEASURED');
  sections.push('MEASURED METRICS — the ONLY numbers you may state:');
  if (measured.length) {
    for (const metric of measured) sections.push(`  - ${renderMetric(metric)}`);
  } else {
    sections.push('  (none measured — do not state any number in this draft)');
  }

  const unmeasured = request.metrics.filter((metric) => metric.status !== 'MEASURED');
  if (unmeasured.length) {
    sections.push('');
    sections.push('NOT MEASURED — do not cite these, and do not estimate them:');
    for (const metric of unmeasured) sections.push(`  - ${metric.label}`);
  }

  if (request.visualSpec) {
    sections.push('');
    sections.push(`A ${request.visualKind?.replace(/_/g, ' ') ?? 'visual'} will accompany this. Write so it complements the text.`);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Content assets and the approval state machine
// ---------------------------------------------------------------------------

export type ContentState =
  | 'IDEA'
  | 'DRAFT'
  | 'EVIDENCE_CHECK'
  | 'RISK_REVIEW'
  | 'READY_FOR_REVIEW'
  | 'HUMAN_APPROVED'
  | 'REJECTED'
  | 'EXPORTED'
  | 'PUBLISHED'
  | 'MEASURED';

/**
 * Permitted transitions.
 *
 * Nothing reaches HUMAN_APPROVED except from READY_FOR_REVIEW, and nothing
 * reaches READY_FOR_REVIEW without passing through the risk review. The path
 * cannot be short-circuited, and the database enforces the human-approver
 * requirement independently.
 */
const TRANSITIONS: Record<ContentState, readonly ContentState[]> = {
  IDEA: ['DRAFT'],
  DRAFT: ['EVIDENCE_CHECK', 'REJECTED'],
  EVIDENCE_CHECK: ['RISK_REVIEW', 'DRAFT', 'REJECTED'],
  RISK_REVIEW: ['READY_FOR_REVIEW', 'DRAFT', 'REJECTED'],
  READY_FOR_REVIEW: ['HUMAN_APPROVED', 'DRAFT', 'REJECTED'],
  HUMAN_APPROVED: ['EXPORTED', 'PUBLISHED', 'DRAFT'],
  REJECTED: ['DRAFT'],
  EXPORTED: ['PUBLISHED', 'MEASURED'],
  PUBLISHED: ['MEASURED'],
  MEASURED: [],
};

export type ContentAction =
  | 'created' | 'generated' | 'evidence_checked' | 'risk_reviewed' | 'submitted'
  | 'approved' | 'rejected' | 'edited' | 'rewrite_requested' | 'audience_changed'
  | 'tone_changed' | 'channel_changed' | 'claim_excluded' | 'exported' | 'published' | 'measured';

export class ContentWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentWorkflowError';
  }
}

export interface ContentAsset {
  id: string;
  opportunityId?: string;
  channelId?: string;
  assetType: AssetType;
  title?: string;
  body: string;
  audience?: string;
  tone?: string;
  visualKind?: VisualKind;
  visualSpec?: string;
  state: ContentState;
  riskFindings: RiskFinding[];
  unsupportedStatements: string[];
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  generatedByModel?: string;
  generatedByInstance?: string;
  createdAt: string;
  updatedAt: string;
}

export class ContentStore {
  async create(input: {
    opportunityId?: string;
    channelId?: string;
    assetType: AssetType;
    title?: string;
    body: string;
    audience?: string;
    tone?: string;
    visualKind?: VisualKind;
    visualSpec?: string;
    riskFindings?: readonly RiskFinding[];
    unsupportedStatements?: readonly string[];
    generatedByModel?: string;
    generatedByInstance?: string;
    claims?: ReadonlyArray<{ text: string; claimId?: string; signalId?: string; evidenceId?: string }>;
    actor: string;
  }): Promise<ContentAsset> {
    const id = createId('cnt');
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO content_assets
           (id, opportunity_id, channel_id, asset_type, title, body, audience, tone,
            visual_kind, visual_spec, state, risk_findings, unsupported_statements,
            generated_by_model, generated_by_instance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11,$12,$13,$14)`,
        [
          id, input.opportunityId ?? null, input.channelId ?? null, input.assetType,
          input.title ?? null, input.body, input.audience ?? null, input.tone ?? null,
          input.visualKind ?? null, input.visualSpec ?? null,
          JSON.stringify(input.riskFindings ?? []),
          JSON.stringify(input.unsupportedStatements ?? []),
          input.generatedByModel ?? null, input.generatedByInstance ?? null,
        ],
      );

      for (const claim of input.claims ?? []) {
        // The table requires at least one reference; a claim with none is
        // provenance-free and is skipped rather than silently stored.
        if (!claim.claimId && !claim.signalId && !claim.evidenceId) continue;
        await client.query(
          `INSERT INTO content_claims (id, content_asset_id, claim_id, signal_id, evidence_id, claim_text)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [createId('cc'), id, claim.claimId ?? null, claim.signalId ?? null, claim.evidenceId ?? null, claim.text],
        );
      }

      await client.query(
        `INSERT INTO content_asset_audit (id, content_asset_id, from_state, to_state, action, actor, detail)
         VALUES ($1,$2,NULL,'DRAFT','generated',$3,$4)`,
        [
          createId('aud'), id, input.actor,
          input.generatedByModel ? `model=${input.generatedByModel} instance=${input.generatedByInstance ?? '?'}` : null,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return (await this.byId(id))!;
  }

  /**
   * Moves an asset through the workflow.
   *
   * Approval requires a named human. `actor` is recorded on the audit row for
   * every transition, so "who approved this" always has an answer.
   */
  async transition(input: {
    assetId: string;
    to: ContentState;
    action: ContentAction;
    actor: string;
    detail?: string;
    rejectedReason?: string;
  }): Promise<ContentAsset> {
    const actor = input.actor?.trim();
    if (!actor) throw new ContentWorkflowError('A named actor is required for every state transition.');

    const asset = await this.byId(input.assetId);
    if (!asset) throw new ContentWorkflowError(`Unknown content asset "${input.assetId}".`);

    const allowed = TRANSITIONS[asset.state] ?? [];
    if (!allowed.includes(input.to)) {
      throw new ContentWorkflowError(
        `Cannot move a content asset from ${asset.state} to ${input.to}. ` +
          `Permitted from ${asset.state}: ${allowed.join(', ') || '(terminal)'}.`,
      );
    }

    // A blocking risk finding stops the piece here. This is the check that
    // makes the risk guard consequential rather than advisory.
    if (input.to === 'READY_FOR_REVIEW' || input.to === 'HUMAN_APPROVED') {
      const blocking = asset.riskFindings.filter((finding) => finding.severity === 'blocking');
      if (blocking.length) {
        throw new ContentWorkflowError(
          `Refusing to advance "${asset.id}" to ${input.to}: ${blocking.length} blocking risk finding(s) remain. ` +
            `First: ${blocking[0].message}`,
        );
      }
    }

    if (input.to === 'REJECTED' && !input.rejectedReason?.trim()) {
      throw new ContentWorkflowError('Rejecting content requires a reason.');
    }

    const approving = input.to === 'HUMAN_APPROVED';
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE content_assets
            SET state = $2,
                approved_by = CASE WHEN $3 THEN $4 ELSE approved_by END,
                approved_at = CASE WHEN $3 THEN now() ELSE approved_at END,
                rejected_reason = COALESCE($5, rejected_reason),
                exported_at = CASE WHEN $2 = 'EXPORTED' THEN now() ELSE exported_at END,
                published_at = CASE WHEN $2 = 'PUBLISHED' THEN now() ELSE published_at END,
                updated_at = now()
          WHERE id = $1`,
        [input.assetId, input.to, approving, actor, input.rejectedReason ?? null],
      );
      await client.query(
        `INSERT INTO content_asset_audit (id, content_asset_id, from_state, to_state, action, actor, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [createId('aud'), input.assetId, asset.state, input.to, input.action, actor, input.detail ?? null],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return (await this.byId(input.assetId))!;
  }

  /** Operator edit. Returns the asset to DRAFT so checks re-run on new text. */
  async edit(input: {
    assetId: string;
    actor: string;
    body?: string;
    title?: string;
    audience?: string;
    tone?: string;
    channelId?: string;
  }): Promise<ContentAsset> {
    const actor = input.actor?.trim();
    if (!actor) throw new ContentWorkflowError('A named actor is required to edit content.');

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE content_assets
            SET body = COALESCE($2, body),
                title = COALESCE($3, title),
                audience = COALESCE($4, audience),
                tone = COALESCE($5, tone),
                channel_id = COALESCE($6, channel_id),
                -- Edited text has not been checked. Returning to DRAFT forces
                -- the evidence and risk passes to run again on what changed.
                state = 'DRAFT',
                risk_findings = '[]'::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [input.assetId, input.body ?? null, input.title ?? null, input.audience ?? null,
         input.tone ?? null, input.channelId ?? null],
      );
      await client.query(
        `INSERT INTO content_asset_audit (id, content_asset_id, from_state, to_state, action, actor, detail)
         VALUES ($1,$2,NULL,'DRAFT','edited',$3,$4)`,
        [createId('aud'), input.assetId, actor, describeEdit(input)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return (await this.byId(input.assetId))!;
  }

  async excludeClaim(assetId: string, claimText: string, actor: string): Promise<void> {
    if (!actor?.trim()) throw new ContentWorkflowError('A named actor is required to exclude a claim.');
    await getPool().query(
      'UPDATE content_claims SET excluded = true WHERE content_asset_id = $1 AND claim_text = $2',
      [assetId, claimText],
    );
    await getPool().query(
      `INSERT INTO content_asset_audit (id, content_asset_id, from_state, to_state, action, actor, detail)
       VALUES ($1,$2,NULL,'DRAFT','claim_excluded',$3,$4)`,
      [createId('aud'), assetId, actor, claimText.slice(0, 400)],
    );
  }

  async recordRiskFindings(assetId: string, findings: readonly RiskFinding[], actor: string): Promise<void> {
    await getPool().query(
      'UPDATE content_assets SET risk_findings = $2, updated_at = now() WHERE id = $1',
      [assetId, JSON.stringify(findings)],
    );
    await getPool().query(
      `INSERT INTO content_asset_audit (id, content_asset_id, from_state, to_state, action, actor, detail)
       VALUES ($1,$2,NULL,'RISK_REVIEW','risk_reviewed',$3,$4)`,
      [createId('aud'), assetId, actor, `${findings.length} finding(s)`],
    );
  }

  async byId(id: string): Promise<ContentAsset | undefined> {
    const { rows } = await getPool().query('SELECT * FROM content_assets WHERE id = $1', [id]);
    return rows[0] ? toAsset(rows[0]) : undefined;
  }

  async list(state?: ContentState, limit = 50): Promise<ContentAsset[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM content_assets ${state ? 'WHERE state = $2' : ''} ORDER BY updated_at DESC LIMIT $1`,
      state ? [Math.max(1, Math.min(limit, 200)), state] : [Math.max(1, Math.min(limit, 200))],
    );
    return rows.map(toAsset);
  }

  async auditTrail(assetId: string): Promise<Array<{
    fromState?: string; toState: string; action: string; actor: string; detail?: string; occurredAt: string;
  }>> {
    const { rows } = await getPool().query(
      'SELECT * FROM content_asset_audit WHERE content_asset_id = $1 ORDER BY occurred_at',
      [assetId],
    );
    return rows.map((row) => ({
      fromState: (row.from_state as string | null) ?? undefined,
      toState: String(row.to_state),
      action: String(row.action),
      actor: String(row.actor),
      detail: (row.detail as string | null) ?? undefined,
      occurredAt: (row.occurred_at as Date).toISOString(),
    }));
  }
}

function describeEdit(input: { body?: string; title?: string; audience?: string; tone?: string; channelId?: string }): string {
  const changed = Object.entries(input)
    .filter(([key, value]) => value !== undefined && key !== 'assetId' && key !== 'actor')
    .map(([key]) => key);
  return changed.length ? `changed: ${changed.join(', ')}` : 'no fields changed';
}

function toAsset(row: Record<string, unknown>): ContentAsset {
  return {
    id: String(row.id),
    opportunityId: (row.opportunity_id as string | null) ?? undefined,
    channelId: (row.channel_id as string | null) ?? undefined,
    assetType: String(row.asset_type) as AssetType,
    title: (row.title as string | null) ?? undefined,
    body: String(row.body),
    audience: (row.audience as string | null) ?? undefined,
    tone: (row.tone as string | null) ?? undefined,
    visualKind: (row.visual_kind as VisualKind | null) ?? undefined,
    visualSpec: (row.visual_spec as string | null) ?? undefined,
    state: String(row.state) as ContentState,
    riskFindings: (row.risk_findings as RiskFinding[] | null) ?? [],
    unsupportedStatements: (row.unsupported_statements as string[] | null) ?? [],
    approvedBy: (row.approved_by as string | null) ?? undefined,
    approvedAt: (row.approved_at as Date | null)?.toISOString(),
    rejectedReason: (row.rejected_reason as string | null) ?? undefined,
    generatedByModel: (row.generated_by_model as string | null) ?? undefined,
    generatedByInstance: (row.generated_by_instance as string | null) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Export for copy/paste.
 *
 * The internal provenance stays out of the exported text — the operator gets
 * clean content — but the export refuses outright while the asset is not
 * approved, so there is no path from a draft to a clipboard that skips review.
 */
export function exportAsset(asset: ContentAsset): string {
  if (asset.state !== 'HUMAN_APPROVED' && asset.state !== 'EXPORTED' && asset.state !== 'PUBLISHED') {
    throw new ContentWorkflowError(
      `Refusing to export "${asset.id}" in state ${asset.state}. Content is exported only after human approval.`,
    );
  }
  return [asset.title ? `# ${asset.title}` : '', asset.body].filter(Boolean).join('\n\n');
}
