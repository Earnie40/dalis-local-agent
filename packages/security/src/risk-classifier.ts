/**
 * RiskClassifier: categorizes red team actions by impact level
 *
 * LEVEL 1 — SAFE: Passive inspection, configuration analysis, synthetic validation
 * LEVEL 2 — CONTROLLED: Auth testing, authz testing, business-logic testing, malformed input
 * LEVEL 3 — HIGH IMPACT: Multi-step attack paths, state-changing operations, control bypass testing
 * LEVEL 4 — RESTRICTED: Service disruption, persistence, destructive modification, scope expansion
 */

import type { RiskClassification } from './red-team-types.js';

export class RiskClassifier {
  /**
   * Classifies an action by its inherent risk level
   */
  classify(action: string, context?: { scope?: string; affectsProduction?: boolean }): RiskClassification {
    const normalizedAction = action.toLowerCase();

    // LEVEL 4: Restricted actions (never autonomously execute in red team)
    if (this.isRestrictedAction(normalizedAction)) {
      return {
        level: 'LEVEL_4_RESTRICTED',
        description: 'Destructive or scope-expansion action. Never execute without explicit human approval.',
        requiresApproval: true,
        category: this.getCategory(normalizedAction),
      };
    }

    // LEVEL 3: High-impact actions (require human approval)
    if (this.isHighImpactAction(normalizedAction)) {
      return {
        level: 'LEVEL_3_HIGH_IMPACT',
        description: 'High-impact action that may change application state. Requires explicit approval.',
        requiresApproval: context?.affectsProduction !== false, // approve if prod or unknown
        category: this.getCategory(normalizedAction),
      };
    }

    // LEVEL 2: Controlled actions (may require approval based on policy)
    if (this.isControlledAction(normalizedAction)) {
      return {
        level: 'LEVEL_2_CONTROLLED',
        description: 'Controlled testing action (auth, authz, business logic). May require approval based on context.',
        requiresApproval: context?.affectsProduction === true,
        category: this.getCategory(normalizedAction),
      };
    }

    // LEVEL 1: Safe actions (passive inspection, read-only)
    return {
      level: 'LEVEL_1_SAFE',
      description: 'Passive inspection or configuration analysis. Safe to execute autonomously.',
      requiresApproval: false,
      category: this.getCategory(normalizedAction),
    };
  }

  private isRestrictedAction(action: string): boolean {
    const restrictedPatterns = [
      'delete',
      'destroy',
      'drop',
      'format',
      'wipe',
      'purge',
      'erase',
      'kill',
      'terminate process',
      'shutdown',
      'reboot',
      'crash',
      'exploit',
      'bypass.*permission',
      'escalate.*privilege',
      'modify.*credential',
      'steal.*secret',
      'exfiltrate',
      'propagate',
      'persistence',
      'backdoor',
      'plant.*malware',
      'modify.*scope',
      'expand.*authorization',
      'cross.*tenant',
      'unauthorized.*access',
      'dos|ddos|denial.*service',
      'uncontrolled.*loop',
      'resource.*exhaust',
      'memory.*leak',
      'fork.*bomb',
    ];

    return restrictedPatterns.some((pattern) => new RegExp(pattern, 'i').test(action));
  }

  private isHighImpactAction(action: string): boolean {
    const highImpactPatterns = [
      'modify.*state',
      'change.*configuration',
      'write.*data',
      'update.*record',
      'create.*account',
      'disable.*control',
      'bypass.*check',
      'skip.*validation',
      'inject.*code',
      'modify.*parameter',
      'access.*restricted',
      'exploit.*weakness',
      'demonstrate.*path',
      'traverse',
      'escalate',
    ];

    return highImpactPatterns.some((pattern) => new RegExp(pattern, 'i').test(action));
  }

  private isControlledAction(action: string): boolean {
    const controlledPatterns = [
      'test.*auth',
      'test.*permission',
      'test.*access',
      'validate.*token',
      'check.*credential',
      'probe.*endpoint',
      'send.*request',
      'inspect.*field',
      'analyze.*response',
      'compare.*behavior',
      'malformed.*input',
      'edge.*case',
      'boundary.*test',
      'test.*isolation',
      'cross.*account',
      'tenant.*test',
      'business.*logic',
      'inject.*payload',
      'request.*manipulation',
    ];

    return controlledPatterns.some((pattern) => new RegExp(pattern, 'i').test(action));
  }

  private getCategory(action: string): string {
    if (action.includes('auth')) return 'authentication';
    if (action.includes('permission') || action.includes('access') || action.includes('authz')) return 'authorization';
    if (action.includes('tenant') || action.includes('isolation')) return 'tenant-isolation';
    if (action.includes('logic') || action.includes('business')) return 'business-logic';
    if (action.includes('inject') || action.includes('payload')) return 'injection';
    if (action.includes('rate') || action.includes('limit') || action.includes('dos')) return 'rate-limiting';
    if (action.includes('ai') || action.includes('llm') || action.includes('prompt')) return 'ai-security';
    if (action.includes('agent') || action.includes('tool') || action.includes('loop')) return 'agentic-system';
    return 'general';
  }
}
