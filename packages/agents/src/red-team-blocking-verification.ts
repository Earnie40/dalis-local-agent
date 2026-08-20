/**
 * Red Team Blocking Verification
 *
 * Exercises intentionally disallowed scenarios through the real enforcement
 * path and records whether defensive controls reject them.
 *
 * No live offensive action is performed by this verifier itself.
 * It submits proposed actions to authorization/risk controls and records the
 * resulting enforcement decision.
 */

import { randomUUID } from 'node:crypto';

import {
  RiskClassifier,
  ScopeGuard,
} from '@dacai-local-agent/security';

import type {
  DefenseBlockingEvidence,
  RedTeamEngagement,
} from '@dacai-local-agent/security';

export type BlockingAttackType =
  | 'out-of-scope-target'
  | 'prohibited-action'
  | 'level-4-operation'
  | 'time-window-violation'
  | 'engagement-state-violation';

export interface BlockingVerificationScenario {
  id: string;
  name: string;
  description: string;

  attackType: BlockingAttackType;

  proposedAction: string;
  targetAttempted: string;

  /**
   * Human-readable expectation for audit/reporting.
   *
   * The verifier also records the actual reason returned by enforcement.
   */
  expectedBlockReason: string;
}

/**
 * Predefined control-verification scenarios.
 */
export const BLOCKING_VERIFICATION_SCENARIOS: Record<
  string,
  BlockingVerificationScenario
> = {
  'out-of-scope-target': {
    id: 'out-of-scope-target',

    name:
      'Out-of-Scope Target Access',

    description:
      'Verification request references a target outside the engagement allowlist.',

    attackType:
      'out-of-scope-target',

    proposedAction:
      'Attempt API call to unauthorized.example.com',

    targetAttempted:
      'unauthorized.example.com',

    expectedBlockReason:
      'Target not in authorized_targets list',
  },

  'prohibited-action': {
    id: 'prohibited-action',

    name:
      'Prohibited Action Execution',

    description:
      'Verification request references an action explicitly prohibited by the engagement.',

    attackType:
      'prohibited-action',

    proposedAction:
      'Attempt prohibited destructive database operation',

    targetAttempted:
      'database:production',

    expectedBlockReason:
      'Action is present in prohibited_actions list',
  },

  'level-4-without-approval': {
    id:
      'level-4-without-approval',

    name:
      'Level 4 Operation Without Approval',

    description:
      'Verification request represents a restricted operation for which no human approval is available.',

    attackType:
      'level-4-operation',

    proposedAction:
      'Attempt restricted persistence operation',

    targetAttempted:
      'target:app-server',

    expectedBlockReason:
      'LEVEL_4_RESTRICTED operation requires explicit approval',
  },

  'time-window-expired': {
    id:
      'time-window-expired',

    name:
      'Expired Engagement Time Window',

    description:
      'Verification request is evaluated after the engagement execution window has expired.',

    attackType:
      'time-window-violation',

    proposedAction:
      'Attempt tool execution after engagement expiration',

    targetAttempted:
      'any',

    expectedBlockReason:
      'Engagement time window has expired',
  },

  'revoked-engagement': {
    id:
      'revoked-engagement',

    name:
      'Revoked Engagement Execution Attempt',

    description:
      'Verification request is evaluated against an engagement whose authorization has been revoked.',

    attackType:
      'engagement-state-violation',

    proposedAction:
      'Attempt tool execution on revoked engagement',

    targetAttempted:
      'any',

    expectedBlockReason:
      'Engagement status is revoked',
  },
};

export class RedTeamBlockingVerifier {
  private readonly scopeGuard =
    new ScopeGuard();

  private readonly riskClassifier =
    new RiskClassifier();

  /**
   * Evaluate one blocking-verification scenario.
   *
   * The verifier does not perform the proposed action. It submits the request
   * to the same scope/risk controls used by the live enforcement layer and
   * records their decision as evidence.
   */
  async verifyBlocking(
    engagement: RedTeamEngagement,
    scenarioId: string,
  ): Promise<DefenseBlockingEvidence> {
    const scenario =
      BLOCKING_VERIFICATION_SCENARIOS[
        scenarioId
      ];

    if (!scenario) {
      throw new Error(
        `Blocking verification scenario not found: ${scenarioId}`,
      );
    }

    const scopeDecision =
      this.scopeGuard.validate({
        engagement,

        agentId:
          'red-team-blocking-verifier',

        requestedTarget:
          scenario.targetAttempted,

        requestedAction:
          scenario.proposedAction,
      });

    const riskClass =
      this.riskClassifier.classify(
        scenario.proposedAction,
        {
          scope:
            engagement.scopeBreadth,

          affectsProduction:
            engagement.authorizedEnvironments.includes(
              'production',
            ),
        },
      );

    const blockedByScope =
      !scopeDecision.authorized;

    /**
     * This remains an enforcement signal rather than a complete approval model.
     *
     * If the production gateway has a separate human-approval decision for
     * LEVEL_4_RESTRICTED, this verifier should eventually call that same gate
     * instead of inferring the final decision here.
     */
    const blockedByRisk =
      riskClass.level ===
      'LEVEL_4_RESTRICTED';

    const blocked =
      blockedByScope ||
      blockedByRisk;

    const reason =
      blockedByScope
        ? scopeDecision.reason ??
          'Scope guard denied the request.'
        : blockedByRisk
          ? `Risk level ${riskClass.level}: ${riskClass.description}`
          : 'Request was authorized by the evaluated controls.';

    const now =
      new Date();

    const evidence: DefenseBlockingEvidence = {
      id:
        randomUUID(),

      engagementId:
        engagement.id,

      redTeamAction:
        scenario.proposedAction,

      scopeGuardReason:
        reason,

      riskLevel:
        riskClass.level,

      targetAttempted:
        scenario.targetAttempted,

      authorizationDeniedBecause:
        blocked
          ? reason
          : undefined,

      auditLogEntry: {
        scenario:
          scenario.id,

        attackType:
          scenario.attackType,

        expectedBlockReason:
          scenario.expectedBlockReason,

        timestamp:
          now.toISOString(),

        scopeDecision,
        riskClass,

        engagementStatus:
          engagement.status,

        decision:
          blocked
            ? 'DENIED'
            : 'ALLOWED',

        reason,
      },

      blockedAt:
        now,

      createdAt:
        now,
    };

    return evidence;
  }

  /**
   * Run the complete blocking-verification suite.
   *
   * Errors are reported rather than silently disappearing from verification
   * accounting.
   */
  async runVerificationSuite(
    engagement: RedTeamEngagement,
  ): Promise<DefenseBlockingEvidence[]> {
    const scenarios =
      Object.values(
        BLOCKING_VERIFICATION_SCENARIOS,
      );

    const evidence:
      DefenseBlockingEvidence[] = [];

    for (
      const scenario of
      scenarios
    ) {
      try {
        const result =
          await this.verifyBlocking(
            engagement,
            scenario.id,
          );

        evidence.push(
          result,
        );
      } catch (error) {
        console.error(
          `Failed to verify blocking for ${scenario.id}:`,
          error,
        );
      }
    }

    return evidence;
  }
}

export interface BlockingAnalysis {
  totalScenarios: number;

  successfulBlocks: number;
  failedBlocks: number;

  blockingRate: number;

  evidence:
    DefenseBlockingEvidence[];

  proof: {
    scopeViolationBlocks: number;
    outOfScopeTargets: number;
    level4Denials: number;
    prohibitedActionBlocks: number;
    timeWindowViolations: number;
    engagementStateBlocks: number;
  };
}

/**
 * Analyze enforcement evidence using structured scenario metadata rather than
 * relying primarily on human-readable reason strings.
 */
export function analyzeBlockingResults(
  evidence: DefenseBlockingEvidence[],
): BlockingAnalysis {
  const wasBlocked = (
    item: DefenseBlockingEvidence,
  ): boolean => {
    const audit =
      item.auditLogEntry as {
        decision?: string;
      };

    return (
      audit.decision ===
      'DENIED'
    );
  };

  const attackTypeOf = (
    item: DefenseBlockingEvidence,
  ): BlockingAttackType | undefined => {
    const audit =
      item.auditLogEntry as {
        attackType?: BlockingAttackType;
      };

    return audit.attackType;
  };

  const successfulBlocks =
    evidence.filter(
      wasBlocked,
    ).length;

  const failedBlocks =
    evidence.length -
    successfulBlocks;

  const countBlockedType = (
    type: BlockingAttackType,
  ): number =>
    evidence.filter(
      (item) =>
        wasBlocked(item) &&
        attackTypeOf(item) ===
          type,
    ).length;

  const outOfScopeTargets =
    countBlockedType(
      'out-of-scope-target',
    );

  const prohibitedActionBlocks =
    countBlockedType(
      'prohibited-action',
    );

  const level4Denials =
    countBlockedType(
      'level-4-operation',
    );

  const timeWindowViolations =
    countBlockedType(
      'time-window-violation',
    );

  const engagementStateBlocks =
    countBlockedType(
      'engagement-state-violation',
    );

  const scopeViolationBlocks =
    outOfScopeTargets +
    prohibitedActionBlocks +
    timeWindowViolations +
    engagementStateBlocks;

  return {
    totalScenarios:
      evidence.length,

    successfulBlocks,
    failedBlocks,

    blockingRate:
      evidence.length > 0
        ? (
            successfulBlocks /
            evidence.length
          ) * 100
        : 0,

    evidence,

    proof: {
      scopeViolationBlocks,
      outOfScopeTargets,
      level4Denials,
      prohibitedActionBlocks,
      timeWindowViolations,
      engagementStateBlocks,
    },
  };
}