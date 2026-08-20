/**
 * Defensive Testing Routes
 *
 * Endpoints for running control validation tests, blocking verification,
 * and viewing defensive agent recommendations.
 */

import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@dacai-local-agent/shared';
import {
  DEFAULT_PERMISSION_POLICY,
  NodeProcessHealthMonitor,
  JsonlLiveValidationAuditSink,
  type ControlTestExecutionContext,
  type ControlTestHttpRequest,
  type RiskLevel,
} from '@dacai-local-agent/security';
import {
  DefensiveControlTestResultStore,
  AnonymizedSourceAuditStore,
  DefenseBlockingEvidenceStore,
  DefensiveRecommendationStore,
  DefensivePostureSummaryStore,
  RedTeamEngagementStore,
  RedTeamFindingStore,
  AdversarialTestResultStore,
} from '@dacai-local-agent/shared';
import {
  CONTROL_TEST_SCENARIOS,
  executeControlTest,
  runControlTestCategory,
  RedTeamBlockingVerifier,
  analyzeBlockingResults,
  DefensiveAgent,
  DefensiveControlInspectorImpl,
  DefensiveRegressionVerifierImpl,
  type AnalyzeEngagementOptions,
  type LiveScenarioApprovalGate,
} from '@dacai-local-agent/agents';
import type { ApprovalRegistry } from '../approvals';

/** LEVEL_1/2 map onto the existing tool-approval tiers; LEVEL_3/4 are always high-impact. */
function tierForRiskLevel(riskLevel: RiskLevel): 'safe' | 'mutation' | 'high-impact' {
  if (riskLevel === 'LEVEL_1_SAFE') return 'safe';
  if (riskLevel === 'LEVEL_2_CONTROLLED') return 'mutation';
  return 'high-impact';
}

/** Same audit log and env var convention as security.ts's LIVE_VALIDATION run route. */
function buildAuditSink(): JsonlLiveValidationAuditSink {
  const path = process.env.TOMAHAWK1_AUDIT_LOG_FILE || resolve(process.cwd(), '.tomahawk', 'live-validation-audit.jsonl');
  return new JsonlLiveValidationAuditSink(path);
}

function buildApprovalGate(approvals: ApprovalRegistry): LiveScenarioApprovalGate {
  return {
    async requestApproval({ runId, scenarioId, riskLevel, reason, input }) {
      return approvals.request({
        runId,
        toolName: `security.regression-verification.${scenarioId}`,
        decision: { kind: 'approval-required', tier: tierForRiskLevel(riskLevel), reason, layer: 'tier-policy' },
        input,
      });
    },
  };
}

export function registerDefensiveRoutes(server: FastifyInstance, deps: { config: AppConfig; approvals: ApprovalRegistry }): void {
  const controlTestResultStore = new DefensiveControlTestResultStore();
  const anonymizedSourceStore = new AnonymizedSourceAuditStore();
  const blockingEvidenceStore = new DefenseBlockingEvidenceStore();
  const recommendationStore = new DefensiveRecommendationStore();
  const postureStore = new DefensivePostureSummaryStore();
  const engagementStore = new RedTeamEngagementStore();
  const findingStore = new RedTeamFindingStore();
  const testResultStore = new AdversarialTestResultStore();
  const controlInspector = new DefensiveControlInspectorImpl(DEFAULT_PERMISSION_POLICY);
  const regressionVerifier = new DefensiveRegressionVerifierImpl(
    engagementStore,
    testResultStore,
    { auditSink: buildAuditSink(), healthMonitor: new NodeProcessHealthMonitor() },
    buildApprovalGate(deps.approvals),
  );

  /**
   * GET /api/security/defensive/control-tests
   * List available defensive control test scenarios
   */
  server.get<{ Querystring: { category?: string } }>('/api/security/defensive/control-tests', async (request) => {
    const tests = Object.values(CONTROL_TEST_SCENARIOS).filter((t) => !request.query.category || t.category === request.query.category);
    return { tests, total: tests.length };
  });

  /**
   * POST /api/security/defensive/control-tests/:scenarioId/run
   * Execute a single control test scenario against the real system under
   * test. The caller must supply the real HTTP request(s) that exercise the
   * control (requests[]) — there is no built-in fabricated result.
   */
  server.post<{ Params: { scenarioId: string }; Body: { requests: ControlTestHttpRequest[] } }>(
    '/api/security/defensive/control-tests/:scenarioId/run',
    async (request, reply) => {
      const scenario = CONTROL_TEST_SCENARIOS[request.params.scenarioId];
      if (!scenario) {
        return reply.code(404).send({ error: 'Control test scenario not found.' });
      }

      try {
        const context: ControlTestExecutionContext = { requests: request.body?.requests ?? [] };
        const result = await executeControlTest(request.params.scenarioId, context);

        // Store result
        await controlTestResultStore.create({
          testId: result.testId,
          passed: result.passed,
          observedBehavior: result.observedBehavior,
          evidence: result.evidence,
          severityIfFailed: scenario.severity,
          executedAt: new Date(),
        });

        return { scenario, result };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * POST /api/security/defensive/control-tests/category/:category/run-all
   * Run all control tests in a category against the real system under test.
   * The caller must supply a real HTTP request context per scenario id.
   */
  server.post<{
    Params: { category: string };
    Body: { contexts: Record<string, ControlTestExecutionContext> };
  }>(
    '/api/security/defensive/control-tests/category/:category/run-all',
    async (request, reply) => {
      const validCategories = ['authentication', 'authorization', 'tenant-isolation', 'rate-limit', 'validation'];
      if (!validCategories.includes(request.params.category)) {
        return reply.code(400).send({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
      }

      try {
        const results = await runControlTestCategory(
          request.params.category as 'authentication' | 'authorization' | 'tenant-isolation' | 'rate-limit' | 'validation',
          request.body?.contexts ?? {},
        );
        const passed = results.filter((r) => r.passed).length;
        const failed = results.filter((r) => !r.passed).length;

        return { category: request.params.category, results, passed, failed, passRate: (passed / results.length) * 100 };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * POST /api/security/defensive/red-team-blocking/:engagementId/verify
   * Run blocking verification scenarios against an engagement
   */
  server.post<{ Params: { engagementId: string } }>(
    '/api/security/defensive/red-team-blocking/:engagementId/verify',
    async (request, reply) => {
      const engagement = await engagementStore.get(request.params.engagementId);
      if (!engagement) {
        return reply.code(404).send({ error: 'Engagement not found.' });
      }

      try {
        const blockingVerifier = new RedTeamBlockingVerifier();
        const evidence = await blockingVerifier.runVerificationSuite(engagement);
        const analysis = analyzeBlockingResults(evidence);

        // Store evidence
        for (const block of evidence) {
          await blockingEvidenceStore.create(block);
        }

        return { engagement: engagement.id, analysis, evidence };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * GET /api/security/defensive/red-team-blocking/:engagementId
   * Get blocking evidence for an engagement
   */
  server.get<{ Params: { engagementId: string } }>(
    '/api/security/defensive/red-team-blocking/:engagementId',
    async (request, reply) => {
      const engagement = await engagementStore.get(request.params.engagementId);
      if (!engagement) {
        return reply.code(404).send({ error: 'Engagement not found.' });
      }

      const evidence = await blockingEvidenceStore.listByEngagement(request.params.engagementId);
      const analysis = analyzeBlockingResults(evidence);

      return { engagement: engagement.id, evidence, analysis };
    },
  );

  /**
   * POST /api/security/defensive/defensive-agent/:engagementId/analyze
   *
   * Run defensive agent analysis on an engagement. `inspectControls` (default
   * true) runs the real, read-only PermissionEngine/rate-limit inspector.
   * `verifyFindings` (default false — it triggers real LIVE_VALIDATION HTTP
   * calls against the engagement's own authorized target, so it is opt-in)
   * re-runs each verified finding's original scenario for real and only marks
   * it remediated if that real re-run shows the attack no longer succeeds.
   */
  server.post<{ Params: { engagementId: string }; Body: AnalyzeEngagementOptions }>(
    '/api/security/defensive/defensive-agent/:engagementId/analyze',
    async (request, reply) => {
      const engagement = await engagementStore.get(request.params.engagementId);
      if (!engagement) {
        return reply.code(404).send({ error: 'Engagement not found.' });
      }

      try {
        const defensiveAgent = new DefensiveAgent(`agent-${Date.now()}`, findingStore, controlInspector, regressionVerifier);
        const analysis = await defensiveAgent.analyzeEngagement(request.params.engagementId, {
          inspectControls: request.body?.inspectControls ?? true,
          verifyFindings: request.body?.verifyFindings ?? false,
        });

        // Store recommendations
        for (const rec of analysis.recommendations) {
          await recommendationStore.create(rec);
        }

        return { engagement: engagement.id, analysis };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  /**
   * GET /api/security/defensive/recommendations/:engagementId
   * Get defensive recommendations for an engagement
   */
  server.get<{ Params: { engagementId: string } }>(
    '/api/security/defensive/recommendations/:engagementId',
    async (request, reply) => {
      const engagement = await engagementStore.get(request.params.engagementId);
      if (!engagement) {
        return reply.code(404).send({ error: 'Engagement not found.' });
      }

      const recommendations = await recommendationStore.listByEngagement(request.params.engagementId);
      const bySeverity = {
        critical: recommendations.filter((r) => r.severity === 'critical').length,
        high: recommendations.filter((r) => r.severity === 'high').length,
        medium: recommendations.filter((r) => r.severity === 'medium').length,
        low: recommendations.filter((r) => r.severity === 'low').length,
      };

      return { engagement: engagement.id, recommendations, statistics: { total: recommendations.length, bySeverity } };
    },
  );

  /**
   * GET /api/security/defensive/posture/:engagementId
   * Get defensive posture summary for an engagement
   */
  server.get<{ Params: { engagementId: string } }>(
    '/api/security/defensive/posture/:engagementId',
    async (request, reply) => {
      const engagement = await engagementStore.get(request.params.engagementId);
      if (!engagement) {
        return reply.code(404).send({ error: 'Engagement not found.' });
      }

      const posture = await postureStore.getOrCreate(request.params.engagementId);
      return { engagement: engagement.id, posture };
    },
  );

  /**
   * GET /api/security/defensive/anonymized-sources
   * List detected anonymized sources (Tor, proxy, VPN)
   */
  server.get<{ Querystring: { classification?: string; limit?: string } }>(
    '/api/security/defensive/anonymized-sources',
    async (request) => {
      const classification = request.query.classification || 'suspicious';
      const limit = parseInt(request.query.limit || '100', 10);

      const sources = await anonymizedSourceStore.listByClassification(classification, limit);
      const byClassification = {
        informational: sources.filter((s) => s.classification === 'informational').length,
        suspicious: sources.filter((s) => s.classification === 'suspicious').length,
        hostile: sources.filter((s) => s.classification === 'hostile').length,
      };

      return { sources, statistics: { total: sources.length, byClassification } };
    },
  );
}
