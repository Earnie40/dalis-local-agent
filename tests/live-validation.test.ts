import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHttpLiveActionDriver,
  InMemoryKillSwitchStateStore,
  InMemoryLiveValidationAuditSink,
  LIVE_VALIDATION_MODE,
  LiveValidationKillSwitchCoordinator,
  LiveValidationSafetyController,
  type LiveActionDriver,
  type LiveValidationRunConfig,
  type TargetResolver,
} from '../packages/security/src/index';

class MapResolver implements TargetResolver {
  constructor(private readonly records: Record<string, string[]>) {}

  async resolve(hostname: string): Promise<string[]> {
    const addresses = this.records[hostname];
    if (!addresses) throw new Error('NXDOMAIN');
    return addresses;
  }
}

function runConfig(overrides: Partial<LiveValidationRunConfig> = {}): LiveValidationRunConfig {
  return {
    mode: LIVE_VALIDATION_MODE,
    testId: 'live-test-001',
    operator: 'test-operator',
    authorizationEvidenceId: 'approval-001',
    authorizedScope: ['lab.local'],
    limits: {
      maxDurationMs: 60_000,
      maxActionCount: 10,
      maxConcurrency: 1,
      maxBytesPerSecond: 1024 * 1024,
      maxTotalBytes: 10 * 1024 * 1024,
      expiresAt: new Date(Date.now() + 60_000),
    },
    healthThresholds: { maxMemoryRssBytes: Number.MAX_SAFE_INTEGER },
    heartbeatTimeoutMs: 30_000,
    hardNetworkStop: false,
    ...overrides,
  };
}

function dependencies(records: Record<string, string[]> = { 'lab.local': ['10.20.0.10'] }) {
  const audit = new InMemoryLiveValidationAuditSink();
  const stateStore = new InMemoryKillSwitchStateStore();
  const killSwitch = new LiveValidationKillSwitchCoordinator(stateStore, {});
  return {
    audit,
    stateStore,
    killSwitch,
    values: {
      auditSink: audit,
      healthMonitor: {
        sample: async () => ({ memoryRssBytes: 1, observedAt: new Date() }),
      },
      targetResolver: new MapResolver(records),
      killSwitch,
    },
  };
}

function liveObservation(observedResult: unknown, target = 'http://lab.local/test') {
  return {
    source: 'LIVE_ENVIRONMENT' as const,
    observedAt: new Date(),
    observedResult,
    artifacts: [],
    contactedTargets: [target],
    bytesSent: 0,
    bytesReceived: 0,
  };
}

describe('Tomahawk1 LIVE_VALIDATION safety controller', () => {
  it('rejects unauthorized targets before the driver can execute and trips the circuit breaker', async () => {
    const deps = dependencies({ 'lab.local': ['10.20.0.10'], 'other.local': ['10.20.0.11'] });
    const controller = await LiveValidationSafetyController.create(runConfig(), deps.values);
    const driver = vi.fn(async () => liveObservation('must not run', 'http://other.local/test'));

    await expect(
      controller.executeAction(
        { actionId: 'a-1', target: 'http://other.local/test', action: 'GET /test', expectedResult: 403 },
        driver,
      ),
    ).rejects.toThrow(/not provably within/i);

    expect(driver).not.toHaveBeenCalled();
    expect((await deps.killSwitch.getState())?.reason).toMatch(/OUTSIDE_AUTHORIZED_SCOPE/);
  });

  it('rejects public Internet destinations even when the hostname appears in the allowlist', async () => {
    const deps = dependencies({ 'public.example': ['93.184.216.34'] });
    const controller = await LiveValidationSafetyController.create(
      runConfig({ authorizedScope: ['public.example'] }),
      deps.values,
    );
    const driver = vi.fn<LiveActionDriver>();

    await expect(
      controller.executeAction(
        { actionId: 'a-2', target: 'https://public.example/', action: 'GET /', expectedResult: 200 },
        driver,
      ),
    ).rejects.toThrow(/Public Internet routing is forbidden/i);
    expect(driver).not.toHaveBeenCalled();
    expect((await deps.killSwitch.getState())?.reason).toMatch(/PUBLIC_INTERNET/);
  });

  it('global kill switch aborts active work, cancels queued work, and closes sessions', async () => {
    const deps = dependencies();
    const controller = await LiveValidationSafetyController.create(runConfig(), deps.values);
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => (startedResolve = resolve));
    const closeSession = vi.fn();
    const activeDriver: LiveActionDriver = async (_request, context) => {
      context.registerOutboundSession(closeSession);
      startedResolve();
      return new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
    };
    const queuedDriver = vi.fn(async () => liveObservation('queued'));

    const active = controller.executeAction(
      { actionId: 'active', target: 'http://lab.local/test', action: 'active action', expectedResult: 'done' },
      activeDriver,
    );
    await started;
    const queued = controller.executeAction(
      { actionId: 'queued', target: 'http://lab.local/test', action: 'queued action', expectedResult: 'done' },
      queuedDriver,
    );
    while (controller.status.queued === 0) await new Promise((resolve) => setImmediate(resolve));

    await deps.killSwitch.stopAll({ reason: 'test emergency', operator: 'operator-1' });

    await expect(active).rejects.toThrow(/test emergency/i);
    await expect(queued).rejects.toThrow(/test emergency/i);
    expect(queuedDriver).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledOnce();
    expect(controller.status.state).toBe('STOPPED');
  });

  it('honors TOMAHAWK1_EMERGENCY_STOP before a run can start', async () => {
    const audit = new InMemoryLiveValidationAuditSink();
    const stateStore = new InMemoryKillSwitchStateStore();
    const killSwitch = new LiveValidationKillSwitchCoordinator(stateStore, {
      TOMAHAWK1_EMERGENCY_STOP: 'true',
    });

    await expect(
      LiveValidationSafetyController.create(runConfig(), {
        auditSink: audit,
        healthMonitor: { sample: async () => ({ memoryRssBytes: 1, observedAt: new Date() }) },
        targetResolver: new MapResolver({ 'lab.local': ['10.20.0.10'] }),
        killSwitch,
      }),
    ).rejects.toThrow(/environment latch|explicitly restart/i);
    expect((await killSwitch.getState())?.operator).toBe('environment');
  });

  it('keeps the stop latch across coordinators until an explicit operator restart', async () => {
    const stateStore = new InMemoryKillSwitchStateStore();
    const first = new LiveValidationKillSwitchCoordinator(stateStore, {});
    await first.stopAll({ reason: 'latched stop', operator: 'operator-1' });

    const afterRestartedProcess = new LiveValidationKillSwitchCoordinator(stateStore, {});
    await expect(afterRestartedProcess.assertCanStart()).rejects.toThrow(/explicitly restart/i);
    await expect(afterRestartedProcess.restart('operator-2', 'yes')).rejects.toThrow(/exact acknowledgement/i);

    await afterRestartedProcess.restart('operator-2', 'RESTART LIVE VALIDATION');
    await expect(afterRestartedProcess.assertCanStart()).resolves.toBeUndefined();
  });

  it('stops workers even if durable kill-switch persistence fails', async () => {
    const participant = { emergencyStop: vi.fn(async () => undefined) };
    const killSwitch = new LiveValidationKillSwitchCoordinator(
      {
        load: async () => null,
        save: async () => Promise.reject(new Error('disk unavailable')),
        clear: async () => undefined,
      },
      {},
    );
    await killSwitch.register(participant);

    await expect(killSwitch.stopAll({ reason: 'fail-safe stop', operator: 'operator-3' })).rejects.toThrow(
      /disk unavailable/i,
    );
    expect(participant.emergencyStop).toHaveBeenCalledWith('fail-safe stop', 'operator-3', false);
  });

  it('fails closed when the safety health service is unavailable', async () => {
    const deps = dependencies();
    await expect(
      LiveValidationSafetyController.create(runConfig(), {
        ...deps.values,
        healthMonitor: { sample: async () => Promise.reject(new Error('health endpoint down')) },
      }),
    ).rejects.toThrow(/System health is unavailable/i);
    expect((await deps.killSwitch.getState())?.reason).toMatch(/initialization failed closed/i);
  });

  it('cannot start without explicit authorization evidence', async () => {
    const deps = dependencies();
    await expect(
      LiveValidationSafetyController.create(runConfig({ authorizationEvidenceId: '' }), deps.values),
    ).rejects.toThrow(/explicit authorization evidence/i);
  });

  it('preserves OBSERVED_RESULT separately and never substitutes EXPECTED_RESULT', async () => {
    const deps = dependencies();
    const controller = await LiveValidationSafetyController.create(runConfig(), deps.values);
    const observed = { statusCode: 503, body: 'actual lab response' };
    const expected = { statusCode: 200 };

    const result = await controller.executeAction(
      { actionId: 'a-3', target: 'http://lab.local/test', action: 'GET /test', expectedResult: expected },
      async () => liveObservation(observed),
    );
    await controller.end();

    expect(result.expectedResult).toEqual(expected);
    expect(result.observedResult).toEqual(observed);
    expect(result.observedResult).not.toEqual(result.expectedResult);
    const observationAudit = deps.audit.events.find((event) => event.eventType === 'OBSERVATION_RECORDED');
    expect(observationAudit?.expectedResult).toEqual(expected);
    expect(observationAudit?.observedResult).toEqual(observed);
  });

  it('uses the real pinned HTTP service response in LIVE_VALIDATION', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 418;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ source: 'actual-lab-service', detected: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const deps = dependencies({ 'lab.local': ['127.0.0.1'] });
    const controller = await LiveValidationSafetyController.create(
      runConfig({ authorizedScope: [{ host: 'lab.local', ports: [port] }] }),
      deps.values,
    );

    try {
      const target = `http://lab.local:${port}/probe`;
      const result = await controller.executeAction(
        { actionId: 'http-live', target, action: 'GET /probe', expectedResult: { statusCode: 200 } },
        createHttpLiveActionDriver({ method: 'GET', maxResponseBytes: 4096, timeoutMs: 2000 }),
      );
      expect(result.observedResult).toMatchObject({ statusCode: 418 });
      expect(JSON.stringify(result.observedResult)).toContain('actual-lab-service');
      expect(result.observation.source).toBe('LIVE_ENVIRONMENT');
      await controller.end();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('rejects simulated observations on the LIVE_VALIDATION path', async () => {
    const deps = dependencies();
    const controller = await LiveValidationSafetyController.create(runConfig(), deps.values);

    await expect(
      controller.executeAction(
        { actionId: 'a-4', target: 'http://lab.local/test', action: 'GET /test', expectedResult: 200 },
        async () => ({ ...liveObservation({ statusCode: 200 }), source: 'SIMULATION' as never }),
      ),
    ).rejects.toThrow(/simulated or unknown observation source/i);
    expect((await deps.killSwitch.getState())?.reason).toMatch(/provenance failure/i);
  });

  it('trips when a worker reports unexpected network propagation', async () => {
    const deps = dependencies({ 'lab.local': ['10.20.0.10'], 'spread.local': ['10.20.0.12'] });
    const controller = await LiveValidationSafetyController.create(runConfig(), deps.values);

    await expect(
      controller.executeAction(
        { actionId: 'propagation', target: 'http://lab.local/test', action: 'probe', expectedResult: 'isolated' },
        async () => ({
          ...liveObservation('unexpected propagation'),
          contactedTargets: ['http://lab.local/test', 'http://spread.local/peer'],
        }),
      ),
    ).rejects.toThrow(/not provably within/i);
    expect((await deps.killSwitch.getState())?.reason).toMatch(/OUTSIDE_AUTHORIZED_SCOPE/);
  });

  it('trips when configured network throughput is exceeded', async () => {
    const deps = dependencies();
    const controller = await LiveValidationSafetyController.create(
      runConfig({
        limits: {
          ...runConfig().limits,
          maxBytesPerSecond: 4,
          maxTotalBytes: 100,
        },
      }),
      deps.values,
    );

    await expect(
      controller.executeAction(
        { actionId: 'traffic', target: 'http://lab.local/test', action: 'probe', expectedResult: 'bounded' },
        async (_request, context) => {
          await context.reportNetworkUsage(5);
          return liveObservation('must not finish');
        },
      ),
    ).rejects.toThrow(/throughput exceeded/i);
    expect((await deps.killSwitch.getState())?.reason).toMatch(/throughput exceeded/i);
  });

  it('invokes independent HARD_NETWORK_STOP after application-level cancellation', async () => {
    const deps = dependencies();
    const isolate = vi.fn(async () => ({ isolated: true, details: 'lab egress firewall disabled' }));
    const controller = await LiveValidationSafetyController.create(runConfig({ hardNetworkStop: true }), {
      ...deps.values,
      hardNetworkStopProvider: { isolate },
    });

    await deps.killSwitch.stopAll({ reason: 'containment test', operator: 'operator-2', hardNetworkStop: true });

    expect(controller.status.state).toBe('STOPPED');
    expect(isolate).toHaveBeenCalledWith('containment test');
  });
});
