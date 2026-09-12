import type { ToolDefinition, ToolExecutionContext } from '@dacai-local-agent/tools';
import { gitWorktreeCreateTool } from '@dacai-local-agent/tools';
import { PostgresWorkspaceRegistry } from '@dacai-local-agent/workspace';

const CHILD_ROLES = new Set([
  'repo-explorer',
  'debugger',
  'coder',
  'reviewer',
  'test-engineer',
  'security-reviewer',
  'variant-hunter',
  'ci-fixer',
]);

function requireContext(ctx: ToolExecutionContext): { workspaceId: string; workspaceRoot: string } {
  if (!ctx.workspaceId || !ctx.workspaceRoot) throw new Error('Delegation requires an active registered workspace.');
  return { workspaceId: ctx.workspaceId, workspaceRoot: ctx.workspaceRoot };
}

function childName(objective: string): string {
  const words = objective.toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 5) ?? ['task'];
  return `${words.join('-').slice(0, 45)}-${Date.now().toString(36)}`;
}

function infrastructureEvidence(
  locator: string,
  result: unknown,
  effect: 'read' | 'mutation' = 'read',
) {
  return [{
    id: 'infrastructure',
    locator,
    provenance: 'production_data' as const,
    content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    effect,
  }];
}

function swarmEvidence(locator: string, result: unknown, effect: 'read' | 'mutation' = 'read') {
  return [{
    id: 'agent-swarm',
    locator,
    provenance: 'production_data' as const,
    content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    effect,
  }];
}

function summarizeRunpodStatus(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const status = result as Record<string, unknown>;
  const connected = status.connected === true;
  const tunnelHealthy = status.tunnelHealthy === true;
  return {
    statusSummary: connected
      ? `The configured RunPod is connected; its inference tunnel is ${tunnelHealthy ? 'healthy' : 'not healthy'}.`
      : 'The configured RunPod is not connected.',
    ...status,
  };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`Internal agent API returned HTTP ${response.status}: ${text.slice(0, 1200)}`);
  return body;
}

export function createCodexServerTools(port: number): ToolDefinition[] {
  const base = `http://127.0.0.1:${port}`;
  const workspaces = new PostgresWorkspaceRegistry();

  const runpodStatus: ToolDefinition = {
    name: 'infrastructure.runpod.status',
    description:
      'Measure the configured RunPod SSH connection, GPU/VRAM, CUDA, Python, Ollama, tunnel, inference endpoint and available models. ' +
      'Uses the server connection without exposing credentials to the model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permissionTier: 'safe',
    requiresNetwork: true,
    timeoutMs: 120_000,
    evidenceSources: (result) => infrastructureEvidence('configured RunPod status', result),
    async execute(_input, ctx) {
      const result = await jsonFetch(`${base}/api/infrastructure/runpod/status`, { signal: ctx.signal });
      return summarizeRunpodStatus(result);
    },
  };

  const runpodPreflight: ToolDefinition = {
    name: 'infrastructure.runpod.preflight',
    description:
      'Read the configured RunPod account and pod availability used for routing, including whether a pod is running and ready to route. ' +
      'Does not start billable compute.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permissionTier: 'safe',
    requiresNetwork: true,
    timeoutMs: 30_000,
    evidenceSources: (result) => infrastructureEvidence('RunPod account and pod preflight', result),
    async execute(_input, ctx) {
      return jsonFetch(`${base}/api/infrastructure/runpod/preflight`, { signal: ctx.signal });
    },
  };

  const gpuRouting: ToolDefinition = {
    name: 'infrastructure.gpu-routing',
    description:
      'Refresh and report whether this agent run can route to the configured RunPod GPU provider, including the exact fallback reason when it cannot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permissionTier: 'safe',
    requiresNetwork: true,
    timeoutMs: 30_000,
    evidenceSources: (result) => infrastructureEvidence('live GPU routing probe', result),
    async execute(_input, ctx) {
      return jsonFetch(`${base}/api/infrastructure/gpu-routing?refresh=1`, { signal: ctx.signal });
    },
  };

  const runpodReconnect: ToolDefinition = {
    name: 'infrastructure.runpod.reconnect',
    description:
      'Reconnect the configured RunPod SSH endpoint, restore the existing pod-side Ollama service when needed, and rebuild its local inference tunnel. ' +
      'This does not create or start a stopped RunPod pod, but it can change service state on an already-running configured pod.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    permissionTier: 'mutation',
    requiresNetwork: true,
    timeoutMs: 120_000,
    evidenceSources: (result) => infrastructureEvidence('configured RunPod reconnect', result, 'mutation'),
    async execute(_input, ctx) {
      const result = await jsonFetch(`${base}/api/infrastructure/runpod/reconnect`, {
        method: 'POST',
        signal: ctx.signal,
      });
      return summarizeRunpodStatus(result);
    },
  };

  const swarmCreate: ToolDefinition = {
    name: 'agent.swarm.create',
    description:
      'Create a durable AI swarm of 2-6 bounded specialist workers for one objective. Members run through the existing task queue and permission system, then one coordinator automatically synthesizes their results.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 12_000 },
        strategy: {
          type: 'string',
          enum: ['balanced', 'research', 'review', 'security', 'offensive-security', 'defensive-security'],
        },
        size: { type: 'number', minimum: 2, maximum: 6 },
        engagementId: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Required for offensive-security so protected-system work binds to an active audited engagement.',
        },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    timeoutMs: 90_000,
    evidenceSources: (result) => swarmEvidence('durable AI swarm creation', result, 'mutation'),
    async execute(input, ctx) {
      const current = requireContext(ctx);
      const strategy = String(input.strategy ?? 'balanced');
      return jsonFetch(`${base}/api/swarms`, {
        method: 'POST',
        body: JSON.stringify({
          objective: String(input.objective ?? '').trim(),
          workspaceId: current.workspaceId,
          strategy,
          size: input.size ?? (strategy === 'offensive-security' || strategy === 'defensive-security' ? 6 : 3),
          engagementId: input.engagementId,
          source: 'internal',
        }),
        signal: ctx.signal,
      });
    },
  };

  const swarmStatus: ToolDefinition = {
    name: 'agent.swarm.status',
    description:
      'Read live member progress, evidence, coordinator state, and the final synthesized result for a durable AI swarm.',
    inputSchema: {
      type: 'object',
      properties: { swarmId: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['swarmId'],
      additionalProperties: false,
    },
    permissionTier: 'safe',
    timeoutMs: 20_000,
    evidenceSources: (result) => swarmEvidence('durable AI swarm status', result),
    async execute(input, ctx) {
      const swarmId = encodeURIComponent(String(input.swarmId ?? ''));
      return jsonFetch(`${base}/api/swarms/${swarmId}`, { signal: ctx.signal });
    },
  };

  const swarmCancel: ToolDefinition = {
    name: 'agent.swarm.cancel',
    description: 'Cancel a durable AI swarm and every member/coordinator task that is still queued or running.',
    inputSchema: {
      type: 'object',
      properties: { swarmId: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['swarmId'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    timeoutMs: 20_000,
    evidenceSources: (result) => swarmEvidence('durable AI swarm cancellation', result, 'mutation'),
    async execute(input, ctx) {
      const swarmId = encodeURIComponent(String(input.swarmId ?? ''));
      return jsonFetch(`${base}/api/swarms/${swarmId}/cancel`, { method: 'POST', signal: ctx.signal });
    },
  };

  const delegate: ToolDefinition = {
    name: 'agent.delegate',
    description:
      'Submit a child agent task and return immediately. Use isolate=true for mutating child work so it receives its own Git worktree/workspace. ' +
      'Submit multiple independent children before polling to obtain real parallelism.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 12_000 },
        role: { type: 'string', enum: [...CHILD_ROLES] },
        isolate: { type: 'boolean' },
        maxTurns: { type: 'number', minimum: 4, maximum: 50 },
      },
      required: ['objective', 'role'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    requiresWrite: true,
    requiresShell: true,
    timeoutMs: 90_000,
    async execute(input, ctx) {
      const current = requireContext(ctx);
      const objective = String(input.objective ?? '').trim();
      const role = String(input.role ?? '');
      if (!CHILD_ROLES.has(role)) throw new Error(`Unsupported child role "${role}".`);

      let workspaceId = current.workspaceId;
      let isolation: Record<string, unknown> | undefined;

      if (input.isolate === true) {
        const parent = await workspaces.get(current.workspaceId);
        if (!parent) throw new Error('Parent workspace no longer exists.');
        const name = childName(objective);
        const created = await gitWorktreeCreateTool.execute({ name }, ctx) as {
          path?: string; branch?: string; exitCode?: number; stderr?: string;
        };
        if (created.exitCode !== undefined && created.exitCode !== 0) {
          throw new Error(`Worktree creation failed: ${created.stderr ?? 'git worktree error'}`);
        }
        if (!created.path) throw new Error('Worktree tool returned no path.');

        const childWorkspace = await workspaces.create({
          displayName: `${parent.displayName} / ${name}`,
          rootPath: created.path,
          capabilities: { ...parent.capabilities },
          memoryNamespace: parent.memoryNamespace,
          projectInstructions: parent.projectInstructions,
        });
        workspaceId = childWorkspace.id;
        isolation = {
          name,
          workspaceId: childWorkspace.id,
          path: childWorkspace.rootPath,
          branch: created.branch,
        };
      }

      const response = await jsonFetch(`${base}/api/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          objective,
          workspaceId,
          role,
          source: 'internal',
          maxTurns: typeof input.maxTurns === 'number' ? input.maxTurns : undefined,
        }),
        signal: ctx.signal,
      });

      return {
        task: response.task,
        queued: response.queued,
        active: response.active,
        isolation,
        instruction: 'Submit other independent child tasks now; poll later with agent.delegate.status.',
      };
    },
  };

  const status: ToolDefinition = {
    name: 'agent.delegate.status',
    description: 'Read the status/result of a previously submitted child task.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['taskId'],
      additionalProperties: false,
    },
    permissionTier: 'safe',
    timeoutMs: 20_000,
    async execute(input, ctx) {
      const taskId = encodeURIComponent(String(input.taskId ?? ''));
      return jsonFetch(`${base}/api/tasks/${taskId}`, { signal: ctx.signal });
    },
  };

  const cancel: ToolDefinition = {
    name: 'agent.delegate.cancel',
    description: 'Cancel a previously submitted child task. Does not remove its worktree.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', minLength: 1, maxLength: 120 } },
      required: ['taskId'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    timeoutMs: 20_000,
    async execute(input, ctx) {
      const taskId = encodeURIComponent(String(input.taskId ?? ''));
      return jsonFetch(`${base}/api/tasks/${taskId}/cancel`, { method: 'POST', signal: ctx.signal });
    },
  };

  return [
    runpodStatus,
    runpodPreflight,
    gpuRouting,
    runpodReconnect,
    swarmCreate,
    swarmStatus,
    swarmCancel,
    delegate,
    status,
    cancel,
  ];
}
