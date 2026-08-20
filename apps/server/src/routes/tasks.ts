import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@dacai-local-agent/shared';
import { createId, PermissionAuditStore, UsageStore } from '@dacai-local-agent/shared';
import { runAgentLoop } from '@dacai-local-agent/agent-core';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import { getWorkerRole, WORKER_ROLE_IDS } from '@dacai-local-agent/agents';
import { TaskRunner } from '@dacai-local-agent/orchestrator';
import { PostgresWorkspaceRegistry } from '@dacai-local-agent/workspace';
import { LoopTraceRecorder, TraceStore } from '@dacai-local-agent/training-traces';
import type { TrainingTrace } from '@dacai-local-agent/training-traces';
import { classifyTrace, deriveOutcome } from '@dacai-local-agent/training-traces';
import { containsSecret, PermissionEngine } from '@dacai-local-agent/security';
import { ContextManager } from '@dacai-local-agent/context';
import {
  FILESYSTEM_TOOLS,
  PermissionedToolExecutor,
  READ_ONLY_FILESYSTEM_TOOLS,
  READ_ONLY_SHELL_TOOLS,
  SHELL_TOOLS,
  ToolRegistry,
} from '@dacai-local-agent/tools';

/**
 * The delegated-task surface.
 *
 * A task is submitted, runs in the background under a concurrency cap, and is
 * polled for its result — so a supervising session can hand off token-heavy
 * work without holding a connection open for minutes. Phase 8's MCP bridge is
 * a thin client over exactly these endpoints.
 */

interface CreateTaskBody {
  objective: string;
  workspaceId: string;
  role?: string;
  alias?: string;
  source?: 'ui' | 'mcp' | 'internal';
  maxTurns?: number;
}

/** Versions recorded on every trace so behaviour can be compared later. */
const PROMPT_VERSION = 'roles-v1';
const TOOL_SCHEMA_VERSION = 'tools-v1';
const ROUTER_VERSION = 'alias-v1';

export function registerTaskRoutes(
  server: FastifyInstance,
  deps: { config: AppConfig; registry: ProviderRegistry },
): void {
  const workspaces = new PostgresWorkspaceRegistry();
  const traces = new TraceStore();
  const usage = new UsageStore();
  const auditStore = new PermissionAuditStore();
  const runner = new TaskRunner({
    maxLocalWorkers: deps.config.limits.maxLocalWorkers,
    maxTaskDepth: deps.config.limits.maxTaskDepth,
  });
  const contextManager = new ContextManager();

  server.get('/api/roles', async () => ({
    roles: WORKER_ROLE_IDS.map((id) => {
      const role = getWorkerRole(id)!;
      return { id: role.id, alias: role.alias, readOnly: !role.canEditFiles, maxTurns: role.maxTurns };
    }),
  }));

  server.get('/api/tasks', async () => ({ tasks: await runner.list() }));

  server.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = await runner.get(request.params.id);
    if (!task) return reply.code(404).send({ error: 'Task not found.' });
    return { task };
  });

  server.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request) => ({
    cancelled: await runner.cancel(request.params.id),
  }));

  /**
   * Submits a task and returns immediately with its id. The work continues in
   * the background — the caller polls rather than waiting, which is what makes
   * long-running delegation survive a dropped connection.
   */
  server.post<{ Body: CreateTaskBody }>('/api/tasks', async (request, reply) => {
    const body = request.body;
    if (!body?.objective?.trim()) return reply.code(400).send({ error: 'objective is required.' });

    const role = getWorkerRole(body.role ?? 'repo-explorer');
    if (!role) {
      return reply.code(400).send({ error: `Unknown role. Known roles: ${WORKER_ROLE_IDS.join(', ')}.` });
    }

    const workspace = await workspaces.get(body.workspaceId);
    if (!workspace) return reply.code(400).send({ error: 'Unknown workspace.' });

    // A read-only role must not be handed write tools even in a writable
    // workspace: the role is a narrower grant than the workspace, never a wider one.
    const effective = {
      ...workspace.capabilities,
      write: workspace.capabilities.write && role.canEditFiles,
    };

    let resolved;
    try {
      resolved = await deps.registry.resolveAlias(body.alias ?? role.alias, { requireToolCalling: true });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const task = await runner.create({
      objective: body.objective,
      agentId: role.id,
      providerInstanceId: resolved.instance.id,
      model: resolved.model,
      workspaceId: workspace.id,
      source: body.source ?? 'internal',
    });

    // Deliberately not awaited: the response returns the task id now.
    void (async () => {
      const recorder = new LoopTraceRecorder({ source: body.source ?? 'internal' });
      const startedAt = new Date().toISOString();

      await runner.run(task, async (signal) => {
        const tools = new ToolRegistry();
        const available = [
          ...(effective.write ? FILESYSTEM_TOOLS : READ_ONLY_FILESYSTEM_TOOLS),
          ...(effective.shell ? SHELL_TOOLS : READ_ONLY_SHELL_TOOLS),
        ];
        for (const tool of available) {
          if (!role.tools || role.tools.includes(tool.name)) tools.register(tool);
        }

        const executor = new PermissionedToolExecutor({
          registry: tools,
          engine: new PermissionEngine(
            effective.write || effective.shell
              ? { autoApprove: ['safe', 'mutation'], requireApproval: ['high-impact'], deny: [] }
              : { autoApprove: ['safe'], requireApproval: ['mutation', 'high-impact'], deny: [] },
          ),
          capabilities: effective,
          context: { workspaceId: workspace.id, workspaceRoot: workspace.rootPath, taskId: task.id },
          audit: {
            record: (entry) =>
              auditStore.record({
                workspaceId: workspace.id,
                taskId: task.id,
                toolName: entry.toolName,
                tier: entry.decision.tier,
                decision: entry.decision.kind,
                reason: entry.decision.reason,
                input: entry.input,
              }),
          },
          // No approval gate on a delegated task: nobody is watching it, so
          // high-impact work fails closed rather than waiting for a click.
        });

        // Build augmented system prompt with context
        let systemPrompt = role.systemPrompt;
        try {
          const builtContext = await contextManager.buildContext({
            goal: body.objective,
            scope: { workspaceId: workspace.id },
            options: {
              enableRag: true,
              enableMemory: true,
              maxContextTokens: 10000,
            },
          });

          if (builtContext.sections.length > 0) {
            const contextString = contextManager.formatContextString(builtContext);
            systemPrompt = `${contextString}\n\n---\n\n${role.systemPrompt}`;
            if (builtContext.truncated) {
              server.log.debug({
                reasoning: builtContext.reasoning,
                totalTokens: builtContext.totalTokens,
              }, 'Context was truncated to fit token limit');
            }
          }
        } catch (error) {
          server.log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Context retrieval failed, proceeding with base system prompt',
          );
        }

        const result = await runAgentLoop({
          provider: resolved.provider,
          model: resolved.model,
          capabilities: resolved.capabilities,
          executor,
          prompt: body.objective,
          systemPrompt,
          temperature: role.temperature,
          maxTurns: Math.min(body.maxTurns ?? role.maxTurns, deps.config.limits.maxAgentTurns),
          maxToolCalls: 64,
          maxContextTokens: resolved.capabilities.contextWindow ? Math.max(4096, Math.min(resolved.capabilities.contextWindow, 12288)) : 12288,
          reasoningMode: 'auto',
          evidenceRequirement: role.requiresEvidenceFrom
            ? { tools: [...role.requiresEvidenceFrom], maxNudges: 1 }
            : undefined,
          signal,
          onEvent: (event) => recorder.record(event),
        });

        await usage.record({
          taskId: task.id,
          workspaceId: workspace.id,
          providerInstanceId: resolved.instance.id,
          usageClass: resolved.instance.usageClass,
          model: resolved.model,
          source: body.source ?? 'internal',
          workerRole: role.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          toolCalls: result.toolCalls,
          durationMs: result.durationMs,
        });

        const steps = recorder.collect();
        const outcome = deriveOutcome(steps, {
          completed: result.stopReason === 'final-answer',
          reverted: false,
          durationMs: result.durationMs,
          retryCount: result.retries,
        });

        // Sanitization is a gate, not a label: a trace carrying anything that
        // looks like a credential never becomes training-eligible.
        const serialized = JSON.stringify(steps);
        const sanitizationPassed = !containsSecret(serialized) && !containsSecret(result.answer);

        const trace: TrainingTrace = {
          traceId: createId('tr'),
          taskId: task.id,
          workspaceId: workspace.id,
          agentRole: role.id,
          providerInstanceId: resolved.instance.id,
          model: resolved.model,
          taskType: roleToTaskType(role.id),
          objective: body.objective,
          constraints: [],
          source: body.source ?? 'internal',
          startedAt,
          completedAt: new Date().toISOString(),
          steps,
          outcome,
          classification: classifyTrace(outcome, steps, result.stopReason === 'cancelled'),
          provenance: {
            agentPromptVersion: PROMPT_VERSION,
            toolSchemaVersion: TOOL_SCHEMA_VERSION,
            routerVersion: ROUTER_VERSION,
            providerInstanceId: resolved.instance.id,
            usageClass: resolved.instance.usageClass,
            model: resolved.model,
            configHash: `${role.id}:${resolved.model}`,
          },
          sanitizationPassed,
          sanitizationNotes: sanitizationPassed ? undefined : 'Possible credential detected in trace.',
          eligibleForTraining: false,
        };

        await traces.save(trace).catch((error) => {
          server.log.warn({ err: String(error) }, 'trace persistence failed');
        });

        // A run that died on a provider error is a failure, not a completion.
        // Recording it as completed hands a supervisor "status: completed" with
        // empty findings, which is worse than an honest error: it invites the
        // reader to treat an absent answer as a negative finding.
        if (result.stopReason === 'provider-error') {
          throw new Error(
            `Worker failed after ${result.turns} turns and ${result.toolCalls} tool calls: ` +
              `${result.error ?? 'provider error'}`,
          );
        }

        return {
          result: result.answer,
          evidence: steps.filter((step) => (step.evidence?.length ?? 0) > 0).flatMap((s) => s.evidence ?? []),
          usage: {
            ...result.usage,
            turns: result.turns,
            toolCalls: result.toolCalls,
            stopReason: result.stopReason,
            traceId: trace.traceId,
          },
        };
      });
    })();

    return { task, queued: runner.queuedCount, active: runner.activeCount };
  });

  /** Dataset quality report — what would be exportable, and what would not. */
  server.get('/api/traces/stats', async () => traces.stats());

  /**
   * The step-by-step record of a run, by task id or trace id.
   *
   * Exists because a supervisor evaluating a delegated result needs to answer
   * "did the worker find nothing, or was something lost?" — and could not:
   * traces live in Postgres, so there is nothing to find on disk. Without this,
   * an empty result is indistinguishable from a plumbing bug.
   */
  server.get<{ Params: { id: string } }>('/api/traces/:id', async (request, reply) => {
    const trace = await traces.getByTaskOrTraceId(request.params.id);
    if (!trace) return reply.code(404).send({ error: 'No trace for that task or trace id.' });
    return trace;
  });

  server.post<{ Params: { id: string }; Body: { rating: 'good' | 'bad' | 'partial'; comment?: string } }>(
    '/api/traces/:id/feedback',
    async (request, reply) => {
      const rating = request.body?.rating;
      if (!rating || !['good', 'bad', 'partial'].includes(rating)) {
        return reply.code(400).send({ error: 'rating must be good, bad, or partial.' });
      }

      await traces.recordFeedback(request.params.id, {
        rating,
        comment: request.body.comment,
        ratedAt: new Date().toISOString(),
      });
      return { ok: true };
    },
  );
}

function roleToTaskType(roleId: string): string {
  switch (roleId) {
    case 'repo-explorer':
      return 'explore_repo';
    case 'debugger':
      return 'debug_task';
    case 'reviewer':
      return 'review_task';
    case 'test-engineer':
      return 'test_task';
    default:
      return 'code_task';
  }
}

