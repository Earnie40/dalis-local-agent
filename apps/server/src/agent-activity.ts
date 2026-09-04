import { createId, getPool } from '@dacai-local-agent/shared';
import { redactDeep, sanitizeText } from '@dacai-local-agent/security';
import { stripHiddenReasoning } from '@dacai-local-agent/training-traces';

/**
 * Observable execution events for the agent activity UI. This intentionally
 * contains operational summaries only: it never carries hidden model reasoning
 * or raw prompts. Values are redacted at this boundary before persistence and
 * before they are sent over SSE.
 */
export type AgentActivityType =
  | 'planning'
  | 'reasoning_summary'
  | 'inspection'
  | 'search'
  | 'decision'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_result'
  | 'command'
  | 'file_read'
  | 'file_edit'
  | 'test'
  | 'verification'
  | 'warning'
  | 'error'
  | 'success'
  | 'next_step'
  | 'model'
  | 'system';

export type AgentActivityStatus = 'running' | 'success' | 'failed' | 'blocked' | 'info';

export interface AgentActivityEvent {
  id: string;
  workspaceId: string;
  sessionId?: string;
  runId: string;
  sequence: number;
  timestamp: string;
  type: AgentActivityType;
  status: AgentActivityStatus;
  title: string;
  message?: string;
  toolName?: string;
  command?: string;
  filePath?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export type ActivityInput = Omit<AgentActivityEvent, 'id' | 'workspaceId' | 'sessionId' | 'runId' | 'sequence' | 'timestamp'>;

export interface ActivityLoopEvent {
  type: string;
  turn: number;
  content?: string;
  message?: string;
  toolCall?: { name: string; arguments?: Record<string, unknown> };
  result?: { success?: boolean; denied?: boolean; output?: string; error?: string };
  budget?: { mode?: string; turns: number; maxTurns: number; toolCalls: number; maxToolCalls: number; reserveTurns?: number };
}

interface ActivityEmitterOptions {
  workspaceId: string;
  runId: string;
  sessionId?: string;
  onEvent?: (event: AgentActivityEvent) => void;
}

const MAX_MESSAGE_LENGTH = 1600;
const MAX_TERMINAL_OUTPUT_LENGTH = 12_000;
const TERMINAL_TOOLS = new Set(['shell.run', 'git.run', 'tests.run']);

function shortText(value: unknown, limit = MAX_MESSAGE_LENGTH): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = sanitizeText(value).replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function terminalText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const sanitized = sanitizeText(value).trimEnd();
  return sanitized.length > MAX_TERMINAL_OUTPUT_LENGTH
    ? `${sanitized.slice(0, MAX_TERMINAL_OUTPUT_LENGTH)}\n… output truncated for display`
    : sanitized;
}

function parsedToolOutput(output: string | undefined): Record<string, unknown> | undefined {
  if (!output?.trim()) return undefined;
  try {
    const value = JSON.parse(output) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function terminalResultMetadata(output: string | undefined, error: string | undefined): Record<string, unknown> {
  const parsed = parsedToolOutput(output);
  return {
    kind: 'terminal',
    phase: 'result',
    stdout: terminalText(parsed?.stdout),
    stderr: terminalText(parsed?.stderr ?? error ?? (!parsed ? output : undefined)),
    exitCode: typeof parsed?.exitCode === 'number' ? parsed.exitCode : undefined,
    timedOut: parsed?.timedOut === true || undefined,
    cancelled: parsed?.cancelled === true || undefined,
    truncated: parsed?.truncated === true || undefined,
  };
}

function stringArgument(arguments_: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = arguments_?.[key];
    if (typeof value === 'string' && value.trim()) return shortText(value, 500);
  }
  return undefined;
}

function classifyTool(name: string): AgentActivityType {
  if (name === 'filesystem.read' || name === 'filesystem.stat') return 'file_read';
  if (name === 'filesystem.edit' || name === 'filesystem.write' || name === 'filesystem.move' || name === 'filesystem.copy') return 'file_edit';
  if (name === 'image.generate' || name === 'video.generate') return 'file_edit';
  if (name === 'filesystem.list' || name === 'code.architecture.context') return 'inspection';
  if (name === 'filesystem.search' || name.startsWith('code.symbol.') || name === 'code.path.trace') return 'search';
  if (name === 'shell.run' || name === 'git.run') return 'command';
  if (name === 'tests.run') return 'test';
  if (name === 'code.diagnostics' || name.startsWith('quality.')) return 'verification';
  return 'tool_start';
}

function safeArguments(arguments_: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!arguments_) return undefined;
  return redactDeep(arguments_);
}

/**
 * A model may provide a short, user-visible explanation alongside a tool call.
 * Keep that useful English prose, but remove any reasoning-tag content before
 * it reaches the activity stream. This is a public work journal, never a dump
 * of private chain-of-thought.
 */
function visibleRationale(content: string | undefined): string | undefined {
  if (!content?.trim()) return undefined;
  const publicText = stripHiddenReasoning(content).content;
  return shortText(publicText, 900);
}

function toolIntent(toolName: string, filePath: string | undefined, command: string | undefined, args: Record<string, unknown> | undefined): { title: string; message: string } {
  const query = stringArgument(args, ['query', 'pattern', 'symbol', 'term', 'url']);
  if (toolName === 'filesystem.read' || toolName === 'filesystem.stat') {
    return { title: 'I’m inspecting a file', message: `I need concrete evidence from ${filePath ?? 'the selected file'} before I draw a conclusion.` };
  }
  if (toolName === 'filesystem.list') {
    return { title: 'I’m mapping the workspace', message: `I’m checking ${filePath ?? 'the workspace'} to find the relevant implementation surface.` };
  }
  if (toolName === 'filesystem.search' || toolName.startsWith('code.symbol.')) {
    return { title: 'I’m searching for evidence', message: query ? `I’m looking for “${query}” so the next decision is grounded in the repository.` : 'I’m locating the relevant symbols and references before choosing an edit.' };
  }
  if (toolName === 'filesystem.edit' || toolName === 'filesystem.write' || toolName === 'filesystem.move' || toolName === 'filesystem.copy') {
    return { title: 'I’m preparing a change', message: `I believe ${filePath ?? 'the selected file'} is the right place to change. Permission checks still guard the mutation.` };
  }
  if (toolName === 'image.generate') {
    return { title: 'I’m generating a raster image', message: `I’m using the configured image backend to create ${filePath ?? 'a workspace PNG'}. Permission checks still guard the generated file.` };
  }
  if (toolName === 'video.generate') {
    return { title: 'I’m generating a video', message: `I’m using the configured GPU media backend to create ${filePath ?? 'a workspace MP4'}. Permission checks still guard the generated file.` };
  }
  if (toolName === 'tests.run' || toolName === 'code.diagnostics' || toolName.startsWith('quality.')) {
    return { title: 'I’m verifying the work', message: command ? `I’m running ${command} to test the current evidence.` : 'I’m running a targeted verification step before treating the work as complete.' };
  }
  if (toolName === 'shell.run' || toolName === 'git.run') {
    return { title: 'I’m checking the environment', message: command ? `I’m running ${command} to answer the current question with observable output.` : 'I’m running a scoped command to gather the next piece of evidence.' };
  }
  if (toolName.startsWith('web.')) {
    return { title: 'I’m researching a public source', message: query ? `I’m checking “${query}” against a permitted public source.` : 'I’m gathering permitted public-web evidence for the task.' };
  }
  return { title: `I’m using ${toolName}`, message: 'I chose this action to gather evidence or make the next permitted change.' };
}

function toolOutcome(toolName: string, success: boolean, blocked: boolean, output: string | undefined): string {
  if (blocked) return `This action did not run because ${toolName} needs approval or is not permitted.`;
  if (!success) return `This action did not succeed. I will use the returned error as evidence for the next step.${output ? ` Tool output: ${output}` : ''}`;
  return `The action completed. I can now incorporate its observed result into the next decision.${output ? ` Tool output: ${output}` : ''}`;
}

export function activityForLoopEvent(event: ActivityLoopEvent): ActivityInput | undefined {
  const toolName = event.toolCall?.name;
  const args = event.toolCall?.arguments;
  const filePath = stringArgument(args, ['path', 'outputPath', 'filePath', 'source', 'destination', 'to', 'from']);
  const command = stringArgument(args, ['command', 'cmd', 'script']);

  if (event.type === 'model_request') {
    return { type: 'model', status: 'running', title: 'I’m weighing the latest evidence', message: `The agent is forming the next public action for turn ${event.turn} from the results gathered so far.` };
  }
  if (event.type === 'model_response') {
    const rationale = visibleRationale(event.content);
    return {
      type: 'reasoning_summary', status: 'info', title: rationale ? 'Agent’s stated rationale' : 'I have a next step',
      message: rationale ? `Visible explanation: ${rationale}` : `Turn ${event.turn} completed; I’m moving from the latest evidence to the next observable action.`,
    };
  }
  if (event.type === 'thinking') {
    return {
      type: 'reasoning_summary',
      status: 'info',
      title: 'Model reasoning preview',
      message: event.content ? `Qwen emitted this reasoning preview (not guaranteed to be complete or faithful):\n${event.content}` : event.message,
      metadata: { source: 'provider-emitted', label: 'not-hidden-internals' },
    };
  }
  if (event.type === 'tool_call' && toolName) {
    const type = classifyTool(toolName);
    const intent = toolIntent(toolName, filePath, command, args);
    return {
      type,
      status: 'running',
      title: intent.title,
      message: intent.message,
      toolName,
      filePath,
      command,
      metadata: safeArguments(args),
    };
  }
  if (event.type === 'tool_result' && toolName) {
    const blocked = event.result?.denied === true;
    const success = event.result?.success === true;
    const output = shortText(event.result?.error ?? event.result?.output, 900);
    const terminal = TERMINAL_TOOLS.has(toolName);
    return {
      type: terminal ? classifyTool(toolName) : 'tool_result',
      status: blocked ? 'blocked' : success ? 'success' : 'failed',
      title: blocked
        ? 'I need your approval to continue'
        : terminal
          ? success ? (toolName === 'tests.run' ? 'Tests completed' : 'Command completed') : (toolName === 'tests.run' ? 'Tests failed' : 'Command failed')
          : success ? 'I have new evidence' : 'I hit an obstacle',
      message: toolOutcome(toolName, success, blocked, output),
      toolName,
      filePath,
      command,
      metadata: terminal && !blocked
        ? terminalResultMetadata(event.result?.output, event.result?.error)
        : undefined,
    };
  }
  if (event.type === 'validation') {
    return { type: 'verification', status: event.result?.success ? 'success' : 'failed', title: 'Validation result', message: shortText(event.message), toolName };
  }
  if (event.type === 'context_refresh' || event.type === 'context_compaction') {
    return { type: 'system', status: 'info', title: 'Context updated', message: shortText(event.message) };
  }
  if (event.type === 'reasoning_mode') {
    return { type: 'decision', status: 'info', title: 'Execution approach updated', message: shortText(event.message) };
  }
  if (event.type === 'budget' && event.budget) {
    const remaining = event.budget.maxTurns - event.budget.turns;
    const reserveActive = (event.budget.reserveTurns ?? 0) > 0 && remaining < (event.budget.reserveTurns ?? 0);
    return {
      type: reserveActive ? 'warning' : 'system',
      status: reserveActive ? 'running' : 'info',
      title: reserveActive ? 'Budget reserve: synthesis and verification' : `Mode: ${event.budget.mode ?? 'interactive'}`,
      message: event.message,
      metadata: {
        mode: event.budget.mode,
        turn: `${event.budget.turns}/${event.budget.maxTurns}`,
        toolCalls: `${event.budget.toolCalls}/${event.budget.maxToolCalls}`,
        synthesisReserveTurns: event.budget.reserveTurns,
      },
    };
  }
  if (event.type === 'error') {
    return { type: 'error', status: 'failed', title: 'Agent error', message: shortText(event.message ?? event.content) };
  }
  return undefined;
}

function sanitizeActivity(event: AgentActivityEvent): AgentActivityEvent {
  return {
    ...event,
    title: shortText(event.title, 300) ?? 'Agent activity',
    message: shortText(event.message),
    toolName: shortText(event.toolName, 200),
    command: shortText(event.command, 700),
    filePath: shortText(event.filePath, 700),
    metadata: event.metadata ? redactDeep(event.metadata) : undefined,
  };
}

/** Serializes per-run writes so event ordering remains stable under concurrent tools. */
export class AgentActivityEmitter {
  private sequence = 0;
  private tail: Promise<void> = Promise.resolve();
  private sequenceLoaded = false;

  constructor(private readonly options: ActivityEmitterOptions) {}

  emit(input: ActivityInput): Promise<AgentActivityEvent> {
    let emitted: AgentActivityEvent | undefined;

    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (!this.sequenceLoaded) {
        try {
          const { rows } = await getPool().query<{ sequence: number | null }>(
            'SELECT max(sequence) AS sequence FROM agent_activity_events WHERE run_id = $1',
            [this.options.runId],
          );
          this.sequence = Number(rows[0]?.sequence ?? 0);
        } catch (error) {
          console.warn('Agent activity sequence lookup failed:', error instanceof Error ? error.message : String(error));
        }
        this.sequenceLoaded = true;
      }
      const event = sanitizeActivity({
        id: createId('activity'),
        workspaceId: this.options.workspaceId,
        sessionId: this.options.sessionId,
        runId: this.options.runId,
        sequence: ++this.sequence,
        timestamp: new Date().toISOString(),
        ...input,
      });
      try {
        await getPool().query(
          `INSERT INTO agent_activity_events
             (id, workspace_id, session_id, run_id, sequence, event_type, status, title, message, tool_name, command, file_path, duration_ms, metadata, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
          [event.id, event.workspaceId, event.sessionId ?? null, event.runId, event.sequence, event.type, event.status, event.title, event.message ?? null, event.toolName ?? null, event.command ?? null, event.filePath ?? null, event.durationMs ?? null, JSON.stringify(event.metadata ?? {}), event.timestamp],
        );
      } catch (error) {
        // Activity persistence must never interrupt a real tool execution. The
        // stream still receives the redacted event and the error is observable.
        console.warn('Agent activity persistence failed:', error instanceof Error ? error.message : String(error));
      }
      this.options.onEvent?.(event);
      emitted = event;
    });

    return this.tail.then(() => emitted!);
  }

  emitLoopEvent(event: ActivityLoopEvent): Promise<AgentActivityEvent | undefined> {
    const activity = activityForLoopEvent(event);
    return activity ? this.emit(activity) : Promise.resolve(undefined);
  }
}

export async function listAgentActivity(runId: string, afterSequence = 0): Promise<AgentActivityEvent[]> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT id, workspace_id, session_id, run_id, sequence, event_type, status, title, message,
            tool_name, command, file_path, duration_ms, metadata, created_at
       FROM agent_activity_events
      WHERE run_id = $1 AND sequence > $2
      ORDER BY sequence ASC, created_at ASC, id ASC`,
    [runId, afterSequence],
  );
  return rows.map((row) => sanitizeActivity({
    id: String(row.id), workspaceId: String(row.workspace_id), sessionId: row.session_id ? String(row.session_id) : undefined,
    runId: String(row.run_id), sequence: Number(row.sequence), timestamp: new Date(row.created_at as string).toISOString(),
    type: row.event_type as AgentActivityType, status: row.status as AgentActivityStatus, title: String(row.title),
    message: row.message ? String(row.message) : undefined, toolName: row.tool_name ? String(row.tool_name) : undefined,
    command: row.command ? String(row.command) : undefined, filePath: row.file_path ? String(row.file_path) : undefined,
    durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms), metadata: (row.metadata as Record<string, unknown>) ?? undefined,
  }));
}
