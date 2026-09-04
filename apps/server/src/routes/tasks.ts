import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@dacai-local-agent/shared';
import { createId, PermissionAuditStore, UsageStore } from '@dacai-local-agent/shared';
import { runAgentLoop } from '@dacai-local-agent/agent-core';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import { getWorkerRole, WORKER_ROLE_IDS } from '@dacai-local-agent/agents';
import { ScheduleStore, ScheduleValidationError, TaskRunner } from '@dacai-local-agent/orchestrator';
import type { ScheduleKind, TaskRecord } from '@dacai-local-agent/orchestrator';
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
  WEB_TOOLS,
  REPOSITORY_INTELLIGENCE_TOOLS,
} from '@dacai-local-agent/tools';
import { repositoryAuditInstructions, resolveAgentRunMode } from '../agent-run-mode';
import { resolveTaskModel } from '../task-model-routing';

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
  runMode?: 'interactive' | 'coding' | 'repository_audit' | 'deep_research';
}

interface CreateScheduleBody {
  name?: string;
  objective: string;
  role: string;
  workspaceId: string;
  alias?: string;
  kind: ScheduleKind;
  intervalSeconds?: number;
  /** ISO timestamp of the first fire; defaults to a minute from now. */
  firstRunAt?: string;
  enabled?: boolean;
}

interface UpdateScheduleBody {
  name?: string;
  objective?: string;
  enabled?: boolean;
  intervalSeconds?: number;
  nextRunAt?: string;
}

/**
 * How often the server reconciles abandoned work, fires due schedules, and
 * looks for queued tasks. Short enough that a schedule set for a specific
 * minute is not visibly late, long enough to stay cheap when idle.
 */
const TICK_INTERVAL_MS = 20_000;

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
  const schedules = new ScheduleStore();
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
   * Runs a task using only what its row records.
   *
   * Everything the worker needs is re-derived here rather than captured from
   * the request that created the task. That is what lets a task outlive the
   * process it was submitted to: after a restart the claim loop can pick up a
   * queued row and execute it identically, with no in-memory state to lose.
   */
  async function executeTask(task: TaskRecord): Promise<void> {
    const role = getWorkerRole(task.agentId);
    const workspace = task.workspaceId ? await workspaces.get(task.workspaceId) : undefined;

    if (!role || !workspace) {
      await runner.run(task, async () => {
        throw new Error(
          !role
            ? `Task references unknown role "${task.agentId}".`
            : 'Task references a workspace that no longer exists.',
        );
      });
      return;
    }

    // A read-only role must not be handed write tools even in a writable
    // workspace: the role is a narrower grant than the workspace, never a wider one.
    const effective = {
      ...workspace.capabilities,
      write: workspace.capabilities.write && role.canEditFiles,
    };

    let resolved;
    try {
      resolved = await resolveTaskModel(task, deps.registry);
      await runner.recordResolution(task.id, resolved.instance.id, resolved.model);
    } catch (error) {
      const message = (error as Error).message;
      await runner.run(task, async () => {
        throw new Error(`Provider is no longer resolvable for this task: ${message}`);
      });
      return;
    }

    const resolvedRunMode = resolveAgentRunMode({
      prompt: task.objective,
      role: role.id,
      config: deps.config,
    });

    {
      const recorder = new LoopTraceRecorder({ source: task.source });
      const startedAt = new Date().toISOString();

      await runner.run(task, async (signal) => {
        const tools = new ToolRegistry();
        const available = [
          ...(effective.write ? FILESYSTEM_TOOLS : READ_ONLY_FILESYSTEM_TOOLS),
          ...(effective.shell ? SHELL_TOOLS : READ_ONLY_SHELL_TOOLS),
          ...(effective.network ? WEB_TOOLS : []),
          ...(resolvedRunMode.mode === 'repository_audit' ? REPOSITORY_INTELLIGENCE_TOOLS : []),
        ];
        for (const tool of available) {
          const auditReadOnlyTool = resolvedRunMode.mode === 'repository_audit' && tool.name.startsWith('code.');
          if (auditReadOnlyTool || !role.tools || role.tools.includes(tool.name)) tools.register(tool);
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
        let systemPrompt = [
          role.systemPrompt,
          resolvedRunMode.mode === 'repository_audit' ? repositoryAuditInstructions() : '',
        ].filter(Boolean).join('\n\n');
        try {
          const builtContext = await contextManager.buildContext({
            goal: task.objective,
            scope: { workspaceId: workspace.id },
            options: {
              enableRag: true,
              enableMemory: true,
              maxContextTokens: 10000,
            },
          });

          if (builtContext.sections.length > 0) {
            const contextString = contextManager.formatContextString(builtContext);
            systemPrompt = `${contextString}\n\n---\n\n${systemPrompt}`;
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
          prompt: task.objective,
          systemPrompt,
          temperature: role.temperature,
          maxTurns: resolvedRunMode.budget.maxTurns,
          maxToolCalls: resolvedRunMode.budget.maxToolCalls,
          maxContextTokens: resolved.capabilities.contextWindow ? Math.max(4096, Math.min(resolved.capabilities.contextWindow, 12288)) : 12288,
          reasoningMode: 'auto',
          runMode: resolvedRunMode.mode,
          synthesisReserveTurns: resolvedRunMode.budget.synthesisReserveTurns,
          completionSignalRequired: resolvedRunMode.mode === 'repository_audit' || resolvedRunMode.mode === 'deep_research',
          evidenceRequirement: role.requiresEvidenceFrom
            ? { tools: resolvedRunMode.mode === 'repository_audit' ? ['code.architecture.context', 'code.symbol.search', 'filesystem.read'] : [...role.requiresEvidenceFrom], maxNudges: 1 }
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
          source: task.source,
          workerRole: role.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          toolCalls: result.toolCalls,
          durationMs: result.durationMs,
        });

        const steps = recorder.collect();
        const outcome = deriveOutcome(steps, {
          completed: result.completionState === 'GOAL_COMPLETE' || result.completionState === 'VERIFICATION_COMPLETE',
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
          objective: task.objective,
          constraints: [],
          source: task.source,
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
          status: result.completionState === 'WAITING_FOR_USER'
            ? 'waiting_for_user'
            : result.completionState === 'BLOCKED' || result.completionState === 'HARD_BUDGET_EXHAUSTED'
              ? 'blocked'
              : result.completionState === 'CANCELLED'
                ? 'cancelled'
                : result.completionState === 'FAILED'
                  ? 'failed'
                  : 'completed',
          usage: {
            ...result.usage,
            turns: result.turns,
            toolCalls: result.toolCalls,
            stopReason: result.stopReason,
            completionState: result.completionState,
            traceId: trace.traceId,
            modelAlias: task.modelAlias ?? resolved.alias,
            resolvedAlias: resolved.alias,
            providerInstanceId: resolved.instance.id,
            usageClass: resolved.instance.usageClass,
            routingNote: resolved.routingNote,
            promotedFromAlias: resolved.promotedFromAlias,
            fellBackFromAlias: resolved.fellBackFromAlias,
          },
        };
      });
    }
  }

  // Counts work this process has claimed but not yet finished. The database
  // decides *which* task runs; this only decides whether there is room to take
  // another, and prevents claiming more than the worker cap between the claim
  // and the point where TaskRunner accounts for it.
  let inFlight = 0;
  let draining = false;

  /**
   * Claims and starts queued work until the worker cap is reached.
   *
   * Because claiming reads from Postgres rather than an in-memory list, a task
   * queued by a process that has since exited is picked up here instead of
   * being stranded.
   */
  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (inFlight < deps.config.limits.maxLocalWorkers) {
        const task = await runner.claimNext();
        if (!task) return;
        inFlight += 1;
        void executeTask(task)
          .catch((error) => server.log.error({ err: String(error), taskId: task.id }, 'task execution failed'))
          .finally(() => {
            inFlight -= 1;
            void drainQueue();
          });
      }
    } finally {
      draining = false;
    }
  }

  /** Turns every due schedule into a queued task. */
  async function tickSchedules(): Promise<void> {
    const due = await schedules.claimDue();
    for (const schedule of due) {
      try {
        const role = getWorkerRole(schedule.role);
        if (!role) throw new Error(`Unknown role "${schedule.role}".`);
        const modelAlias = schedule.alias ?? role.alias;
        const resolved = await deps.registry.resolveAlias(modelAlias, { requireToolCalling: true });
        const task = await runner.create({
          objective: schedule.objective,
          agentId: role.id,
          modelAlias,
          providerInstanceId: resolved.instance.id,
          model: resolved.model,
          workspaceId: schedule.workspaceId,
          source: 'internal',
          scheduleId: schedule.id,
        });
        await schedules.recordRun(schedule.id, task.id);
        server.log.info({ scheduleId: schedule.id, taskId: task.id }, 'schedule fired');
      } catch (error) {
        // One unusable schedule must not stop the rest of the tick.
        server.log.error({ err: String(error), scheduleId: schedule.id }, 'schedule could not be started');
      }
    }
  }

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

    let resolved;
    const modelAlias = body.alias ?? role.alias;
    try {
      resolved = await deps.registry.resolveAlias(modelAlias, { requireToolCalling: true });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const task = await runner.create({
      objective: body.objective,
      agentId: role.id,
      modelAlias,
      providerInstanceId: resolved.instance.id,
      model: resolved.model,
      workspaceId: workspace.id,
      source: body.source ?? 'internal',
    });

    // The row is durable before the response returns; the drain loop picks it
    // up from the database, so nothing depends on this request surviving.
    void drainQueue();

    return { task, queued: runner.queuedCount, active: inFlight };
  });

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  server.get('/api/schedules', async () => ({ schedules: await schedules.list() }));

  server.post<{ Body: CreateScheduleBody }>('/api/schedules', async (request, reply) => {
    const body = request.body;
    if (!body?.objective?.trim()) return reply.code(400).send({ error: 'objective is required.' });
    if (!getWorkerRole(body.role ?? '')) {
      return reply.code(400).send({ error: `Unknown role. Known roles: ${WORKER_ROLE_IDS.join(', ')}.` });
    }
    if (!(await workspaces.get(body.workspaceId))) {
      return reply.code(400).send({ error: 'Unknown workspace.' });
    }

    const firstRunAt = body.firstRunAt ? new Date(body.firstRunAt) : new Date(Date.now() + 60_000);
    try {
      const schedule = await schedules.create({
        name: body.name?.trim() || body.objective.trim().slice(0, 60),
        objective: body.objective,
        role: body.role,
        workspaceId: body.workspaceId,
        alias: body.alias,
        kind: body.kind,
        intervalSeconds: body.intervalSeconds,
        firstRunAt,
        enabled: body.enabled,
      });
      return reply.code(201).send({ schedule });
    } catch (error) {
      if (error instanceof ScheduleValidationError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  server.patch<{ Params: { id: string }; Body: UpdateScheduleBody }>(
    '/api/schedules/:id',
    async (request, reply) => {
      const schedule = await schedules.update(request.params.id, {
        name: request.body?.name,
        objective: request.body?.objective,
        enabled: request.body?.enabled,
        intervalSeconds: request.body?.intervalSeconds,
        nextRunAt: request.body?.nextRunAt ? new Date(request.body.nextRunAt) : undefined,
      });
      if (!schedule) return reply.code(404).send({ error: 'Schedule not found.' });
      return { schedule };
    },
  );

  server.delete<{ Params: { id: string } }>('/api/schedules/:id', async (request, reply) => {
    if (!(await schedules.remove(request.params.id))) {
      return reply.code(404).send({ error: 'Schedule not found.' });
    }
    return { deleted: true };
  });

  /** Fire a schedule now without disturbing its cadence. */
  server.post<{ Params: { id: string } }>('/api/schedules/:id/run-now', async (request, reply) => {
    const schedule = await schedules.get(request.params.id);
    if (!schedule) return reply.code(404).send({ error: 'Schedule not found.' });

    const role = getWorkerRole(schedule.role);
    if (!role) return reply.code(400).send({ error: `Unknown role "${schedule.role}".` });

    const modelAlias = schedule.alias ?? role.alias;
    const resolved = await deps.registry.resolveAlias(modelAlias, { requireToolCalling: true });
    const task = await runner.create({
      objective: schedule.objective,
      agentId: role.id,
      modelAlias,
      providerInstanceId: resolved.instance.id,
      model: resolved.model,
      workspaceId: schedule.workspaceId,
      source: 'internal',
      scheduleId: schedule.id,
    });
    await schedules.recordRun(schedule.id, task.id);
    void drainQueue();
    return { task };
  });

  // -------------------------------------------------------------------------
  // Background loop
  // -------------------------------------------------------------------------

  // Reconcile before anything else: rows abandoned by a previous process are
  // resolved to 'interrupted' so the queue reflects reality at startup rather
  // than accumulating work nothing will ever pick up.
  void runner
    .reconcile()
    .then(({ interrupted, released }) => {
      if (interrupted || released) {
        server.log.warn({ interrupted, released }, 'recovered tasks abandoned by a previous process');
      }
      return Promise.all([tickSchedules(), drainQueue()]);
    })
    .catch((error) => server.log.error({ err: String(error) }, 'task startup reconciliation failed'));

  const ticker = setInterval(() => {
    void runner.reconcile().catch(() => undefined);
    void tickSchedules().catch((error) => server.log.error({ err: String(error) }, 'schedule tick failed'));
    void drainQueue().catch(() => undefined);
  }, TICK_INTERVAL_MS);
  ticker.unref?.();
  server.addHook('onClose', async () => clearInterval(ticker));

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

