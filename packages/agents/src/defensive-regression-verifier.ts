/**
 * Real DefensiveRegressionVerifier implementation.
 *
 * Calls back into AdversarialAgent to actually re-run the exact authorized
 * live scenario tied to a finding. It never manufactures a result: a scenario
 * with no live executor, a missing target/authorization on the engagement, or
 * a safety-envelope rejection all resolve to 'inconclusive' — only a real
 * completed live run can produce 'blocked' or 'still-vulnerable'.
 */

import {
  LIVE_VALIDATION_MODE,
  type LiveValidationSafetyDependencies,
} from '@dacai-local-agent/security';
import type { RedTeamEngagementStore, AdversarialTestResultStore } from '@dacai-local-agent/shared';
import { AdversarialAgent, type LiveScenarioApprovalGate } from './adversarial-agent';
import { BUILT_IN_SCENARIOS } from './security-scenario-registry';
import type {
  DefensiveRegressionVerifier,
  RegressionVerificationRequest,
  RegressionVerificationResult,
  VerificationOutcome,
} from './defensive-agent';

/** A single bounded verification action — not an open engagement, so limits stay small. */
const VERIFICATION_LIMITS = {
  maxDurationMs: 30_000,
  maxActionCount: 1,
  maxConcurrency: 1,
  maxBytesPerSecond: 1_000_000,
  maxTotalBytes: 1_000_000,
};

export class DefensiveRegressionVerifierImpl implements DefensiveRegressionVerifier {
  constructor(
    private readonly engagementStore: RedTeamEngagementStore,
    private readonly resultStore: AdversarialTestResultStore,
    private readonly liveSafetyDependencies: LiveValidationSafetyDependencies,
    private readonly approvalGate?: LiveScenarioApprovalGate,
  ) {}

  async verify(request: RegressionVerificationRequest): Promise<RegressionVerificationResult> {
    const engagement = await this.engagementStore.get(request.engagementId);
    if (!engagement) {
      return inconclusive(`Engagement ${request.engagementId} not found.`);
    }
    if (!BUILT_IN_SCENARIOS[request.scenarioId]) {
      return inconclusive(`Unknown scenario id "${request.scenarioId}".`);
    }
    const target = engagement.authorizedTargets[0];
    if (!target) {
      return inconclusive('Engagement has no authorized target to verify against.');
    }
    if (!engagement.authorizationEvidenceId) {
      return inconclusive('Engagement has no recorded authorization evidence; cannot run a live regression check.');
    }

    const agent = new AdversarialAgent(this.engagementStore, this.resultStore, this.liveSafetyDependencies, this.approvalGate);

    try {
      const results = await agent.runTest({
        engagementId: request.engagementId,
        scenarioId: request.scenarioId,
        // LEVEL_1/2 proceed without a redundant click for routine regression checks; LEVEL_3/4
        // still always require the real approval gate regardless (see RISK_POLICIES.autoApprovable).
        autoApproveLevel1: true,
        autoApproveLevel2: true,
        maxConcurrentTests: 1,
        timeoutMs: VERIFICATION_LIMITS.maxDurationMs,
        executionMode: LIVE_VALIDATION_MODE,
        operator: 'defensive-regression-verifier',
        authorizationEvidenceId: engagement.authorizationEvidenceId,
        target,
        limits: { ...VERIFICATION_LIMITS, expiresAt: engagement.expiresAt },
        healthThresholds: { maxMemoryRssBytes: 4 * 1024 * 1024 * 1024 },
        heartbeatTimeoutMs: 5_000,
        hardNetworkStop: false,
      });

      const result = results[0];
      if (!result) {
        return inconclusive('The live regression run produced no result.');
      }

      // 'passed' means the scenario's own real check held (e.g. a malformed token was still
      // rejected) — the attack did not reproduce, i.e. the defense blocked it. 'failed' means
      // the real observation did not match what a secure system should produce — still
      // vulnerable. A safety-envelope rejection ('error'/'blocked') is not a defense verdict
      // either way — inconclusive is the only honest outcome for that.
      const outcome: VerificationOutcome =
        result.status === 'passed' ? 'blocked' : result.status === 'failed' ? 'still-vulnerable' : 'inconclusive';

      return {
        outcome,
        evidence: [result.observedBehavior, `status=${result.status ?? 'unknown'}`, `target=${result.target}`],
        observedAt: result.createdAt,
      };
    } catch (error) {
      return inconclusive(`Live regression run did not complete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function inconclusive(reason: string): RegressionVerificationResult {
  return { outcome: 'inconclusive', evidence: [reason], observedAt: new Date() };
}
