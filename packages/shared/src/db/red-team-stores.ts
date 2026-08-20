/**
 * Red Team Persistence Layer
 *
 * Stores and retrieves red team engagements, findings, evidence, and audit data
 * from PostgreSQL.
 */

import { getPool } from './pool.js';
import { createId } from '../utils.js';
import type {
  RedTeamEngagement,
  RedTeamFinding,
  RedTeamEvidence,
  AdversarialTestResult,
  SecurityTestSummary,
  RedTeamApproval,
} from '@dacai-local-agent/security';

export class RedTeamEngagementStore {
  async create(engagement: Omit<RedTeamEngagement, 'id' | 'createdAt' | 'updatedAt'>): Promise<RedTeamEngagement> {
    const pool = getPool();
    const id = createId('eng');
    const now = new Date();

    const result = await pool.query(
      `
      INSERT INTO red_team_engagements (
        id, customer_id, authorized_targets, authorized_environments,
        allowed_test_categories, prohibited_actions, starts_at, expires_at,
        human_approver, authorization_evidence_id, status, request_limit,
        concurrency_limit, rules_of_engagement, scope_breadth, threat_model_tags,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
      RETURNING *
      `,
      [
        id,
        engagement.customerId,
        JSON.stringify(engagement.authorizedTargets),
        JSON.stringify(engagement.authorizedEnvironments),
        JSON.stringify(engagement.allowedTestCategories),
        JSON.stringify(engagement.prohibitedActions),
        engagement.startsAt,
        engagement.expiresAt,
        engagement.humanApprover,
        engagement.authorizationEvidenceId ?? null,
        engagement.status,
        engagement.requestLimit ?? null,
        engagement.concurrencyLimit ?? null,
        JSON.stringify(engagement.rulesOfEngagement),
        engagement.scopeBreadth,
        JSON.stringify(engagement.threatModelTags),
        now,
        now,
      ],
    );

    const row = result.rows[0];
    return this.rowToEngagement(row);
  }

  async get(id: string): Promise<RedTeamEngagement | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM red_team_engagements WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToEngagement(result.rows[0]);
  }

  async list(customerId: string, status?: string): Promise<RedTeamEngagement[]> {
    const pool = getPool();
    let query = 'SELECT * FROM red_team_engagements WHERE customer_id = $1';
    const params: unknown[] = [customerId];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    return result.rows.map((row) => this.rowToEngagement(row));
  }

  async updateStatus(id: string, status: RedTeamEngagement['status']): Promise<void> {
    const pool = getPool();
    await pool.query('UPDATE red_team_engagements SET status = $1, updated_at = now() WHERE id = $2', [status, id]);
  }

  private rowToEngagement(row: Record<string, unknown>): RedTeamEngagement {
    return {
      id: row.id as string,
      customerId: row.customer_id as string,
      authorizedTargets: row.authorized_targets as string[],
      authorizedEnvironments: row.authorized_environments as string[],
      allowedTestCategories: row.allowed_test_categories as string[],
      prohibitedActions: row.prohibited_actions as string[],
      startsAt: new Date(row.starts_at as string),
      expiresAt: new Date(row.expires_at as string),
      requestLimit: row.request_limit as number | undefined,
      concurrencyLimit: row.concurrency_limit as number | undefined,
      humanApprover: row.human_approver as string,
      authorizationEvidenceId: row.authorization_evidence_id as string | undefined,
      rulesOfEngagement: row.rules_of_engagement as RedTeamEngagement['rulesOfEngagement'],
      scopeBreadth: row.scope_breadth as RedTeamEngagement['scopeBreadth'],
      threatModelTags: row.threat_model_tags as string[],
      status: row.status as RedTeamEngagement['status'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    };
  }
}

export class RedTeamFindingStore {
  async create(finding: Omit<RedTeamFinding, 'id' | 'createdAt'>): Promise<RedTeamFinding> {
    const pool = getPool();
    const id = createId('fnd');
    const now = new Date();

    const result = await pool.query(
      `
      INSERT INTO red_team_findings (
        id, engagement_id, title, description, severity, confidence,
        finding_type, attack_vector, affected_components, reproducibility_steps,
        impact_assessment, exploitation_difficulty, status, judge_decision,
        judge_confidence, evidence_ids, cve_id, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
      RETURNING *
      `,
      [
        id,
        finding.engagementId,
        finding.title,
        finding.description,
        finding.severity,
        finding.confidence,
        finding.findingType,
        finding.attackVector ?? null,
        JSON.stringify(finding.affectedComponents),
        finding.reproducibilitySteps ?? null,
        finding.impactAssessment ?? null,
        finding.exploitationDifficulty ?? null,
        finding.status,
        finding.judgeDecision ?? null,
        finding.judgeConfidence ?? null,
        JSON.stringify(finding.evidenceIds),
        finding.cveId ?? null,
        now,
      ],
    );

    const row = result.rows[0];
    return this.rowToFinding(row);
  }

  async get(id: string): Promise<RedTeamFinding | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM red_team_findings WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToFinding(result.rows[0]);
  }

  async listByEngagement(engagementId: string): Promise<RedTeamFinding[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM red_team_findings WHERE engagement_id = $1 ORDER BY created_at DESC',
      [engagementId],
    );
    return result.rows.map((row) => this.rowToFinding(row));
  }

  async updateStatus(id: string, status: RedTeamFinding['status']): Promise<void> {
    const pool = getPool();
    await pool.query('UPDATE red_team_findings SET status = $1 WHERE id = $2', [status, id]);
  }

  private rowToFinding(row: Record<string, unknown>): RedTeamFinding {
    return {
      id: row.id as string,
      engagementId: row.engagement_id as string,
      title: row.title as string,
      description: row.description as string,
      severity: row.severity as RedTeamFinding['severity'],
      confidence: row.confidence as number,
      findingType: row.finding_type as RedTeamFinding['findingType'],
      attackVector: row.attack_vector as RedTeamFinding['attackVector'],
      affectedComponents: row.affected_components as string[],
      reproducibilitySteps: row.reproducibility_steps as string | undefined,
      impactAssessment: row.impact_assessment as string | undefined,
      exploitationDifficulty: row.exploitation_difficulty as RedTeamFinding['exploitationDifficulty'],
      status: row.status as RedTeamFinding['status'],
      judgeDecision: row.judge_decision as string | undefined,
      judgeConfidence: row.judge_confidence as number | undefined,
      evidenceIds: row.evidence_ids as string[],
      cveId: row.cve_id as string | undefined,
      createdAt: new Date(row.created_at as string),
      verifiedAt: row.verified_at ? new Date(row.verified_at as string) : undefined,
      remediatedAt: row.remediated_at ? new Date(row.remediated_at as string) : undefined,
    };
  }
}

export class RedTeamEvidenceStore {
  async create(evidence: Omit<RedTeamEvidence, 'id' | 'createdAt'>): Promise<RedTeamEvidence> {
    const pool = getPool();
    const id = createId('evt');
    const now = new Date();

    const result = await pool.query(
      `
      INSERT INTO red_team_evidence (
        id, finding_id, engagement_id, evidence_type, sanitized_payload,
        timestamp, agent_id, tool_used, target_system, proof_of_impact, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
      RETURNING *
      `,
      [
        id,
        evidence.findingId,
        evidence.engagementId,
        evidence.evidenceType,
        JSON.stringify(evidence.sanitizedPayload),
        evidence.timestamp,
        evidence.agentId ?? null,
        evidence.toolUsed ?? null,
        evidence.targetSystem,
        evidence.proofOfImpact ?? null,
        now,
      ],
    );

    const row = result.rows[0];
    return this.rowToEvidence(row);
  }

  async listByFinding(findingId: string): Promise<RedTeamEvidence[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM red_team_evidence WHERE finding_id = $1 ORDER BY created_at DESC',
      [findingId],
    );
    return result.rows.map((row) => this.rowToEvidence(row));
  }

  private rowToEvidence(row: Record<string, unknown>): RedTeamEvidence {
    return {
      id: row.id as string,
      findingId: row.finding_id as string,
      engagementId: row.engagement_id as string,
      evidenceType: row.evidence_type as RedTeamEvidence['evidenceType'],
      sanitizedPayload: row.sanitized_payload as Record<string, unknown>,
      timestamp: new Date(row.timestamp as string),
      agentId: row.agent_id as string | undefined,
      toolUsed: row.tool_used as string | undefined,
      targetSystem: row.target_system as string,
      proofOfImpact: row.proof_of_impact as string | undefined,
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class AdversarialTestResultStore {
  async create(result: Omit<AdversarialTestResult, 'id' | 'createdAt'>): Promise<AdversarialTestResult> {
    const pool = getPool();
    const id = createId('tst');
    const now = new Date();

    const queryResult = await pool.query(
      `
      INSERT INTO adversarial_test_results (
        id, engagement_id, test_category, test_scenario, target,
        passed, status, observed_behavior, evidence, regression_test, previous_issue_id, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      RETURNING *
      `,
      [
        id,
        result.engagementId ?? null,
        result.testCategory,
        result.testScenario,
        result.target,
        result.passed,
        result.status ?? (result.passed ? 'passed' : 'failed'),
        result.observedBehavior,
        JSON.stringify(result.evidence),
        result.regressionTest,
        result.previousIssueId ?? null,
        now,
      ],
    );

    const row = queryResult.rows[0];
    return this.rowToResult(row);
  }

  async listByEngagement(engagementId: string): Promise<AdversarialTestResult[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM adversarial_test_results WHERE engagement_id = $1 ORDER BY created_at DESC',
      [engagementId],
    );
    return result.rows.map((row) => this.rowToResult(row));
  }

  private rowToResult(row: Record<string, unknown>): AdversarialTestResult {
    return {
      id: row.id as string,
      engagementId: row.engagement_id as string | undefined,
      testCategory: row.test_category as AdversarialTestResult['testCategory'],
      testScenario: row.test_scenario as string,
      target: row.target as string,
      passed: row.passed as boolean,
      status: row.status as AdversarialTestResult['status'],
      observedBehavior: row.observed_behavior as string,
      evidence: row.evidence as Record<string, unknown>,
      regressionTest: row.regression_test as boolean,
      previousIssueId: row.previous_issue_id as string | undefined,
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class RedTeamApprovalStore {
  async create(approval: Omit<RedTeamApproval, 'id' | 'createdAt'>): Promise<RedTeamApproval> {
    const pool = getPool();
    const id = createId('apr');
    const now = new Date();

    const result = await pool.query(
      `
      INSERT INTO red_team_approvals (
        id, engagement_id, approval_type, decision, approver, reason,
        requested_at, decided_at, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )
      RETURNING *
      `,
      [
        id,
        approval.engagementId,
        approval.approvalType,
        approval.decision,
        approval.approver,
        approval.reason ?? null,
        approval.requestedAt,
        approval.decidedAt,
        now,
      ],
    );

    return this.rowToApproval(result.rows[0]);
  }

  async get(id: string): Promise<RedTeamApproval | null> {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM red_team_approvals WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToApproval(result.rows[0]);
  }

  async listByEngagement(engagementId: string): Promise<RedTeamApproval[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM red_team_approvals WHERE engagement_id = $1 ORDER BY created_at DESC',
      [engagementId],
    );
    return result.rows.map((row) => this.rowToApproval(row));
  }

  private rowToApproval(row: Record<string, unknown>): RedTeamApproval {
    return {
      id: row.id as string,
      engagementId: row.engagement_id as string,
      approvalType: row.approval_type as RedTeamApproval['approvalType'],
      decision: row.decision as boolean,
      approver: row.approver as string,
      reason: (row.reason as string | undefined) ?? undefined,
      requestedAt: new Date(row.requested_at as string),
      decidedAt: new Date(row.decided_at as string),
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class SecurityTestSummaryStore {
  async getOrCreate(engagementId: string): Promise<SecurityTestSummary> {
    const pool = getPool();
    const existing = await pool.query(
      'SELECT * FROM security_test_summaries WHERE engagement_id = $1',
      [engagementId],
    );

    if (existing.rows.length > 0) {
      return this.rowToSummary(existing.rows[0]);
    }

    const createResult = await pool.query(
      `
      INSERT INTO security_test_summaries (id, engagement_id)
      VALUES ($1, $2)
      RETURNING *
      `,
      [createId('sum'), engagementId],
    );

    return this.rowToSummary(createResult.rows[0]);
  }

  private rowToSummary(row: Record<string, unknown>): SecurityTestSummary {
    return {
      engagementId: row.engagement_id as string,
      totalTestAttempts: row.total_test_attempts as number,
      adversarialTestsRun: row.adversarial_tests_run as number,
      adversarialTestsPassed: row.adversarial_tests_passed as number,
      findingsCount: row.findings_count as number,
      criticalCount: row.critical_count as number,
      highCount: row.high_count as number,
      mediumCount: row.medium_count as number,
      lowCount: row.low_count as number,
      infoCount: row.info_count as number,
      falsePositives: row.false_positives as number,
      attackPathsFound: row.attack_paths_found as number,
      scopeViolations: row.scope_violations as number,
      purpleTeamExecutions: row.purple_team_executions as number,
      detectionRate: row.detection_rate as number | undefined,
      blockRate: row.block_rate as number | undefined,
      meanTimeToDetection: row.mean_time_to_detection as number | undefined,
      meanTimeToResponse: row.mean_time_to_response as number | undefined,
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

