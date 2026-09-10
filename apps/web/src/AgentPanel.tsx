import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamAgent, type AgentActivityEvent, type AgentEvent, type AgentRun, type Upload, type Workspace } from './api';
import { AttachmentBar } from './AttachmentBar';
import {
  agentConversationHistory,
  chooseAgentWorkspace,
} from './agent-ui-state';
import { agentArtifactUrl, extractAgentArtifacts, type AgentArtifact } from './agent-artifacts';
import { LiveMonitor, activityMonitorLines } from './LiveMonitor';
import { useStickToBottom } from './use-stick-to-bottom';

interface AgentSession {
  id: string;
  title: string;
  /** Present when this entry came from server run history rather than this browser. */
  remote?: { status: AgentRun['status']; startedAt: string; eventCount?: number };
  events: AgentEvent[];
  activityEvents?: AgentActivityEvent[];
  runIds?: string[];
  workspaceId?: string;
  alias?: string;
  role?: 'coding' | 'adversarial-twin-simulator' | 'tomahawk1';
  runMode?: 'interactive' | 'coding' | 'repository_audit' | 'deep_research';
  updatedAt: string;
}

const AGENT_SESSIONS_KEY = 'dacai.agent.sessions.v1';
const AGENT_WORKSPACE_KEY = 'dacai.agent.workspace.v1';
const IMAGE_GENERATION_INTENT =
  /(?:\b|you)(?:generate|create|make|produce|render|draw|paint|illustrate|design|edit|modify|update|transform)\b[\s\S]{0,160}\b(?:ai\s+)?(?:image|photo|picture|portrait|artwork)\b|\b(?:ai\s+)?(?:image|photo|picture|portrait|artwork)\b[\s\S]{0,160}\b(?:generate|create|make|produce|render|draw|paint|illustrate|design|edit|modify|update|transform)\b|\b(?:image|photo|picture|portrait|artwork)\s+of\b/;
const DESCRIPTIVE_IMAGE_INTENT =
  /\b(?:woman|women|man|men|female|male|person|people|model|character|characters|fashion|outfit|portrait|face|body|figure|landscape|mountain|beach|ocean|cityscape|architecture|interior|still[- ]life|product|animal|dog|cat|bird|flower|sunset|night[- ]sky)\b/i;
const VISUAL_CREATION_VERB =
  /^\s*(?:(?:please|can you|could you|would you)\s+)?(?:generate|create|make|produce|render|draw|paint|illustrate|design)\b/i;
const VISUAL_STYLE_INTENT =
  /\b(?:photo[- ]?realistic|photorealism|cinematic|editorial|lifestyle\s+photograph|studio\s+(?:photo|portrait)|macro\s+photograph|watercolou?r|oil\s+painting|digital\s+art|concept\s+art|anime|manga|comic|pixel\s+art|3d\s+render|cgi|film\s+grain|shallow\s+depth\s+of\s+field)\b/i;
const NON_IMAGE_REQUEST_INTENT =
  /\b(?:code|coding|repository|repo|file|function|class|bug|error|test|typescript|javascript|python|api|endpoint|database|sql|regex|command|terminal|shell|explain|describe|analy[sz]e|inspect|identify|what|who|where|when|why|how)\b/i;

const EDITABLE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function hasEditableImage(uploads: readonly Upload[]): boolean {
  return uploads.some((upload) => EDITABLE_IMAGE_MIME_TYPES.includes(upload.mimeType.toLowerCase()));
}

/**
 * Mirrors the server's classification: an attached picture makes any
 * instruction an image request, even one that never says "image".
 */
function isImageGenerationPrompt(value: string, uploads: readonly Upload[] = []): boolean {
  if (hasEditableImage(uploads) && value.trim().length > 0) return true;
  const normalized = value.toLowerCase().trim();
  return IMAGE_GENERATION_INTENT.test(normalized)
    || (normalized.length > 2
      && DESCRIPTIVE_IMAGE_INTENT.test(normalized)
      && !NON_IMAGE_REQUEST_INTENT.test(normalized))
    || (normalized.length > 2
      && VISUAL_CREATION_VERB.test(normalized)
      && VISUAL_STYLE_INTENT.test(normalized)
      && !NON_IMAGE_REQUEST_INTENT.test(normalized));
}

function savedPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
const TOOL_LABELS: Record<string, string> = {
  'filesystem.list': 'List files',
  'filesystem.read': 'Read files',
  'filesystem.search': 'Search files',
  'filesystem.stat': 'File metadata',
  'filesystem.edit': 'Edit files',
  'filesystem.write': 'Write files',
  'git.run': 'Git inspection',
  'tests.run': 'Run tests/builds',
  'shell.run': 'Shell commands',
  'system.network.info': 'Network status',
  'web.fetch': 'Fetch public web page',
  'web.search': 'Search public web',
  'download.approved': 'Download approved file',
  'mcp.list': 'List MCP servers',
  'code.diagnostics': 'Run code diagnostics',
  'code.path.trace': 'Trace indexed code path',
  'engineering.capabilities.inspect': 'Inspect engineering backends',
  'engineering.artifact.inspect': 'Hash engineering artifacts',
  'cad.execute': 'Execute approved CAD source',
  'bim.execute': 'Execute approved BIM source',
  'scene.render': 'Render approved Blender scene',
  'image.generate': 'Generate photoreal raster image',
  'video.generate': 'Generate photoreal video',
  'video.faceSwap': 'Swap a face into a video',
  'workspace.open-file': 'Open file in VS Code',
  'terminal.open': 'Open PowerShell/CMD/WSL/Docker',
  'security.simulation.api-input': 'Synthetic API fuzzing',
  'security.simulation.prompt-injection': 'Synthetic prompt injection',
  'security.simulation.tenant-isolation': 'Synthetic tenant isolation',
  'security.simulation.network-boundary': 'Synthetic network boundary',
};

type ActivityFilter = 'all' | 'reasoning' | 'tools' | 'files' | 'commands' | 'tests' | 'warnings';

const ACTIVITY_FILTERS: Array<{ id: ActivityFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'reasoning', label: 'Reasoning' }, { id: 'tools', label: 'Tools' },
  { id: 'files', label: 'Files' }, { id: 'commands', label: 'Commands' }, { id: 'tests', label: 'Tests' }, { id: 'warnings', label: 'Warnings' },
];

function matchesActivityFilter(event: AgentActivityEvent, filter: ActivityFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'reasoning') return ['planning', 'reasoning_summary', 'decision', 'next_step', 'model'].includes(event.type);
  if (filter === 'tools') return ['tool_start', 'tool_progress', 'tool_result', 'search', 'inspection'].includes(event.type);
  if (filter === 'files') return ['file_read', 'file_edit'].includes(event.type);
  if (filter === 'commands') return event.type === 'command';
  if (filter === 'tests') return ['test', 'verification'].includes(event.type);
  return ['warning', 'error'].includes(event.type) || event.status === 'blocked' || event.status === 'failed';
}

/**
 * Agent mode. Unlike chat, this runs the tool loop. Ordinary/personal questions
 * use public-web tools. Coding requests inspect the workspace with filesystem,
 * git, and tests. Every call passes the permission engine, and each step is
 * shown as it happens.
 */
export function AgentPanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => savedPreference(AGENT_WORKSPACE_KEY, ''));
  const alias = 'agent';
  const [role, setRole] = useState<'coding' | 'adversarial-twin-simulator' | 'tomahawk1'>('coding');
  const [runMode, setRunMode] = useState<'interactive' | 'coding' | 'repository_audit' | 'deep_research'>('interactive');
  const [prompt, setPrompt] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activityEvents, setActivityEvents] = useState<AgentActivityEvent[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([
    'web.search', 'web.fetch', 'download.approved',
  ]);
  const [toolSelectionCustomized, setToolSelectionCustomized] = useState(false);
  // Deliberately not restored from a saved session: pre-approval has to be
  // chosen for the run in front of you, so a reload always returns to asking.
  const [preApprove, setPreApprove] = useState<'ask' | 'mutation' | 'selected'>('ask');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showNew, setShowNew] = useState(false);
  /** Approval ids already answered, so the buttons disable after one click. */
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState({ displayName: '', rootPath: '', write: false, shell: false, network: true });
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [followActivity, setFollowActivity] = useState(true);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const logScroll = useStickToBottom<HTMLDivElement>([events]);
  const activityRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(AGENT_SESSIONS_KEY) ?? '[]') as AgentSession[];
      if (Array.isArray(saved)) setSessions(saved);
    } catch {
      setSessions([]);
    }
  }, []);

  /*
   * Agent history used to live only in this browser's localStorage, so it died
   * with a cleared profile and never followed the operator to another machine —
   * while every run's activity sat in PostgreSQL, unreachable because nothing
   * could enumerate run ids. Merge the server's run list in as the durable
   * source, keeping any local session that already covers the same run.
   */
  useEffect(() => {
    let cancelled = false;

    api.listAgentRuns({ limit: 100 })
      .then(({ runs }) => {
        if (cancelled) return;
        setSessions((current) => {
          const covered = new Set(current.flatMap((session) => session.runIds ?? [session.id]));
          const additions = runs
            .filter((run) => !covered.has(run.id))
            .map<AgentSession>((run) => ({
              id: run.id,
              title: run.title,
              events: [],
              runIds: [run.id],
              workspaceId: run.workspaceId,
              alias: run.alias,
              role: run.role as AgentSession['role'],
              runMode: run.runMode as AgentSession['runMode'],
              updatedAt: run.endedAt ?? run.startedAt,
              remote: { status: run.status, startedAt: run.startedAt, eventCount: run.eventCount },
            }));

          if (additions.length === 0) return current;
          return [...current, ...additions].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          );
        });
      })
      // History enrichment must never break the panel: local sessions still work.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Only this browser's own transcripts belong in localStorage. Persisting the
    // server list too would let 100 remote rows evict real local work from the
    // 30-entry cap.
    const local = sessions.filter((session) => !session.remote);
    localStorage.setItem(AGENT_SESSIONS_KEY, JSON.stringify(local.slice(0, 30)));
  }, [sessions]);

  useEffect(() => {
    if (workspaceId) localStorage.setItem(AGENT_WORKSPACE_KEY, workspaceId);
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    const { workspaces: list } = await api.listWorkspaces();
    setWorkspaces(list);
    setWorkspaceId((current) => chooseAgentWorkspace(list, current));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  const imageGenerationRequest = useMemo(
    () => isImageGenerationPrompt(prompt, attachments),
    [attachments, prompt],
  );

  useEffect(() => {
    if (followActivity) activityRef.current?.scrollTo({ top: activityRef.current.scrollHeight, behavior: 'smooth' });
  }, [activityEvents, followActivity]);

  const appendActivity = useCallback((activeSessionId: string, event: AgentActivityEvent) => {
    setActivityEvents((current) => {
      if (current.some((item) => item.id === event.id)) return current;
      const next = [...current, event].sort((left, right) => left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp));
      setSessions((saved) => saved.map((item) => item.id === activeSessionId
        ? { ...item, activityEvents: next, runIds: [...new Set([...(item.runIds ?? []), event.runId])], updatedAt: new Date().toISOString() }
        : item));
      return next;
    });
  }, []);

  const active = workspaces.find((w) => w.id === workspaceId);
  const availableTools = useMemo(() => {
    const names: string[] = [];
    if (active?.capabilities.network) names.push('web.search', 'web.fetch', 'download.approved');
    names.push('filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'system.network.info');
    if (active?.capabilities.write) names.push('filesystem.edit', 'filesystem.write');
    if (active?.capabilities.shell) names.push('tests.run', 'shell.run', 'engineering.capabilities.inspect');
    if (active?.capabilities.write) names.push('image.generate');
    if (active?.capabilities.read && active?.capabilities.write) names.push('video.generate');
    names.push('mcp.list', 'engineering.artifact.inspect');
    if (active?.capabilities.shell) names.push('code.diagnostics', 'workspace.open-file', 'terminal.open');
    if (active?.capabilities.write && active?.capabilities.shell) names.push(
      'cad.execute', 'bim.execute', 'scene.render',
    );
    names.push(
      'code.symbol.search',
      'code.symbol.references',
      'code.symbol.callers',
      'code.symbol.callees',
      'code.symbol.impact',
      'code.path.trace',
      'code.architecture.context',
      'code.failure.recall',
      'code.working-state.get',
      'code.validation.status',
      'code.review.prepare',
      'code.review.record',
    );
    if (role === 'adversarial-twin-simulator') names.push(
      'security.simulation.api-input',
      'security.simulation.prompt-injection',
      'security.simulation.tenant-isolation',
      'security.simulation.network-boundary',
    );
    return names;
  }, [active, role]);

  const run = useCallback(async () => {
    // File content is no longer spliced into the prompt: the server reads the
    // stored upload and appends it, so the transcript keeps what was typed.
    const text = prompt.trim();
    if (!text || !workspaceId || running) return;

    setError(undefined);
    setPrompt('');
    const activeSessionId = sessionId ?? `agent_${Date.now()}`;
    const userEvent: AgentEvent = { type: 'user_prompt', content: text };
    setSessionId(activeSessionId);
    setEvents((current) => [...current, userEvent]);
    setSessions((current) => {
      const existing = current.find((item) => item.id === activeSessionId);
      const nextEvents = [...(existing?.events ?? events), userEvent];
      const next = {
        id: activeSessionId,
        title: existing?.title ?? text.slice(0, 70),
        events: nextEvents,
        activityEvents: existing?.activityEvents ?? activityEvents,
        runIds: existing?.runIds ?? [],
        workspaceId,
        alias,
        role,
        runMode,
        updatedAt: new Date().toISOString(),
      };
      return [next, ...current.filter((item) => item.id !== activeSessionId)];
    });
    setAnswered({});
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAgent({
        prompt: text,
        workspaceId,
        alias,
        role,
        tools: toolSelectionCustomized ? selectedTools : undefined,
        sessionId: activeSessionId,
        history: agentConversationHistory(events),
        runMode,
        // The grant always names the tools it covers. With a custom selection
        // that is the chosen list; on automatic selection it is the set this
        // workspace's capabilities already allow, which is what the run can
        // reach anyway. Either way it is an explicit list, scoped to this run.
        autoApprove:
          preApprove === 'ask'
            ? undefined
            : (() => {
                const tools = toolSelectionCustomized ? selectedTools : availableTools;
                if (!tools.length) return undefined;
                return {
                  tools,
                  tiers: preApprove === 'mutation' ? ['mutation'] : undefined,
                };
              })(),
        attachments: attachments.length
          ? attachments.map((upload) => ({
              id: upload.id,
              role: upload.role,
              targetFaceIndex: upload.targetFaceIndex,
              swapTargetId: upload.swapTargetId,
            }))
          : undefined,
      }, (event) => {
        if (event.type === 'activity' && event.activity) {
          appendActivity(activeSessionId, event.activity);
          return;
        }
        if (event.type === 'approval_resolved' && event.id) {
          setAnswered((current) => ({ ...current, [event.id!]: event.approved === true }));
        }
        setEvents((current) => {
          const next = [...current, event];
          setSessions((saved) => saved.map((item) => item.id === activeSessionId
            ? { ...item, events: next, runIds: event.runId ? [...new Set([...(item.runIds ?? []), event.runId])] : item.runIds, updatedAt: new Date().toISOString() }
            : item));
          return next;
        });
      }, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = undefined;
      setRunning(false);
      setAttachments([]);
    }
  }, [activityEvents, alias, appendActivity, attachments, availableTools, events, preApprove, prompt, role, runMode, running, selectedTools, sessionId, toolSelectionCustomized, workspaceId]);

  const addWorkspace = useCallback(async () => {
    try {
      await api.createWorkspace({
        displayName: draft.displayName || draft.rootPath,
        rootPath: draft.rootPath,
        write: draft.write,
        shell: draft.shell,
        network: draft.network,
      });
      setShowNew(false);
      setDraft({ displayName: '', rootPath: '', write: false, shell: false, network: true });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draft, refresh]);

  const decide = useCallback(async (id: string, approved: boolean) => {
    // Recorded before the request so a double-click cannot send two answers.
    setAnswered((current) => ({ ...current, [id]: approved }));
    try {
      const result = await api.approve(id, approved);
      setAnswered((current) => ({ ...current, [id]: result.approved }));
    } catch (e) {
      setAnswered((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const approveAll = useCallback(async (runId: string) => {
    setAnswered((current) => ({
      ...current,
      ...Object.fromEntries(events.filter((event) => event.type === 'approval_request' && event.runId === runId && event.id).map((event) => [event.id, true])),
    }));
    try {
      await api.approveAll(runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [events]);

  /**
   * Stop asking about one tool for the rest of this run, and settle the request
   * that prompted it. Narrower than approveAll — every other tool keeps its
   * gate — and it dies with the run like any other grant.
   */
  const allowToolForRun = useCallback(async (runId: string, tool: string, approvalId: string) => {
    setAnswered((current) => ({ ...current, [approvalId]: true }));
    try {
      // Grant first: if the grant fails, the single approval below still lets
      // this call through rather than stranding the run on a failed request.
      await api.grantTools(runId, { tools: [tool] });
      const result = await api.approve(approvalId, true);
      setAnswered((current) => ({ ...current, [approvalId]: result.approved }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    setSelectedTools((current) => current.filter((tool) => availableTools.includes(tool)));
  }, [availableTools]);

  const newSession = useCallback(() => {
    if (running) return;
    setSessionId(undefined);
    setEvents([]);
    setActivityEvents([]);
    setPrompt('');
    setAttachments([]);
    setError(undefined);
  }, [running]);

  const deleteSession = useCallback((id: string) => {
    if (running) return;
    const removed = sessions.find((session) => session.id === id);
    setSessions((current) => current.filter((session) => session.id !== id));

    /*
     * Drop the server-side history too, or the next history refresh re-adds
     * the row the operator just deleted. Best-effort: a purely local session
     * has no server row, and a failed delete must not block the UI.
     */
    for (const runId of removed?.runIds ?? []) {
      void api.deleteAgentRun(runId).catch(() => undefined);
    }

    if (sessionId === id) {
      setSessionId(undefined);
      setEvents([]);
      setActivityEvents([]);
      setPrompt('');
      setAttachments([]);
      setError(undefined);
    }
  }, [running, sessionId, sessions]);

  const openSession = useCallback((session: AgentSession) => {
    if (running) return;
    setSessionId(session.id);
    setEvents(session.events);
    setActivityEvents(session.activityEvents ?? []);
    if (session.workspaceId) setWorkspaceId(session.workspaceId);
    if (session.role) setRole(session.role);
    if (session.runMode) setRunMode(session.runMode);
    setPrompt('');
    setAttachments([]);
    // Server persistence is the source of truth for completed/reconnected runs.
    void Promise.all((session.runIds ?? []).map((runId) => api.agentActivity(runId)))
      .then((results) => results.flatMap((result) => result.events))
      .then((replayed) => replayed.forEach((event) => appendActivity(session.id, event)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [appendActivity, running]);

  const done = events.find((e) => e.type === 'done');
  const filteredActivity = useMemo(
    () => activityEvents.filter((event) => matchesActivityFilter(event, activityFilter)),
    [activityEvents, activityFilter],
  );
  const activityRuns = useMemo(() => {
    const groups = new Map<string, AgentActivityEvent[]>();
    for (const event of filteredActivity) groups.set(event.runId, [...(groups.get(event.runId) ?? []), event]);
    return [...groups.entries()].reverse();
  }, [filteredActivity]);
  const latestActivity = activityEvents.at(-1);
  const activityStatus = latestActivity?.status === 'failed' || latestActivity?.status === 'blocked'
    ? 'error'
    : running || latestActivity?.status === 'running' ? 'active' : 'idle';
  const activityLabel = latestActivity?.status === 'blocked' ? 'Waiting for approval'
    : latestActivity?.status === 'failed' ? 'Needs attention'
    : running ? 'Live' : latestActivity?.status === 'success' ? 'Complete' : 'Ready';

  return (
    <div className="agent">
      <aside className="agent-sessions">
        <button type="button" className="primary" onClick={newSession}>+ New agent conversation</button>
        <div className="agent-session-list">
          {sessions.length === 0 && <p className="muted small">No agent runs yet.</p>}
          {sessions.map((session) => (
            <div key={session.id} className={`agent-session ${session.id === sessionId ? 'active' : ''}`}>
              <button type="button" className="agent-session-open" onClick={() => openSession(session)}>
                <strong>{session.title}</strong>
                <span>
                  {new Date(session.updatedAt).toLocaleString()}
                  {session.remote && (
                    <>
                      {' · '}
                      <em className={`agent-session-status ${session.remote.status}`}>{session.remote.status}</em>
                      {session.remote.eventCount ? ` · ${session.remote.eventCount} events` : ''}
                    </>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="agent-session-delete"
                aria-label={`Delete conversation ${session.title}`}
                title="Delete conversation"
                onClick={() => deleteSession(session.id)}
                disabled={running}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
      <div className="agent-controls">
        <div className="field">
          <label htmlFor="agent-role">Role</label>
          <select id="agent-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="coding">DACAIS agent</option>
            <option value="adversarial-twin-simulator">Adversarial Twin Simulator</option>
            <option value="tomahawk1">Tomahawk1 defensive analyst</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="ws">Workspace</label>
          <select id="ws" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.length === 0 && <option value="">No workspace registered</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.displayName} — {w.rootPath}
              </option>
            ))}
          </select>
          {active && (
            <p className="muted small">
              {/* Capabilities are what the permission engine actually enforces. */}
              read{active.capabilities.write ? ' · write' : ''}
              {active.capabilities.shell ? ' · shell' : ''}
              {active.capabilities.network ? ' · network' : ''}
              {active.gitDetected ? ' · git' : ''}
              {active.detectedLanguages.length ? ` · ${active.detectedLanguages.join(', ')}` : ''}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="agent-alias">Agent</label>
          <div className="agent-identity" id="agent-alias">
            <strong>DACAIS Agent</strong>
            <span>Personal LLM, coding, vision, media, and tools</span>
          </div>
          <p className="muted small">
            {imageGenerationRequest
              ? 'The agent will use vision understanding and the configured media backend automatically.'
              : 'The backend selects the best available model and falls back locally when needed.'}
          </p>
        </div>

        <button onClick={() => setShowNew((v) => !v)}>{showNew ? 'Cancel' : '+ Workspace'}</button>
      </div>

      {showNew && (
        <div className="workspace-form">
          <input
            placeholder="Folder path, e.g. C:\\Users\\Kyleh\\DacaiLocalAgent"
            value={draft.rootPath}
            onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })}
          />
          <input
            placeholder="Display name (optional)"
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={draft.write}
              onChange={(e) => setDraft({ ...draft, write: e.target.checked })}
            />
            Allow file writes
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.shell}
              onChange={(e) => setDraft({ ...draft, shell: e.target.checked })}
            />
            Allow shell and tests
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.network}
              onChange={(e) => setDraft({ ...draft, network: e.target.checked })}
            />
            Allow public web access
          </label>
          <button className="primary" onClick={() => void addWorkspace()}>
            Register
          </button>
        </div>
      )}

      <details className="tool-menu">
        <summary>Tools for this run <span>{toolSelectionCustomized ? `${selectedTools.length} selected` : 'automatic'}</span></summary>
        <div className="tool-menu-options" role="group" aria-label="Tools for this run">
          {availableTools.map((tool) => (
            <button
              key={tool}
              type="button"
              className={selectedTools.includes(tool) ? 'selected' : ''}
              aria-pressed={selectedTools.includes(tool)}
              onClick={() => {
                setToolSelectionCustomized(true);
                setSelectedTools((current) => current.includes(tool) ? current.filter((item) => item !== tool) : [...current, tool]);
              }}
            >
              {TOOL_LABELS[tool] ?? tool}
            </button>
          ))}
          {toolSelectionCustomized && (
            <button type="button" onClick={() => setToolSelectionCustomized(false)}>
              Use automatic selection
            </button>
          )}
        </div>

        <div className="field">
          <label htmlFor="agent-run-mode">Execution mode</label>
          <select id="agent-run-mode" value={runMode} onChange={(e) => setRunMode(e.target.value as typeof runMode)}>
            <option value="interactive">Interactive · 16 turns</option>
            <option value="coding">Coding · 40 turns</option>
            <option value="repository_audit">Repository audit · 80 turns</option>
            <option value="deep_research">Deep research · 100 turns</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="agent-pre-approve">Approvals</label>
          <select
            id="agent-pre-approve"
            value={preApprove}
            onChange={(e) => setPreApprove(e.target.value as typeof preApprove)}
          >
            <option value="ask">Ask before every tool call</option>
            <option value="mutation">Run without asking · mutations only</option>
            <option value="selected">Run without asking · all tiers</option>
          </select>
          <small className="muted">
            {preApprove === 'ask'
              ? 'Every tool call waits for a click.'
              : `${(toolSelectionCustomized ? selectedTools : availableTools).length} tool${(toolSelectionCustomized ? selectedTools : availableTools).length === 1 ? '' : 's'} ${toolSelectionCustomized ? 'you selected' : 'this workspace allows'} run without asking${preApprove === 'mutation' ? ', for mutations only — high-impact calls still ask' : ''}. This run only; a new run asks again.`}
          </small>
        </div>
      </details>

      <div className="agent-workspace">
        <div className="agent-log" ref={logScroll.ref} onScroll={logScroll.onScroll}>
          {events.length === 0 && !running && (
            <div className="empty">
              <h2>Agent mode</h2>
              <p className="muted">
                DACAIS is your local personal LLM for you and people you personally allow on a
                local machine. Ordinary questions and public research use web tools. Coding
                requests inspect this workspace. Every call passes the permission engine first,
                and each step appears here as it happens.
              </p>
            </div>
          )}

          {events.map((event, index) => (
            <AgentStep key={index} event={event} workspaceId={workspaceId} answered={answered} onDecide={decide} onApproveAll={approveAll} onAllowTool={allowToolForRun} />
          ))}
        </div>

        <aside
          className="agent-activity"
          ref={activityRef}
          aria-live="polite"
          aria-label="Agent activity"
          onScroll={(event) => {
            const target = event.currentTarget;
            setFollowActivity(target.scrollHeight - target.scrollTop - target.clientHeight < 36);
          }}
        >
          <div className="agent-activity-header">
            <h2>Agent activity</h2>
            <span className={`activity-status ${activityStatus}`}>{activityLabel}</span>
          </div>
          <p className="muted small">Live execution journal — plans, stated rationale, arguments, actions, tool inputs, evidence, and results stream here as they happen.</p>

          <div className="activity-filters" role="group" aria-label="Filter agent activity">
            {ACTIVITY_FILTERS.map((filter) => (
              <button key={filter.id} type="button" className={activityFilter === filter.id ? 'selected' : ''} onClick={() => setActivityFilter(filter.id)}>
                {filter.label}
              </button>
            ))}
          </div>

          {!followActivity && (
            <button className="activity-jump" type="button" onClick={() => {
              setFollowActivity(true);
              activityRef.current?.scrollTo({ top: activityRef.current.scrollHeight, behavior: 'smooth' });
            }}>
              Jump to latest
            </button>
          )}

          <section className="activity-runs">
            {activityRuns.length === 0 ? (
              <p className="muted small">The activity timeline will appear when a run starts. Reopening a saved conversation replays persisted events.</p>
            ) : activityRuns.map(([runId, runEvents]) => (
              <div className="activity-run" key={runId}>
                <h3>{runId === latestActivity?.runId ? 'Current run' : 'Earlier run'} <span title={runId}>{runId.slice(0, 12)}</span></h3>
                {runEvents.map((event) => <ActivityCard key={event.id} event={event} />)}
              </div>
            ))}
          </section>
        </aside>
      </div>

      {error && <div className="error">{error}</div>}

      {done && (
        <div className="agent-summary">
          <strong>{done.stopReason}</strong> · {done.turns} turns · {done.toolCalls} tool calls ·{' '}
          {Math.round((done.durationMs ?? 0) / 100) / 10}s
        </div>
      )}

      <LiveMonitor
        active={running}
        title="DACAIS · Agent monitor"
        lines={activityMonitorLines(activityEvents)}
        onStop={() => abortRef.current?.abort()}
      />

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <textarea
          rows={3}
          value={prompt}
          placeholder="Give the agent a task, e.g. 'What does the permission engine do? Cite the file and lines.'"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.altKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <AttachmentBar
          workspaceId={workspaceId}
          uploads={attachments}
          onChange={setAttachments}
          disabled={running}
          mediaRoles
        />
        <div className="actions">
          {running ? (
            <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={!prompt.trim() || !workspaceId}
            >
              Run
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function ActivityCard({ event }: { event: AgentActivityEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const details = event.message || event.toolName || event.command || event.filePath || event.metadata;
  const terminal = event.metadata?.kind === 'terminal' ? event.metadata : undefined;
  const terminalStdout = typeof terminal?.stdout === 'string' ? terminal.stdout : '';
  const terminalStderr = typeof terminal?.stderr === 'string' ? terminal.stderr : '';
  const terminalExitCode = typeof terminal?.exitCode === 'number' ? terminal.exitCode : undefined;
  const isTerminalActivity = event.type === 'command' || event.type === 'test';
  return (
    <details className={`activity-card ${event.status}`} open={isTerminalActivity || event.status === 'running' || event.status === 'failed' || event.status === 'blocked'}>
      <summary>
        <span className="activity-card-title">{event.title}</span>
        <time dateTime={event.timestamp}>{time}</time>
      </summary>
      {details && (
        <div className="activity-card-detail">
          {event.message && <p>{event.message}</p>}
          {event.toolName && <p><strong>Tool</strong> <code>{event.toolName}</code></p>}
          {event.filePath && <p><strong>File</strong> <code>{event.filePath}</code></p>}
          {isTerminalActivity && event.command && (
            <div className="terminal-transcript">
              <div className="terminal-title"><span>Terminal</span>{terminalExitCode !== undefined && <span>exit {terminalExitCode}</span>}</div>
              <pre><span className="terminal-prompt">$ </span>{event.command}{terminalStdout && `\n${terminalStdout}`}{terminalStderr && `\n${terminalStderr}`}</pre>
            </div>
          )}
          {!isTerminalActivity && event.command && <pre>{event.command}</pre>}
          {event.durationMs !== undefined && <p className="muted small">{Math.round(event.durationMs / 10) / 100}s</p>}
          {event.metadata && !terminal && Object.keys(event.metadata).length > 0 && <pre>{JSON.stringify(event.metadata, null, 2)}</pre>}
        </div>
      )}
    </details>
  );
}

function AgentStep({
  event,
  workspaceId,
  answered,
  onDecide,
  onApproveAll,
  onAllowTool,
}: {
  event: AgentEvent;
  workspaceId: string;
  answered: Record<string, boolean>;
  onDecide: (id: string, approved: boolean) => void;
  onApproveAll?: (runId: string) => void;
  onAllowTool?: (runId: string, tool: string, approvalId: string) => void;
}) {
  // The run is paused here: nothing executes until this is answered, and it
  // denies itself on timeout or if the page is closed.
  if (event.type === 'approval_request' && event.id) {
    const decision = answered[event.id];
    return (
      <div className="step approval">
        <header>approval required · {event.tier}</header>
        <p className="muted small">{event.reason}</p>
        <code>
          {event.tool}({JSON.stringify(event.input ?? {})})
        </code>
        {decision === undefined ? (
          <div className="approval-actions">
            <button className="primary" onClick={() => onDecide(event.id!, true)}>
              Approve once
            </button>
            {event.runId && event.tool && (
              <button
                className="primary"
                title={`${event.tool} stops asking for the rest of this run. Every other tool still asks.`}
                onClick={() => onAllowTool?.(event.runId!, event.tool!, event.id!)}
              >
                Always allow {event.tool} this run
              </button>
            )}
            {event.runId && (
              <button className="primary" onClick={() => onApproveAll?.(event.runId!)}>
                Approve all for this run
              </button>
            )}
            <button className="danger" onClick={() => onDecide(event.id!, false)}>
              Deny
            </button>
          </div>
        ) : (
          <p className={`badge ${decision ? 'ok' : 'warn'}`}>{decision ? 'approved' : 'denied'}</p>
        )}
      </div>
    );
  }

  if (event.type === 'user_prompt') {
    return (
      <div className="step user-prompt">
        <header>you</header>
        <p>{event.content}</p>
      </div>
    );
  }

  if (event.type === 'approval_resolved') return null;

  if (event.type === 'start') {
    return (
      <div className="step meta">
        <span className="badge ok">{event.role ?? 'coding'}</span> <span className="badge">{event.model}</span> in <strong>{event.workspace}</strong> ·{' '}
        {event.tools?.length ?? 0} tools available
      </div>
    );
  }

  if (event.type === 'model_response') {
    if (!event.content?.trim()) return null;
    return (
      <div className="step model">
        <header>turn {event.turn}</header>
        <Markdown remarkPlugins={[remarkGfm]}>{event.content}</Markdown>
      </div>
    );
  }

  if (event.type === 'tool_call') {
    return (
      <div className="step call">
        <code>
          {event.tool}({JSON.stringify(event.arguments ?? {})})
        </code>
      </div>
    );
  }

  if (event.type === 'permission') {
    // Denials are the interesting ones; allowed calls stay quiet.
    if (event.decision === 'allowed') return null;
    return (
      <div className="step denied">
        <span className="badge warn">{event.decision}</span> {event.tool} ({event.tier}) — {event.reason}
      </div>
    );
  }

  if (event.type === 'tool_result') {
    const artifacts = extractAgentArtifacts(event);
    return (
      <div className={`step result ${event.success ? '' : 'failed'}`}>
        <header>{event.denied ? 'denied' : event.success ? 'result' : 'error'}</header>
        <pre>{(event.output ?? '').slice(0, 1200)}</pre>
        {artifacts.map((artifact) => (
          <AgentArtifactPreview key={artifact.path} artifact={artifact} workspaceId={workspaceId} />
        ))}
      </div>
    );
  }

  if (event.type === 'done') {
    return (
      <div className="step answer">
        <header>answer</header>
        <Markdown remarkPlugins={[remarkGfm]}>{event.answer || '_(no answer)_'}</Markdown>
      </div>
    );
  }

  if (event.type === 'error') {
    return <div className="error">{event.message}</div>;
  }

  return null;
}

function AgentArtifactPreview({ artifact, workspaceId }: { artifact: AgentArtifact; workspaceId: string }) {
  const url = agentArtifactUrl(workspaceId, artifact.path);
  const name = artifact.path.split('/').at(-1) ?? artifact.path;

  if (artifact.kind === 'sandbox') {
    return (
      <details className="agent-artifact sandbox-preview">
        <summary>Open sandbox · {name}</summary>
        <iframe
          sandbox="allow-scripts"
          src={url}
          title={`Sandbox preview of ${name}`}
        />
      </details>
    );
  }

  if (artifact.kind === 'video') {
    return (
      <figure className="agent-artifact video-preview">
        <video src={url} controls preload="metadata" />
        <figcaption>{artifact.path}</figcaption>
      </figure>
    );
  }

  return (
    <figure className="agent-artifact image-preview">
      <a href={url} target="_blank" rel="noreferrer" title={`Open ${name}`}>
        <img src={url} alt={`Generated artifact ${name}`} loading="lazy" />
      </a>
      <figcaption>{artifact.path}</figcaption>
    </figure>
  );
}
