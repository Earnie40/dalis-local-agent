import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdversarialAgent,
  BUILT_IN_SCENARIOS,
  type LiveAdversarialTestConfig,
  type LiveScenarioApprovalGate,
} from '@dacai-local-agent/agents';
import {
  LIVE_VALIDATION_MODE,
  SIMULATION_MODE,
  NodeProcessHealthMonitor,
  type AdversarialTestResult,
  type LiveValidationAuditSink,
  type RedTeamEngagement,
} from '@dacai-local-agent/security';

/** In-memory stand-ins for the real Postgres-backed stores — no DB needed for these tests. */
function fakeEngagementStore(engagement: RedTeamEngagement) {
  return { get: async (id: string) => (id === engagement.id ? engagement : null) } as any;
}

function fakeResultStore() {
  const created: Array<Omit<AdversarialTestResult, 'id' | 'createdAt'>> = [];
  return {
    store: { create: async (result: any) => { created.push(result); return { ...result, id: 'tst_fake', createdAt: new Date() }; } } as any,
    created,
  };
}

function engagementFixture(overrides: Partial<RedTeamEngagement> = {}): RedTeamEngagement {
  return {
    id: 'eng_test',
    customerId: 'cust_test',
    authorizedTargets: [],
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
  events: unknown[] = [];
  async record(event: unknown): Promise<void> {
    this.events.push(event);
  }
}

function liveDependencies() {
  return { auditSink: new MemoryAuditSink(), healthMonitor: new NodeProcessHealthMonitor() };
}

const baseLimits = {
  maxDurationMs: 15_000,
  maxActionCount: 5,
  maxConcurrency: 1,
  maxBytesPerSecond: 1_000_000,
  maxTotalBytes: 1_000_000,
  expiresAt: new Date(Date.now() + 60_000),
};

const baseHealthThresholds = { maxMemoryRssBytes: 4 * 1024 * 1024 * 1024 };

describe('AdversarialAgent SIMULATION mode', () => {
  it('runs a built-in scenario deterministically and persists a passed status', async () => {
    const engagement = engagementFixture();
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store);

    const results = await agent.runTest({
      engagementId: engagement.id,
      scenarioId: 'auth-malformed-token',
      autoApproveLevel1: true,
      autoApproveLevel2: true,
      maxConcurrentTests: 1,
      timeoutMs: 5_000,
      executionMode: SIMULATION_MODE,
    });

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].status).toBe('passed');
    expect(created).toHaveLength(1);
  });

  it('requires autoApproveLevel1 for a LEVEL_1_SAFE scenario', async () => {
    const engagement = engagementFixture();
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store);

    // SIMULATION-mode failures are logged and swallowed (matching this method's pre-existing
    // "only LIVE_VALIDATION fails visibly" contract) — the gate still blocks the run, it just
    // surfaces as an empty result set rather than a thrown rejection.
    const results = await agent.runTest({
      engagementId: engagement.id,
      scenarioId: 'auth-malformed-token',
      autoApproveLevel1: false,
      autoApproveLevel2: true,
      maxConcurrentTests: 1,
      timeoutMs: 5_000,
      executionMode: SIMULATION_MODE,
    });

    expect(results).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

describe('AdversarialAgent LIVE_VALIDATION mode', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/me')) {
        const auth = req.headers.authorization;
        if (auth === 'Bearer real-valid-token-xyz') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function liveConfig(overrides: Partial<LiveAdversarialTestConfig> = {}): LiveAdversarialTestConfig {
    return {
      engagementId: 'eng_test',
      scenarioId: 'auth-malformed-token',
      autoApproveLevel1: true,
      autoApproveLevel2: true,
      maxConcurrentTests: 1,
      timeoutMs: 15_000,
      executionMode: LIVE_VALIDATION_MODE,
      operator: 'operator',
      authorizationEvidenceId: 'evd_test',
      target: baseUrl,
      limits: baseLimits,
      healthThresholds: baseHealthThresholds,
      heartbeatTimeoutMs: 5_000,
      hardNetworkStop: false,
      ...overrides,
    };
  }

  it('runs a real HTTP scenario against a real local server and evaluates the real response', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    const results = await agent.runTest(liveConfig());

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].status).toBe('passed');
    expect((results[0].evidence as any).OBSERVED_RESULT.statusCode).toBe(401);
    expect(created).toHaveLength(1);
  });

  it('evaluates a real observation as failed when the target does not behave as expected', async () => {
    // auth-valid-token expects 200/204, but no fixture token is provided so the real
    // server call this test hits (via a mismatched-scenario setup) would 401. Instead,
    // prove failure detection using a scenario/fixture combination that legitimately
    // fails: an unmodified server always returns 401 for auth-valid-token's malformed
    // Authorization-less request shape is not applicable here since fixtures are required;
    // exercise the required-fixture fail-closed path instead (see next test) and confirm
    // a genuine mismatch is caught when the server never returns the expected status.
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    const results = await agent.runTest(
      liveConfig({ scenarioId: 'auth-valid-token', fixtures: { validToken: 'this-is-not-the-real-token' } }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].status).toBe('failed');
    expect((results[0].evidence as any).OBSERVED_RESULT.statusCode).toBe(401);
  });

  it('fails closed with the exact missing fixture name when required fixtures are absent', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    await expect(agent.runTest(liveConfig({ scenarioId: 'auth-valid-token' }))).rejects.toThrow(/requires fixtures: validToken/);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe('blocked');
  });

  it('fails closed via ScopeGuard when the target is outside engagement.authorizedTargets', async () => {
    const engagement = engagementFixture({ authorizedTargets: ['http://127.0.0.1:1'] });
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    await expect(agent.runTest(liveConfig())).rejects.toThrow(/ScopeGuard denied/);
    expect(created[0].status).toBe('blocked');
  });

  it('fails closed when a LEVEL_2 scenario has no approval gate configured', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    await expect(
      agent.runTest(
        liveConfig({
          scenarioId: 'tenant-isolation-basic',
          autoApproveLevel2: false,
          fixtures: { tenantAToken: 'x', otherTenantResourcePath: '/api/tenant-data/x' },
        }),
      ),
    ).rejects.toThrow(/requires human approval/);
    expect(created[0].status).toBe('blocked');
  });

  it('honors a real approval gate denial without ever contacting the target', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store, created } = fakeResultStore();
    let requestedWith: unknown;
    const denyingGate: LiveScenarioApprovalGate = {
      requestApproval: async (input) => {
        requestedWith = input;
        return false;
      },
    };
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies(), denyingGate);

    await expect(
      agent.runTest(
        liveConfig({
          scenarioId: 'tenant-isolation-basic',
          autoApproveLevel2: false,
          fixtures: { tenantAToken: 'x', otherTenantResourcePath: '/api/tenant-data/x' },
        }),
      ),
    ).rejects.toThrow(/was not approved/);
    expect(created[0].status).toBe('blocked');
    expect((requestedWith as any).riskLevel).toBe('LEVEL_2_CONTROLLED');
  });

  it('proceeds to a real live action once a real approval gate approves', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store, created } = fakeResultStore();
    const approvingGate: LiveScenarioApprovalGate = { requestApproval: async () => true };
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies(), approvingGate);

    const results = await agent.runTest(
      liveConfig({
        scenarioId: 'tenant-isolation-basic',
        autoApproveLevel2: false,
        fixtures: { tenantAToken: 'x', otherTenantResourcePath: '/api/tenant-data/x' },
      }),
    );

    // The fixture path 404s on this test server (no such route), which is within the
    // scenario's own expected [403, 404] — proving the real HTTP call actually happened.
    expect(results[0].passed).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('rejects mismatched authorization evidence without touching the target', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    await expect(agent.runTest(liveConfig({ authorizationEvidenceId: 'wrong-evidence-id' }))).rejects.toThrow(
      /matching explicit engagement authorization/,
    );
  });

  it('has no live executor for scenarios outside the MVP set and fails closed rather than degrading', async () => {
    const engagement = engagementFixture({ authorizedTargets: [baseUrl] });
    const { store, created } = fakeResultStore();
    const agent = new AdversarialAgent(fakeEngagementStore(engagement), store, liveDependencies());

    await expect(agent.runTest(liveConfig({ scenarioId: 'state-consistency-creation' }))).rejects.toThrow(
      /No LIVE_VALIDATION executor is registered/,
    );
    expect(created[0].status).toBe('blocked');
  });
});

describe('BUILT_IN_SCENARIOS', () => {
  it('has exactly 13 scenarios, unchanged by the registry relocation', () => {
    expect(Object.keys(BUILT_IN_SCENARIOS)).toHaveLength(13);
  });
});
