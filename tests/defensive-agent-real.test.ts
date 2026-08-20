import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DefensiveControlInspectorImpl,
  DefensiveRegressionVerifierImpl,
} from '@dacai-local-agent/agents';
import {
  DEFAULT_PERMISSION_POLICY,
  NodeProcessHealthMonitor,
  type LiveValidationAuditSink,
  type RedTeamEngagement,
  type RedTeamFinding,
} from '@dacai-local-agent/security';

function findingFixture(overrides: Partial<RedTeamFinding> = {}): RedTeamFinding {
  return {
    id: 'fnd_test',
    engagementId: 'eng_test',
    title: 'Rate limiting can be bypassed on the login endpoint',
    description: 'No 429 was ever observed after 500 rapid requests.',
    severity: 'high',
    confidence: 0.8,
    findingType: 'vulnerability',
    affectedComponents: ['auth'],
    status: 'verified',
    evidenceIds: [],
    createdAt: new Date(),
    ...overrides,
  };
}

describe('DefensiveControlInspectorImpl', () => {
  const inspector = new DefensiveControlInspectorImpl(DEFAULT_PERMISSION_POLICY);

  it('inspects the real PermissionPolicy for rate-limit findings and reports the control is genuinely missing', async () => {
    const observation = await inspector.inspect({ engagementId: 'eng_test', finding: findingFixture() });
    expect(observation).not.toBeNull();
    expect(observation?.controlPresent).toBe(false);
    expect(observation?.rootCause).toBe('missing-control');
    expect(observation?.evidence[0]).toMatch(/no rate-limiting middleware/i);
  });

  it('inspects the real PermissionPolicy for authorization findings', async () => {
    const observation = await inspector.inspect({
      engagementId: 'eng_test',
      finding: findingFixture({ title: 'Normal user reached an admin-only endpoint', description: 'Authorization bypass on /api/admin.' }),
    });
    expect(observation).not.toBeNull();
    expect(observation?.control).toBe('PermissionEngine tier policy');
    expect(observation?.evidence[0]).toContain('requireApproval=[mutation,high-impact]'.replace(',', ', '));
  });

  it('returns null (no fabricated verdict) for a category it has no real signal for', async () => {
    const observation = await inspector.inspect({
      engagementId: 'eng_test',
      finding: findingFixture({ title: 'SQL injection in the search endpoint', description: 'Unescaped input reached the query.' }),
    });
    expect(observation).toBeNull();
  });
});

describe('DefensiveRegressionVerifierImpl', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function engagementFixture(overrides: Partial<RedTeamEngagement> = {}): RedTeamEngagement {
    return {
      id: 'eng_test',
      customerId: 'cust_test',
      authorizedTargets: [baseUrl],
      authorizedEnvironments: [],
      allowedTestCategories: [],
      prohibitedActions: [],
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      humanApprover: 'approver',
      authorizationEvidenceId: 'evd_test',
      rulesOfEngagement: {},
      scopeBreadth: 'defined',
      threatModelTags: [],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  class MemoryAuditSink implements LiveValidationAuditSink {
    async record(): Promise<void> {}
  }

  it('re-runs the real scenario tied to a finding and reports the defense held', async () => {
    const engagement = engagementFixture();
    const engagementStore = { get: async (id: string) => (id === engagement.id ? engagement : null) } as any;
    const resultStore = { create: async (r: any) => ({ ...r, id: 'tst_x', createdAt: new Date() }) } as any;
    const verifier = new DefensiveRegressionVerifierImpl(engagementStore, resultStore, {
      auditSink: new MemoryAuditSink(),
      healthMonitor: new NodeProcessHealthMonitor(),
    });

    // The test server always 401s, matching what auth-malformed-token expects — the real
    // attack (a malformed token) still fails to authenticate, so the defense held.
    const result = await verifier.verify({ engagementId: engagement.id, findingId: 'fnd_test', scenarioId: 'auth-malformed-token' });

    expect(result.outcome).toBe('blocked');
    expect(result.evidence.some((e) => e.includes('status=passed'))).toBe(true);
  });

  it('reports still-vulnerable when the real re-run shows the attack succeeding', async () => {
    server.close();
    server = createServer((req, res) => {
      // A malformed token being accepted (200) is exactly what a real vulnerable target would do.
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const engagement = engagementFixture({ authorizedTargets: [`http://127.0.0.1:${port}`] });
    const engagementStore = { get: async (id: string) => (id === engagement.id ? engagement : null) } as any;
    const resultStore = { create: async (r: any) => ({ ...r, id: 'tst_x', createdAt: new Date() }) } as any;
    const verifier = new DefensiveRegressionVerifierImpl(engagementStore, resultStore, {
      auditSink: new MemoryAuditSink(),
      healthMonitor: new NodeProcessHealthMonitor(),
    });

    const result = await verifier.verify({ engagementId: engagement.id, findingId: 'fnd_test', scenarioId: 'auth-malformed-token' });

    expect(result.outcome).toBe('still-vulnerable');
  });

  it('reports inconclusive rather than fabricating a verdict when the engagement has no target', async () => {
    const engagement = engagementFixture({ authorizedTargets: [] });
    const engagementStore = { get: async (id: string) => (id === engagement.id ? engagement : null) } as any;
    const resultStore = { create: async () => { throw new Error('should not be called'); } } as any;
    const verifier = new DefensiveRegressionVerifierImpl(engagementStore, resultStore, {
      auditSink: new MemoryAuditSink(),
      healthMonitor: new NodeProcessHealthMonitor(),
    });

    const result = await verifier.verify({ engagementId: engagement.id, findingId: 'fnd_test', scenarioId: 'auth-malformed-token' });

    expect(result.outcome).toBe('inconclusive');
    expect(result.evidence[0]).toMatch(/no authorized target/i);
  });
});
