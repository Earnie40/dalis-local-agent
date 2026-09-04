import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * The DacaiLocalAgent MCP server.
 *
 * This is a **thin bridge**: it speaks MCP over stdio and forwards every call
 * to the running DacaiLocalAgent server over loopback HTTP. It deliberately
 * holds no delegation engine, database pool, or tool registry of its own, so
 * the task queue, concurrency caps, permission engine, audit trail and
 * telemetry all exist exactly once — and a task started by a supervising
 * session stays visible and cancellable in the web UI.
 *
 * Results are deliberately concise. The whole point of delegation is to spend
 * few supervisor tokens, so tools return findings and evidence rather than
 * transcripts.
 */

export interface McpServerOptions {
  /** Base URL of the running DacaiLocalAgent server. */
  apiBaseUrl?: string;
  /** How long to wait for a delegated task before returning its id to poll. */
  waitMs?: number;
  pollIntervalMs?: number;
}

interface TaskRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'waiting_for_user' | 'interrupted';
  objective: string;
  agentId: string;
  modelAlias?: string;
  model: string;
  providerInstanceId: string;
  result?: string;
  evidence?: unknown[];
  errors?: unknown[];
  usage?: Record<string, unknown>;
}

const DEFAULT_WAIT_MS = 240_000;
const DEFAULT_POLL_MS = 2_000;

class ApiError extends Error {}

export function createDacaiMcpServer(options: McpServerOptions = {}): McpServer {
  const baseUrl = (options.apiBaseUrl ?? process.env.DACAI_API_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
  const waitMs = options.waitMs ?? Number(process.env.DACAI_MCP_WAIT_MS ?? DEFAULT_WAIT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  const server = new McpServer({ name: 'dacai-local-agent', version: '0.1.0' });

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
    } catch (error) {
      // The bridge is useless without the server; say so plainly rather than
      // silently degrading to some local half-implementation.
      throw new ApiError(
        `DacaiLocalAgent is not reachable at ${baseUrl}. Start it with \`pnpm dev\` in the repository root. ` +
          `(${(error as Error).message})`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let message = body;
      try {
        message = (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        /* keep the raw body */
      }
      throw new ApiError(`${path} failed (${response.status}): ${message.slice(0, 400)}`);
    }

    return response.json() as Promise<T>;
  }

  /** Resolves a workspace by path or id, so callers can pass either. */
  async function resolveWorkspaceId(pathOrId: string): Promise<string> {
    const { workspaces } = await api<{
      workspaces: Array<{ id: string; rootPath: string; displayName: string }>;
    }>('/api/workspaces');

    const normalize = (value: string) => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const wanted = normalize(pathOrId);

    const match =
      workspaces.find((workspace) => workspace.id === pathOrId) ??
      workspaces.find((workspace) => normalize(workspace.rootPath) === wanted) ??
      workspaces.find((workspace) => workspace.displayName.toLowerCase() === pathOrId.toLowerCase());

    if (!match) {
      const known = workspaces.map((w) => `${w.displayName} (${w.rootPath})`).join('; ') || 'none registered';
      throw new ApiError(
        `No workspace matches "${pathOrId}". Register it in DacaiLocalAgent first. Known workspaces: ${known}.`,
      );
    }

    return match.id;
  }

  /**
   * Submits a task and waits for it, falling back to returning the id so the
   * supervisor can poll with local_agent.get_task rather than blocking forever.
   */
  async function delegate(input: {
    objective: string;
    workspace: string;
    role: string;
    maxTurns?: number;
  }): Promise<string> {
    const workspaceId = await resolveWorkspaceId(input.workspace);

    const { task } = await api<{ task: TaskRecord }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        objective: input.objective,
        workspaceId,
        role: input.role,
        source: 'mcp',
        maxTurns: input.maxTurns,
      }),
    });

    const deadline = Date.now() + waitMs;
    let current = task;

    while (Date.now() < deadline) {
      if (current.status !== 'queued' && current.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      current = (await api<{ task: TaskRecord }>(`/api/tasks/${task.id}`)).task;
    }

    return formatTask(current);
  }

  function formatTask(task: TaskRecord): string {
    const usage = task.usage ?? {};
    const usageClass = typeof usage.usageClass === 'string' ? usage.usageClass : undefined;
    const onRunPod = usageClass === 'REMOTE_GPU_OLLAMA' || task.providerInstanceId === 'remote_gpu_ollama';
    const onLocal = usageClass === 'LOCAL_OLLAMA' || task.providerInstanceId === 'local_ollama';
    const providerLabel = onRunPod ? 'RunPod GPU' : onLocal ? 'local Ollama' : task.providerInstanceId;
    const lines = [
      `task: ${task.id}`,
      `status: ${task.status}`,
      `worker: ${task.agentId} · ${task.model} · ${providerLabel}`,
    ];

    if (task.status === 'queued' || task.status === 'running') {
      lines.push('', 'Still running. Poll with local_agent.get_task, or stop it with local_agent.cancel_task.');
      return lines.join('\n');
    }

    if (usage.turns !== undefined) {
      const billing = onRunPod
        ? 'RunPod pod billing applies'
        : onLocal
          ? '$0 incremental (local inference)'
          : `provider billing: ${task.providerInstanceId}`;
      lines.push(
        `cost: ${usage.turns} turns · ${usage.toolCalls ?? 0} tool calls · ` +
          `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out tokens · ${billing}`,
      );
    }
    if (typeof usage.routingNote === 'string') lines.push(`routing: ${usage.routingNote}`);
    if (usage.traceId) lines.push(`trace: ${usage.traceId}`);

    if (task.status === 'failed' || task.status === 'cancelled') {
      lines.push(
        '',
        `The worker did not produce findings — it ${task.status === 'failed' ? 'failed' : 'was cancelled'}. ` +
          'Do not read this as a negative finding about the code; nothing was concluded.',
      );
    }

    if (task.errors?.length) {
      lines.push('', 'errors:', ...task.errors.map((error) => `- ${JSON.stringify(error)}`));
    }

    if (task.evidence?.length) {
      lines.push('', 'evidence:');
      for (const item of task.evidence.slice(0, 20)) {
        const record = item as { kind?: string; summary?: string };
        lines.push(`- ${record.kind ?? 'evidence'}: ${record.summary ?? JSON.stringify(item)}`);
      }
    }

    lines.push('', '--- findings ---', task.result ?? '(no result)');
    return lines.join('\n');
  }

  const workspaceArg = z
    .string()
    .describe('Workspace root path or id, e.g. "C:/Users/you/project". Must already be registered.');

  const delegated: Array<{ name: string; role: string; title: string; description: string }> = [
    {
      name: 'local_agent.explore_repo',
      role: 'repo-explorer',
      title: 'Explore a repository with DACAIS',
      description:
        'Delegate repository exploration to a DACAIS worker. Use for orienting in unfamiliar code, ' +
        'locating where something lives, or summarising structure — instead of reading many files yourself. ' +
        'Read-only. Uses the preferred RunPod GPU when it is usable and reports when it falls back locally.',
    },
    {
      name: 'local_agent.debug_task',
      role: 'debugger',
      title: 'Diagnose a failure with DACAIS',
      description:
        'Delegate first-pass debugging to a DACAIS worker: reproduce, read the error, trace it to the code. ' +
        'Returns a diagnosis with file and line. Does not apply fixes. Read-only.',
    },
    {
      name: 'local_agent.code_task',
      role: 'coder',
      title: 'Make a bounded code change with DACAIS',
      description:
        'Delegate a small, well-specified code change to a DACAIS worker. It reads surrounding code, edits, ' +
        'and runs the tests. Requires a workspace with write access. Keep the objective narrow.',
    },
    {
      name: 'local_agent.review_task',
      role: 'reviewer',
      title: 'Review changes with DACAIS',
      description:
        'Delegate a correctness review of the current diff to a DACAIS worker. Returns findings with file ' +
        'and line, or says plainly that it found nothing substantive. Read-only.',
    },
    {
      name: 'local_agent.test_task',
      role: 'test-engineer',
      title: 'Run tests with DACAIS',
      description:
        'Delegate running the project test suite to a DACAIS worker and report exact pass/fail counts and ' +
        'exit code. Requires a workspace with shell access.',
    },
  ];

  for (const tool of delegated) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: {
          objective: z
            .string()
            .describe('What the local worker should accomplish. Be specific about the expected answer.'),
          workspace: workspaceArg,
          maxTurns: z.number().int().min(1).max(20).optional().describe('Turn budget. Defaults to the role limit.'),
        },
      },
      async ({ objective, workspace, maxTurns }) => {
        try {
          const text = await delegate({ objective, workspace, role: tool.role, maxTurns });
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: (error as Error).message }],
            isError: true,
          };
        }
      },
    );
  }

  server.registerTool(
    'local_agent.get_task',
    {
      title: 'Check a delegated task',
      description: 'Fetch the current status and result of a previously delegated local task.',
      inputSchema: { taskId: z.string().describe('Task id returned by a local_agent delegation tool.') },
    },
    async ({ taskId }) => {
      try {
        const { task } = await api<{ task: TaskRecord }>(`/api/tasks/${taskId}`);
        return { content: [{ type: 'text' as const, text: formatTask(task) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  server.registerTool(
    'local_agent.cancel_task',
    {
      title: 'Cancel a delegated task',
      description: 'Stop a running local task. Cancellation is durable and reaches the model request.',
      inputSchema: { taskId: z.string().describe('Task id to cancel.') },
    },
    async ({ taskId }) => {
      try {
        const { cancelled } = await api<{ cancelled: boolean }>(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
        return {
          content: [
            {
              type: 'text' as const,
              text: cancelled ? `Cancelled ${taskId}.` : `${taskId} was already finished or unknown.`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: (error as Error).message }], isError: true };
      }
    },
  );

  return server;
}

export async function startStdioServer(options: McpServerOptions = {}): Promise<void> {
  const server = createDacaiMcpServer(options);
  await server.connect(new StdioServerTransport());
}
