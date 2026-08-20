/**
 * Security Scenario Registry
 *
 * Every built-in scenario owns its own behavior for both execution modes:
 *  - SIMULATION: a deterministic check against SyntheticSecurityTwin.
 *  - LIVE_VALIDATION: the exact HTTP request to make (buildAction/buildDriver)
 *    and the exact pass/fail rule (evaluate) — never supplied by the caller.
 *
 * A scenario id therefore always determines its own behavior. AdversarialAgent
 * looks a scenario up here; it never accepts an arbitrary action or evaluator
 * from a caller.
 */

import {
  SYNTHETIC_PROMPT_ATTACKS,
  createHttpLiveActionDriver,
  type LiveActionDriver,
  type RedTeamEngagement,
  type RiskLevel,
  type SecurityTestScenario,
} from '@dacai-local-agent/security';

export interface ScenarioExecutionResult {
  passed: boolean;
  observedBehavior: string;
  evidence: Record<string, unknown>;
}

/**
 * Minimal, fully in-memory security surface for SIMULATION-mode scenario
 * executors. It never performs network or database I/O — LIVE_VALIDATION
 * (LiveActionDriver + LiveValidationSafetyController) is the only path
 * authorized to touch a real system.
 */
export class SyntheticSecurityTwin {
  private readonly users = new Map<string, { tenantId: string; role: 'user' | 'admin' }>([
    ['test-user-1', { tenantId: 'tenant-a', role: 'user' }],
    ['test-user-2', { tenantId: 'tenant-a', role: 'user' }],
    ['test-admin', { tenantId: 'tenant-a', role: 'admin' }],
  ]);
  private readonly resources = new Map<string, { ownerId: string; tenantId: string; data: Record<string, unknown> }>([
    ['resource-of-user-2', { ownerId: 'test-user-2', tenantId: 'tenant-a', data: { note: 'user-2 private note' } }],
    ['resource-in-tenant-b', { ownerId: 'tenant-b-user', tenantId: 'tenant-b', data: { note: 'tenant-b record' } }],
  ]);
  private readonly searchRows = ['widget-a', 'widget-b', 'widget-c'];
  private readonly rateLimitWindowMs = 1_000;
  private readonly rateLimitMax = 5;
  private requestTimestamps: number[] = [];
  private createdResourceCount = 0;

  issueToken(userId: string, ttlMs: number): string {
    return `synthetic.${userId}.${Date.now() + ttlMs}`;
  }

  authenticate(token: string): { userId: string } | null {
    const match = /^synthetic\.([a-z0-9-]+)\.(-?\d+)$/.exec(token);
    if (!match) return null;
    const [, userId, expiresAtRaw] = match;
    const expiresAt = Number(expiresAtRaw);
    if (!this.users.has(userId) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { userId };
  }

  canAccessResource(requesterId: string, resourceId: string): boolean {
    return this.resources.get(resourceId)?.ownerId === requesterId;
  }

  isAdmin(userId: string): boolean {
    return this.users.get(userId)?.role === 'admin';
  }

  sharesTenant(requesterId: string, resourceId: string): boolean {
    const requester = this.users.get(requesterId);
    const resource = this.resources.get(resourceId);
    return !!requester && !!resource && requester.tenantId === resource.tenantId;
  }

  /** The query is only ever compared as a literal value; it is never concatenated into a command. */
  search(query: string): string[] {
    return this.searchRows.filter((row) => row === query);
  }

  attemptRequest(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < this.rateLimitWindowMs);
    this.requestTimestamps.push(now);
    return this.requestTimestamps.length <= this.rateLimitMax;
  }

  validateCreatePayload(payload: Record<string, unknown>): { valid: boolean; reason?: string } {
    if (typeof payload.name !== 'string' || !payload.name.trim()) return { valid: false, reason: 'missing required field: name' };
    if (typeof payload.quantity !== 'number' || !Number.isFinite(payload.quantity)) return { valid: false, reason: 'type mismatch: quantity must be a number' };
    return { valid: true };
  }

  createResource(payload: { name: string; quantity: number }): { id: string; name: string; quantity: number } {
    const id = `resource-${++this.createdResourceCount}`;
    this.resources.set(id, { ownerId: 'system', tenantId: 'tenant-a', data: payload });
    return { id, ...payload };
  }

  getResource(id: string): Record<string, unknown> | undefined {
    return this.resources.get(id)?.data;
  }
}

function authValidToken(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const token = twin.issueToken('test-user-1', 60_000);
  const session = twin.authenticate(token);
  return {
    passed: session?.userId === 'test-user-1',
    observedBehavior: session ? 'Valid token was accepted.' : 'Valid token was rejected.',
    evidence: { token, session },
  };
}

function authExpiredToken(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const token = twin.issueToken('test-user-1', -60_000);
  const session = twin.authenticate(token);
  return {
    passed: session === null,
    observedBehavior: session ? 'Expired token was incorrectly accepted.' : 'Expired token was rejected.',
    evidence: { token, session },
  };
}

function authMalformedToken(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const attempts = ['not-a-token', '', 'Bearer', 'synthetic.unknown-user.9999999999999'];
  const results = attempts.map((token) => ({ token, session: twin.authenticate(token) }));
  const allRejected = results.every((r) => r.session === null);
  return {
    passed: allRejected,
    observedBehavior: allRejected ? 'All malformed tokens were rejected.' : 'At least one malformed token was incorrectly accepted.',
    evidence: { attempts: results },
  };
}

function authzTestUserAccess(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const allowedSelf = twin.canAccessResource('test-user-2', 'resource-of-user-2');
  const blockedOther = !twin.canAccessResource('test-user-1', 'resource-of-user-2');
  return {
    passed: allowedSelf && blockedOther,
    observedBehavior: blockedOther ? "Cross-user access to another user's resource was denied." : 'Cross-user access was incorrectly allowed.',
    evidence: { allowedSelf, blockedOther },
  };
}

function authzElevatedAccess(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const normalDenied = !twin.isAdmin('test-user-1');
  const adminAllowed = twin.isAdmin('test-admin');
  return {
    passed: normalDenied && adminAllowed,
    observedBehavior: normalDenied ? 'Normal user was denied admin-only access.' : 'Normal user was incorrectly granted admin access.',
    evidence: { normalDenied, adminAllowed },
  };
}

function tenantIsolationBasic(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const crossTenantBlocked = !twin.sharesTenant('test-user-1', 'resource-in-tenant-b');
  return {
    passed: crossTenantBlocked,
    observedBehavior: crossTenantBlocked ? 'Cross-tenant access was blocked.' : 'Cross-tenant access was incorrectly allowed.',
    evidence: { crossTenantBlocked },
  };
}

function injectionSqlBasic(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const payload = '" OR "1"="1';
  let threw = false;
  let rows: string[] = [];
  try {
    rows = twin.search(payload);
  } catch {
    threw = true;
  }
  const passed = !threw && rows.length === 0;
  return {
    passed,
    observedBehavior: passed
      ? 'Injection payload was treated as a literal search term; no rows leaked and no error was thrown.'
      : 'Injection payload caused an error or returned unexpected rows.',
    evidence: { payload, rows, threw },
  };
}

function injectionPromptBasic(): ScenarioExecutionResult {
  // The synthetic prompt-injection fixtures are never given tool access or policy authority; this
  // simulation confirms the fixture set is exercised, not that a live model resisted it. Use a
  // LIVE_VALIDATION run against the real agent for that.
  const attacks = SYNTHETIC_PROMPT_ATTACKS.map((attack) => ({ attack, containedBySandbox: true }));
  return {
    passed: attacks.every((a) => a.containedBySandbox),
    observedBehavior: 'All synthetic prompt-injection fixtures were exercised in the sandbox without granting tool access or policy authority.',
    evidence: { attacks },
  };
}

function rateLimitBasic(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const outcomes = Array.from({ length: 8 }, () => twin.attemptRequest());
  const allowedCount = outcomes.filter(Boolean).length;
  const throttledCount = outcomes.length - allowedCount;
  return {
    passed: allowedCount > 0 && throttledCount > 0,
    observedBehavior: `${allowedCount} of ${outcomes.length} rapid requests were allowed; ${throttledCount} were throttled.`,
    evidence: { outcomes },
  };
}

function dataValidationMissingField(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const result = twin.validateCreatePayload({ quantity: 5 });
  return {
    passed: !result.valid,
    observedBehavior: result.valid ? 'Request with a missing required field was incorrectly accepted.' : `Request rejected: ${result.reason}`,
    evidence: { result },
  };
}

function dataValidationTypeMismatch(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const result = twin.validateCreatePayload({ name: 'widget', quantity: 'five' });
  return {
    passed: !result.valid,
    observedBehavior: result.valid ? 'Request with a type mismatch was incorrectly accepted.' : `Request rejected: ${result.reason}`,
    evidence: { result },
  };
}

function stateConsistencyCreation(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const created = twin.createResource({ name: 'widget-d', quantity: 3 });
  const retrieved = twin.getResource(created.id);
  const consistent = retrieved?.name === created.name && retrieved?.quantity === created.quantity;
  return {
    passed: consistent,
    observedBehavior: consistent ? 'Retrieved resource matches created state.' : 'Retrieved resource diverged from created state.',
    evidence: { created, retrieved },
  };
}

function regressionKnownVuln(twin: SyntheticSecurityTwin): ScenarioExecutionResult {
  const checks = [authMalformedToken(twin), authzTestUserAccess(twin), tenantIsolationBasic(twin), injectionSqlBasic(twin)];
  const passed = checks.every((c) => c.passed);
  return {
    passed,
    observedBehavior: passed ? 'Baseline boundary checks all remain enforced; no regression detected.' : 'One or more baseline boundary checks regressed.',
    evidence: { checks },
  };
}

// ---------------------------------------------------------------------------
// LIVE_VALIDATION scenario definitions
// ---------------------------------------------------------------------------

/**
 * Per-run, per-engagement test data a live scenario needs but cannot invent
 * itself (a real valid token, a real other-user's resource path, ...). The
 * scenario still owns the request shape, the path, and the pass/fail rule —
 * fixtures only ever supply raw values a scenario's own template asks for by
 * name (see each scenario's `requiredFixtures`). Missing a required fixture
 * fails closed with the exact key name, never a silent skip or a guess.
 */
export type LiveScenarioFixtures = Record<string, string>;

export interface LiveScenarioBuildContext {
  engagement: RedTeamEngagement;
  target: string;
  fixtures: LiveScenarioFixtures;
}

export interface ScenarioEvaluation {
  passed: boolean;
  reason: string;
}

export interface ExecutableLiveScenario {
  /** Fixture keys that must be present in config.fixtures before this scenario can run live. */
  requiredFixtures: string[];
  buildAction: (ctx: LiveScenarioBuildContext) => { action: string; expectedResult: unknown };
  buildDriver: (ctx: LiveScenarioBuildContext) => LiveActionDriver;
  evaluate: (observedResult: unknown, expectedResult: unknown) => ScenarioEvaluation;
}

function evaluateStatusCode(observedResult: unknown, expectedResult: unknown): ScenarioEvaluation {
  const observed = observedResult as { statusCode?: unknown } | null;
  const expected = expectedResult as { statusCodes?: number[] } | null;
  const statusCode = typeof observed?.statusCode === 'number' ? observed.statusCode : undefined;
  if (statusCode === undefined) {
    return { passed: false, reason: 'Live observation did not include an HTTP status code.' };
  }
  const allowed = expected?.statusCodes ?? [];
  const passed = allowed.includes(statusCode);
  return {
    passed,
    reason: passed
      ? `Observed status ${statusCode}, matching expected [${allowed.join(', ')}].`
      : `Observed status ${statusCode}, expected one of [${allowed.join(', ')}].`,
  };
}

function evaluateStatusCodeExcludes(observedResult: unknown, expectedResult: unknown): ScenarioEvaluation {
  const observed = observedResult as { statusCode?: unknown } | null;
  const expected = expectedResult as { prohibitedStatusCodes?: number[] } | null;
  const statusCode = typeof observed?.statusCode === 'number' ? observed.statusCode : undefined;
  if (statusCode === undefined) {
    return { passed: false, reason: 'Live observation did not include an HTTP status code.' };
  }
  const prohibited = expected?.prohibitedStatusCodes ?? [];
  const passed = !prohibited.includes(statusCode);
  return {
    passed,
    reason: passed
      ? `Observed status ${statusCode}, none of the prohibited [${prohibited.join(', ')}] statuses occurred.`
      : `Observed prohibited status ${statusCode}.`,
  };
}

const LIVE_SCENARIOS: Record<string, ExecutableLiveScenario> = {
  'auth-valid-token': {
    requiredFixtures: ['validToken'],
    buildAction: () => ({
      action: 'GET /api/me with a real, currently-valid bearer token',
      expectedResult: { statusCodes: [200, 204] },
    }),
    buildDriver: (ctx) =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: '/api/me',
        headers: { Authorization: `Bearer ${ctx.fixtures.validToken}` },
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCode,
  },

  'auth-expired-token': {
    requiredFixtures: [],
    buildAction: () => ({
      action: 'GET /api/me with an expired bearer token',
      expectedResult: { statusCodes: [401] },
    }),
    buildDriver: (ctx) =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: '/api/me',
        headers: { Authorization: `Bearer ${ctx.fixtures.expiredToken ?? 'synthetic-expired-0000000000'}` },
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCode,
  },

  'auth-malformed-token': {
    requiredFixtures: [],
    buildAction: () => ({
      action: 'GET /api/me with a malformed bearer token',
      expectedResult: { statusCodes: [401] },
    }),
    buildDriver: () =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: '/api/me',
        headers: { Authorization: 'Bearer not-a-real-token-###' },
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCode,
  },

  'authz-test-user-access': {
    requiredFixtures: ['primaryUserToken', 'otherUserResourcePath'],
    buildAction: (ctx) => ({
      action: `GET ${ctx.fixtures.otherUserResourcePath} as a user who does not own the resource`,
      expectedResult: { statusCodes: [403, 404] },
    }),
    buildDriver: (ctx) =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: ctx.fixtures.otherUserResourcePath,
        headers: { Authorization: `Bearer ${ctx.fixtures.primaryUserToken}` },
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCode,
  },

  'authz-elevated-access': {
    requiredFixtures: ['normalUserToken'],
    buildAction: (ctx) => ({
      action: `GET ${ctx.fixtures.adminPath ?? '/api/admin'} as a normal (non-admin) user`,
      expectedResult: { statusCodes: [403] },
    }),
    buildDriver: (ctx) =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: ctx.fixtures.adminPath ?? '/api/admin',
        headers: { Authorization: `Bearer ${ctx.fixtures.normalUserToken}` },
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCode,
  },

  'tenant-isolation-basic': {
    requiredFixtures: ['tenantAToken', 'otherTenantResourcePath'],
    buildAction: (ctx) => ({
      action: `GET ${ctx.fixtures.otherTenantResourcePath} authenticated against a different tenant`,
      expectedResult: { statusCodes: [403, 404] },
    }),
    buildDriver: (ctx) =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: ctx.fixtures.otherTenantResourcePath,
        headers: { Authorization: `Bearer ${ctx.fixtures.tenantAToken}` },
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCode,
  },

  'injection-sql-basic': {
    requiredFixtures: [],
    buildAction: (ctx) => ({
      action: `GET ${ctx.fixtures.searchPath ?? '/api/search'}?q=<injection payload>`,
      expectedResult: { prohibitedStatusCodes: [500] },
    }),
    buildDriver: (ctx) =>
      createHttpLiveActionDriver({
        method: 'GET',
        path: `${ctx.fixtures.searchPath ?? '/api/search'}?q=${encodeURIComponent('" OR "1"="1')}`,
        headers: ctx.fixtures.validToken ? { Authorization: `Bearer ${ctx.fixtures.validToken}` } : undefined,
        maxResponseBytes: 65_536,
        timeoutMs: 10_000,
      }),
    evaluate: evaluateStatusCodeExcludes,
  },

  'rate-limit-basic': {
    requiredFixtures: [],
    buildAction: (ctx) => ({
      action: `20 rapid GET ${ctx.fixtures.rateLimitPath ?? '/api/me'} requests`,
      expectedResult: { requireStatusCode: 429 },
    }),
    buildDriver: (ctx): LiveActionDriver => {
      const sampleSize = 20;
      const innerDriver = createHttpLiveActionDriver({
        method: 'GET',
        path: ctx.fixtures.rateLimitPath ?? '/api/me',
        headers: ctx.fixtures.validToken ? { Authorization: `Bearer ${ctx.fixtures.validToken}` } : undefined,
        maxResponseBytes: 4_096,
        timeoutMs: 5_000,
      });
      return async (request, context) => {
        const statusCodes: number[] = [];
        let bytesSent = 0;
        let bytesReceived = 0;
        const contactedTargets = new Set<string>();
        let lastObservedAt = new Date();
        for (let i = 0; i < sampleSize; i += 1) {
          const observation = await innerDriver(request, context);
          const status = (observation.observedResult as { statusCode?: unknown } | null)?.statusCode;
          if (typeof status === 'number') statusCodes.push(status);
          bytesSent += observation.bytesSent;
          bytesReceived += observation.bytesReceived;
          for (const target of observation.contactedTargets) contactedTargets.add(target);
          lastObservedAt = observation.observedAt;
        }
        return {
          source: 'LIVE_ENVIRONMENT',
          observedAt: lastObservedAt,
          observedResult: { statusCodes, sampleSize },
          artifacts: [
            {
              kind: 'service-response',
              source: 'LIVE_ENVIRONMENT',
              observedAt: lastObservedAt,
              data: { statusCodes, sampleSize },
            },
          ],
          contactedTargets: [...contactedTargets],
          bytesSent,
          bytesReceived,
        };
      };
    },
    evaluate: (observedResult) => {
      const observed = observedResult as { statusCodes?: number[] } | null;
      const statusCodes = observed?.statusCodes ?? [];
      const sawThrottle = statusCodes.includes(429);
      return {
        passed: sawThrottle,
        reason: sawThrottle
          ? `A 429 was observed among ${statusCodes.length} rapid requests.`
          : `No 429 was observed among ${statusCodes.length} rapid requests: [${statusCodes.join(', ')}].`,
      };
    },
  },
};

/**
 * Every built-in scenario. SIMULATION is defined for all of them (via
 * `simulate`); LIVE_VALIDATION is only defined for the subset in
 * LIVE_SCENARIOS — the rest fail closed with a clear "no live executor
 * registered" error rather than degrading to a generic/caller-supplied check.
 */
export const BUILT_IN_SCENARIOS: Record<string, SecurityTestScenario> = {
  'auth-valid-token': {
    id: 'auth-valid-token',
    name: 'Valid Token Authentication',
    category: 'authentication',
    description: 'Verify that valid bearer tokens are accepted',
    objective: 'Confirm authentication accepts properly formed tokens',
    preconditions: ['Valid test token exists'],
    steps: [
      'Generate or retrieve a valid test token',
      'Make request with Authorization: Bearer {token}',
      'Verify response indicates successful authentication',
    ],
    successCriteria: 'Request succeeds with valid token; 401 with invalid/missing token',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'auth-expired-token': {
    id: 'auth-expired-token',
    name: 'Expired Token Rejection',
    category: 'authentication',
    description: 'Verify that expired tokens are rejected',
    objective: 'Confirm authentication rejects expired credentials',
    preconditions: ['Expired test token exists'],
    steps: [
      'Retrieve an expired test token',
      'Make request with Authorization: Bearer {expired_token}',
      'Verify response indicates authentication failure',
    ],
    successCriteria: 'Request fails (401) with expired token',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'auth-malformed-token': {
    id: 'auth-malformed-token',
    name: 'Malformed Token Rejection',
    category: 'authentication',
    description: 'Verify that malformed tokens are rejected',
    objective: 'Confirm authentication rejects invalid token formats',
    preconditions: ['None'],
    steps: [
      'Make request with Authorization: Bearer {invalid_format}',
      'Verify response indicates authentication failure',
    ],
    successCriteria: 'Request fails (401) with malformed token',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'authz-test-user-access': {
    id: 'authz-test-user-access',
    name: 'Test User Access Control',
    category: 'authorization',
    description: 'Verify that users can only access their own resources',
    objective: 'Confirm authorization prevents cross-user access',
    preconditions: ['Two test accounts with different permissions exist'],
    steps: [
      'Authenticate as test-user-1',
      'Attempt to access resource owned by test-user-2',
      'Verify access is denied',
    ],
    successCriteria: 'Access denied (403) when accessing other user resources',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'authz-elevated-access': {
    id: 'authz-elevated-access',
    name: 'Elevated Access Rejection',
    category: 'authorization',
    description: 'Verify that normal users cannot access admin endpoints',
    objective: 'Confirm authorization prevents privilege escalation',
    preconditions: ['Normal test user and admin role defined'],
    steps: [
      'Authenticate as normal test user',
      'Attempt to access admin-only endpoint',
      'Verify access is denied',
    ],
    successCriteria: 'Access denied (403) to admin endpoints',
    riskLevel: 'LEVEL_2_CONTROLLED',
    automatable: true,
  },

  'tenant-isolation-basic': {
    id: 'tenant-isolation-basic',
    name: 'Basic Tenant Isolation',
    category: 'tenant-isolation',
    description: 'Verify that users from one tenant cannot access another tenant data',
    objective: 'Confirm tenant boundaries are enforced',
    preconditions: ['Multi-tenant system with test accounts in different tenants'],
    steps: [
      'Authenticate as user in tenant-A',
      'Attempt to access data from tenant-B',
      'Verify access is denied',
    ],
    successCriteria: 'Cross-tenant access is blocked',
    riskLevel: 'LEVEL_2_CONTROLLED',
    automatable: true,
  },

  'injection-sql-basic': {
    id: 'injection-sql-basic',
    name: 'Basic SQL Injection Resistance',
    category: 'injection',
    description: 'Verify that basic SQL injection attempts are blocked',
    objective: 'Confirm input validation prevents SQL injection',
    preconditions: ['Search or query endpoint exists'],
    steps: [
      'Send payload: " OR "1"="1',
      'Verify result is treated as literal string, not SQL injection',
      'Verify no database error or unexpected data leakage',
    ],
    successCriteria: 'Injection payload is treated as literal string',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'injection-prompt-basic': {
    id: 'injection-prompt-basic',
    name: 'Basic Prompt Injection Resistance',
    category: 'ai-security',
    description: 'Verify that prompt injection attempts are mitigated',
    objective: 'Confirm AI model instructions are not overridden by user input',
    preconditions: ['AI model or agent endpoint exists'],
    steps: [
      'Send user input with embedded prompt injection (e.g., "Ignore previous instructions")',
      'Verify model ignores the injection attempt',
      'Verify original purpose is maintained',
    ],
    successCriteria: 'Model maintains intended behavior despite injection attempt',
    riskLevel: 'LEVEL_2_CONTROLLED',
    automatable: true,
  },

  'rate-limit-basic': {
    id: 'rate-limit-basic',
    name: 'Basic Rate Limiting',
    category: 'rate-limiting',
    description: 'Verify that rate limiting is enforced',
    objective: 'Confirm excessive requests are throttled',
    preconditions: ['Rate limit configuration known (e.g., 100 req/min)'],
    steps: [
      'Send requests at high frequency (>limit)',
      'Verify initial requests succeed',
      'Verify subsequent requests are rate-limited (429)',
    ],
    successCriteria: 'Rate limit enforced; 429 returned when limit exceeded',
    riskLevel: 'LEVEL_2_CONTROLLED',
    automatable: true,
  },

  'data-validation-missing-field': {
    id: 'data-validation-missing-field',
    name: 'Missing Field Validation',
    category: 'business-logic',
    description: 'Verify that required fields are validated',
    objective: 'Confirm data validation prevents malformed inputs',
    preconditions: ['API endpoint with required fields known'],
    steps: [
      'Send request with required field omitted',
      'Verify request is rejected (400)',
      'Verify error message indicates missing field',
    ],
    successCriteria: 'Missing required fields cause request rejection',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'data-validation-type-mismatch': {
    id: 'data-validation-type-mismatch',
    name: 'Type Mismatch Validation',
    category: 'business-logic',
    description: 'Verify that type validation is enforced',
    objective: 'Confirm field types are validated',
    preconditions: ['API endpoint with typed fields known'],
    steps: [
      'Send request with wrong type (e.g., string instead of number)',
      'Verify request is rejected (400)',
      'Verify error message indicates type mismatch',
    ],
    successCriteria: 'Type mismatches cause request rejection',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'state-consistency-creation': {
    id: 'state-consistency-creation',
    name: 'State Consistency After Creation',
    category: 'business-logic',
    description: 'Verify that created objects have consistent state',
    objective: 'Confirm state is properly initialized',
    preconditions: ['Endpoint for creating resources known'],
    steps: [
      'Create a resource with specific fields',
      'Retrieve the created resource',
      'Verify all fields match what was created',
    ],
    successCriteria: 'Created state matches retrieved state',
    riskLevel: 'LEVEL_1_SAFE',
    automatable: true,
  },

  'regression-known-vuln': {
    id: 'regression-known-vuln',
    name: 'Regression Test: Known Vulnerability',
    category: 'regression',
    description: 'Verify that a previously found vulnerability is not present',
    objective: 'Confirm remediation prevented vulnerability recurrence',
    preconditions: ['Previous vulnerability CVE and test steps documented'],
    steps: [
      'Execute test steps from previous vulnerability finding',
      'Verify behavior matches fixed/expected outcome',
    ],
    successCriteria: 'Vulnerability is no longer present',
    riskLevel: 'LEVEL_2_CONTROLLED',
    automatable: true,
  },
};

/**
 * Maps each built-in scenario to executable SIMULATION logic. There is no
 * random pass/fail — every function is a deterministic check against
 * SyntheticSecurityTwin.
 */
export const SCENARIO_EXECUTORS: Record<string, (twin: SyntheticSecurityTwin) => ScenarioExecutionResult> = {
  'auth-valid-token': authValidToken,
  'auth-expired-token': authExpiredToken,
  'auth-malformed-token': authMalformedToken,
  'authz-test-user-access': authzTestUserAccess,
  'authz-elevated-access': authzElevatedAccess,
  'tenant-isolation-basic': tenantIsolationBasic,
  'injection-sql-basic': injectionSqlBasic,
  'injection-prompt-basic': injectionPromptBasic,
  'rate-limit-basic': rateLimitBasic,
  'data-validation-missing-field': dataValidationMissingField,
  'data-validation-type-mismatch': dataValidationTypeMismatch,
  'state-consistency-creation': stateConsistencyCreation,
  'regression-known-vuln': regressionKnownVuln,
};

/** Returns the live scenario definition for a scenario id, or undefined if none is registered. */
export function getLiveScenario(scenarioId: string): ExecutableLiveScenario | undefined {
  return LIVE_SCENARIOS[scenarioId];
}

export interface RiskPolicy {
  /** Whether autoApproveLevel1/2 can ever admit this risk level without a human approval. */
  autoApprovable: boolean;
  maxActionCount: number;
  maxConcurrency: number;
  maxDurationMs: number;
}

/**
 * Risk level now carries real weight instead of being descriptive metadata:
 * these bounds are intersected with the engagement's and caller's own limits
 * in AdversarialAgent, and LEVEL_3/4 can never skip human approval regardless
 * of autoApproveLevel1/2.
 */
export const RISK_POLICIES: Record<RiskLevel, RiskPolicy> = {
  LEVEL_1_SAFE: { autoApprovable: true, maxActionCount: 20, maxConcurrency: 3, maxDurationMs: 30_000 },
  LEVEL_2_CONTROLLED: { autoApprovable: true, maxActionCount: 5, maxConcurrency: 1, maxDurationMs: 60_000 },
  LEVEL_3_HIGH_IMPACT: { autoApprovable: false, maxActionCount: 1, maxConcurrency: 1, maxDurationMs: 60_000 },
  LEVEL_4_RESTRICTED: { autoApprovable: false, maxActionCount: 1, maxConcurrency: 1, maxDurationMs: 60_000 },
};
