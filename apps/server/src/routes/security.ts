/**
 * Red Team / Security Testing Routes
 *
 * Endpoints for managing authorized red team engagements, findings, evidence,
 * and security testing operations.
 */

import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@dacai-local-agent/shared';
import {
  getLiveValidationStopState,
  restartAllLiveValidation,
  stopAllLiveValidation,
  LIVE_VALIDATION_MODE,
  NodeProcessHealthMonitor,
  JsonlLiveValidationAuditSink,
  ProcessHardNetworkStopProvider,
  type HardNetworkStopProvider,
  type LiveValidationLimits,
  type PermissionTier,
  type RiskLevel,
  type SystemHealthThresholds,
} from '@dacai-local-agent/security';
import {
  AdversarialAgent,
  BUILT_IN_SCENARIOS,
  type LiveAdversarialTestConfig,
  type LiveScenarioApprovalGate,
} from '@dacai-local-agent/agents';
import {
  RedTeamEngagementStore,
  RedTeamFindingStore,
  RedTeamEvidenceStore,
  AdversarialTestResultStore,
  SecurityTestSummaryStore,
} from '@dacai-local-agent/shared';
import type { ApprovalRegistry } from '../approvals';

interface RunLiveValidationRequest {
  scenarioId: string;
  operator: string;
  authorizationEvidenceId: string;
  /** Tomahawk1's real address in the private lab, e.g. http://192.168.1.50:8787 */
  target: string;
  /** Raw values (tokens, resource paths) the scenario's own template asks for by name. */
  fixtures?: Record<string, string>;
  limits: Omit<LiveValidationLimits, 'expiresAt'> & { expiresAt: string };
  healthThresholds: SystemHealthThresholds;
  heartbeatTimeoutMs: number;
  hardNetworkStop: boolean;
  autoApproveLevel1?: boolean;
  autoApproveLevel2?: boolean;
  maxConcurrentTests?: number;
  timeoutMs?: number;
}

/** LEVEL_1/2 map onto the existing tool-approval tiers; LEVEL_3/4 are always high-impact. */
function tierForRiskLevel(riskLevel: RiskLevel): PermissionTier {
  if (riskLevel === 'LEVEL_1_SAFE') return 'safe';
  if (riskLevel === 'LEVEL_2_CONTROLLED') return 'mutation';
  return 'high-impact';
}

/** Routes a live scenario's approval requirement through the same real, fail-closed
 *  ApprovalRegistry the interactive agent loop uses for high-impact tool calls. */
function buildApprovalGate(approvals: ApprovalRegistry): LiveScenarioApprovalGate {
  return {
    async requestApproval({ runId, scenarioId, riskLevel, reason, input }) {
      return approvals.request({
        runId,
        toolName: `security.live-validation.${scenarioId}`,
        decision: { kind: 'approval-required', tier: tierForRiskLevel(riskLevel), reason, layer: 'tier-policy' },
        input,
      });
    },
  };
}

function buildAuditSink(): JsonlLiveValidationAuditSink {
  const path = process.env.TOMAHAWK1_AUDIT_LOG_FILE || resolve(process.cwd(), '.tomahawk', 'live-validation-audit.jsonl');
  return new JsonlLiveValidationAuditSink(path);
}

/** Only constructed when infrastructure has actually configured a firewall/isolation helper. */
function buildHardNetworkStopProvider(): HardNetworkStopProvider | undefined {
  const executable = process.env.TOMAHAWK1_HARD_STOP_EXECUTABLE;
  if (!executable) return undefined;
  const args = process.env.TOMAHAWK1_HARD_STOP_ARGS ? process.env.TOMAHAWK1_HARD_STOP_ARGS.split(' ').filter(Boolean) : [];
  const timeoutMs = Number(process.env.TOMAHAWK1_HARD_STOP_TIMEOUT_MS ?? 15_000);
  return new ProcessHardNetworkStopProvider({ executable, args, timeoutMs });
}

interface CreateEngagementRequest {
  customerId: string;
  authorizedTargets: string[];
  authorizedEnvironments: string[];
  allowedTestCategories: string[];
  prohibitedActions: string[];
  startsAt: string;
  expiresAt: string;
  humanApprover: string;
  scopeBreadth?: 'defined' | 'broad' | 'internal-only';
  threatModelTags?: string[];
  requestLimit?: number;
  concurrencyLimit?: number;
}

interface CreateFindingRequest {
  engagementId: string;
  title: string;
  description: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  findingType: 'vulnerability' | 'weakness' | 'misconfiguration' | 'design-flaw';
  affectedComponents: string[];
}

interface CreateEvidenceRequest {
  findingId: string;
  engagementId: string;
  evidenceType: string;
  sanitizedPayload: Record<string, unknown>;
  targetSystem: string;
  proofOfImpact?: string;
}

export function registerSecurityRoutes(server: FastifyInstance, deps: { config: AppConfig; approvals: ApprovalRegistry }): void {
  const engagementStore = new RedTeamEngagementStore();
  const findingStore = new RedTeamFindingStore();
  const evidenceStore = new RedTeamEvidenceStore();
  const testResultStore = new AdversarialTestResultStore();
  const summaryStore = new SecurityTestSummaryStore();
  const approvalGate = buildApprovalGate(deps.approvals);

  /** Built-in scenarios a live run can target, for populating a picker. */
  server.get('/api/security/live-validation/scenarios', async () => ({
    scenarios: Object.values(BUILT_IN_SCENARIOS),
  }));

  /** Global, fail-closed LIVE_VALIDATION control plane. */
  server.get('/api/security/live-validation/status', async () => ({
    mode: 'LIVE_VALIDATION',
    stopState: await getLiveValidationStopState(),
    environmentStop: ['true', '1', 'yes'].includes(
      (process.env.TOMAHAWK1_EMERGENCY_STOP ?? '').toLowerCase(),
    ),
  }));

  server.post<{
    Body: { reason?: string; operator?: string; hardNetworkStop?: boolean };
  }>('/api/security/live-validation/stop', async (request) => {
    const stopState = await stopAllLiveValidation({
      reason: request.body?.reason,
      operator: request.body?.operator,
      hardNetworkStop: request.body?.hardNetworkStop,
    });
    return { stopped: true, stopState };
  });

  server.post<{
    Body: { operator?: string; acknowledgement?: string };
  }>('/api/security/live-validation/restart', async (request, reply) => {
    try {
      await restartAllLiveValidation(
        request.body?.operator ?? '',
        request.body?.acknowledgement ?? '',
      );
      return { restarted: true, operator: request.body?.operator };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * POST /api/security/live-validation/:engagementId/run
   *
   * Starts a real LIVE_VALIDATION action against the engagement's real
   * authorized target (e.g. Tomahawk1's actual address in the private lab).
   * Every field below is required — this route has no implicit defaults for
   * limits, thresholds, or approval evidence, matching the safety
   * controller's own fail-closed validation.
   */
  server.post<{ Params: { engagementId: string }; Body: RunLiveValidationRequest }>(
    '/api/security/live-validation/:engagementId/run',
    async (request, reply) => {
      const engagement = await engagementStore.get(request.params.engagementId);
      if (!engagement) {
        return reply.code(404).send({ error: 'Engagement not found.' });
      }

      const body = request.body;
      if (!body?.scenarioId || !body.operator || !body.authorizationEvidenceId || !body.target) {
        return reply.code(400).send({
          error: 'scenarioId, operator, authorizationEvidenceId, and target are required to start LIVE_VALIDATION.',
        });
      }
      if (!body.limits || !body.healthThresholds || !body.heartbeatTimeoutMs || typeof body.hardNetworkStop !== 'boolean') {
        return reply.code(400).send({
          error:
            'limits, healthThresholds, heartbeatTimeoutMs, and hardNetworkStop are required to start LIVE_VALIDATION; there are no implicit defaults for a live run.',
        });
      }

      const agent = new AdversarialAgent(
        engagementStore,
        testResultStore,
        {
          auditSink: buildAuditSink(),
          healthMonitor: new NodeProcessHealthMonitor(),
          hardNetworkStopProvider: buildHardNetworkStopProvider(),
        },
        approvalGate,
      );

      const config: LiveAdversarialTestConfig = {
        engagementId: request.params.engagementId,
        scenarioId: body.scenarioId,
        autoApproveLevel1: body.autoApproveLevel1 ?? false,
        autoApproveLevel2: body.autoApproveLevel2 ?? false,
        maxConcurrentTests: body.maxConcurrentTests ?? 1,
        timeoutMs: body.timeoutMs ?? body.limits.maxDurationMs,
        executionMode: LIVE_VALIDATION_MODE,
        operator: body.operator,
        authorizationEvidenceId: body.authorizationEvidenceId,
        target: body.target,
        fixtures: body.fixtures,
        limits: { ...body.limits, expiresAt: new Date(body.limits.expiresAt) },
        healthThresholds: body.healthThresholds,
        heartbeatTimeoutMs: body.heartbeatTimeoutMs,
        hardNetworkStop: body.hardNetworkStop,
      };

      try {
        const results = await agent.runTest(config);
        return { engagementId: engagement.id, results };
      } catch (error) {
        // LIVE_VALIDATION must fail visibly; never substitute a demo result.
        return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
      }
    },
  );

  /**
   * POST /api/security/engagements
   * Create a new red team engagement
   */
  server.post<{ Body: CreateEngagementRequest }>('/api/security/engagements', async (request, reply) => {
    const body = request.body;

    if (!body?.customerId || !body?.authorizedTargets || !body?.startsAt || !body?.expiresAt) {
      return reply.code(400).send({
        error: 'customerId, authorizedTargets, startsAt, and expiresAt are required.',
      });
    }

    try {
      const engagement = await engagementStore.create({
        customerId: body.customerId,
        authorizedTargets: body.authorizedTargets,
        authorizedEnvironments: body.authorizedEnvironments || [],
        allowedTestCategories: body.allowedTestCategories || [],
        prohibitedActions: body.prohibitedActions || [],
        startsAt: new Date(body.startsAt),
        expiresAt: new Date(body.expiresAt),
        humanApprover: body.humanApprover || 'system',
        status: 'draft',
        scopeBreadth: body.scopeBreadth || 'defined',
        threatModelTags: body.threatModelTags || [],
        requestLimit: body.requestLimit,
        concurrencyLimit: body.concurrencyLimit,
        rulesOfEngagement: {},
      });

      return { engagement };
    } catch (error) {
      return reply.code(400).send({
        error: (error as Error).message,
      });
    }
  });

  /**
   * GET /api/security/engagements/:id
   * Get engagement details with findings summary
   */
  server.get<{ Params: { id: string } }>('/api/security/engagements/:id', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    const findings = await findingStore.listByEngagement(engagement.id);
    const summary = await summaryStore.getOrCreate(engagement.id);

    return {
      engagement,
      findings,
      summary,
    };
  });

  /**
   * GET /api/security/engagements?customerId=...
   * List engagements for a customer
   */
  server.get<{ Querystring: { customerId?: string; status?: string } }>('/api/security/engagements', async (request) => {
    const customerId = request.query.customerId;
    if (!customerId) {
      return { engagements: [], error: 'customerId query parameter is required.' };
    }

    const engagements = await engagementStore.list(customerId, request.query.status);
    return { engagements };
  });

  /**
   * POST /api/security/engagements/:id/approve
   * Approve an engagement for activation
   */
  server.post<{ Params: { id: string }; Body: { approver: string } }>('/api/security/engagements/:id/approve', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    if (engagement.status !== 'draft') {
      return reply.code(400).send({ error: 'Only draft engagements can be approved.' });
    }

    await engagementStore.updateStatus(request.params.id, 'approved');
    const updated = await engagementStore.get(request.params.id);

    return { engagement: updated, approved: true };
  });

  /**
   * POST /api/security/engagements/:id/start
   * Activate an approved engagement
   */
  server.post<{ Params: { id: string } }>('/api/security/engagements/:id/start', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    if (engagement.status !== 'approved') {
      return reply.code(400).send({ error: 'Only approved engagements can be started.' });
    }

    await engagementStore.updateStatus(request.params.id, 'active');
    const updated = await engagementStore.get(request.params.id);

    return { engagement: updated, started: true };
  });

  /**
   * POST /api/security/engagements/:id/pause
   * Temporarily pause an active engagement
   */
  server.post<{ Params: { id: string } }>('/api/security/engagements/:id/pause', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    if (engagement.status !== 'active') {
      return reply.code(400).send({ error: 'Only active engagements can be paused.' });
    }

    await engagementStore.updateStatus(request.params.id, 'paused');
    const updated = await engagementStore.get(request.params.id);

    return { engagement: updated, paused: true };
  });

  /**
   * POST /api/security/engagements/:id/stop
   * Revoke an engagement immediately
   */
  server.post<{ Params: { id: string } }>('/api/security/engagements/:id/stop', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    await engagementStore.updateStatus(request.params.id, 'revoked');
    const updated = await engagementStore.get(request.params.id);

    return { engagement: updated, revoked: true };
  });

  /**
   * POST /api/security/engagements/:id/findings
   * Create a finding during engagement
   */
  server.post<{ Params: { id: string }; Body: CreateFindingRequest }>('/api/security/engagements/:id/findings', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    const body = request.body;
    if (!body?.title || !body?.description) {
      return reply.code(400).send({ error: 'title and description are required.' });
    }

    try {
      const finding = await findingStore.create({
        engagementId: request.params.id,
        title: body.title,
        description: body.description,
        severity: body.severity || 'medium',
        confidence: body.confidence || 0.5,
        findingType: body.findingType || 'vulnerability',
        affectedComponents: body.affectedComponents || [],
        status: 'candidate',
        evidenceIds: [],
      });

      return { finding };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /**
   * GET /api/security/engagements/:id/findings
   * List findings for an engagement
   */
  server.get<{ Params: { id: string } }>('/api/security/engagements/:id/findings', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    const findings = await findingStore.listByEngagement(request.params.id);
    return { findings };
  });

  /**
   * POST /api/security/findings/:id/evidence
   * Add evidence to a finding
   */
  server.post<{ Params: { id: string }; Body: Omit<CreateEvidenceRequest, 'findingId'> }>('/api/security/findings/:id/evidence', async (request, reply) => {
    const finding = await findingStore.get(request.params.id);
    if (!finding) {
      return reply.code(404).send({ error: 'Finding not found.' });
    }

    const body = request.body;
    if (!body?.evidenceType || !body?.targetSystem) {
      return reply.code(400).send({ error: 'evidenceType and targetSystem are required.' });
    }

    try {
      const evidence = await evidenceStore.create({
        findingId: request.params.id,
        engagementId: body.engagementId,
        evidenceType: body.evidenceType as any,
        sanitizedPayload: body.sanitizedPayload || {},
        timestamp: new Date(),
        targetSystem: body.targetSystem,
        proofOfImpact: body.proofOfImpact,
      });

      return { evidence };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /**
   * GET /api/security/findings/:id/evidence
   * Get all evidence for a finding
   */
  server.get<{ Params: { id: string } }>('/api/security/findings/:id/evidence', async (request, reply) => {
    const finding = await findingStore.get(request.params.id);
    if (!finding) {
      return reply.code(404).send({ error: 'Finding not found.' });
    }

    const evidence = await evidenceStore.listByFinding(request.params.id);
    return { evidence };
  });

  /**
   * GET /api/security/engagements/:id/statistics
   * Get engagement statistics and summary
   */
  server.get<{ Params: { id: string } }>('/api/security/engagements/:id/statistics', async (request, reply) => {
    const engagement = await engagementStore.get(request.params.id);
    if (!engagement) {
      return reply.code(404).send({ error: 'Engagement not found.' });
    }

    const findings = await findingStore.listByEngagement(request.params.id);
    const summary = await summaryStore.getOrCreate(request.params.id);

    const bySeverity = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.severity === 'info').length,
    };

    const byStatus = {
      candidate: findings.filter((f) => f.status === 'candidate').length,
      verified: findings.filter((f) => f.status === 'verified').length,
      falsePositive: findings.filter((f) => f.status === 'false-positive').length,
      remediated: findings.filter((f) => f.status === 'remediated').length,
      acceptedRisk: findings.filter((f) => f.status === 'accepted-risk').length,
    };

    return {
      engagement,
      statistics: {
        totalFindings: findings.length,
        bySeverity,
        byStatus,
        ...summary,
      },
    };
  });
}
