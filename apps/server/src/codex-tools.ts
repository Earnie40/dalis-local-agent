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

  return [delegate, status, cancel];
}
