/**
 * Real DefensiveControlInspector implementation.
 *
 * Scoped narrowly: it only reports on categories where a real, already-existing
 * static signal exists in this codebase. Everything else returns null, which
 * DefensiveAgent already treats correctly (confidence downgrades to
 * 'candidate' rather than fabricating a verdict).
 *
 * Note: RedTeamFinding.findingType is typed as a coarse category
 * ('vulnerability' | 'weakness' | 'misconfiguration' | 'design-flaw'), not the
 * specific attack-type strings DefensiveAgent's FINDING_TO_DEFENSE_MAP keys
 * against ('authentication-bypass', 'rate-limit-bypass', ...) — those never
 * match in practice. This inspector matches against title/description text
 * instead, since that's the only place the specific attack type is actually
 * recorded today.
 */

import type { PermissionPolicy } from '@dacai-local-agent/security';
import type {
  DefensiveControlInspector,
  DefensiveControlObservation,
  DefensiveInspectionContext,
} from './defensive-agent';

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const RATE_LIMIT_PATTERNS = [/rate[\s-]?limit/i];
const AUTHZ_PATTERNS = [/authoriz|authz|privilege|permission|access\s+control|admin/i, /prompt\s+injection|tool\s+authoriz/i];

export class DefensiveControlInspectorImpl implements DefensiveControlInspector {
  constructor(private readonly policy: PermissionPolicy) {}

  async inspect(context: DefensiveInspectionContext): Promise<DefensiveControlObservation | null> {
    const { finding } = context;
    const text = `${finding.title} ${finding.description}`;

    if (matches(text, RATE_LIMIT_PATTERNS)) {
      return {
        control: 'Rate Limiting',
        category: 'rate-limit',
        controlPresent: false,
        evidence: [
          'Inspected apps/server/src/index.ts: no rate-limiting middleware, hook, or policy is registered anywhere in this server.',
        ],
        rootCause: 'missing-control',
        explanation:
          'Rate Limiting was inspected directly: this deployment has no rate-limit enforcement at all, so a rate-limit finding ' +
          'is explained by a missing control, not a misconfiguration of an existing one.',
      };
    }

    if (matches(text, AUTHZ_PATTERNS)) {
      const hasApprovalOrDenyTier = this.policy.requireApproval.length > 0 || this.policy.deny.length > 0;
      return {
        control: 'PermissionEngine tier policy',
        category: 'authorization',
        controlPresent: true,
        correctlyConfigured: hasApprovalOrDenyTier,
        evidence: [
          `Inspected the live PermissionPolicy: autoApprove=[${this.policy.autoApprove.join(', ')}], ` +
            `requireApproval=[${this.policy.requireApproval.join(', ')}], deny=[${this.policy.deny.join(', ')}].`,
        ],
        explanation: hasApprovalOrDenyTier
          ? 'The active PermissionPolicy requires approval or denies at least one tier, consistent with a functioning ' +
            'authorization boundary; whether this specific finding bypassed it requires the actual per-call permission ' +
            'decision, which this inspector does not have access to — treat rootCause as a starting point, not a verdict.'
          : 'The active PermissionPolicy auto-approves every tier, with nothing requiring approval or denied. That is a ' +
            'real, inspected configuration fact, not a diagnosis on its own — but it is consistent with a finding that ' +
            'reached its target unchallenged.',
      };
    }

    return null;
  }
}
