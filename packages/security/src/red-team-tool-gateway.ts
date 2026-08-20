/**
 * RedTeamToolGateway: enforces engagement authorization before tool execution
 *
 * Every red team tool call must:
 * 1. Provide an engagement ID
 * 2. Pass scope guard validation
 * 3. Pass risk classification
 * 4. Request human approval if high-risk
 * 5. Log all decisions
 *
 * The gateway treats red team agents as potentially hostile and never trusts:
 * - Generated parameters
 * - Retrieved content
 * - Claimed authorization
 * - Internal LLM decisions
 */

import { randomUUID } from 'node:crypto';
import { ScopeGuard } from './scope-guard.js';
import { RiskClassifier } from './risk-classifier.js';
import type {
  RedTeamEngagement,
  EngagementAuthorizationContext,
  RedTeamToolAudit,
} from './red-team-types.js';

export interface RedTeamToolRequest {
  engagementId: string;
  customerId: string;
  agentId: string;
  toolName: string;
  proposedAction: string;
  requestedTarget: string;
  requestedCategory?: string;
  parameters: Record<string, unknown>;
}

export interface RedTeamToolExecutionResult {
  authorized: boolean;
  requiresApproval: boolean;
  riskLevel: string;
  reason: string;
  audit: RedTeamToolAudit;
  executionAllowed: boolean;
  approvalRequestId?: string;
}

export interface RedTeamGatewayConfig {
  getEngagement: (id: string) => Promise<RedTeamEngagement | null>;
  recordAudit: (audit: RedTeamToolAudit) => Promise<void>;
  requestApproval?: (context: {
    engagementId: string;
    toolName: string;
    proposedAction: string;
    riskLevel: string;
    reason: string;
  }) => Promise<boolean>;
}

export class RedTeamToolGateway {
  private scopeGuard = new ScopeGuard();
  private riskClassifier = new RiskClassifier();

  constructor(private config: RedTeamGatewayConfig) {}

  /**
   * Validates and optionally executes a red team tool request
   */
  async validateAndExecute(request: RedTeamToolRequest): Promise<RedTeamToolExecutionResult> {
    const auditId = randomUUID();

    // Step 1: Verify engagement exists and is active
    const engagement = await this.config.getEngagement(request.engagementId);
    if (!engagement) {
      const audit: RedTeamToolAudit = {
        id: auditId,
        engagementId: request.engagementId,
        agentId: request.agentId,
        toolName: request.toolName,
        proposedAction: request.proposedAction,
        scopeVerified: false,
        policyAllowed: false,
        executed: false,
        blockedReason: 'Engagement not found or invalid',
        createdAt: new Date(),
      };
      await this.config.recordAudit(audit);

      return {
        authorized: false,
        requiresApproval: false,
        riskLevel: 'UNKNOWN',
        reason: 'Engagement not found or invalid',
        audit,
        executionAllowed: false,
      };
    }

    // Step 2: Scope Guard validation
    const scopeContext: EngagementAuthorizationContext = {
      engagement,
      agentId: request.agentId,
      requestedTarget: request.requestedTarget,
      requestedAction: request.proposedAction,
      requestedCategory: request.requestedCategory,
      proposedParameters: request.parameters,
    };

    const scopeDecision = this.scopeGuard.validate(scopeContext);
    if (!scopeDecision.authorized) {
      const audit: RedTeamToolAudit = {
        id: auditId,
        engagementId: request.engagementId,
        agentId: request.agentId,
        toolName: request.toolName,
        proposedAction: request.proposedAction,
        scopeVerified: false,
        policyAllowed: false,
        executed: false,
        blockedReason: scopeDecision.reason,
        createdAt: new Date(),
      };
      await this.config.recordAudit(audit);

      return {
        authorized: false,
        requiresApproval: false,
        riskLevel: 'OUT_OF_SCOPE',
        reason: `Scope violation: ${scopeDecision.reason}`,
        audit,
        executionAllowed: false,
      };
    }

    // Step 3: Risk Classification
    const riskClass = this.riskClassifier.classify(request.proposedAction, {
      scope: engagement.scopeBreadth,
      affectsProduction: engagement.authorizedEnvironments.includes('production'),
    });

    // Step 4: LEVEL 4 actions are never auto-executed
    if (riskClass.level === 'LEVEL_4_RESTRICTED') {
      const audit: RedTeamToolAudit = {
        id: auditId,
        engagementId: request.engagementId,
        agentId: request.agentId,
        toolName: request.toolName,
        proposedAction: request.proposedAction,
        scopeVerified: true,
        policyAllowed: false,
        executed: false,
        blockedReason: `Risk level ${riskClass.level}: ${riskClass.description}`,
        createdAt: new Date(),
      };
      await this.config.recordAudit(audit);

      return {
        authorized: true, // Scope is OK, but execution blocked by risk
        requiresApproval: true,
        riskLevel: riskClass.level,
        reason: riskClass.description,
        audit,
        executionAllowed: false,
      };
    }

    // Step 5: Request approval for high-risk actions
    if (riskClass.requiresApproval && this.config.requestApproval) {
      const approvalRequestId = randomUUID();
      const approved = await this.config.requestApproval({
        engagementId: request.engagementId,
        toolName: request.toolName,
        proposedAction: request.proposedAction,
        riskLevel: riskClass.level,
        reason: riskClass.description,
      });

      if (!approved) {
        const audit: RedTeamToolAudit = {
          id: auditId,
          engagementId: request.engagementId,
          agentId: request.agentId,
          toolName: request.toolName,
          proposedAction: request.proposedAction,
          scopeVerified: true,
          policyAllowed: true,
          executed: false,
          blockedReason: 'Human approval denied or timed out',
          createdAt: new Date(),
        };
        await this.config.recordAudit(audit);

        return {
          authorized: true,
          requiresApproval: true,
          riskLevel: riskClass.level,
          reason: 'Human approval required and was denied',
          audit,
          executionAllowed: false,
          approvalRequestId,
        };
      }
    }

    // Step 6: Execution allowed
    const audit: RedTeamToolAudit = {
      id: auditId,
      engagementId: request.engagementId,
      agentId: request.agentId,
      toolName: request.toolName,
      proposedAction: request.proposedAction,
      scopeVerified: true,
      policyAllowed: true,
      executed: true,
      createdAt: new Date(),
    };
    await this.config.recordAudit(audit);

    return {
      authorized: true,
      requiresApproval: riskClass.requiresApproval,
      riskLevel: riskClass.level,
      reason: riskClass.description,
      audit,
      executionAllowed: true,
    };
  }
}
