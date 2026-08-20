/**
 * The single permission vocabulary for the whole platform. Tools, workspaces,
 * and agent roles all classify against these three tiers.
 *
 * safe        — read-only, no side effects outside the process
 * mutation    — changes project state (writes, normal builds, tests)
 * high-impact — destructive, irreversible, external-facing, or credential-touching
 */
export type PermissionTier = 'safe' | 'mutation' | 'high-impact';

export type PermissionDecisionKind = 'allowed' | 'denied' | 'approval-required';

export interface PermissionDecision {
  kind: PermissionDecisionKind;
  tier: PermissionTier;
  reason: string;
  /** Which security layer produced this decision, for audit and debugging. */
  layer: SecurityLayer;
}

export type SecurityLayer =
  | 'workspace-containment'
  | 'operation-classification'
  | 'argument-analysis'
  | 'pattern-escalation'
  | 'tier-policy'
  | 'unknown-operation';

/** Per-workspace capability grants. */
export interface WorkspaceCapabilities {
  read: boolean;
  write: boolean;
  shell: boolean;
  network: boolean;
}

/** How each tier is handled for a given agent role or workspace. */
export interface PermissionPolicy {
  autoApprove: PermissionTier[];
  requireApproval: PermissionTier[];
  deny: PermissionTier[];
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  autoApprove: ['safe'],
  requireApproval: ['mutation', 'high-impact'],
  deny: [],
};

export interface CommandClassification {
  tier: PermissionTier;
  /** Normalized executable, e.g. "git", "npm". */
  executable: string;
  /** Normalized subcommand where meaningful, e.g. "push". */
  operation?: string;
  reason: string;
  layer: SecurityLayer;
}

/**
 * The platform's one live-vs-simulation discriminant. Any subsystem that
 * needs to distinguish real execution from a deterministic test/CI fixture
 * should reuse these constants rather than inventing another vocabulary.
 */
export const LIVE_VALIDATION_MODE = 'LIVE_VALIDATION' as const;
export const SIMULATION_MODE = 'SIMULATION' as const;

export type ValidationExecutionMode = typeof LIVE_VALIDATION_MODE | typeof SIMULATION_MODE;
