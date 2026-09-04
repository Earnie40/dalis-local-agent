import { classifyCommand, TIER_ORDER } from './command-classifier';
import {
  DEFAULT_PERMISSION_POLICY,
  type CommandClassification,
  type PermissionDecision,
  type PermissionPolicy,
  type PermissionTier,
  type WorkspaceCapabilities,
} from './types';

export interface ToolAuthorizationRequest {
  toolName: string;
  tier: PermissionTier;
  capabilities: WorkspaceCapabilities;
  /** Set for shell tools so the command can be classified and escalated. */
  command?: string;
  /** Set for network tools. */
  requiresNetwork?: boolean;
  /** Set for tools that inspect workspace files, metadata, or repository state. */
  requiresRead?: boolean;
  requiresWrite?: boolean;
  requiresShell?: boolean;
  /** Trusted, non-shell mutation whose tool contract is safe to run unattended. */
  autoApprove?: boolean;
}

/**
 * Central authorization point. Every tool call passes through here before
 * execution. The engine never widens a decision: workspace capability denials
 * are final and cannot be overridden by policy.
 */
export class PermissionEngine {
  constructor(private readonly policy: PermissionPolicy = DEFAULT_PERMISSION_POLICY) {}

  authorizeTool(request: ToolAuthorizationRequest): PermissionDecision {
    const { capabilities } = request;

    // Shell and workspace mutation necessarily expose workspace contents or
    // metadata, even when a particular tool forgot to declare requiresRead.
    if ((request.requiresRead || request.requiresWrite || request.requiresShell) && !capabilities.read) {
      return {
        kind: 'denied',
        tier: request.tier,
        reason: 'Workspace does not grant read access.',
        layer: 'workspace-containment',
      };
    }

    if (request.requiresWrite && !capabilities.write) {
      return {
        kind: 'denied',
        tier: request.tier,
        reason: 'Workspace does not grant write access.',
        layer: 'workspace-containment',
      };
    }

    if (request.requiresShell && !capabilities.shell) {
      return {
        kind: 'denied',
        tier: request.tier,
        reason: 'Workspace does not grant shell access.',
        layer: 'workspace-containment',
      };
    }

    if (request.requiresNetwork && !capabilities.network) {
      return {
        kind: 'denied',
        tier: request.tier,
        reason: 'Workspace does not grant network access.',
        layer: 'workspace-containment',
      };
    }

    let tier = request.tier;
    let reason = `Tool "${request.toolName}" is classified ${tier}.`;
    let layer: PermissionDecision['layer'] = 'tier-policy';

    // A shell command's own classification can only raise the tier, never lower
    // the one the tool declared.
    if (request.command !== undefined) {
      const classification = this.classify(request.command);
      if (TIER_ORDER[classification.tier] > TIER_ORDER[tier]) {
        tier = classification.tier;
      }
      reason = classification.reason;
      layer = classification.layer;
    }

    // This flag comes from the registered ToolDefinition, never model input.
    // Keep it deliberately narrow: it cannot waive a workspace capability,
    // approve a shell command, or downgrade a high-impact operation.
    if (
      request.autoApprove &&
      request.command === undefined &&
      tier === 'mutation' &&
      !this.policy.deny.includes(tier)
    ) {
      return {
        kind: 'allowed',
        tier,
        reason: `Tool "${request.toolName}" is a bounded auto-approved mutation.`,
        layer: 'tier-policy',
      };
    }

    return this.applyPolicy(tier, reason, layer);
  }

  classify(command: string): CommandClassification {
    return classifyCommand(command);
  }

  private applyPolicy(
    tier: PermissionTier,
    reason: string,
    layer: PermissionDecision['layer'],
  ): PermissionDecision {
    if (this.policy.deny.includes(tier)) {
      return { kind: 'denied', tier, reason, layer };
    }
    if (this.policy.autoApprove.includes(tier)) {
      return { kind: 'allowed', tier, reason, layer };
    }
    return { kind: 'approval-required', tier, reason, layer };
  }
}
