/**
 * Defensive Control Tests
 *
 * Built-in test scenarios that prove security controls actually work.
 * These are "guaranteed to fail" scenarios that should be rejected by the system.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPrivateLabAddress, redactDeep } from '@dacai-local-agent/security';
import type {
  ControlTestExecutionContext,
  ControlTestHttpRequest,
  ControlTestScenario,
} from '@dacai-local-agent/security';

/**
 * Built-in control test scenarios
 */
export const CONTROL_TEST_SCENARIOS: Record<string, ControlTestScenario> = {
  'auth-expired-token': {
    id: 'auth-expired-token',
    category: 'authentication',
    name: 'Expired Token Rejection',
    description: 'Verify that authentication rejects expired bearer tokens',
    objective: 'Prove that token expiration is enforced',
    setup: 'Create or retrieve an expired test token (created > 1 hour ago or with exp claim in past)',
    steps: [
      'Retrieve expired test token',
      'Make request with Authorization: Bearer {expired_token}',
      'Verify response indicates authentication failure (401)',
      'Verify error message mentions token expiration',
    ],
    expectedOutcome: 'Request fails with 401 Unauthorized; token expiration is enforced',
    failureMeaning: 'CRITICAL: Expired tokens are accepted; authentication control is broken',
    severity: 'critical',
  },

  'auth-malformed-token': {
    id: 'auth-malformed-token',
    category: 'authentication',
    name: 'Malformed Token Rejection',
    description: 'Verify that authentication rejects malformed tokens',
    objective: 'Prove that token format validation works',
    setup: 'None (use invalid token formats)',
    steps: [
      'Make request with Authorization: Bearer {garbage_string}',
      'Make request with Authorization: Bearer',
      'Make request with Authorization: {empty}',
      'Verify all requests fail with 401',
    ],
    expectedOutcome: 'Malformed tokens are rejected; 401 returned',
    failureMeaning: 'CRITICAL: Malformed tokens accepted; format validation broken',
    severity: 'critical',
  },

  'authz-user-isolation': {
    id: 'authz-user-isolation',
    category: 'authorization',
    name: 'User Isolation',
    description: 'Verify that users cannot access other users\' resources',
    objective: 'Prove that user authorization boundaries are enforced',
    setup: 'Two test users in same account with different resources',
    steps: [
      'Authenticate as test-user-1',
      'Attempt to read/modify resource owned by test-user-2',
      'Verify request fails with 403 Forbidden',
      'Verify ownership is respected',
    ],
    expectedOutcome: 'Cross-user access is denied; 403 returned',
    failureMeaning: 'HIGH: Users can access each other\'s data; authorization broken',
    severity: 'critical',
  },

  'authz-role-enforcement': {
    id: 'authz-role-enforcement',
    category: 'authorization',
    name: 'Role-Based Access Enforcement',
    description: 'Verify that role-based access control is enforced',
    objective: 'Prove that privilege levels are respected',
    setup: 'Normal user role and admin-only endpoint defined',
    steps: [
      'Authenticate as normal user (non-admin)',
      'Attempt to access admin-only endpoint (e.g., DELETE /api/admin/users)',
      'Verify request fails with 403 Forbidden',
      'Authenticate as admin, verify same endpoint succeeds',
    ],
    expectedOutcome: 'Role-based access control is enforced; 403 for insufficient privilege',
    failureMeaning: 'CRITICAL: Normal users can access admin endpoints; privilege escalation possible',
    severity: 'critical',
  },

  'tenant-isolation-basic': {
    id: 'tenant-isolation-basic',
    category: 'tenant-isolation',
    name: 'Basic Tenant Isolation',
    description: 'Verify that users from one tenant cannot access another tenant\'s data',
    objective: 'Prove that tenant boundaries are enforced',
    setup: 'Two test accounts in different tenants',
    steps: [
      'Authenticate as user in tenant-A',
      'Attempt to list/read data from tenant-B',
      'Verify request returns tenant-A data only or fails with 403',
      'Attempt to enumerate tenant IDs (verify no cross-tenant leakage)',
    ],
    expectedOutcome: 'Tenant isolation enforced; cross-tenant access denied',
    failureMeaning: 'CRITICAL: Users can access other tenants\' data; data breach',
    severity: 'critical',
  },

  'rate-limit-enforcement': {
    id: 'rate-limit-enforcement',
    category: 'rate-limit',
    name: 'Rate Limit Enforcement',
    description: 'Verify that rate limiting prevents excessive requests',
    objective: 'Prove that rate limits are applied',
    setup: 'Known rate limit (e.g., 100 requests per minute)',
    steps: [
      'Send requests at rapid pace (>configured limit)',
      'Verify initial requests succeed (< limit)',
      'Verify subsequent requests fail with 429 Too Many Requests',
      'Verify rate limit header is present (X-RateLimit-Remaining)',
    ],
    expectedOutcome: 'Rate limit is enforced; 429 returned when exceeded',
    failureMeaning: 'HIGH: Rate limiting not enforced; DoS attacks possible',
    severity: 'high',
  },

  'validation-required-field': {
    id: 'validation-required-field',
    category: 'validation',
    name: 'Required Field Validation',
    description: 'Verify that required fields are validated',
    objective: 'Prove that input validation prevents missing required data',
    setup: 'API endpoint with required fields known',
    steps: [
      'Send POST request with required field omitted',
      'Verify request fails with 400 Bad Request',
      'Verify error message identifies missing field',
    ],
    expectedOutcome: 'Missing required fields cause 400; validation works',
    failureMeaning: 'MEDIUM: Missing fields accepted; data quality compromised',
    severity: 'high',
  },

  'validation-type-mismatch': {
    id: 'validation-type-mismatch',
    category: 'validation',
    name: 'Type Validation',
    description: 'Verify that field types are validated',
    objective: 'Prove that type checking prevents invalid data',
    setup: 'API endpoint with typed fields known',
    steps: [
      'Send field with wrong type (e.g., string instead of number)',
      'Verify request fails with 400 Bad Request',
      'Verify error message indicates type mismatch',
    ],
    expectedOutcome: 'Type mismatches cause 400; validation works',
    failureMeaning: 'MEDIUM: Type validation missing; could lead to logic errors',
    severity: 'high',
  },

  'validation-size-limit': {
    id: 'validation-size-limit',
    category: 'validation',
    name: 'Size/Length Validation',
    description: 'Verify that field size limits are enforced',
    objective: 'Prove that oversized inputs are rejected',
    setup: 'API endpoint with size limits known',
    steps: [
      'Send field value exceeding size limit',
      'Verify request fails with 400 or 413 Payload Too Large',
      'Send value at limit, verify success',
    ],
    expectedOutcome: 'Size limits enforced; oversized payloads rejected',
    failureMeaning: 'MEDIUM: Size limits not enforced; could cause DoS or buffer overflow',
    severity: 'high',
  },
};

interface ControlCheckOutcome {
  target: string;
  method: string;
  statusCode: number;
  durationMs: number;
  passed: boolean;
}

/** Real, DNS-resolved HTTP check against a private-lab system under test. No public egress. */
async function executeHttpCheck(check: ControlTestHttpRequest): Promise<ControlCheckOutcome> {
  const url = new URL(check.url);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Control test request must use http/https, got "${url.protocol}".`);
  }

  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : (await lookup(url.hostname, { all: true, verbatim: true })).map((record) => record.address);
  if (addresses.length === 0 || addresses.some((address) => !isPrivateLabAddress(address))) {
    throw new Error(
      `Control test target "${url.hostname}" is not within the private Tomahawk1 lab network (RFC1918/loopback/link-local only).`,
    );
  }

  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const startedAt = Date.now();

  const statusCode = await new Promise<number>((resolvePromise, reject) => {
    const req = transport(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: check.method.toUpperCase(),
        headers: check.headers,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolvePromise(res.statusCode ?? 0));
        res.on('error', reject);
      },
    );
    req.setTimeout(check.timeoutMs ?? 10_000, () => req.destroy(new Error('Control test request timed out.')));
    req.on('error', reject);
    if (check.body) req.write(check.body);
    req.end();
  });

  return {
    target: check.url,
    method: check.method.toUpperCase(),
    statusCode,
    durationMs: Date.now() - startedAt,
    passed: check.passStatusCodes.includes(statusCode),
  };
}

/**
 * Execute a defensive control test and verify the control works.
 *
 * Requires the operator to supply the real HTTP request(s) that exercise the
 * control (context.requests) — there is no fabricated result path. A test
 * with no requests configured throws rather than reporting a synthetic pass.
 */
export async function executeControlTest(
  scenarioId: string,
  context: ControlTestExecutionContext,
): Promise<{
  testId: string;
  passed: boolean;
  observedBehavior: string;
  evidence: Record<string, unknown>;
}> {
  const scenario = CONTROL_TEST_SCENARIOS[scenarioId];
  if (!scenario) {
    throw new Error(`Control test scenario not found: ${scenarioId}`);
  }
  if (!context?.requests?.length) {
    throw new Error(
      `Control test "${scenario.name}" requires at least one real HTTP request (context.requests) against the ` +
        'private-lab system under test; refusing to fabricate a result.',
    );
  }

  const observations = await Promise.all(context.requests.map((request) => executeHttpCheck(request)));
  const testPassed = observations.every((observation) => observation.passed);

  return {
    testId: scenario.id,
    passed: testPassed,
    observedBehavior: testPassed
      ? `Control test "${scenario.name}" passed: ${scenario.expectedOutcome}`
      : `Control test "${scenario.name}" FAILED: ${scenario.failureMeaning}`,
    evidence: {
      scenario: scenario.id,
      timestamp: new Date().toISOString(),
      observations: redactDeep(observations),
    },
  };
}

/**
 * Run all control tests for a category. Each scenario in the category must
 * have a matching entry in `contexts`, keyed by scenario id.
 */
export async function runControlTestCategory(
  category: 'authentication' | 'authorization' | 'tenant-isolation' | 'rate-limit' | 'validation',
  contexts: Record<string, ControlTestExecutionContext>,
): Promise<{ testId: string; passed: boolean }[]> {
  const relevantTests = Object.values(CONTROL_TEST_SCENARIOS).filter((s) => s.category === category);
  const missing = relevantTests.filter((test) => !contexts[test.id]?.requests?.length).map((test) => test.id);
  if (missing.length > 0) {
    throw new Error(`Missing real HTTP request context for control test(s): ${missing.join(', ')}`);
  }

  const results: { testId: string; passed: boolean }[] = [];

  for (const test of relevantTests) {
    const result = await executeControlTest(test.id, contexts[test.id]);
    results.push({
      testId: result.testId,
      passed: result.passed,
    });
  }

  return results;
}
