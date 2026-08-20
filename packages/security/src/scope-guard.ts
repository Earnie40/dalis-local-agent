/**
 * ScopeGuard: validates red team actions against engagement authorization
 *
 * Enforces: time windows, target allowlists, action categories, rate limits,
 * concurrent request limits, and stops on engagement revocation.
 */

import type { EngagementAuthorizationContext, ScopeGuardDecision } from './red-team-types.js';

export class ScopeGuard {
  /**
   * Validates a proposed action against engagement authorization.
   * Returns a decision and reason.
   */
  validate(context: EngagementAuthorizationContext): ScopeGuardDecision {
    const engagement = context.engagement;

    // Stop conditions: revoked or expired
    if (engagement.status === 'revoked') {
      return {
        authorized: false,
        targetAuthorized: false,
        environmentAuthorized: false,
        categoryAuthorized: false,
        actionProhibited: false,
        withinTimeWindow: false,
        withinRequestLimit: true,
        withinConcurrencyLimit: true,
        reason: 'Engagement is revoked.',
      };
    }

    if (engagement.status !== 'active') {
      return {
        authorized: false,
        targetAuthorized: false,
        environmentAuthorized: false,
        categoryAuthorized: false,
        actionProhibited: false,
        withinTimeWindow: false,
        withinRequestLimit: true,
        withinConcurrencyLimit: true,
        reason: `Engagement is not active (status: ${engagement.status}).`,
      };
    }

    // Time window check
    const now = new Date();
    const withinTimeWindow = now >= engagement.startsAt && now <= engagement.expiresAt;

    if (!withinTimeWindow) {
      return {
        authorized: false,
        targetAuthorized: false,
        environmentAuthorized: false,
        categoryAuthorized: false,
        actionProhibited: false,
        withinTimeWindow: false,
        withinRequestLimit: true,
        withinConcurrencyLimit: true,
        reason: 'Action is outside authorization time window.',
      };
    }

    // Target check
    const targetAuthorized = engagement.authorizedTargets.some((t) => this.matchesTarget(context.requestedTarget, t));

    if (!targetAuthorized) {
      return {
        authorized: false,
        targetAuthorized: false,
        environmentAuthorized: true,
        categoryAuthorized: true,
        actionProhibited: false,
        withinTimeWindow: true,
        withinRequestLimit: true,
        withinConcurrencyLimit: true,
        reason: `Target "${context.requestedTarget}" is not in authorized targets.`,
      };
    }

    // Category check
    const categoryAuthorized = !context.requestedCategory || engagement.allowedTestCategories.includes(context.requestedCategory);

    if (!categoryAuthorized) {
      return {
        authorized: false,
        targetAuthorized: true,
        environmentAuthorized: true,
        categoryAuthorized: false,
        actionProhibited: false,
        withinTimeWindow: true,
        withinRequestLimit: true,
        withinConcurrencyLimit: true,
        reason: `Test category "${context.requestedCategory}" is not allowed in this engagement.`,
      };
    }

    // Prohibited actions check
    const actionProhibited = engagement.prohibitedActions.some(
      (prohibited) => context.requestedAction.toLowerCase().includes(prohibited.toLowerCase()),
    );

    if (actionProhibited) {
      return {
        authorized: false,
        targetAuthorized: true,
        environmentAuthorized: true,
        categoryAuthorized: true,
        actionProhibited: true,
        withinTimeWindow: true,
        withinRequestLimit: true,
        withinConcurrencyLimit: true,
        reason: `Action "${context.requestedAction}" is prohibited in this engagement.`,
      };
    }

    // Rate and concurrency limits are checked by the caller with runtime state
    return {
      authorized: true,
      targetAuthorized: true,
      environmentAuthorized: true,
      categoryAuthorized: true,
      actionProhibited: false,
      withinTimeWindow: true,
      withinRequestLimit: true,
      withinConcurrencyLimit: true,
      reason: 'Action is authorized within engagement scope.',
    };
  }

  /**
   * Matches a target against a pattern (exact or glob-like)
   */
  private matchesTarget(actual: string, pattern: string): boolean {
    if (pattern === '*' || pattern === '**') return true;
    if (pattern === actual) return true;

    // Simple glob support: *.example.com matches api.example.com
    if (pattern.startsWith('*.')) {
      const domain = pattern.slice(2);
      return actual.endsWith(domain) || actual.endsWith('.' + domain);
    }

    // Prefix glob: api-* matches api-v1, api-v2
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(actual);
    }

    return false;
  }
}
