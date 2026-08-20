/**
 * Defensive Agent (Blue Team)
 *
 * Evidence-driven defensive security analysis.
 *
 * This agent DOES NOT simulate defensive outcomes.
 *
 * It consumes real Red Team findings and their recorded evidence, determines
 * which defensive control was exercised, obtains additional observations from
 * injected defensive inspectors when available, produces remediation plans,
 * and can verify remediation by re-running the exact authorized regression
 * scenario through an injected verifier.
 *
 * Important:
 * - No Math.random()
 * - No invented pass/fail state
 * - No fake detection rates
 * - No assumption that a false-positive means a defense blocked an attack
 * - No claim that remediation succeeded unless a real verification run proves it
 */

import type {
  RedTeamFinding,
  DefensiveRecommendation,
  DefensiveAgentAnalysis,
} from '@dacai-local-agent/security';

import {
  RedTeamFindingStore,
  createId,
} from '@dacai-local-agent/shared';

export type DefenseRootCause =
  | 'missing-validation'
  | 'missing-control'
  | 'control-bypass'
  | 'control-misconfiguration'
  | 'implementation-defect'
  | 'unknown';

export type DefensiveSeverity =
  | 'critical'
  | 'high'
  | 'medium'
  | 'low';

export type RemediationPath =
  | 'code-change'
  | 'config-hardening'
  | 'policy-update'
  | 'process-change';

export type VerificationOutcome =
  | 'blocked'
  | 'still-vulnerable'
  | 'inconclusive'
  | 'not-run';

export interface DefenseFailureAnalysis {
  findingId: string;
  category: string;
  failedControl: string;
  whyItFailed: string;
  rootCause: DefenseRootCause;
  severity: DefensiveSeverity;

  /**
   * Evidence supporting the analysis.
   *
   * This should describe observations, not model speculation.
   */
  evidence: string[];

  /**
   * Indicates whether the root cause was supported by actual inspection or is
   * only a candidate explanation.
   */
  confidence: 'verified' | 'supported' | 'candidate';
}

export interface RemediationStrategy {
  findingId: string;
  failedDefense: string;
  remediationPath: RemediationPath;
  recommendation: string;
  effortEstimate: 'trivial' | 'small' | 'medium' | 'large';

  /**
   * Instructions for proving the remediation rather than a fabricated PoC.
   */
  verificationPlan: string[];

  status: 'proposed' | 'approved' | 'implemented' | 'verified';
}

export interface DefensiveInspectionContext {
  engagementId: string;
  finding: RedTeamFinding;
}

export interface DefensiveControlObservation {
  control: string;
  category: string;

  /**
   * Whether inspection found the control at all.
   */
  controlPresent: boolean;

  /**
   * Whether configuration/implementation appears consistent with policy.
   */
  correctlyConfigured?: boolean;

  /**
   * Actual observations produced by inspection.
   */
  evidence: string[];

  /**
   * Optional root cause established by the inspector.
   */
  rootCause?: DefenseRootCause;

  /**
   * Optional human-readable explanation derived from inspected evidence.
   */
  explanation?: string;
}

/**
 * Pluggable inspector for real defensive controls.
 *
 * Implementations may inspect:
 * - application configuration
 * - authorization policy
 * - middleware registration
 * - rate-limit configuration
 * - workspace permission rules
 * - agent tool permissions
 * - validation schemas
 * - security logs
 *
 * The inspector is read-only unless separately authorized elsewhere.
 */
export interface DefensiveControlInspector {
  inspect(
    context: DefensiveInspectionContext,
  ): Promise<DefensiveControlObservation | null>;
}

export interface RegressionVerificationRequest {
  engagementId: string;
  findingId: string;

  /**
   * The exact red-team scenario that originally produced the finding.
   */
  scenarioId: string;
}

export interface RegressionVerificationResult {
  outcome: VerificationOutcome;

  /**
   * Real observations returned by the Red Team / scenario executor.
   */
  evidence: string[];

  observedAt: Date;
}

/**
 * This must call the real, authorized adversarial scenario executor.
 *
 * It must never manufacture a result.
 */
export interface DefensiveRegressionVerifier {
  verify(
    request: RegressionVerificationRequest,
  ): Promise<RegressionVerificationResult>;
}

interface DefenseMapping {
  control: string;
  category: string;
}

const FINDING_TO_DEFENSE_MAP: Record<string, DefenseMapping> = {
  'authentication-bypass': {
    control: 'Authentication',
    category: 'authentication',
  },

  'authorization-bypass': {
    control: 'Authorization',
    category: 'authorization',
  },

  'tenant-isolation-breach': {
    control: 'Tenant Isolation',
    category: 'tenant-isolation',
  },

  'sql-injection': {
    control: 'Input Validation / Parameterized Database Access',
    category: 'validation',
  },

  'prompt-injection': {
    control: 'Agent Instruction / Tool Authorization Boundary',
    category: 'ai-security',
  },

  'privilege-escalation': {
    control: 'Role and Permission Enforcement',
    category: 'authorization',
  },

  'rate-limit-bypass': {
    control: 'Rate Limiting',
    category: 'rate-limit',
  },

  'business-logic-flaw': {
    control: 'Business Logic Validation',
    category: 'business-logic',
  },
};

export interface AnalyzeEngagementOptions {
  /**
   * Run real defensive-control inspection where an inspector is configured.
   */
  inspectControls?: boolean;

  /**
   * Re-run verified findings through the authorized regression verifier.
   *
   * Normally use this AFTER remediation.
   */
  verifyFindings?: boolean;
}

export interface DefenseSuccessAnalysis {
  blockedAttacks: string[];
  verifiedVulnerabilities: string[];
  falsePositives: string[];
  inconclusive: string[];

  totalObserved: number;

  /**
   * Percentage is null when the available findings do not contain enough
   * information to establish the metric.
   */
  blockRate: number | null;
}

/**
 * DefensiveAgent
 *
 * Analyzes real findings generated by the Red Team.
 *
 * It does not create fake observations and does not infer that a defense
 * succeeded merely because a finding was classified as a false positive.
 */
export class DefensiveAgent {
  constructor(
    private readonly agentId: string,
    private readonly findingStore: RedTeamFindingStore,
    private readonly inspector?: DefensiveControlInspector,
    private readonly regressionVerifier?: DefensiveRegressionVerifier,
  ) {}

  /**
   * Analyze all real findings associated with an engagement.
   */
  async analyzeEngagement(
    engagementId: string,
    options: AnalyzeEngagementOptions = {},
  ): Promise<DefensiveAgentAnalysis> {
    const findings =
      await this.findingStore.listByEngagement(engagementId);

    const defensiveAnalysis: DefenseFailureAnalysis[] = [];
    const recommendations: DefensiveRecommendation[] = [];

    const actionableFindings = findings.filter(
      (finding) =>
        finding.status === 'verified' ||
        finding.status === 'candidate',
    );

    for (const finding of actionableFindings) {
      const analysis = await this.analyzeFinding(
        engagementId,
        finding,
        options.inspectControls ?? true,
      );

      defensiveAnalysis.push(analysis);

      const recommendation =
        this.generateRecommendation(finding, analysis);

      recommendations.push(recommendation);

      if (
        options.verifyFindings &&
        finding.status === 'verified' &&
        this.regressionVerifier
      ) {
        await this.verifyFinding(
          engagementId,
          finding,
        );
      }
    }

    const severityDistribution = {
      critical: recommendations.filter(
        (r) => r.severity === 'critical',
      ).length,

      high: recommendations.filter(
        (r) => r.severity === 'high',
      ).length,

      medium: recommendations.filter(
        (r) => r.severity === 'medium',
      ).length,

      low: recommendations.filter(
        (r) => r.severity === 'low',
      ).length,
    };

    const defensiveOutcome =
      analyzeDefenseSuccess(findings);

    return {
      engagementId,
      agentId: this.agentId,

      /**
       * Report only findings actually analyzed.
       */
      findingsAnalyzed: actionableFindings.length,

      /**
       * Do not claim every stored finding is an attack.
       *
       * Candidate/verified findings represent actual suspicious observations.
       */
      attacksObserved:
        findings.filter(
          (finding) =>
            finding.status === 'verified' ||
            finding.status === 'candidate',
        ).length,

      /**
       * A false-positive is NOT proof that a defense succeeded.
       *
       * Only explicitly recorded blocked outcomes should count.
       */
      defensesSucceeded:
        defensiveOutcome.blockedAttacks.length,

      defensesFailed:
        findings.filter(
          (finding) => finding.status === 'verified',
        ).length,

      rootCauseAnalysis: defensiveAnalysis,
      recommendations,
      severityDistribution,

      createdAt: new Date(),
    };
  }

  /**
   * Analyze one finding from actual recorded evidence.
   */
  private async analyzeFinding(
    engagementId: string,
    finding: RedTeamFinding,
    inspectControl: boolean,
  ): Promise<DefenseFailureAnalysis> {
    const mapping =
      FINDING_TO_DEFENSE_MAP[finding.findingType] ?? {
        control: finding.findingType,
        category: 'general',
      };

    let observation:
      | DefensiveControlObservation
      | null = null;

    if (inspectControl && this.inspector) {
      observation = await this.inspector.inspect({
        engagementId,
        finding,
      });
    }

    /*
     * If a real inspector established a root cause, use it.
     *
     * Otherwise classify only what the finding evidence supports and mark the
     * conclusion as candidate rather than pretending it was proven.
     */

    if (observation) {
      const rootCause =
        observation.rootCause ??
        this.rootCauseFromObservation(observation);

      return {
        findingId: finding.id,

        category:
          observation.category || mapping.category,

        failedControl:
          observation.control || mapping.control,

        whyItFailed:
          observation.explanation ??
          this.describeObservedFailure(
            observation.control || mapping.control,
            rootCause,
          ),

        rootCause,

        severity: this.normalizeSeverity(
          finding.severity,
        ),

        evidence: observation.evidence,

        confidence:
          observation.rootCause
            ? 'verified'
            : 'supported',
      };
    }

    /*
     * No inspector means we MUST NOT claim to have proven a root cause.
     */

    return {
      findingId: finding.id,

      category: mapping.category,

      failedControl: mapping.control,

      whyItFailed:
        `The Red Team finding "${finding.findingType}" indicates that ` +
        `${mapping.control} did not prevent the observed behavior. ` +
        'The exact implementation-level root cause has not yet been inspected.',

      rootCause:
        this.candidateRootCause(finding.findingType),

      severity:
        this.normalizeSeverity(finding.severity),

      evidence:
        this.extractFindingEvidence(finding),

      confidence: 'candidate',
    };
  }

  private rootCauseFromObservation(
    observation: DefensiveControlObservation,
  ): DefenseRootCause {
    if (!observation.controlPresent) {
      return 'missing-control';
    }

    if (
      observation.correctlyConfigured === false
    ) {
      return 'control-misconfiguration';
    }

    return 'unknown';
  }

  /**
   * Used only when no real inspector could establish the root cause.
   *
   * The result remains explicitly marked "candidate".
   */
  private candidateRootCause(
    findingType: string,
  ): DefenseRootCause {
    if (findingType.includes('bypass')) {
      return 'control-bypass';
    }

    if (
      findingType.includes('missing') ||
      findingType.includes('insufficient')
    ) {
      return 'missing-control';
    }

    if (findingType.includes('injection')) {
      return 'missing-validation';
    }

    return 'unknown';
  }

  private describeObservedFailure(
    control: string,
    rootCause: DefenseRootCause,
  ): string {
    switch (rootCause) {
      case 'missing-control':
        return `${control} was not present on the inspected execution path.`;

      case 'missing-validation':
        return `${control} did not validate the observed input sufficiently.`;

      case 'control-bypass':
        return `${control} was present but the observed execution path bypassed it.`;

      case 'control-misconfiguration':
        return `${control} was present but its inspected configuration did not enforce the expected policy.`;

      case 'implementation-defect':
        return `${control} was present but inspection identified an implementation defect.`;

      default:
        return `${control} failed to prevent the observed behavior; further inspection is required to establish the precise root cause.`;
    }
  }

  private generateRecommendation(
    finding: RedTeamFinding,
    analysis: DefenseFailureAnalysis,
  ): DefensiveRecommendation {
    const remediationPath =
      this.determineRemediationPath(analysis);

    return {
      id: createId('rec'),
      findingId: finding.id,
      failedDefense: analysis.failedControl,
      attackCategory: finding.findingType,

      remediationPath,

      recommendation:
        this.buildRecommendation(
          finding,
          analysis,
          remediationPath,
        ),

      severity: analysis.severity,

      effortEstimate:
        this.estimateEffort(analysis.rootCause),

      /*
       * This is a verification procedure, not a fabricated exploit.
       */
      proofOfConcept:
        this.buildVerificationPlan(
          finding,
          analysis,
        ).join('\n'),

      defensiveAgentId: this.agentId,

      createdAt: new Date(),
    };
  }

  private determineRemediationPath(
    analysis: DefenseFailureAnalysis,
  ): RemediationPath {
    switch (analysis.rootCause) {
      case 'control-misconfiguration':
        return 'config-hardening';

      case 'missing-validation':
      case 'missing-control':
      case 'control-bypass':
      case 'implementation-defect':
        return 'code-change';

      case 'unknown':
      default:
        /*
         * Do not pretend we know the remediation before root-cause inspection.
         */
        return 'process-change';
    }
  }

  private buildRecommendation(
    finding: RedTeamFinding,
    analysis: DefenseFailureAnalysis,
    path: RemediationPath,
  ): string {
    const base =
      `Address ${analysis.failedControl} for verified/candidate finding ` +
      `"${finding.findingType}".`;

    switch (path) {
      case 'code-change':
        return (
          `${base} Inspect the affected execution path using the recorded ` +
          `finding evidence, correct the ${analysis.rootCause} condition, ` +
          'add a regression test reproducing the original observation, and ' +
          're-run the authorized Red Team scenario.'
        );

      case 'config-hardening':
        return (
          `${base} Correct the inspected ${analysis.failedControl} ` +
          'configuration, validate the effective runtime configuration, and ' +
          're-run the original authorized scenario.'
        );

      case 'policy-update':
        return (
          `${base} Update the controlling security policy and verify that ` +
          'runtime enforcement matches the updated policy.'
        );

      case 'process-change':
      default:
        return (
          `${base} The implementation-level root cause has not been proven. ` +
          'Inspect the affected control before modifying production behavior, ' +
          'then create and execute a regression verification.'
        );
    }
  }

  private estimateEffort(
    rootCause: DefenseRootCause,
  ): 'trivial' | 'small' | 'medium' | 'large' {
    switch (rootCause) {
      case 'control-misconfiguration':
        return 'small';

      case 'missing-validation':
        return 'small';

      case 'missing-control':
        return 'medium';

      case 'implementation-defect':
        return 'medium';

      case 'control-bypass':
        return 'large';

      case 'unknown':
      default:
        return 'medium';
    }
  }

  private buildVerificationPlan(
    finding: RedTeamFinding,
    analysis: DefenseFailureAnalysis,
  ): string[] {
    const steps: string[] = [];

    steps.push(
      `1. Reproduce the original Red Team finding "${finding.id}" using its recorded engagement scenario.`,
    );

    if (finding.reproducibilitySteps) {
      steps.push(
        `2. Original reproduction evidence: ${finding.reproducibilitySteps}`,
      );
    } else {
      steps.push(
        '2. Use the original scenario ID and recorded evidence; do not construct a new unscoped test.',
      );
    }

    steps.push(
      `3. Apply the remediation for ${analysis.failedControl}.`,
    );

    steps.push(
      '4. Re-run the exact authorized scenario through the Red Team scenario executor.',
    );

    steps.push(
      '5. Mark the remediation verified only if the real observed result shows the original behavior is blocked.',
    );

    return steps;
  }

  /**
   * Re-run the real authorized Red Team scenario.
   *
   * This is the step that turns Blue Team verification into real evidence.
   */
  async verifyFinding(
    engagementId: string,
    finding: RedTeamFinding,
  ): Promise<RegressionVerificationResult> {
    if (!this.regressionVerifier) {
      return {
        outcome: 'not-run',
        evidence: [
          'No DefensiveRegressionVerifier is configured.',
        ],
        observedAt: new Date(),
      };
    }

    /*
     * Assumes testScenario/scenarioId is present in your finding model.
     * If your actual RedTeamFinding type stores it under a different field,
     * connect that field here.
     */
    const scenarioId =
      this.getFindingScenarioId(finding);

    if (!scenarioId) {
      return {
        outcome: 'inconclusive',
        evidence: [
          `Finding "${finding.id}" does not contain the original scenario identifier.`,
        ],
        observedAt: new Date(),
      };
    }

    return this.regressionVerifier.verify({
      engagementId,
      findingId: finding.id,
      scenarioId,
    });
  }

  private getFindingScenarioId(
    finding: RedTeamFinding,
  ): string | undefined {
    const record =
      finding as unknown as Record<string, unknown>;

    const candidate =
      record.scenarioId ??
      record.testScenario ??
      record.scenario;

    return typeof candidate === 'string'
      ? candidate
      : undefined;
  }

  /**
   * Extract only evidence that was actually recorded on the finding.
   */
  private extractFindingEvidence(
    finding: RedTeamFinding,
  ): string[] {
    const result: string[] = [];

    if (finding.reproducibilitySteps) {
      result.push(
        `Reproduction: ${finding.reproducibilitySteps}`,
      );
    }

    const record =
      finding as unknown as Record<string, unknown>;

    if (record.evidence !== undefined) {
      try {
        result.push(
          `Recorded evidence: ${JSON.stringify(record.evidence)}`,
        );
      } catch {
        result.push(
          'Recorded evidence exists but could not be serialized.',
        );
      }
    }

    if (result.length === 0) {
      result.push(
        'No detailed evidence was attached to this finding; root-cause analysis requires additional inspection.',
      );
    }

    return result;
  }

  private normalizeSeverity(
    severity: unknown,
  ): DefensiveSeverity {
    switch (severity) {
      case 'critical':
      case 'high':
      case 'medium':
      case 'low':
        return severity;

      default:
        return 'medium';
    }
  }
}

/**
 * Analyze actual finding outcomes.
 *
 * IMPORTANT:
 *
 * A "false-positive" does NOT mean the defense successfully blocked an attack.
 * It means the reported finding was determined not to represent a real
 * vulnerability.
 *
 * A successful defensive block must therefore be represented explicitly in the
 * evidence/status model.
 */
export function analyzeDefenseSuccess(
  findings: RedTeamFinding[],
): DefenseSuccessAnalysis {
  const blockedAttacks: string[] = [];
  const verifiedVulnerabilities: string[] = [];
  const falsePositives: string[] = [];
  const inconclusive: string[] = [];

  for (const finding of findings) {
    const record =
      finding as unknown as Record<string, unknown>;

    if (
      record.outcome === 'blocked' ||
      record.defenseOutcome === 'blocked'
    ) {
      blockedAttacks.push(finding.title);
      continue;
    }

    switch (finding.status) {
      case 'verified':
        verifiedVulnerabilities.push(
          finding.title,
        );
        break;

      case 'false-positive':
        falsePositives.push(
          finding.title,
        );
        break;

      case 'candidate':
      default:
        inconclusive.push(
          finding.title,
        );
        break;
    }
  }

  const observedSecurityTests =
    blockedAttacks.length +
    verifiedVulnerabilities.length;

  const blockRate =
    observedSecurityTests === 0
      ? null
      : (blockedAttacks.length /
          observedSecurityTests) *
        100;

  return {
    blockedAttacks,
    verifiedVulnerabilities,
    falsePositives,
    inconclusive,

    totalObserved: findings.length,

    blockRate,
  };
}