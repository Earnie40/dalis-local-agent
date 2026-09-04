import { RunnableLambda } from '@langchain/core/runnables';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  runAgentLoop,
  type AgentLoopContextSnapshot,
  type AgentLoopResult,
  type LoopEvent,
  type ToolExecutor,
  type ReasoningPreference,
  type AgentCompletionState,
  type CompletionMessage,
} from '@dacai-local-agent/agent-core';
import type { ResolvedModel } from '@dacai-local-agent/providers';
import type { ContextManager } from '@dacai-local-agent/context';
import type { MemoryStore } from '@dacai-local-agent/memory';

export type GraphPhase = 'bootstrap' | 'plan' | 'execute' | 'review' | 'finalize';

export interface CodingGraphEvent {
  type: 'phase' | 'checkpoint' | 'plan_update' | 'review' | 'reasoning_mode' | 'context_compaction' | 'context_refresh' | 'validation';
  phase?: GraphPhase;
  message: string;
  detail?: Record<string, unknown>;
}

export type GraphTaskKind = 'repository' | 'operational';

/**
 * What the run is about and what proves it. The graph defaults to repository
 * work; an operational profile keeps the same plan → execute → review shape
 * but lets live-system output stand as evidence and does not demand a
 * repository mutation that the goal never asked for.
 */
export interface GraphTaskProfile {
  kind: GraphTaskKind;
  evidenceRequirement?: { tools: string[]; maxNudges?: number };
}

export interface CodingAgentGraphInput {
  threadId: string;
  workspaceId: string;
  goal: string;
  history?: CompletionMessage[];
  systemPrompt: string;
  taskProfile?: GraphTaskProfile;
  executor: ToolExecutor;
  coder: ResolvedModel;
  planner?: ResolvedModel;
  reviewer?: ResolvedModel;
  contextManager: ContextManager;
  memoryStore: MemoryStore;
  maxTurns: number;
  maxToolCalls: number;
  maxContextTokens: number;
  runMode?: string;
  synthesisReserveTurns?: number;
  reasoningMode?: ReasoningPreference;
  signal?: AbortSignal;
  onLoopEvent?: (event: LoopEvent) => void;
  onGraphEvent?: (event: CodingGraphEvent) => void;
}

interface StoredExecutionResult {
  taskId: string;
  answer: string;
  stopReason: AgentLoopResult['stopReason'];
  completionState: AgentCompletionState;
  turns: number;
  toolCalls: number;
  rejectedCalls: number;
  deniedCalls: number;
  retries: number;
  durationMs: number;
  usage: AgentLoopResult['usage'];
  workingState: AgentLoopResult['workingState'];
  error?: string;
}

const GraphState = Annotation.Root({
  workspaceId: Annotation<string>,
  goal: Annotation<string>,
  phase: Annotation<GraphPhase>,
  plan: Annotation<string>,
  initialContext: Annotation<string>,
  execution: Annotation<StoredExecutionResult | undefined>,
  review: Annotation<string>,
  reviewPassed: Annotation<boolean>,
  cycle: Annotation<number>,
  finalAnswer: Annotation<string>,
});

type CodingGraphState = typeof GraphState.State;

function stripTaskMarker(answer: string): string {
  return answer.replace(/^\s*TASK_(?:COMPLETE|BLOCKED):\s*/i, '').trim();
}

const REPOSITORY_EVIDENCE_TOOLS = ['filesystem.list', 'filesystem.search', 'filesystem.read', 'filesystem.stat'];

export function fallbackPlan(goal: string, kind: GraphTaskKind = 'repository'): string {
  const steps = kind === 'operational'
    ? [
        'PENDING — run the requested operation through the required live-system tool and runtime',
        'PENDING — inspect the actual command output for errors or missing capabilities',
        'PENDING — verify the requested outcome from observed output and finish only when it is established',
      ]
    : [
        'PENDING — inspect repository instructions and relevant implementation',
        'PENDING — execute the requested repository work with exact observed paths',
        'PENDING — validate mutations with diagnostics/tests',
        'PENDING — inspect results/diff and finish only when the goal is verified',
      ];
  return [...steps, `GOAL — ${goal.slice(0, 1800)}`].join('\n');
}

const PLAN_ACTION = /^(?:analyze|check|compare|determine|edit|identify|inspect|locate|make|read|review|run|search|test|update|use|validate|verify)\b/i;
const PLAN_COMPLETION_CLAIM = /\b(?:final\s+summary|evidence\s+used|change\s+made|git\s+diff\s+confirmed|tests?\s+(?:passed|succeeded)|validation\s+(?:passed|succeeded)|(?:has|have|was|were)\s+(?:updated|changed|modified|validated|verified|completed|confirmed)|updated\s+(?:the\s+)?readme)\b/i;
const PLAN_REPOSITORY_CLAIM = /\b(?:is|are|was|were|has|have|had|contains?|found|shows?|indicates?|reports?|confirmed|completed|passed|succeeded|changed|modified|updated|validated|verified)\b/i;

/**
 * A planner is advisory only. Its output may describe future work, but it
 * cannot introduce completion claims, evidence, or a terminal status before
 * the executor has observed anything. Invalid or mixed prose falls back to a
 * deterministic, all-pending checklist.
 */
export function normalizeExecutionPlan(candidate: string, goal: string, kind: GraphTaskKind = 'repository'): string {
  const fallback = fallbackPlan(goal, kind);
  const trimmed = candidate.trim();
  if (!trimmed || PLAN_COMPLETION_CLAIM.test(trimmed)) return fallback;

  const actions: string[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '');
    const match = /^PENDING\s*[-—:]\s*(.+)$/i.exec(line);
    if (!match) return fallback;

    const action = match[1].trim();
    if (
      action.length > 360 ||
      !PLAN_ACTION.test(action) ||
      PLAN_COMPLETION_CLAIM.test(action) ||
      PLAN_REPOSITORY_CLAIM.test(action)
    ) {
      return fallback;
    }
    actions.push(action);
    if (actions.length >= 12) break;
  }

  if (!actions.length) return fallback;
  return [...actions.map((action) => `PENDING — ${action}`), `GOAL — ${goal.slice(0, 1800)}`].join('\n');
}

async function advisoryCall(resolved: ResolvedModel | undefined, systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<string> {
  if (!resolved) return '';
  const response = await resolved.provider.chat({
    model: resolved.model,
    systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    temperature: resolved.temperature,
    maxTokens: Math.min(resolved.maxTokens ?? 1800, 2400),
    think: resolved.capabilities.configurableThinking !== 'unsupported',
    contextWindowTokens: Math.min(resolved.capabilities.contextWindow ?? 32768, 32768),
    signal,
  });
  return response.content?.trim() ?? '';
}

function compactExecution(result: AgentLoopResult): StoredExecutionResult {
  return {
    taskId: result.taskId,
    answer: result.answer,
    stopReason: result.stopReason,
    completionState: result.completionState,
    turns: result.turns,
    toolCalls: result.toolCalls,
    rejectedCalls: result.rejectedCalls,
    deniedCalls: result.deniedCalls,
    retries: result.retries,
    durationMs: result.durationMs,
    usage: result.usage,
    workingState: result.workingState,
    error: result.error,
  };
}

/**
 * Durable coding orchestration using LangGraph while retaining DACAIS as the
 * model, tool, permission, approval, memory and RAG authority.
 */
export class DurableCodingAgentGraph {
  private checkpointer?: PostgresSaver;
  private checkpointerSetup?: Promise<void>;

  constructor(private readonly databaseUrl: string) {}

  private async getCheckpointer(): Promise<PostgresSaver> {
    if (!this.checkpointer) this.checkpointer = PostgresSaver.fromConnString(this.databaseUrl, {});
    if (!this.checkpointerSetup) this.checkpointerSetup = this.checkpointer.setup();
    await this.checkpointerSetup;
    return this.checkpointer;
  }

  async run(input: CodingAgentGraphInput): Promise<StoredExecutionResult> {
    let checkpointer: PostgresSaver | MemorySaver;
    try {
      checkpointer = await this.getCheckpointer();
      input.onGraphEvent?.({ type: 'checkpoint', phase: 'bootstrap', message: 'PostgreSQL durable checkpointing is active.' });
    } catch (error) {
      // A transient checkpoint-table/setup failure must not make the local coding
      // agent unusable. Fail over visibly to process-local checkpoints while the
      // DACAIS database/RAG/memory layers continue using their own stores.
      checkpointer = new MemorySaver();
      input.onGraphEvent?.({
        type: 'checkpoint',
        phase: 'bootstrap',
        message: `PostgreSQL checkpointing unavailable; using in-memory checkpoints for this run: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const emitPhase = (phase: GraphPhase, message: string, detail?: Record<string, unknown>) => {
      input.onGraphEvent?.({ type: 'phase', phase, message, detail });
    };

    const bootstrap = RunnableLambda.from(async (state: CodingGraphState) => {
      emitPhase('bootstrap', 'Loading curated repository, RAG and memory context.');
      const built = await input.contextManager.buildContext({
        goal: state.goal,
        scope: { workspaceId: state.workspaceId },
        planContext: state.plan || undefined,
        options: { maxContextTokens: input.maxContextTokens },
      });
      const initialContext = input.contextManager.formatContextString(built);
      input.onGraphEvent?.({
        type: 'checkpoint',
        phase: 'bootstrap',
        message: `Initial context assembled (${built.totalTokens} estimated tokens${built.truncated ? ', compacted' : ''}).`,
      });
      return { phase: 'plan' as const, initialContext };
    });

    const taskKind: GraphTaskKind = input.taskProfile?.kind ?? 'repository';
    const operational = taskKind === 'operational';

    const plan = RunnableLambda.from(async (state: CodingGraphState) => {
      emitPhase('plan', 'Building a compact execution checklist.');
      let nextPlan = fallbackPlan(state.goal, taskKind);
      try {
        const planned = await advisoryCall(
          input.planner,
          [
            'You are the planning pass for a coding agent.',
            operational
              ? 'This goal is a live system/network operation, not repository work: plan steps that execute on the running machine through the required runtime and read real output. Do not plan repository listing, searching, or source inspection unless the goal itself asks for it.'
              : '',
            'Return only 3-12 concise checklist lines in the exact form: PENDING — <future action>.',
            'Do not emit headings, Final Summary, results, evidence, repository facts, COMPLETE, or BLOCKED.',
            operational
              ? 'The plan is intent only: the executor must run the operation and observe its output before any completion claim.'
              : 'The plan is intent only: the executor must inspect, mutate, and validate before any completion claim.',
          ].filter(Boolean).join('\n'),
          `GOAL:\n${state.goal}\n\nCURATED CONTEXT:\n${state.initialContext.slice(0, 14000)}`,
          input.signal,
        );
        if (planned) nextPlan = normalizeExecutionPlan(planned, state.goal, taskKind);
      } catch {
        // Planner is advisory. Executor remains able to work from deterministic fallback.
      }
      input.onGraphEvent?.({ type: 'plan_update', phase: 'plan', message: nextPlan.slice(0, 4000) });
      return { phase: 'execute' as const, plan: nextPlan };
    });

    const execute = RunnableLambda.from(async (state: CodingGraphState) => {
      emitPhase(
        'execute',
        state.cycle > 0
          ? 'Re-entering execution after reviewer feedback.'
          : operational ? 'Executing live-system task.' : 'Executing repository task.',
      );
      const reviewFeedback = state.review && !state.reviewPassed ? `\n\nREVIEW FEEDBACK TO CORRECT:\n${state.review}` : '';

      const contextProvider = async (snapshot: AgentLoopContextSnapshot): Promise<string> => {
        const built = await input.contextManager.buildContext({
          goal: snapshot.goal,
          scope: { workspaceId: input.workspaceId },
          planContext: `${state.plan}${reviewFeedback}`,
          currentStateContext: [
            `Reasoning mode: ${snapshot.reasoningMode}`,
            snapshot.changedFiles.length ? `Changed files: ${snapshot.changedFiles.join(', ')}` : '',
            snapshot.validationResults.length ? `Validation: ${snapshot.validationResults.join('; ')}` : '',
            snapshot.recentFailures.length ? `Failures: ${snapshot.recentFailures.join('; ')}` : '',
          ].filter(Boolean).join('\n'),
          rollingSummary: snapshot.rollingSummary,
          knownPaths: snapshot.knownPaths,
          recentObservations: snapshot.recentFailures,
          options: { maxContextTokens: input.maxContextTokens },
        });
        return input.contextManager.formatContextString(built);
      };

      const result = await runAgentLoop({
        provider: input.coder.provider,
        model: input.coder.model,
        capabilities: input.coder.capabilities,
        executor: input.executor,
        history: input.history,
        prompt: state.cycle > 0
          ? `${input.goal}\n\nThe previous implementation was reviewed and needs correction:\n${state.review}`
          : input.goal,
        systemPrompt: input.systemPrompt,
        temperature: input.coder.temperature ?? 0.08,
        maxTurns: input.maxTurns,
        maxToolCalls: input.maxToolCalls,
        maxContextTokens: input.maxContextTokens,
        runMode: input.runMode,
        synthesisReserveTurns: input.synthesisReserveTurns,
        completionSignalRequired: true,
        // A repository goal that says "fix"/"add" must produce a file mutation.
        // An operational goal with the same verbs ("install", "add a route")
        // acts on the live system, where no repository mutation is expected.
        requireMutationForMutationIntent: !operational,
        requireValidationAfterMutation: true,
        reasoningMode: state.cycle > 0 ? 'deep' : input.reasoningMode ?? 'auto',
        initialPlan: state.plan,
        initialContext: state.initialContext,
        contextProvider,
        // The profile decides what counts as evidence: repository inspection
        // for repository work, live-system output for operational work. A
        // profile that names no tool leaves the evidence gate off rather than
        // demanding a tool the model cannot call.
        evidenceRequirement: input.taskProfile
          ? input.taskProfile.evidenceRequirement
            ? { maxNudges: 2, ...input.taskProfile.evidenceRequirement }
            : undefined
          : { tools: REPOSITORY_EVIDENCE_TOOLS, maxNudges: 2 },
        signal: input.signal,
        onEvent: input.onLoopEvent,
      });

      return { phase: 'review' as const, execution: compactExecution(result) };
    });

    const review = RunnableLambda.from(async (state: CodingGraphState) => {
      emitPhase('review', 'Reviewing completion claims, validation evidence and changed-file state.');
      const execution = state.execution;
      if (!execution) {
        return { phase: 'finalize' as const, review: 'REVIEW_FIX: execution result is missing.', reviewPassed: false };
      }

      // Failed/stalled execution is not magically repaired by an advisory reviewer.
      if (execution.completionState !== 'GOAL_COMPLETE' && execution.completionState !== 'VERIFICATION_COMPLETE') {
        const feedback = `REVIEW_FIX: executor ended with ${execution.completionState}; completion was not verified. ${stripTaskMarker(execution.answer).slice(0, 1200)}`;
        input.onGraphEvent?.({ type: 'review', phase: 'review', message: feedback });
        return { phase: state.cycle < 1 ? 'execute' as const : 'finalize' as const, review: feedback, reviewPassed: false, cycle: state.cycle + 1 };
      }

      const ws = execution.workingState;
      if (ws.mutationGeneration > ws.validatedMutationGeneration) {
        const feedback = 'REVIEW_FIX: repository mutations occurred after the last passing validation.';
        input.onGraphEvent?.({ type: 'review', phase: 'review', message: feedback });
        return { phase: state.cycle < 1 ? 'execute' as const : 'finalize' as const, review: feedback, reviewPassed: false, cycle: state.cycle + 1 };
      }

      let feedback = 'REVIEW_PASS: deterministic completion and validation gates passed.';
      try {
        const advisory = await advisoryCall(
          input.reviewer,
          [
            'You are the independent reviewer for a coding-agent run.',
            'Return REVIEW_PASS: only if the evidence supports the user goal.',
            'Return REVIEW_FIX: followed by concrete corrective feedback if work is incomplete or inconsistent.',
            'Do not infer tests or files that are not in the evidence.',
            'The plan is intended work only, never evidence that any work happened.',
          ].join('\n'),
          [
            `ORIGINAL GOAL:\n${state.goal}`,
            `PLAN:\n${state.plan}`,
            `EXECUTOR ANSWER:\n${execution.answer}`,
            `CHANGED FILES:\n${ws.changedFiles.join('\n') || '(none)'}`,
            `VALIDATION:\n${ws.validationResults.join('\n') || '(none)'}`,
            `STOP REASON: ${execution.stopReason}`,
          ].join('\n\n'),
          input.signal,
        );
        if (advisory) feedback = advisory;
      } catch {
        // Deterministic gates above remain authoritative if advisory review is unavailable.
      }

      const passed = /^\s*REVIEW_PASS:/i.test(feedback);
      input.onGraphEvent?.({ type: 'review', phase: 'review', message: feedback.slice(0, 4000) });
      return {
        phase: passed || state.cycle >= 1 ? 'finalize' as const : 'execute' as const,
        review: feedback,
        reviewPassed: passed,
        cycle: passed ? state.cycle : state.cycle + 1,
      };
    });

    const finalize = RunnableLambda.from(async (state: CodingGraphState) => {
      emitPhase('finalize', 'Finalizing durable coding-agent result.');
      const execution = state.execution;
      if ((execution?.completionState === 'GOAL_COMPLETE' || execution?.completionState === 'VERIFICATION_COMPLETE') && /^\s*TASK_COMPLETE:/i.test(execution.answer) && state.reviewPassed) {
        await input.memoryStore.saveSafe({
          scope: 'workspace',
          scopeKey: state.workspaceId,
          content: `Verified coding task completed: ${state.goal.slice(0, 500)}. Changed: ${execution.workingState.changedFiles.slice(0, 12).join(', ') || 'no files recorded'}.`,
          metadata: { kind: 'verified-coding-task', taskId: execution.taskId },
        }).catch(() => undefined);
      }
      input.onGraphEvent?.({ type: 'checkpoint', phase: 'finalize', message: 'Final graph state checkpointed.' });
      return { finalAnswer: execution?.answer ?? 'TASK_BLOCKED: BLOCKED — no execution result was produced.' };
    });

    const graph = new StateGraph(GraphState)
      .addNode('bootstrap', bootstrap)
      .addNode('planning', plan)
      .addNode('execute', execute)
      .addNode('reviewing', review)
      .addNode('finalize', finalize)
      .addEdge(START, 'bootstrap')
      .addEdge('bootstrap', 'planning')
      .addEdge('planning', 'execute')
      .addEdge('execute', 'reviewing')
      .addConditionalEdges(
        'reviewing',
        (state): 'execute' | 'finalize' => (state.phase === 'execute' ? 'execute' : 'finalize'),
        { execute: 'execute', finalize: 'finalize' },
      )
      .addEdge('finalize', END)
      .compile({ checkpointer });

    const result = await graph.invoke(
      {
        workspaceId: input.workspaceId,
        goal: input.goal,
        phase: 'bootstrap',
        plan: '',
        initialContext: '',
        execution: undefined,
        review: '',
        reviewPassed: false,
        cycle: 0,
        finalAnswer: '',
      },
      { configurable: { thread_id: input.threadId } },
    );

    if (!result.execution) {
      throw new Error('Durable coding graph completed without an execution result.');
    }
    if (!result.reviewPassed && (result.execution.completionState === 'GOAL_COMPLETE' || result.execution.completionState === 'VERIFICATION_COMPLETE') && /^\s*TASK_COMPLETE:/i.test(result.execution.answer)) {
      return {
        ...result.execution,
        answer: `TASK_BLOCKED: BLOCKED — independent review did not pass after the bounded correction cycle. ${result.review.slice(0, 1200)}`,
        stopReason: 'no-progress',
        completionState: 'BLOCKED',
      };
    }
    return result.execution;
  }
}
