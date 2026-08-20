/**
 * Adversarial Security Agent
 *
 * Orchestrates authorized security testing: engagement/scope checks, risk-tier
 * admission, and dispatch to a registered scenario (packages/agents/src/security-scenario-registry.ts).
 *
 * The scenario registry — not this file's caller — owns what a scenario does
 * in SIMULATION and what HTTP action, expected result, and pass/fail rule it
 * uses in LIVE_VALIDATION. This agent never accepts an arbitrary action or
 * evaluator: a scenario id always determines its own behavior.
 *
 * Runs autonomously within a defined engagement scope.
 * Never requires real customer data or credentials.
 * All SIMULATION tests use synthetic data; LIVE_VALIDATION requires real,
 * explicit authorization evidence and touches only the engagement's own
 * authorized target.
 */

import {
  LIVE_VALIDATION_MODE,
  SIMULATION_MODE,
  ScopeGuard,
  SYNTHETIC_TARGET,
  LiveValidationSafetyController,
  type AdversarialTestResult,
  type LiveValidationLimits,
  type LiveValidationSafetyDependencies,
  type RedTeamEngagement,
  type RiskLevel,
  type SecurityTestScenario,
  type SystemHealthThresholds,
} from '@dacai-local-agent/security';
import { AdversarialTestResultStore, RedTeamEngagementStore, createId } from '@dacai-local-agent/shared';
import {
  BUILT_IN_SCENARIOS,
  RISK_POLICIES,
  SCENARIO_EXECUTORS,
  SyntheticSecurityTwin,
  getLiveScenario,
  type LiveScenarioBuildContext,
  type LiveScenarioFixtures,
} from './security-scenario-registry';

export interface AdversarialTestConfig {
  engagementId: string;
  scenarioId: string;
  autoApproveLevel1: boolean; // Auto-execute LEVEL_1_SAFE tests
  autoApproveLevel2: boolean; // Auto-execute LEVEL_2_CONTROLLED tests (default: false)
  maxConcurrentTests: number;
  timeoutMs: number;
  /** Synthetic path for unit tests and CI. Production live mode must be explicit. */
  executionMode: typeof SIMULATION_MODE;
}

export interface LiveAdversarialTestConfig extends Omit<AdversarialTestConfig, 'executionMode'> {
  executionMode: typeof LIVE_VALIDATION_MODE;
  operator: string;
  authorizationEvidenceId: string;
  target: string;
  /** Raw values (tokens, resource paths) the scenario's own template asks for by name. */
  fixtures?: LiveScenarioFixtures;
  limits: LiveValidationLimits;
  healthThresholds: SystemHealthThresholds;
  heartbeatTimeoutMs: number;
  hardNetworkStop: boolean;
}

export type AdversarialRunConfig = AdversarialTestConfig | LiveAdversarialTestConfig;

/**
 * Real human-approval gate for LIVE scenarios that aren't auto-approvable.
 * Owned by packages/agents so this package never depends on apps/server; the
 * route layer supplies a real adapter backed by the same ApprovalRegistry
 * already used to gate high-impact tool calls in the interactive agent loop.
 */
export interface LiveScenarioApprovalGate {
  requestApproval(input: {
    runId: string;
    scenarioId: string;
    riskLevel: RiskLevel;
    reason: string;
    input: Record<string, unknown>;
  }): Promise<boolean>;
}

const SAFETY_ENVELOPE_ERROR_NAMES = new Set([
  'LiveValidationLimitError',
  'LiveValidationConfigurationError',
  'LiveValidationStoppedError',
  'TargetAuthorizationError',
]);

const SAFETY_ENVELOPE_MESSAGE_MARKERS = [
  'ScopeGuard denied',
  'requires fixtures',
  'requires human approval',
  'was not approved',
  'No LIVE_VALIDATION executor',
  'centralized safety-controller dependencies',
  'matching explicit engagement authorization',
];

/** Distinguishes "the safety envelope correctly rejected this run" from an unexpected failure. */
function classifyLiveFailure(error: unknown): 'blocked' | 'error' {
  if (error instanceof Error) {
    if (SAFETY_ENVELOPE_ERROR_NAMES.has(error.name)) return 'blocked';
    if (SAFETY_ENVELOPE_MESSAGE_MARKERS.some((marker) => error.message.includes(marker))) return 'blocked';
  }
  return 'error';
}

/**
 * AdversarialAgent: orchestrates engagement/scope checks and dispatches each
 * scenario to its registered executor (SIMULATION) or the live safety
 * controller (LIVE_VALIDATION).
 */
export class AdversarialAgent {
  private readonly scopeGuard = new ScopeGuard();

  constructor(
    private engagementStore: RedTeamEngagementStore,
    private resultStore: AdversarialTestResultStore,
    private readonly liveSafetyDependencies?: LiveValidationSafetyDependencies,
    private readonly approvalGate?: LiveScenarioApprovalGate,
  ) {}

  /**
   * Run the single scenario identified by config.scenarioId for an engagement.
   * maxConcurrentTests does not schedule multiple scenarios here — it only
   * clamps the live safety controller's concurrency limit for this one run.
   */
  async runTest(config: AdversarialRunConfig): Promise<AdversarialTestResult[]> {
    const engagement = await this.engagementStore.get(config.engagementId);
    if (!engagement) {
      throw new Error(`Engagement not found: ${config.engagementId}`);
    }

    if (engagement.status !== 'active') {
      throw new Error(`Engagement is not active: ${engagement.status}`);
    }

    const scenario = BUILT_IN_SCENARIOS[config.scenarioId];
    if (!scenario) {
      throw new Error(`Scenario not found: ${config.scenarioId}`);
    }

    // Check if scenario is within allowed categories
    if (
      engagement.allowedTestCategories.length > 0 &&
      !engagement.allowedTestCategories.includes(scenario.category)
    ) {
      throw new Error(`Scenario category not allowed: ${scenario.category}`);
    }

    const results: AdversarialTestResult[] = [];

    try {
      const result =
        config.executionMode === LIVE_VALIDATION_MODE
          ? await this.executeLiveTest(engagement, scenario, config)
          : await this.executeSimulationTest(engagement, scenario, config);
      results.push(result);
      await this.resultStore.create(result);
    } catch (error) {
      console.error(`Test execution failed: ${scenario.id}`, error);
      if (config.executionMode === LIVE_VALIDATION_MODE) {
        // A production-style live run must fail visibly — but the failure itself is evidence
        // (a blocked scope violation, a spent budget, a denied approval) and must not be lost.
        const status = classifyLiveFailure(error);
        const failureResult: Omit<AdversarialTestResult, 'id' | 'createdAt'> = {
          engagementId: engagement.id,
          testCategory: scenario.category as any,
          testScenario: scenario.id,
          target: (config as LiveAdversarialTestConfig).target,
          passed: false,
          status,
          observedBehavior: `Live scenario did not complete: ${error instanceof Error ? error.message : String(error)}`,
          evidence: {
            executionMode: LIVE_VALIDATION_MODE,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          regressionTest: scenario.category === 'regression',
        };
        await this.resultStore.create(failureResult).catch((storeError) => {
          console.error('Failed to persist live-validation failure evidence', storeError);
        });
        throw error;
      }
    }

    return results;
  }

  private async executeSimulationTest(
    engagement: RedTeamEngagement,
    scenario: SecurityTestScenario,
    config: AdversarialRunConfig,
  ): Promise<AdversarialTestResult> {
    // Explicitly isolated simulation used by unit tests and CI only: evaluated
    // against SyntheticSecurityTwin, never a real system or network call.
    //
    // LIVE_VALIDATION already requires matching authorizationEvidenceId (checked in
    // executeLiveTest) plus the safety controller's own gates, so approval here only
    // applies to SIMULATION — otherwise these flags stayed unused and every scenario
    // silently "passed" auto-approval regardless of their value.
    const needsLevel1Approval = scenario.riskLevel === 'LEVEL_1_SAFE' && !config.autoApproveLevel1;
    const needsLevel2Approval = scenario.riskLevel === 'LEVEL_2_CONTROLLED' && !config.autoApproveLevel2;
    if (needsLevel1Approval || needsLevel2Approval) {
      throw new Error(
        `Scenario "${scenario.id}" is ${scenario.riskLevel} and requires ${
          needsLevel1Approval ? 'autoApproveLevel1' : 'autoApproveLevel2'
        } to run.`,
      );
    }

    const executor = SCENARIO_EXECUTORS[scenario.id];
    if (!executor) {
      throw new Error(`No SIMULATION executor is registered for scenario: ${scenario.id}`);
    }

    const outcome = executor(new SyntheticSecurityTwin());

    return {
      id: createId('tst'),
      engagementId: engagement.id,
      testCategory: scenario.category as any,
      testScenario: scenario.id,
      target: engagement.authorizedTargets[0] || SYNTHETIC_TARGET,
      passed: outcome.passed,
      status: outcome.passed ? 'passed' : 'failed',
      observedBehavior: outcome.observedBehavior,
      evidence: {
        executionMode: SIMULATION_MODE,
        source: 'synthetic-digital-twin',
        ...outcome.evidence,
      },
      regressionTest: scenario.category === 'regression',
      createdAt: new Date(),
    };
  }

  private async executeLiveTest(
    engagement: RedTeamEngagement,
    scenario: SecurityTestScenario,
    config: LiveAdversarialTestConfig,
  ): Promise<AdversarialTestResult> {
    if (!this.liveSafetyDependencies) {
      throw new Error('LIVE_VALIDATION cannot start: centralized safety-controller dependencies are unavailable.');
    }
    if (!engagement.authorizationEvidenceId || engagement.authorizationEvidenceId !== config.authorizationEvidenceId) {
      throw new Error('LIVE_VALIDATION cannot start without matching explicit engagement authorization evidence.');
    }

    // Defense-in-depth: the safety controller re-checks target authorization on every
    // action, but a cheap independent check here means a misconfigured target never
    // even gets to controller construction. Category is deliberately NOT passed here —
    // it's already checked above with "empty allowedTestCategories means unrestricted"
    // semantics; ScopeGuard's own category check treats an empty list as "nothing
    // authorized," which would silently re-deny engagements the first check just admitted.
    const scopeDecision = this.scopeGuard.validate({
      engagement,
      agentId: 'adversarial-agent',
      requestedTarget: config.target,
      requestedAction: `live-scenario:${scenario.id}`,
    });
    if (!scopeDecision.authorized) {
      throw new Error(`ScopeGuard denied this live scenario: ${scopeDecision.reason}`);
    }

    const liveScenario = getLiveScenario(scenario.id);
    if (!liveScenario) {
      throw new Error(
        `No LIVE_VALIDATION executor is registered for scenario: ${scenario.id}. ` +
          'Use SIMULATION mode for this scenario, or add a live executor to security-scenario-registry.ts.',
      );
    }
    const fixtures = config.fixtures ?? {};
    const missingFixtures = liveScenario.requiredFixtures.filter((key) => !fixtures[key]);
    if (missingFixtures.length > 0) {
      throw new Error(`Scenario "${scenario.id}" requires fixtures: ${missingFixtures.join(', ')}.`);
    }

    // Risk level now carries real weight: it bounds limits and decides whether
    // autoApproveLevel1/2 can ever admit this scenario without a human approval.
    const policy = RISK_POLICIES[scenario.riskLevel];
    const autoApproved =
      (scenario.riskLevel === 'LEVEL_1_SAFE' && config.autoApproveLevel1) ||
      (scenario.riskLevel === 'LEVEL_2_CONTROLLED' && config.autoApproveLevel2);
    if (!policy.autoApprovable || !autoApproved) {
      if (!this.approvalGate) {
        throw new Error(
          `Scenario "${scenario.id}" (${scenario.riskLevel}) requires human approval, but no approval gate is configured.`,
        );
      }
      const approved = await this.approvalGate.requestApproval({
        runId: `${engagement.id}:${scenario.id}:${createId('run')}`,
        scenarioId: scenario.id,
        riskLevel: scenario.riskLevel,
        reason: `Live adversarial scenario "${scenario.name}" (${scenario.riskLevel}) requires approval.`,
        input: { target: config.target, engagementId: engagement.id },
      });
      if (!approved) {
        throw new Error(`Scenario "${scenario.id}" was not approved.`);
      }
    }

    const limits: LiveValidationLimits = {
      ...config.limits,
      maxActionCount: Math.min(
        config.limits.maxActionCount,
        engagement.requestLimit ?? config.limits.maxActionCount,
        policy.maxActionCount,
      ),
      maxConcurrency: Math.min(
        config.limits.maxConcurrency,
        engagement.concurrencyLimit ?? config.limits.maxConcurrency,
        config.maxConcurrentTests,
        policy.maxConcurrency,
      ),
      expiresAt: new Date(Math.min(config.limits.expiresAt.getTime(), engagement.expiresAt.getTime())),
      maxDurationMs: Math.min(config.limits.maxDurationMs, config.timeoutMs, policy.maxDurationMs),
    };

    const buildCtx: LiveScenarioBuildContext = { engagement, target: config.target, fixtures };
    const { action, expectedResult } = liveScenario.buildAction(buildCtx);
    const driver = liveScenario.buildDriver(buildCtx);

    const controller = await LiveValidationSafetyController.create(
      {
        mode: LIVE_VALIDATION_MODE,
        testId: `${engagement.id}:${scenario.id}`,
        operator: config.operator,
        authorizationEvidenceId: config.authorizationEvidenceId,
        authorizedScope: engagement.authorizedTargets,
        limits,
        healthThresholds: config.healthThresholds,
        heartbeatTimeoutMs: config.heartbeatTimeoutMs,
        hardNetworkStop: config.hardNetworkStop,
      },
      this.liveSafetyDependencies,
    );

    try {
      const liveResult = await controller.executeAction(
        {
          actionId: createId('act'),
          target: config.target,
          action,
          expectedResult,
        },
        driver,
      );
      const evaluation = liveScenario.evaluate(liveResult.observedResult, liveResult.expectedResult);
      await controller.end('Live adversarial scenario completed.');

      return {
        id: createId('tst'),
        engagementId: engagement.id,
        testCategory: scenario.category,
        testScenario: scenario.id,
        target: config.target,
        passed: evaluation.passed,
        status: evaluation.passed ? 'passed' : 'failed',
        observedBehavior: evaluation.reason,
        evidence: {
          executionMode: LIVE_VALIDATION_MODE,
          EXPECTED_RESULT: liveResult.expectedResult,
          OBSERVED_RESULT: liveResult.observedResult,
          observationSource: liveResult.observation.source,
          artifacts: liveResult.observation.artifacts,
          contactedTargets: liveResult.observation.contactedTargets,
          startedAt: liveResult.startedAt,
          endedAt: liveResult.endedAt,
        },
        regressionTest: scenario.category === 'regression',
        createdAt: new Date(),
      };
    } catch (error) {
      await controller.emergencyStop(
        `Live adversarial scenario failed: ${error instanceof Error ? error.message : String(error)}`,
        config.operator,
        config.hardNetworkStop,
      );
      throw error;
    }
  }
}
