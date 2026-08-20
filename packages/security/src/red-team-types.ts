/**
 * Red Team / Blue Team / Purple Team Security Testing Framework
 *
 * Defines domain types for authorized penetration testing, adversarial testing,
 * and collaborative security testing.
 */

/**
 * Engagement: a time-bounded, scope-limited, explicitly authorized security testing campaign
 */
export interface RedTeamEngagement {
  id: string;
  customerId: string;

  authorizedTargets: string[];
  authorizedEnvironments: string[];
  allowedTestCategories: string[];
  prohibitedActions: string[];

  startsAt: Date;
  expiresAt: Date;

  requestLimit?: number;
  concurrencyLimit?: number;

  humanApprover: string;
  authorizationEvidenceId?: string;

  rulesOfEngagement: RulesOfEngagement;
  scopeBreadth: 'defined' | 'broad' | 'internal-only';
  threatModelTags: string[];

  status: 'draft' | 'approved' | 'active' | 'paused' | 'completed' | 'revoked';

  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface RulesOfEngagement {
  allowedTechniques?: string[];
  forbiddenTechniques?: string[];
  dataHandling?: 'synthetic-only' | 'authorized-accounts' | 'test-tenants';
  rateLimits?: {
    maxRequestsPerSecond?: number;
    maxConcurrentRequests?: number;
  };
  stopConditions?: string[];
  escalationThresholds?: {
    severityLevel?: string;
    impactThreshold?: string;
  };
}

/**
 * Finding: a candidate vulnerability or weakness discovered during red team testing
 */
export interface RedTeamFinding {
  id: string;
  engagementId: string;

  title: string;
  description: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number; // 0.0 to 1.0

  findingType: 'vulnerability' | 'weakness' | 'misconfiguration' | 'design-flaw';
  attackVector?: 'network' | 'local' | 'adjacent' | 'physical';
  affectedComponents: string[];

  reproducibilitySteps?: string;
  impactAssessment?: string;
  exploitationDifficulty?: 'trivial' | 'easy' | 'moderate' | 'difficult' | 'impossible' | 'unknown';

  status: 'candidate' | 'verified' | 'false-positive' | 'remediated' | 'retested' | 'accepted-risk';
  judgeDecision?: string;
  judgeConfidence?: number;

  evidenceIds: string[];
  cveId?: string;

  createdAt: Date;
  verifiedAt?: Date;
  remediatedAt?: Date;
}

/**
 * Evidence: sanitized, auditable artifacts that prove a finding
 */
export interface RedTeamEvidence {
  id: string;
  findingId: string;
  engagementId: string;

  evidenceType: 'request-response' | 'log-excerpt' | 'state-diff' | 'screenshot' | 'network-capture' | 'code-sample';
  sanitizedPayload: Record<string, unknown>;
  timestamp: Date;

  agentId?: string;
  toolUsed?: string;
  targetSystem: string;

  proofOfImpact?: string;

  createdAt: Date;
}

/**
 * AttackPath: a chain of findings/observations that together form a composite attack
 */
export interface RedTeamAttackPath {
  id: string;
  engagementId: string;

  pathName: string;
  description: string;
  attackChain: string[]; // ordered list of finding IDs

  stepsToExploit: number;
  compositeSeverity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  compositeConfidence: number;

  exploitability: 'theoretical' | 'poc' | 'demonstrated' | 'weaponized';
  businessImpact?: string;
  remediationBlockingFinding?: string;

  createdAt: Date;
}

/**
 * ScopeViolation: when an agent attempts to act outside authorized scope
 */
export interface RedTeamScopeViolation {
  id: string;
  engagementId?: string;
  agentId: string;

  attemptedTarget: string;
  attemptedAction: string;
  policyRejection: string;
  reason: string;

  createdAt: Date;
}

/**
 * PurpleTeamObservation: synchronized red/blue observations during coordinated testing
 */
export interface PurpleTeamObservation {
  id: string;
  engagementId: string;

  redActionId?: string;
  blueObservation: string;

  attackSucceeded: boolean;
  wasDetected: boolean;
  wasBlocked: boolean;

  timeToDetection?: number; // milliseconds
  timeToResponse?: number; // milliseconds

  evidenceCollected: string[];
  detectionMethod?: string;
  remediationAction?: string;

  createdAt: Date;
}

/**
 * SecurityTestResult: result of an adversarial test scenario
 */
export interface AdversarialTestResult {
  id: string;
  engagementId?: string;

  testCategory:
    | 'authentication'
    | 'authorization'
    | 'tenant-isolation'
    | 'business-logic'
    | 'injection'
    | 'rate-limiting'
    | 'ai-security'
    | 'agentic-system'
    | 'regression'
    | 'regression';

  testScenario: string;
  target: string;

  passed: boolean;
  /**
   * 'blocked' means the safety envelope itself rejected the run (scope,
   * limits, missing approval/fixtures) before or during execution — evidence
   * the safety controls worked, not a defect. 'error' means an unexpected
   * driver/network failure. Optional for backward compatibility with rows
   * written before this field existed.
   */
  status?: 'passed' | 'failed' | 'error' | 'blocked';
  observedBehavior: string;
  evidence: Record<string, unknown>;

  regressionTest: boolean;
  previousIssueId?: string;

  createdAt: Date;
}

/**
 * SecurityTestSummary: aggregated statistics for an engagement
 */
export interface SecurityTestSummary {
  engagementId: string;

  totalTestAttempts: number;
  adversarialTestsRun: number;
  adversarialTestsPassed: number;

  findingsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;

  falsePositives: number;
  attackPathsFound: number;
  scopeViolations: number;

  purpleTeamExecutions: number;
  detectionRate?: number;
  blockRate?: number;
  meanTimeToDetection?: number; // milliseconds
  meanTimeToResponse?: number; // milliseconds

  updatedAt: Date;
}

/**
 * RedTeamToolAudit: every security-relevant tool call during engagement
 */
export interface RedTeamToolAudit {
  id: string;
  engagementId: string;
  agentId: string;

  toolName: string;
  proposedAction: string;

  scopeVerified: boolean;
  policyAllowed: boolean;
  executed: boolean;

  executionResult?: Record<string, unknown>;
  blockedReason?: string;

  createdAt: Date;
}

/**
 * RedTeamApproval: approval trail for engagement lifecycle events
 */
export interface RedTeamApproval {
  id: string;
  engagementId: string;

  approvalType: 'start' | 'step' | 'escalation' | 'expansion';
  decision: boolean;
  approver: string;
  reason?: string;

  requestedAt: Date;
  decidedAt: Date;
  createdAt: Date;
}

/**
 * EngagementAuthorizationContext: runtime context for authorization checks
 */
export interface EngagementAuthorizationContext {
  engagement: RedTeamEngagement;
  agentId: string;
  requestedTarget: string;
  requestedAction: string;
  requestedCategory?: string;
  proposedParameters?: Record<string, unknown>;
}

/**
 * ScopeGuardDecision: result of scope validation
 */
export interface ScopeGuardDecision {
  authorized: boolean;
  targetAuthorized: boolean;
  environmentAuthorized: boolean;
  categoryAuthorized: boolean;
  actionProhibited: boolean;
  withinTimeWindow: boolean;
  withinRequestLimit: boolean;
  withinConcurrencyLimit: boolean;
  reason?: string;
}

/**
 * RiskClassification: categorizes actions by their impact level
 */
export type RiskLevel = 'LEVEL_1_SAFE' | 'LEVEL_2_CONTROLLED' | 'LEVEL_3_HIGH_IMPACT' | 'LEVEL_4_RESTRICTED';

export interface RiskClassification {
  level: RiskLevel;
  description: string;
  requiresApproval: boolean;
  category: string;
}

/**
 * SecurityTestScenario: a defined test case for adversarial or red team testing
 */
export interface SecurityTestScenario {
  id: string;
  name: string;
  category:
    | 'authentication'
    | 'authorization'
    | 'tenant-isolation'
    | 'business-logic'
    | 'injection'
    | 'rate-limiting'
    | 'ai-security'
    | 'agentic-system'
    | 'regression';
  description: string;
  objective: string;
  preconditions: string[];
  steps: string[];
  successCriteria: string;
  riskLevel: RiskLevel;
  automatable: boolean;
}
