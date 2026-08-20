/**
 * Defensive Testing Framework Types
 *
 * Types for control validation, anonymized source detection, red team blocking,
 * and defensive agent recommendations.
 */

/**
 * Defensive Control Test: Automated proof that security control works
 */
export interface DefensiveControlTest {
  id: string;
  testCategory: 'authentication' | 'authorization' | 'tenant-isolation' | 'rate-limit' | 'validation';
  testScenario: string;
  description: string;
  expectedBehavior: string;
  createdAt: Date;
}

/**
 * Result of running a defensive control test
 */
export interface DefensiveControlTestResult {
  id: string;
  testId: string;
  engagementId?: string;
  passed: boolean;
  observedBehavior: string;
  evidence: Record<string, unknown>;
  severityIfFailed?: 'critical' | 'high' | 'medium';
  executedAt: Date;
  createdAt: Date;
}

/**
 * Anonymized Source Detection: Tor/proxy/VPN request
 */
export interface AnonymizedSourceAudit {
  id: string;
  sourceIp: string;
  userAgent?: string;
  detectionMethod: 'tor-exit-node' | 'proxy-ip' | 'vpn-signature' | 'anonymity-service' | 'datacenter-range';
  classification: 'informational' | 'suspicious' | 'hostile';
  endpoint: string;
  requestedAt: Date;
  responseCode?: number;
  actionTaken?: 'logged' | 'throttled' | 'blocked' | 'challenged';
  engagementId?: string;
  createdAt: Date;
}

/**
 * Proof that Red Team attack was blocked
 */
export interface DefenseBlockingEvidence {
  id: string;
  engagementId: string;
  redTeamAction: string;
  scopeGuardReason: string;
  riskLevel?: 'LEVEL_1_SAFE' | 'LEVEL_2_CONTROLLED' | 'LEVEL_3_HIGH_IMPACT' | 'LEVEL_4_RESTRICTED';
  targetAttempted?: string;
  authorizationDeniedBecause?: string;
  auditLogEntry: Record<string, unknown>;
  blockedAt: Date;
  createdAt: Date;
}

/**
 * Defensive Recommendation: Blue team analysis and remediation suggestion
 */
export interface DefensiveRecommendation {
  id: string;
  engagementId?: string;
  findingId?: string;
  failedDefense: string;
  attackCategory: string;
  remediationPath: 'code-change' | 'config-hardening' | 'policy-update' | 'process-change';
  recommendation: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  effortEstimate?: 'trivial' | 'small' | 'medium' | 'large';
  proofOfConcept?: string;
  defensiveAgentId?: string;
  createdAt: Date;
  acceptedAt?: Date;
}

/**
 * Aggregated defensive posture health
 */
export interface DefensivePostureSummary {
  engagementId: string;
  controlTestsRun: number;
  controlTestsPassed: number;
  controlTestsFailed: number;
  anonymizedSourcesDetected: number;
  redTeamBlocks: number;
  defenseBlockingRate?: number; // percentage
  recommendationsGenerated: number;
  recommendationsAccepted: number;
  criticalGaps: number;
  overallPosture: 'unknown' | 'weak' | 'fair' | 'strong' | 'excellent';
  updatedAt: Date;
}

/**
 * Control Test Definition: Scenario to validate a security control
 */
export interface ControlTestScenario {
  id: string;
  category: 'authentication' | 'authorization' | 'tenant-isolation' | 'rate-limit' | 'validation';
  name: string;
  description: string;
  objective: string;
  setup: string;
  steps: string[];
  expectedOutcome: string;
  failureMeaning: string;
  severity: 'critical' | 'high' | 'medium';
}

/**
 * A single real HTTP check the operator supplies to exercise a control test
 * scenario against their own private-lab system under test. The executor
 * sends this request for real and grades it against passStatusCodes — it
 * never fabricates a response.
 */
export interface ControlTestHttpRequest {
  method: string;
  /** Must resolve to a private-lab address (RFC1918/loopback/link-local). */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Status codes that indicate the control is working as intended for this request. */
  passStatusCodes: number[];
}

export interface ControlTestExecutionContext {
  /** One or more real requests exercising this control; at least one is required. */
  requests: ControlTestHttpRequest[];
}

/**
 * Anonymized Source Detection Configuration
 */
export interface AnonymizedSourceDetectionConfig {
  enableTorDetection: boolean;
  enableProxyDetection: boolean;
  enableVpnDetection: boolean;
  /** Real signal, fetched periodically — see anonymized-source-feeds.ts. Weaker than a known
   *  proxy/VPN exit: it only means the request originated from a published cloud netblock. */
  enableDatacenterDetection: boolean;
  knownTorExitNodes: string[]; // List of known Tor exit node IPs
  knownProxyIps: string[];
  /** CIDR ranges (e.g. AWS's published ip-ranges.json), not individual addresses. */
  knownDatacenterRanges: string[];
  classificationRules: {
    singleRequestClassification: 'informational' | 'suspicious';
    patternDetectionThreshold: number; // requests per time window
    patternClassification: 'suspicious' | 'hostile';
  };
  responseActions: {
    informational: 'log' | 'challenge';
    suspicious: 'log' | 'throttle' | 'block';
    hostile: 'block' | 'challenge';
  };
}

/**
 * Red Team Blocking Verification Result
 */
export interface BlockingVerificationResult {
  engagementId: string;
  totalAttemptsGenerated: number;
  totalBlockedByScope: number;
  totalBlockedByRisk: number;
  totalBlockedByApproval: number;
  blockingSuccessRate: number; // percentage
  evidenceGenerated: number;
  proof: {
    scopeViolationBlocks: number;
    outOfScopeTargets: number;
    level4Denials: number;
    prohibitedActionBlocks: number;
  };
}

/**
 * Defensive Agent Analysis
 */
export interface DefensiveAgentAnalysis {
  engagementId: string;
  agentId: string;

  findingsAnalyzed: number;
  attacksObserved: number;

  defensesSucceeded: number;
  defensesFailed: number;

  rootCauseAnalysis: {
    category: string;
    failedControl: string;
    whyItFailed: string;
  }[];

  recommendations: DefensiveRecommendation[];
  severityDistribution: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };

  createdAt: Date;
}

/**
 * Defensive Posture Assessment
 */
export interface DefensivePostureAssessment {
  engagement: {
    id: string;
    customerId: string;
    status: string;
  };

  controlValidation: {
    testsRun: number;
    passed: number;
    failed: number;
    passRate: number;
  };

  sourceThreatDetection: {
    anonymizedSourcesDetected: number;
    classification: {
      informational: number;
      suspicious: number;
      hostile: number;
    };
  };

  redTeamBlocking: {
    attacks: number;
    blocked: number;
    blockRate: number;
  };

  defensiveAnalysis: {
    weaknessesIdentified: number;
    recommendationsGenerated: number;
    recommendationsAccepted: number;
  };

  overallGrade: 'F' | 'D' | 'C' | 'B' | 'A' | 'A+';
  postureHealth: 'critical' | 'weak' | 'fair' | 'strong' | 'excellent';
}
