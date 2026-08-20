import { randomUUID } from 'node:crypto';
import { AuthorizedTargetAllowlist, TargetAuthorizationError, type TargetResolver } from './target-allowlist.js';
import {
  getGlobalLiveValidationKillSwitch,
  LiveValidationKillSwitchCoordinator,
  LiveValidationStoppedError,
  type KillSwitchParticipant,
} from './live-validation-kill-switch.js';
import {
  LIVE_VALIDATION_MODE,
  type HardNetworkStopProvider,
  type LiveActionContext,
  type LiveActionDriver,
  type LiveActionRequest,
  type LiveActionResult,
  type LiveEnvironmentObservation,
  type LiveValidationAuditEvent,
  type LiveValidationAuditSink,
  type LiveValidationHealthMonitor,
  type LiveValidationRunConfig,
  type ResolvedAuthorizedTarget,
  type SystemHealthSnapshot,
} from './live-validation-types.js';

export class LiveValidationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveValidationConfigurationError';
  }
}

export class LiveValidationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveValidationLimitError';
  }
}

class LiveValidationAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveValidationAuditError';
  }
}

export class NodeProcessHealthMonitor implements LiveValidationHealthMonitor {
  async sample(): Promise<SystemHealthSnapshot> {
    return {
      memoryRssBytes: process.memoryUsage().rss,
      observedAt: new Date(),
    };
  }
}

export interface LiveValidationSafetyDependencies {
  auditSink: LiveValidationAuditSink;
  healthMonitor: LiveValidationHealthMonitor;
  targetResolver?: TargetResolver;
  hardNetworkStopProvider?: HardNetworkStopProvider;
  killSwitch?: LiveValidationKillSwitchCoordinator;
  now?: () => Date;
}

interface QueuedAction {
  actionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

type ControllerState = 'INITIALIZING' | 'RUNNING' | 'STOPPED' | 'ENDED';

function positiveFiniteInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LiveValidationConfigurationError(`${name} must be a positive finite integer.`);
  }
}

function validateConfig(config: LiveValidationRunConfig, now: Date): void {
  if (config.mode !== LIVE_VALIDATION_MODE) {
    throw new LiveValidationConfigurationError('The safety controller only accepts explicit LIVE_VALIDATION mode.');
  }
  if (!config.testId.trim()) throw new LiveValidationConfigurationError('LIVE_VALIDATION requires a test ID.');
  if (!config.operator.trim()) throw new LiveValidationConfigurationError('LIVE_VALIDATION requires an operator identity.');
  if (!config.authorizationEvidenceId.trim()) {
    throw new LiveValidationConfigurationError('LIVE_VALIDATION requires explicit authorization evidence.');
  }
  if (config.authorizedScope.length === 0) {
    throw new LiveValidationConfigurationError('LIVE_VALIDATION requires a mandatory target allowlist.');
  }
  positiveFiniteInteger(config.limits.maxDurationMs, 'maxDurationMs');
  positiveFiniteInteger(config.limits.maxActionCount, 'maxActionCount');
  positiveFiniteInteger(config.limits.maxConcurrency, 'maxConcurrency');
  positiveFiniteInteger(config.limits.maxBytesPerSecond, 'maxBytesPerSecond');
  positiveFiniteInteger(config.limits.maxTotalBytes, 'maxTotalBytes');
  positiveFiniteInteger(config.heartbeatTimeoutMs, 'heartbeatTimeoutMs');
  positiveFiniteInteger(config.healthThresholds.maxMemoryRssBytes, 'maxMemoryRssBytes');
  if (!Number.isFinite(config.limits.expiresAt.getTime()) || config.limits.expiresAt <= now) {
    throw new LiveValidationConfigurationError('LIVE_VALIDATION expiration must be a valid future time.');
  }
  if (config.hardNetworkStop && !config.authorizationEvidenceId) {
    throw new LiveValidationConfigurationError('HARD_NETWORK_STOP requires the same explicit authorization evidence.');
  }
}

/**
 * The only entry point for live actions. It owns scope proof, bounded workers,
 * circuit breakers, the global stop latch, sessions, and audit emission.
 */
export class LiveValidationSafetyController implements KillSwitchParticipant {
  private readonly allowlist: AuthorizedTargetAllowlist;
  private readonly killSwitch: LiveValidationKillSwitchCoordinator;
  private readonly now: () => Date;
  private state: ControllerState = 'INITIALIZING';
  private stopReason?: string;
  private startedAt: Date;
  private endedAt?: Date;
  private lastHeartbeatAt: Date;
  private actionCount = 0;
  private activeCount = 0;
  private totalNetworkBytes = 0;
  private readonly trafficWindow: Array<{ timestamp: number; bytes: number }> = [];
  private readonly queue: QueuedAction[] = [];
  private readonly activeWorkers = new Map<string, AbortController>();
  private readonly outboundSessions = new Set<() => void | Promise<void>>();
  private monitor?: ReturnType<typeof setInterval>;
  private unregisterKillSwitch?: () => void;
  private endingRecorded = false;
  private hardNetworkStopApplied = false;

  private constructor(
    readonly config: LiveValidationRunConfig,
    private readonly dependencies: LiveValidationSafetyDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    const initialNow = this.now();
    validateConfig(config, initialNow);
    if (config.hardNetworkStop && !dependencies.hardNetworkStopProvider) {
      throw new LiveValidationConfigurationError(
        'HARD_NETWORK_STOP is enabled but no external firewall/network isolation provider is configured.',
      );
    }
    if (!dependencies.auditSink || !dependencies.healthMonitor) {
      throw new LiveValidationConfigurationError('Audit and health services are mandatory in LIVE_VALIDATION.');
    }
    this.allowlist = new AuthorizedTargetAllowlist(config.authorizedScope, dependencies.targetResolver);
    this.killSwitch = dependencies.killSwitch ?? getGlobalLiveValidationKillSwitch();
    this.startedAt = initialNow;
    this.lastHeartbeatAt = initialNow;
  }

  static async create(
    config: LiveValidationRunConfig,
    dependencies: LiveValidationSafetyDependencies,
  ): Promise<LiveValidationSafetyController> {
    const controller = new LiveValidationSafetyController(config, dependencies);
    try {
      controller.unregisterKillSwitch = await controller.killSwitch.register(controller);
      await controller.killSwitch.assertCanStart();
      await controller.assertSystemHealth();
      await controller.recordAudit({ eventType: 'RUN_STARTED' });
      controller.state = 'RUNNING';
      controller.startMonitor();
      return controller;
    } catch (error) {
      controller.unregisterKillSwitch?.();
      controller.state = 'STOPPED';
      if (!(error instanceof LiveValidationStoppedError)) {
        await controller.killSwitch.stopAll({
          reason: `Safety controller initialization failed closed: ${error instanceof Error ? error.message : String(error)}`,
          operator: config.operator,
          hardNetworkStop: config.hardNetworkStop,
        });
      }
      throw error;
    }
  }

  get status(): { state: ControllerState; stopReason?: string; active: number; queued: number; actions: number } {
    return {
      state: this.state,
      stopReason: this.stopReason,
      active: this.activeCount,
      queued: this.queue.length,
      actions: this.actionCount,
    };
  }

  heartbeat(): void {
    if (this.state === 'RUNNING') this.lastHeartbeatAt = this.now();
  }

  private startMonitor(): void {
    const intervalMs = Math.max(25, Math.min(1000, Math.floor(this.config.heartbeatTimeoutMs / 2)));
    this.monitor = setInterval(() => {
      void this.checkCircuitBreakers().catch((error) => {
        void this.triggerCircuitBreaker(
          `Safety-controller monitor failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, intervalMs);
    this.monitor.unref?.();
  }

  private ensureRunning(): void {
    if (this.state !== 'RUNNING') {
      throw new LiveValidationStoppedError(
        `LIVE_VALIDATION action blocked because controller state is ${this.state}${this.stopReason ? `: ${this.stopReason}` : ''}.`,
      );
    }
  }

  private async recordAudit(
    partial: Pick<LiveValidationAuditEvent, 'eventType'> & Partial<LiveValidationAuditEvent>,
  ): Promise<void> {
    const event: LiveValidationAuditEvent = {
      eventId: randomUUID(),
      executionMode: LIVE_VALIDATION_MODE,
      eventType: partial.eventType,
      testId: this.config.testId,
      operator: partial.operator ?? this.config.operator,
      timestamp: partial.timestamp ?? this.now(),
      authorizationEvidenceId: this.config.authorizationEvidenceId,
      authorizedScope: this.config.authorizedScope,
      target: partial.target,
      actionId: partial.actionId,
      action: partial.action,
      expectedResult: partial.expectedResult,
      observedResult: partial.observedResult,
      reason: partial.reason,
      details: partial.details,
    };
    try {
      await this.dependencies.auditSink.record(event);
    } catch (error) {
      throw new LiveValidationAuditError(
        `Mandatory live-validation audit sink failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async bestEffortAudit(
    partial: Pick<LiveValidationAuditEvent, 'eventType'> & Partial<LiveValidationAuditEvent>,
  ): Promise<void> {
    try {
      await this.recordAudit(partial);
    } catch {
      // Stopping must not depend on the audit sink remaining available.
    }
  }

  private async authorizeOrTrip(target: string, actionId?: string): Promise<ResolvedAuthorizedTarget> {
    try {
      const authorization = await this.allowlist.authorize(target);
      await this.recordAudit({
        eventType: 'TARGET_AUTHORIZED',
        target,
        actionId,
        details: { hostname: authorization.hostname, addresses: authorization.addresses, port: authorization.port },
      });
      return authorization;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.bestEffortAudit({ eventType: 'ACTION_REJECTED', target, actionId, reason });
      if (error instanceof TargetAuthorizationError) {
        await this.triggerCircuitBreaker(`${error.code}: ${reason}`);
      } else {
        await this.triggerCircuitBreaker(`Target authorization unavailable: ${reason}`);
      }
      throw error;
    }
  }

  private healthViolation(snapshot: SystemHealthSnapshot): string | undefined {
    const thresholds = this.config.healthThresholds;
    if (snapshot.memoryRssBytes > thresholds.maxMemoryRssBytes) {
      return `Memory RSS ${snapshot.memoryRssBytes} exceeds threshold ${thresholds.maxMemoryRssBytes}.`;
    }
    if (
      thresholds.maxCpuPercent !== undefined &&
      snapshot.cpuPercent === undefined
    ) {
      return 'CPU health metric is unavailable while a CPU threshold is configured.';
    }
    if (
      thresholds.maxCpuPercent !== undefined &&
      snapshot.cpuPercent !== undefined &&
      snapshot.cpuPercent > thresholds.maxCpuPercent
    ) {
      return `CPU ${snapshot.cpuPercent}% exceeds threshold ${thresholds.maxCpuPercent}%.`;
    }
    if (
      thresholds.maxErrorRate !== undefined &&
      snapshot.errorRate === undefined
    ) {
      return 'Error-rate health metric is unavailable while an error-rate threshold is configured.';
    }
    if (
      thresholds.maxErrorRate !== undefined &&
      snapshot.errorRate !== undefined &&
      snapshot.errorRate > thresholds.maxErrorRate
    ) {
      return `Error rate ${snapshot.errorRate} exceeds threshold ${thresholds.maxErrorRate}.`;
    }
    return undefined;
  }

  private async assertSystemHealth(): Promise<void> {
    let snapshot: SystemHealthSnapshot;
    try {
      snapshot = await this.dependencies.healthMonitor.sample();
    } catch (error) {
      throw new LiveValidationConfigurationError(
        `System health is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const violation = this.healthViolation(snapshot);
    if (violation) throw new LiveValidationLimitError(violation);
  }

  async checkCircuitBreakers(): Promise<void> {
    this.ensureRunning();
    await this.killSwitch.assertCanStart();
    const now = this.now();
    if (now.getTime() - this.startedAt.getTime() >= this.config.limits.maxDurationMs) {
      await this.triggerCircuitBreaker('Maximum live-validation duration exceeded.');
      return;
    }
    if (now >= this.config.limits.expiresAt) {
      await this.triggerCircuitBreaker('Live-validation authorization expired.');
      return;
    }
    if (now.getTime() - this.lastHeartbeatAt.getTime() > this.config.heartbeatTimeoutMs) {
      await this.triggerCircuitBreaker('Safety-controller heartbeat was lost.');
      return;
    }
    try {
      await this.assertSystemHealth();
    } catch (error) {
      await this.triggerCircuitBreaker(error instanceof Error ? error.message : String(error));
    }
  }

  async reportNetworkDestination(target: string, actionId?: string): Promise<ResolvedAuthorizedTarget> {
    this.ensureRunning();
    return this.authorizeOrTrip(target, actionId);
  }

  async reportNetworkUsage(bytes: number): Promise<void> {
    this.ensureRunning();
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      await this.triggerCircuitBreaker('Invalid network usage report received from a live worker.');
      throw new LiveValidationLimitError('Invalid network usage report.');
    }
    const now = this.now().getTime();
    this.totalNetworkBytes += bytes;
    this.trafficWindow.push({ timestamp: now, bytes });
    while (this.trafficWindow[0] && this.trafficWindow[0].timestamp <= now - 1000) this.trafficWindow.shift();
    const oneSecondBytes = this.trafficWindow.reduce((sum, sample) => sum + sample.bytes, 0);
    if (this.totalNetworkBytes > this.config.limits.maxTotalBytes) {
      await this.triggerCircuitBreaker('Maximum total live-validation network traffic exceeded.');
      throw new LiveValidationLimitError('Maximum total network traffic exceeded.');
    }
    if (oneSecondBytes > this.config.limits.maxBytesPerSecond) {
      await this.triggerCircuitBreaker('Maximum live-validation network throughput exceeded.');
      throw new LiveValidationLimitError('Maximum network throughput exceeded.');
    }
  }

  registerOutboundSession(close: () => void | Promise<void>): () => void {
    this.ensureRunning();
    this.outboundSessions.add(close);
    return () => this.outboundSessions.delete(close);
  }

  private async acquire(actionId: string): Promise<void> {
    this.ensureRunning();
    if (this.activeCount < this.config.limits.maxConcurrency) {
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => this.queue.push({ actionId, resolve, reject }));
    this.ensureRunning();
    this.activeCount += 1;
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.state === 'RUNNING') this.queue.shift()?.resolve();
  }

  private validateObservation(observation: LiveEnvironmentObservation): void {
    if (observation.source !== 'LIVE_ENVIRONMENT') {
      throw new Error('Live driver returned a simulated or unknown observation source.');
    }
    if (!(observation.observedAt instanceof Date) || !Number.isFinite(observation.observedAt.getTime())) {
      throw new Error('Live driver did not provide a valid environment observation timestamp.');
    }
    if (!Array.isArray(observation.artifacts) || observation.artifacts.some((item) => item.source !== 'LIVE_ENVIRONMENT')) {
      throw new Error('Every detection, response, telemetry, containment, and recovery artifact must come from LIVE_ENVIRONMENT.');
    }
    if (!Array.isArray(observation.contactedTargets) || observation.contactedTargets.length === 0) {
      throw new Error('Live driver did not report its contacted targets.');
    }
    if (!Number.isSafeInteger(observation.bytesSent) || !Number.isSafeInteger(observation.bytesReceived)) {
      throw new Error('Live driver did not report integer network byte counts.');
    }
  }

  async executeAction(request: LiveActionRequest, driver: LiveActionDriver): Promise<LiveActionResult> {
    this.ensureRunning();
    await this.checkCircuitBreakers();
    if (this.actionCount >= this.config.limits.maxActionCount) {
      await this.triggerCircuitBreaker('Maximum live-validation action count exceeded.');
      throw new LiveValidationLimitError('Maximum action count exceeded.');
    }
    this.actionCount += 1;
    try {
      await this.recordAudit({
        eventType: 'ACTION_ATTEMPTED',
        actionId: request.actionId,
        target: request.target,
        action: request.action,
        expectedResult: request.expectedResult,
      });
    } catch (error) {
      await this.triggerCircuitBreaker(error instanceof Error ? error.message : String(error));
      throw error;
    }

    await this.authorizeOrTrip(request.target, request.actionId);
    await this.acquire(request.actionId);
    const controller = new AbortController();
    this.activeWorkers.set(request.actionId, controller);
    const startedAt = this.now();
    let reportedBytes = 0;

    try {
      await this.checkCircuitBreakers();
      // Resolve again immediately before I/O to reduce DNS-rebinding risk.
      const authorization = await this.authorizeOrTrip(request.target, request.actionId);
      const context: LiveActionContext = {
        signal: controller.signal,
        authorization,
        reportNetworkDestination: (target) => this.reportNetworkDestination(target, request.actionId),
        reportNetworkUsage: async (bytes) => {
          reportedBytes += bytes;
          await this.reportNetworkUsage(bytes);
        },
        registerOutboundSession: (close) => this.registerOutboundSession(close),
      };
      const observation = await driver(request, context);
      this.validateObservation(observation);
      for (const target of observation.contactedTargets) {
        await this.reportNetworkDestination(target, request.actionId);
        await this.recordAudit({ eventType: 'TARGET_CONTACTED', target, actionId: request.actionId });
      }
      const observedBytes = observation.bytesSent + observation.bytesReceived;
      if (reportedBytes < observedBytes) await this.reportNetworkUsage(observedBytes - reportedBytes);

      await this.recordAudit({
        eventType: 'OBSERVATION_RECORDED',
        actionId: request.actionId,
        target: request.target,
        action: request.action,
        expectedResult: request.expectedResult,
        observedResult: observation.observedResult,
        details: { bytesSent: observation.bytesSent, bytesReceived: observation.bytesReceived },
      });
      for (const artifact of observation.artifacts) {
        const eventType =
          artifact.kind === 'detection'
            ? 'DETECTION_RECORDED'
            : artifact.kind === 'response'
              ? 'RESPONSE_RECORDED'
              : artifact.kind === 'containment'
                ? 'CONTAINMENT_RECORDED'
                : artifact.kind === 'recovery'
                  ? 'RECOVERY_RECORDED'
                  : 'OBSERVATION_RECORDED';
        await this.recordAudit({
          eventType,
          actionId: request.actionId,
          target: request.target,
          observedResult: artifact.data,
          details: { kind: artifact.kind, evidenceRef: artifact.evidenceRef },
        });
      }

      return {
        executionMode: LIVE_VALIDATION_MODE,
        testId: this.config.testId,
        actionId: request.actionId,
        target: request.target,
        action: request.action,
        expectedResult: request.expectedResult,
        observedResult: observation.observedResult,
        observation,
        startedAt,
        endedAt: this.now(),
      };
    } catch (error) {
      if (!controller.signal.aborted && this.state === 'RUNNING') {
        const message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof LiveValidationAuditError ||
          message.includes('simulated') ||
          message.includes('LIVE_ENVIRONMENT')
        ) {
          await this.triggerCircuitBreaker(`Observation provenance failure: ${message}`);
        }
      }
      throw error;
    } finally {
      this.activeWorkers.delete(request.actionId);
      this.release();
    }
  }

  private async triggerCircuitBreaker(reason: string): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'ENDED') return;
    await this.bestEffortAudit({ eventType: 'CIRCUIT_BREAKER', reason });
    await this.killSwitch.stopAll({
      reason: `Automatic circuit breaker: ${reason}`,
      operator: this.config.operator,
      hardNetworkStop: this.config.hardNetworkStop,
    });
  }

  async emergencyStop(reason: string, operator: string, hardNetworkStop: boolean): Promise<void> {
    const requestHardStop = hardNetworkStop || this.config.hardNetworkStop;
    if (this.state === 'STOPPED' && (!requestHardStop || this.hardNetworkStopApplied)) return;
    if (this.state !== 'ENDED') {
      this.state = 'STOPPED';
      this.stopReason = reason;
      this.endedAt = this.now();
    }
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;

    const error = new LiveValidationStoppedError(`LIVE_VALIDATION stopped: ${reason}`);
    const queuedActionsCancelled = this.queue.length;
    const activeWorkersSignalled = this.activeWorkers.size;
    for (const queued of this.queue.splice(0)) queued.reject(error);
    for (const worker of this.activeWorkers.values()) worker.abort(error);
    const sessions = [...this.outboundSessions];
    this.outboundSessions.clear();
    void Promise.allSettled(
      sessions.map(async (close) => {
        await close();
      }),
    );
    // Closers are invoked immediately, but a broken closer cannot postpone
    // independent network isolation.

    let hardStopDetails: Record<string, unknown> | undefined;
    if (requestHardStop && !this.hardNetworkStopApplied) {
      if (this.dependencies.hardNetworkStopProvider) {
        try {
          hardStopDetails = { ...(await this.dependencies.hardNetworkStopProvider.isolate(reason)) };
          this.hardNetworkStopApplied = Boolean(hardStopDetails.isolated);
        } catch (hardStopError) {
          hardStopDetails = {
            isolated: false,
            error: hardStopError instanceof Error ? hardStopError.message : String(hardStopError),
          };
        }
      } else {
        hardStopDetails = { isolated: false, error: 'No HARD_NETWORK_STOP provider configured.' };
      }
    }

    await this.bestEffortAudit({
      eventType: 'KILL_SWITCH',
      operator,
      reason,
      details: {
        queuedActionsCancelled,
        activeWorkersSignalled,
        outboundSessionsClosed: sessions.length,
        hardNetworkStop: hardStopDetails,
      },
    });
    await this.recordRunEnded(reason);
    this.unregisterKillSwitch?.();
  }

  private async recordRunEnded(reason: string): Promise<void> {
    if (this.endingRecorded) return;
    this.endingRecorded = true;
    await this.bestEffortAudit({
      eventType: 'RUN_ENDED',
      reason,
      details: {
        startedAt: this.startedAt,
        endedAt: this.endedAt ?? this.now(),
        actionsAttempted: this.actionCount,
        totalNetworkBytes: this.totalNetworkBytes,
      },
    });
  }

  async end(reason = 'Live-validation run completed.'): Promise<void> {
    if (this.state !== 'RUNNING') return;
    if (this.activeCount > 0 || this.queue.length > 0) {
      throw new Error('Cannot end LIVE_VALIDATION while actions are active or queued.');
    }
    this.state = 'ENDED';
    this.endedAt = this.now();
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
    this.unregisterKillSwitch?.();
    await this.recordRunEnded(reason);
  }
}
