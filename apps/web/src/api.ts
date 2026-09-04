import type { StudioFiles } from '@dacai-local-agent/shared';

// In development, address the API directly as well as keeping Vite's proxy.
// This prevents an out-of-date dev server from returning index.html for an
// /api request (which otherwise surfaces as "Unexpected token '<'"). The
// production preview stays same-origin and uses the configured reverse proxy.
const API = import.meta.env.DEV ? 'http://127.0.0.1:3001' : '';

/** SSE framing: frames end with a blank line, fields are one per line. */
const FRAME_SEPARATOR = '\n\n';
const LINE_SEPARATOR = '\n';

export interface Conversation {
  id: string;
  title: string;
  model?: string;
  updatedAt: string;
  messageCount?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ModelAlias {
  alias: string;
  providerInstanceId: string;
  model: string;
  enabled: boolean;
  agentCapability?: 'verified' | 'declared' | 'unsupported' | 'unknown';
  agentLoopCapable?: boolean;
  classification?: 'agent-capable' | 'advisory-class' | 'unverified';
}

export interface AliasCapabilities {
  alias: string;
  model: string;
  capabilities: { toolCalling: string; streaming: string; toolCallChannel?: string };
  agentLoopCapable: boolean;
  classification: 'agent-capable' | 'advisory-class';
}

export interface MediaInfrastructureStatus {
  configured: boolean;
  ready: boolean;
  phase: 'disabled' | 'initializing' | 'starting-pod' | 'waiting-for-ssh' | 'starting-service' | 'connecting-tunnel' | 'ready' | 'error';
  transport?: 'ssh-tunnel' | 'loopback' | 'https';
  autoStart: boolean;
  pod?: { id: string; name?: string; connected: boolean };
  service: { healthy: boolean; imageModel: boolean; videoModel: boolean };
  error?: string;
  checkedAt: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

export interface Workspace {
  id: string;
  displayName: string;
  rootPath: string;
  capabilities: { read: boolean; write: boolean; shell: boolean; network: boolean };
  gitDetected: boolean;
  detectedLanguages: string[];
}

export interface AgentEvent {
  type: string;
  turn?: number;
  content?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  success?: boolean;
  denied?: boolean;
  decision?: string;
  tier?: string;
  reason?: string;
  message?: string;
  answer?: string;
  /** Set on approval_request: the id the decision must be posted against. */
  id?: string;
  input?: Record<string, unknown>;
  approved?: boolean;
  stopReason?: string;
  turns?: number;
  toolCalls?: number;
  durationMs?: number;
  tools?: string[];
  model?: string;
  workspace?: string;
  role?: 'coding' | 'adversarial-twin-simulator' | 'tomahawk1';
  runId?: string;
  runMode?: 'interactive' | 'coding' | 'repository_audit' | 'deep_research';
  budget?: { maxTurns: number; maxToolCalls: number; synthesisReserveTurns?: number };
  completionState?: string;
  activity?: AgentActivityEvent;
}

export type AgentActivityType =
  | 'planning' | 'reasoning_summary' | 'inspection' | 'search' | 'decision'
  | 'tool_start' | 'tool_progress' | 'tool_result' | 'command' | 'file_read'
  | 'file_edit' | 'test' | 'verification' | 'warning' | 'error' | 'success'
  | 'next_step' | 'model' | 'system';

export interface AgentActivityEvent {
  id: string;
  workspaceId: string;
  sessionId?: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: AgentActivityType;
  status: 'running' | 'success' | 'failed' | 'blocked' | 'info';
  title: string;
  message?: string;
  toolName?: string;
  command?: string;
  filePath?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface RedTeamEngagement {
  id: string;
  customerId: string;
  authorizedTargets: string[];
  authorizedEnvironments: string[];
  allowedTestCategories: string[];
  prohibitedActions: string[];
  startsAt: string;
  expiresAt: string;
  requestLimit?: number;
  concurrencyLimit?: number;
  humanApprover: string;
  authorizationEvidenceId?: string;
  scopeBreadth: 'defined' | 'broad' | 'internal-only';
  threatModelTags: string[];
  status: 'draft' | 'approved' | 'active' | 'paused' | 'completed' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

export interface CreateEngagementBody {
  customerId: string;
  authorizedTargets: string[];
  authorizedEnvironments: string[];
  allowedTestCategories: string[];
  prohibitedActions: string[];
  startsAt: string;
  expiresAt: string;
  humanApprover: string;
  scopeBreadth?: 'defined' | 'broad' | 'internal-only';
  threatModelTags?: string[];
  requestLimit?: number;
  concurrencyLimit?: number;
}

export interface KillSwitchState {
  stopped: boolean;
  reason: string;
  stoppedAt: string;
  operator: string;
}

export interface LiveValidationStatus {
  mode: string;
  stopState: KillSwitchState | null;
  environmentStop: boolean;
}

export interface SecurityTestScenario {
  id: string;
  name: string;
  category: string;
  description: string;
  objective: string;
  successCriteria: string;
  riskLevel: 'LEVEL_1_SAFE' | 'LEVEL_2_CONTROLLED' | 'LEVEL_3_HIGH_IMPACT' | 'LEVEL_4_RESTRICTED';
  automatable: boolean;
}

export interface AdversarialTestResult {
  id: string;
  engagementId?: string;
  testCategory: string;
  testScenario: string;
  target: string;
  passed: boolean;
  /** 'blocked' means the safety envelope itself rejected the run; 'error' means an unexpected failure. */
  status?: 'passed' | 'failed' | 'error' | 'blocked';
  observedBehavior: string;
  evidence: Record<string, unknown>;
  regressionTest: boolean;
  createdAt: string;
}

/**
 * The scenario, not this request body, owns the HTTP action and pass/fail
 * rule — `fixtures` only supplies raw values (tokens, resource paths) a
 * scenario's own template asks for by name; see BUILT_IN_SCENARIOS' live
 * definitions server-side for which keys each scenario requires.
 */
export interface RunLiveValidationBody {
  scenarioId: string;
  operator: string;
  authorizationEvidenceId: string;
  target: string;
  fixtures?: Record<string, string>;
  limits: {
    maxDurationMs: number;
    maxActionCount: number;
    maxConcurrency: number;
    maxBytesPerSecond: number;
    maxTotalBytes: number;
    expiresAt: string;
  };
  healthThresholds: {
    maxMemoryRssBytes: number;
    maxCpuPercent?: number;
    maxErrorRate?: number;
  };
  heartbeatTimeoutMs: number;
  hardNetworkStop: boolean;
  autoApproveLevel1?: boolean;
  autoApproveLevel2?: boolean;
  maxConcurrentTests?: number;
  timeoutMs?: number;
}

export const api = {
  approve: (id: string, approved: boolean) =>
    json<{ ok: boolean }>(`/api/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    }),
  approveAll: (runId: string) =>
    json<{ ok: boolean; approved: number }>(`/api/approvals/run/${encodeURIComponent(runId)}/approve-all`, {
      method: 'POST',
    }),
  listWorkspaces: () => json<{ workspaces: Workspace[] }>('/api/workspaces'),
  createWorkspace: (body: { displayName: string; rootPath: string; write: boolean; shell: boolean; network?: boolean }) =>
    json<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify(body) }),
  deleteWorkspace: (id: string) => json<{ ok: boolean }>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  listConversations: () => json<{ conversations: Conversation[] }>('/api/conversations'),
  getConversation: (id: string) =>
    json<{ conversation: Conversation; messages: Message[] }>(`/api/conversations/${id}`),
  deleteConversation: (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  listModels: () => json<{ aliases: ModelAlias[]; tagCount: number; baseCount: number }>('/api/models'),
  capabilities: (alias: string) => json<AliasCapabilities>(`/api/models/${alias}/capabilities`),
  mediaStatus: () => json<MediaInfrastructureStatus>('/api/infrastructure/media/status'),
  reconnectMedia: () => json<MediaInfrastructureStatus>('/api/infrastructure/media/reconnect', { method: 'POST' }),
  usage: () => json<{ summary: Array<{ usageClass: string; source: string; requests: number; outputTokens: number }> }>(
    '/api/usage',
  ),
  agentActivity: (runId: string, after = 0) =>
    json<{ events: AgentActivityEvent[] }>(`/api/agent/runs/${encodeURIComponent(runId)}/activity?after=${after}`),

  // Red-team engagements: authorized targets, categories, and time window.
  listEngagements: (customerId: string) =>
    json<{ engagements: RedTeamEngagement[] }>(`/api/security/engagements?customerId=${encodeURIComponent(customerId)}`),
  createEngagement: (body: CreateEngagementBody) =>
    json<{ engagement: RedTeamEngagement }>('/api/security/engagements', { method: 'POST', body: JSON.stringify(body) }),
  approveEngagement: (id: string, approver: string) =>
    json<{ engagement: RedTeamEngagement; approved: boolean }>(`/api/security/engagements/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approver }),
    }),
  startEngagement: (id: string) =>
    json<{ engagement: RedTeamEngagement; started: boolean }>(`/api/security/engagements/${id}/start`, {
      method: 'POST',
    }),
  pauseEngagement: (id: string) =>
    json<{ engagement: RedTeamEngagement; paused: boolean }>(`/api/security/engagements/${id}/pause`, {
      method: 'POST',
    }),
  revokeEngagement: (id: string) =>
    json<{ engagement: RedTeamEngagement; revoked: boolean }>(`/api/security/engagements/${id}/stop`, {
      method: 'POST',
    }),

  // Global LIVE_VALIDATION control plane — the on/off switch for real runs.
  liveValidationStatus: () => json<LiveValidationStatus>('/api/security/live-validation/status'),
  liveValidationScenarios: () => json<{ scenarios: SecurityTestScenario[] }>('/api/security/live-validation/scenarios'),
  stopLiveValidation: (body: { reason?: string; operator?: string; hardNetworkStop?: boolean }) =>
    json<{ stopped: boolean; stopState: KillSwitchState }>('/api/security/live-validation/stop', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  restartLiveValidation: (body: { operator: string; acknowledgement: string }) =>
    json<{ restarted: boolean; operator?: string }>('/api/security/live-validation/restart', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  runLiveValidation: (engagementId: string, body: RunLiveValidationBody) =>
    json<{ engagementId: string; results: AdversarialTestResult[] }>(
      `/api/security/live-validation/${engagementId}/run`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};

// ---------------------------------------------------------------------------
// Delegated work: agent roles, tasks, and schedules
// ---------------------------------------------------------------------------

export interface WorkerRole {
  id: string;
  alias: string;
  readOnly: boolean;
  maxTurns: number;
}

export type TaskStatus =
  | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  | 'blocked' | 'waiting_for_user' | 'interrupted';

export interface TaskSummary {
  id: string;
  agentId: string;
  objective: string;
  status: TaskStatus;
  source: 'ui' | 'mcp' | 'internal';
  scheduleId?: string;
  model: string;
  providerInstanceId: string;
  result?: string;
  createdAt: string;
  completedAt?: string;
}

export type ScheduleKind = 'once' | 'interval' | 'daily';

export interface Schedule {
  id: string;
  name: string;
  objective: string;
  role: string;
  workspaceId: string;
  alias?: string;
  kind: ScheduleKind;
  intervalSeconds?: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastTaskId?: string;
  runCount: number;
  createdAt: string;
}

export interface CreateScheduleBody {
  name?: string;
  objective: string;
  role: string;
  workspaceId: string;
  alias?: string;
  kind: ScheduleKind;
  intervalSeconds?: number;
  firstRunAt?: string;
}

export const delegationApi = {
  roles: () => json<{ roles: WorkerRole[] }>('/api/roles'),
  workspaces: () => json<{ workspaces: Workspace[] }>('/api/workspaces'),

  tasks: () => json<{ tasks: TaskSummary[] }>('/api/tasks'),
  task: (id: string) => json<{ task: TaskSummary }>(`/api/tasks/${id}`),
  createTask: (body: { objective: string; workspaceId: string; role?: string; alias?: string; source?: 'ui' }) =>
    json<{ task: TaskSummary; queued: number; active: number }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ source: 'ui', ...body }),
    }),
  cancelTask: (id: string) => json<{ cancelled: boolean }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),

  schedules: () => json<{ schedules: Schedule[] }>('/api/schedules'),
  createSchedule: (body: CreateScheduleBody) =>
    json<{ schedule: Schedule }>('/api/schedules', { method: 'POST', body: JSON.stringify(body) }),
  updateSchedule: (id: string, patch: { enabled?: boolean; name?: string; objective?: string; intervalSeconds?: number }) =>
    json<{ schedule: Schedule }>(`/api/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => json<{ deleted: boolean }>(`/api/schedules/${id}`, { method: 'DELETE' }),
  runScheduleNow: (id: string) =>
    json<{ task: TaskSummary }>(`/api/schedules/${id}/run-now`, { method: 'POST' }),
};

export interface StreamHandlers {
  onStart(meta: { conversationId: string; messageId: string; model: string; usageClass: string }): void;
  onChunk(text: string): void;
  onThinking(text?: string): void;
  onDone(payload: { cancelled: boolean; error?: string; durationMs: number }): void;
}

export interface StudioGenerateRequest {
  prompt: string;
  alias: string;
  revision: number;
  files: StudioFiles;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface StudioGenerateResponse {
  update: {
    message: string;
    files: StudioFiles;
    changedFiles: string[];
    baseRevision: number;
  };
  generation: {
    alias: string;
    model: string;
    providerInstanceId: string;
    repaired: boolean;
    durationMs: number;
  };
}

export async function generateStudioProject(
  body: StudioGenerateRequest,
  signal: AbortSignal,
): Promise<StudioGenerateResponse> {
  const response = await fetch(`${API}/api/studio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* retain the bounded server error text */
    }
    throw new Error(message || `Studio generation failed with status ${response.status}.`);
  }

  return response.json() as Promise<StudioGenerateResponse>;
}

/**
 * Reads the SSE stream from a POST request. EventSource cannot POST, so the
 * body is parsed here — frames arrive split across network chunks, so a partial
 * frame is buffered until its terminating blank line appears.
 */
export async function streamChat(
  body: { conversationId?: string; message: string; alias: string; retry?: boolean },
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat failed: ${response.status} ${await response.text().catch(() => '')}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice(7).trim();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      } catch {
        // A truncated or malformed frame is skipped rather than killing the stream.
        continue;
      }

      if (event === 'start') handlers.onStart(data as unknown as Parameters<StreamHandlers['onStart']>[0]);
      else if (event === 'chunk') handlers.onChunk(String(data.content ?? ''));
      else if (event === 'thinking') handlers.onThinking(typeof data.content === 'string' ? data.content : undefined);
      else if (event === 'done' || event === 'error') {
        handlers.onDone(data as unknown as Parameters<StreamHandlers['onDone']>[0]);
      }
    }
  }
}


/**
 * Runs the agent loop and reports every step: model turns, tool calls, the
 * permission decision for each, and tool output.
 */
export async function streamAgent(
  body: {
    prompt: string;
    workspaceId: string;
    alias: string;
    role: 'coding' | 'adversarial-twin-simulator' | 'tomahawk1';
    tools?: string[];
    sessionId?: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    runMode?: 'interactive' | 'coding' | 'repository_audit' | 'deep_research';
  },
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API}/api/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {
      /* keep the raw body */
    }
    throw new Error(message || `Agent failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(FRAME_SEPARATOR);
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const lines = frame.split(LINE_SEPARATOR);
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      try {
        const eventType = eventLine.slice(7).trim();
        const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
        // Activity payloads have their own domain `type`; keep the SSE channel
        // separate so callers never confuse "tool_result" with "activity".
        onEvent(eventType === 'activity'
          ? { type: 'activity', activity: data as unknown as AgentActivityEvent }
          : { type: eventType, ...data });
      } catch {
        continue;
      }
    }
  }
}
