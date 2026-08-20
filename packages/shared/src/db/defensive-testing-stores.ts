/**
 * Defensive Testing Persistence Layer
 *
 * Stores for control tests, anonymized source detection, blocking evidence,
 * recommendations, and posture summaries.
 */

import { getPool } from './pool.js';
import { createId } from '../utils.js';
import type {
  DefensiveControlTest,
  DefensiveControlTestResult,
  AnonymizedSourceAudit,
  DefenseBlockingEvidence,
  DefensiveRecommendation,
  DefensivePostureSummary,
} from '@dacai-local-agent/security';

export class DefensiveControlTestStore {
  async create(test: Omit<DefensiveControlTest, 'id' | 'createdAt'>): Promise<DefensiveControlTest> {
    const pool = getPool();
    const id = createId('dct');

    const result = await pool.query(
      `
      INSERT INTO defensive_control_tests (id, test_category, test_scenario, description, created_at)
      VALUES ($1, $2, $3, $4, now())
      RETURNING *
      `,
      [id, test.testCategory, test.testScenario, test.description],
    );

    return this.rowToTest(result.rows[0]);
  }

  async list(category?: string): Promise<DefensiveControlTest[]> {
    const pool = getPool();
    let query = 'SELECT * FROM defensive_control_tests';
    const params: unknown[] = [];

    if (category) {
      query += ' WHERE test_category = $1';
      params.push(category);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    return result.rows.map((row) => this.rowToTest(row));
  }

  private rowToTest(row: Record<string, unknown>): DefensiveControlTest {
    return {
      id: row.id as string,
      testCategory: row.test_category as DefensiveControlTest['testCategory'],
      testScenario: row.test_scenario as string,
      description: row.description as string,
      expectedBehavior: row.expected_behavior as string,
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class DefensiveControlTestResultStore {
  async create(result: Omit<DefensiveControlTestResult, 'id' | 'createdAt'>): Promise<DefensiveControlTestResult> {
    const pool = getPool();
    const id = createId('dctr');

    const queryResult = await pool.query(
      `
      INSERT INTO defensive_control_test_results (id, test_id, engagement_id, passed, observed_behavior, evidence, severity_if_failed, executed_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      RETURNING *
      `,
      [
        id,
        result.testId,
        result.engagementId ?? null,
        result.passed,
        result.observedBehavior,
        JSON.stringify(result.evidence),
        result.severityIfFailed ?? null,
        result.executedAt,
      ],
    );

    return this.rowToResult(queryResult.rows[0]);
  }

  async listByTest(testId: string): Promise<DefensiveControlTestResult[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM defensive_control_test_results WHERE test_id = $1 ORDER BY created_at DESC',
      [testId],
    );
    return result.rows.map((row) => this.rowToResult(row));
  }

  private rowToResult(row: Record<string, unknown>): DefensiveControlTestResult {
    return {
      id: row.id as string,
      testId: row.test_id as string,
      engagementId: row.engagement_id as string | undefined,
      passed: row.passed as boolean,
      observedBehavior: row.observed_behavior as string,
      evidence: row.evidence as Record<string, unknown>,
      severityIfFailed: row.severity_if_failed as DefensiveControlTestResult['severityIfFailed'],
      executedAt: new Date(row.executed_at as string),
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class AnonymizedSourceAuditStore {
  async record(audit: Omit<AnonymizedSourceAudit, 'id' | 'createdAt'>): Promise<AnonymizedSourceAudit> {
    const pool = getPool();
    const id = createId('asa');

    const result = await pool.query(
      `
      INSERT INTO anonymized_source_audit (id, source_ip, user_agent, detection_method, classification, endpoint, requested_at, response_code, action_taken, engagement_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      RETURNING *
      `,
      [
        id,
        audit.sourceIp,
        audit.userAgent ?? null,
        audit.detectionMethod,
        audit.classification,
        audit.endpoint,
        audit.requestedAt,
        audit.responseCode ?? null,
        audit.actionTaken ?? null,
        audit.engagementId ?? null,
      ],
    );

    return this.rowToAudit(result.rows[0]);
  }

  async listByClassification(classification: string, limit: number = 100): Promise<AnonymizedSourceAudit[]> {
    const pool = getPool();
    const result = await pool.query(
      `
      SELECT * FROM anonymized_source_audit 
      WHERE classification = $1 
      ORDER BY created_at DESC 
      LIMIT $2
      `,
      [classification, limit],
    );
    return result.rows.map((row) => this.rowToAudit(row));
  }

  private rowToAudit(row: Record<string, unknown>): AnonymizedSourceAudit {
    return {
      id: row.id as string,
      sourceIp: row.source_ip as string,
      userAgent: row.user_agent as string | undefined,
      detectionMethod: row.detection_method as AnonymizedSourceAudit['detectionMethod'],
      classification: row.classification as AnonymizedSourceAudit['classification'],
      endpoint: row.endpoint as string,
      requestedAt: new Date(row.requested_at as string),
      responseCode: row.response_code as number | undefined,
      actionTaken: row.action_taken as AnonymizedSourceAudit['actionTaken'],
      engagementId: row.engagement_id as string | undefined,
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class DefenseBlockingEvidenceStore {
  async create(evidence: Omit<DefenseBlockingEvidence, 'id' | 'createdAt'>): Promise<DefenseBlockingEvidence> {
    const pool = getPool();
    const id = createId('dbe');

    const result = await pool.query(
      `
      INSERT INTO defense_blocking_evidence (id, engagement_id, red_team_action, scope_guard_reason, risk_level, target_attempted, authorization_denied_because, audit_log_entry, blocked_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      RETURNING *
      `,
      [
        id,
        evidence.engagementId,
        evidence.redTeamAction,
        evidence.scopeGuardReason,
        evidence.riskLevel ?? null,
        evidence.targetAttempted ?? null,
        evidence.authorizationDeniedBecause ?? null,
        JSON.stringify(evidence.auditLogEntry),
        evidence.blockedAt,
      ],
    );

    return this.rowToEvidence(result.rows[0]);
  }

  async listByEngagement(engagementId: string): Promise<DefenseBlockingEvidence[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM defense_blocking_evidence WHERE engagement_id = $1 ORDER BY blocked_at DESC',
      [engagementId],
    );
    return result.rows.map((row) => this.rowToEvidence(row));
  }

  private rowToEvidence(row: Record<string, unknown>): DefenseBlockingEvidence {
    return {
      id: row.id as string,
      engagementId: row.engagement_id as string,
      redTeamAction: row.red_team_action as string,
      scopeGuardReason: row.scope_guard_reason as string,
      riskLevel: row.risk_level as DefenseBlockingEvidence['riskLevel'],
      targetAttempted: row.target_attempted as string | undefined,
      authorizationDeniedBecause: row.authorization_denied_because as string | undefined,
      auditLogEntry: row.audit_log_entry as Record<string, unknown>,
      blockedAt: new Date(row.blocked_at as string),
      createdAt: new Date(row.created_at as string),
    };
  }
}

export class DefensiveRecommendationStore {
  async create(rec: Omit<DefensiveRecommendation, 'id' | 'createdAt'>): Promise<DefensiveRecommendation> {
    const pool = getPool();
    const id = createId('rec');

    const result = await pool.query(
      `
      INSERT INTO defensive_recommendations (id, engagement_id, finding_id, failed_defense, attack_category, remediation_path, recommendation, severity, effort_estimate, proof_of_concept, defensive_agent_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
      RETURNING *
      `,
      [
        id,
        rec.engagementId ?? null,
        rec.findingId ?? null,
        rec.failedDefense,
        rec.attackCategory,
        rec.remediationPath,
        rec.recommendation,
        rec.severity,
        rec.effortEstimate ?? null,
        rec.proofOfConcept ?? null,
        rec.defensiveAgentId ?? null,
      ],
    );

    return this.rowToRec(result.rows[0]);
  }

  async listByEngagement(engagementId: string): Promise<DefensiveRecommendation[]> {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM defensive_recommendations WHERE engagement_id = $1 ORDER BY created_at DESC',
      [engagementId],
    );
    return result.rows.map((row) => this.rowToRec(row));
  }

  private rowToRec(row: Record<string, unknown>): DefensiveRecommendation {
    return {
      id: row.id as string,
      engagementId: row.engagement_id as string | undefined,
      findingId: row.finding_id as string | undefined,
      failedDefense: row.failed_defense as string,
      attackCategory: row.attack_category as string,
      remediationPath: row.remediation_path as DefensiveRecommendation['remediationPath'],
      recommendation: row.recommendation as string,
      severity: row.severity as DefensiveRecommendation['severity'],
      effortEstimate: row.effort_estimate as DefensiveRecommendation['effortEstimate'],
      proofOfConcept: row.proof_of_concept as string | undefined,
      defensiveAgentId: row.defensive_agent_id as string | undefined,
      createdAt: new Date(row.created_at as string),
      acceptedAt: row.accepted_at ? new Date(row.accepted_at as string) : undefined,
    };
  }
}

export class DefensivePostureSummaryStore {
  async getOrCreate(engagementId: string): Promise<DefensivePostureSummary> {
    const pool = getPool();
    const existing = await pool.query(
      'SELECT * FROM defensive_posture_summary WHERE engagement_id = $1',
      [engagementId],
    );

    if (existing.rows.length > 0) {
      return this.rowToSummary(existing.rows[0]);
    }

    const createResult = await pool.query(
      `
      INSERT INTO defensive_posture_summary (id, engagement_id, overall_posture)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [createId('dps'), engagementId, 'unknown'],
    );

    return this.rowToSummary(createResult.rows[0]);
  }

  private rowToSummary(row: Record<string, unknown>): DefensivePostureSummary {
    return {
      engagementId: row.engagement_id as string,
      controlTestsRun: row.control_tests_run as number,
      controlTestsPassed: row.control_tests_passed as number,
      controlTestsFailed: row.control_tests_failed as number,
      anonymizedSourcesDetected: row.anonymized_sources_detected as number,
      redTeamBlocks: row.red_team_blocks as number,
      defenseBlockingRate: row.defense_blocking_rate as number | undefined,
      recommendationsGenerated: row.recommendations_generated as number,
      recommendationsAccepted: row.recommendations_accepted as number,
      criticalGaps: row.critical_gaps as number,
      overallPosture: row.overall_posture as DefensivePostureSummary['overallPosture'],
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
