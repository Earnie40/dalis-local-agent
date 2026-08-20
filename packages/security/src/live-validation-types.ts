// Relocated to ./types.ts as the platform's one live-vs-simulation vocabulary; re-exported
// here since existing code in this file and its neighbors refers to the unqualified names.
import { LIVE_VALIDATION_MODE, SIMULATION_MODE, type ValidationExecutionMode } from './types';
export { LIVE_VALIDATION_MODE, SIMULATION_MODE, type ValidationExecutionMode };

export interface AuthorizedTargetRule {
  /** Exact hostname or IP literal. Wildcards are deliberately unsupported. */
  host?: string;
  /** IPv4 or IPv6 CIDR belonging to the isolated Tomahawk1 lab. */
  cidr?: string;
  /** Optional destination-port restriction. */
  ports?: number[];
}

export interface LiveValidationLimits {
  maxDurationMs: number;
  maxActionCount: number;
  maxConcurrency: number;
  maxBytesPerSecond: number;
  maxTotalBytes: number;
  expiresAt: Date;
}

export interface SystemHealthSnapshot {
  memoryRssBytes: number;
  cpuPercent?: number;
  errorRate?: number;
  observedAt: Date;
}

export interface SystemHealthThresholds {
  maxMemoryRssBytes: number;
  maxCpuPercent?: number;
  maxErrorRate?: number;
}

export interface LiveValidationRunConfig {
  mode: typeof LIVE_VALIDATION_MODE;
  testId: string;
  operator: string;
  authorizationEvidenceId: string;
  authorizedScope: Array<string | AuthorizedTargetRule>;
  limits: LiveValidationLimits;
  healthThresholds: SystemHealthThresholds;
  heartbeatTimeoutMs: number;
  hardNetworkStop: boolean;
}

export interface ResolvedAuthorizedTarget {
  requestedTarget: string;
  protocol?: string;
  hostname: string;
  port?: number;
  addresses: string[];
  matchedRules: AuthorizedTargetRule[];
  resolvedAt: Date;
}

export type LiveArtifactKind =
  | 'service-response'
  | 'telemetry'
  | 'detection'
  | 'response'
  | 'containment'
  | 'recovery';

export interface LiveArtifact {
  kind: LiveArtifactKind;
  source: 'LIVE_ENVIRONMENT';
  observedAt: Date;
  data: unknown;
  evidenceRef?: string;
}

/**
 * Returned only by a production live driver after real environment I/O.
 * SIMULATION is intentionally not a valid source value.
 */
export interface LiveEnvironmentObservation {
  source: 'LIVE_ENVIRONMENT';
  observedAt: Date;
  observedResult: unknown;
  artifacts: LiveArtifact[];
  contactedTargets: string[];
  bytesSent: number;
  bytesReceived: number;
}

export interface LiveActionRequest {
  actionId: string;
  target: string;
  action: string;
  expectedResult: unknown;
}

export interface LiveActionContext {
  signal: AbortSignal;
  authorization: ResolvedAuthorizedTarget;
  reportNetworkDestination: (target: string) => Promise<ResolvedAuthorizedTarget>;
  reportNetworkUsage: (bytes: number) => Promise<void>;
  registerOutboundSession: (close: () => void | Promise<void>) => () => void;
}

export type LiveActionDriver = (
  request: LiveActionRequest,
  context: LiveActionContext,
) => Promise<LiveEnvironmentObservation>;

export interface LiveActionResult {
  executionMode: typeof LIVE_VALIDATION_MODE;
  testId: string;
  actionId: string;
  target: string;
  action: string;
  expectedResult: unknown;
  observedResult: unknown;
  observation: LiveEnvironmentObservation;
  startedAt: Date;
  endedAt: Date;
}

export type LiveValidationAuditEventType =
  | 'RUN_STARTED'
  | 'ACTION_ATTEMPTED'
  | 'TARGET_AUTHORIZED'
  | 'TARGET_CONTACTED'
  | 'OBSERVATION_RECORDED'
  | 'DETECTION_RECORDED'
  | 'RESPONSE_RECORDED'
  | 'CONTAINMENT_RECORDED'
  | 'RECOVERY_RECORDED'
  | 'ACTION_REJECTED'
  | 'CIRCUIT_BREAKER'
  | 'KILL_SWITCH'
  | 'RUN_ENDED';

export interface LiveValidationAuditEvent {
  eventId: string;
  executionMode: typeof LIVE_VALIDATION_MODE;
  eventType: LiveValidationAuditEventType;
  testId: string;
  operator: string;
  timestamp: Date;
  authorizationEvidenceId: string;
  authorizedScope: Array<string | AuthorizedTargetRule>;
  target?: string;
  actionId?: string;
  action?: string;
  expectedResult?: unknown;
  observedResult?: unknown;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface LiveValidationAuditSink {
  record(event: LiveValidationAuditEvent): Promise<void>;
}

export interface LiveValidationHealthMonitor {
  sample(): Promise<SystemHealthSnapshot>;
}

export interface HardNetworkStopResult {
  isolated: boolean;
  details?: string;
}

/** External firewall/network enforcement. It must remain effective if workers fail. */
export interface HardNetworkStopProvider {
  isolate(reason: string): Promise<HardNetworkStopResult>;
}

export interface KillSwitchState {
  stopped: boolean;
  reason: string;
  stoppedAt: Date;
  operator: string;
}

export interface KillSwitchStateStore {
  load(): Promise<KillSwitchState | null>;
  save(state: KillSwitchState): Promise<void>;
  clear(): Promise<void>;
}
