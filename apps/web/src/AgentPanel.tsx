import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamAgent, type AgentActivityEvent, type AgentEvent, type ModelAlias, type Upload, type Workspace } from './api';
import { AttachmentBar } from './AttachmentBar';
import {
  agentConversationHistory,
  chooseAgentWorkspace,
  type AgentCapabilityStatus,
} from './agent-ui-state';
import { agentArtifactUrl, extractAgentArtifacts, type AgentArtifact } from './agent-artifacts';
import { LiveMonitor, activityMonitorLines } from './LiveMonitor';
import { useStickToBottom } from './use-stick-to-bottom';

interface AgentSession {
  id: string;
  title: string;
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
const AGENT_MODEL_KEY = 'dacai.agent.model.v1';
const IMAGE_GENERATION_INTENT =
  /(?:\b|you)(?:generate|create|make|produce|render|draw|paint|illustrate|design|edit|modify|update|transform)\b[\s\S]{0,160}\b(?:ai\s+)?(?:image|photo|picture|portrait|artwork)\b|\b(?:ai\s+)?(?:image|photo|picture|portrait|artwork)\b[\s\S]{0,160}\b(?:generate|create|make|produce|render|draw|paint|illustrate|design|edit|modify|update|transform)\b|\b(?:image|photo|picture|portrait|artwork)\s+of\b/;

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
  return IMAGE_GENERATION_INTENT.test(value.toLowerCase());
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
 * Agent mode. Unlike chat, this runs the tool loop: the model inspects the
 * workspace with real filesystem/git/test tools, every call passes the
 * permission engine, and each step is shown as it happens.
 */
export function AgentPanel({ aliases }: { aliases: ModelAlias[] }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => savedPreference(AGENT_WORKSPACE_KEY, ''));
  const [alias, setAlias] = useState(() => savedPreference(AGENT_MODEL_KEY, 'coder'));
  const [role, setRole] = useState<'coding' | 'adversarial-twin-simulator' | 'tomahawk1'>('coding');
  const [runMode, setRunMode] = useState<'interactive' | 'coding' | 'repository_audit' | 'deep_research'>('coding');
  const [prompt, setPrompt] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activityEvents, setActivityEvents] = useState<AgentActivityEvent[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([
    'filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'tests.run', 'system.network.info',
    'web.fetch', 'web.search',
  ]);
  const [toolSelectionCustomized, setToolSelectionCustomized] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showNew, setShowNew] = useState(false);
  /** Approval ids already answered, so the buttons disable after one click. */
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState({ displayName: '', rootPath: '', write: false, shell: false, network: true });
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, AgentCapabilityStatus>>({});
  const [checkingModel, setCheckingModel] = useState<string>();
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

  useEffect(() => {
    localStorage.setItem(AGENT_SESSIONS_KEY, JSON.stringify(sessions.slice(0, 30)));
  }, [sessions]);

  useEffect(() => {
    if (workspaceId) localStorage.setItem(AGENT_WORKSPACE_KEY, workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    if (alias) localStorage.setItem(AGENT_MODEL_KEY, alias);
  }, [alias]);

  useEffect(() => {
    setModelCapabilities((current) => Object.fromEntries(aliases.map((entry) => [
      entry.alias,
      current[entry.alias] ?? entry.agentCapability ?? 'unknown',
    ])));
  }, [aliases]);

  const refresh = useCallback(async () => {
    const { workspaces: list } = await api.listWorkspaces();
    setWorkspaces(list);
    setWorkspaceId((current) => chooseAgentWorkspace(list, current));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  const agentAliases = useMemo(
    () => aliases.filter((entry) => entry.enabled),
    [aliases],
  );
  const selectedModelCapability = modelCapabilities[alias]
    ?? aliases.find((entry) => entry.alias === alias)?.agentCapability
    ?? 'unknown';
  const selectedAliasConfigured = aliases.some((entry) => entry.alias === alias);
  const imageGenerationRequest = useMemo(
    () => isImageGenerationPrompt(prompt, attachments),
    [attachments, prompt],
  );

  useEffect(() => {
    if (!alias || !selectedAliasConfigured || selectedModelCapability === 'verified') return;
    if (selectedModelCapability === 'unsupported') {
      setError(`${alias} cannot run the general tool loop, but it remains selectable for direct image generation.`);
      return;
    }

    let cancelled = false;
    setCheckingModel(alias);
    api.capabilities(alias)
      .then((result) => {
        if (cancelled) return;
        const status: AgentCapabilityStatus = result.agentLoopCapable ? 'verified' : 'unsupported';
        setModelCapabilities((current) => ({ ...current, [alias]: status }));
        if (!result.agentLoopCapable) {
          setError(`${alias} cannot run the general tool loop, but it can still submit direct image requests.`);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not verify ${alias} for agent use: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setCheckingModel(undefined);
      });
    return () => { cancelled = true; };
  }, [alias, aliases, modelCapabilities, selectedAliasConfigured, selectedModelCapability]);

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

  const run = useCallback(async () => {
    // File content is no longer spliced into the prompt: the server reads the
    // stored upload and appends it, so the transcript keeps what was typed.
    const text = prompt.trim();
    const directImageRequest = isImageGenerationPrompt(text, attachments);
    if (!text || !workspaceId || running || (!directImageRequest && selectedModelCapability !== 'verified')) return;

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
        attachments: attachments.length ? attachments.map((upload) => upload.id) : undefined,
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
  }, [activityEvents, alias, appendActivity, attachments, events, prompt, role, runMode, running, selectedModelCapability, selectedTools, sessionId, toolSelectionCustomized, workspaceId]);

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

  const active = workspaces.find((w) => w.id === workspaceId);
  const availableTools = useMemo(() => {
    const names = ['filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'system.network.info'];
    if (active?.capabilities.write) names.push('filesystem.edit', 'filesystem.write');
    if (active?.capabilities.shell) names.push('tests.run', 'shell.run', 'engineering.capabilities.inspect');
    if (active?.capabilities.network) names.push('web.fetch', 'web.search', 'download.approved');
    if (active?.capabilities.write) names.push('image.generate');
    if (active?.capabilities.read && active?.capabilities.write && active?.capabilities.network) names.push('video.generate');
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

  const openSession = useCallback((session: AgentSession) => {
    if (running) return;
    setSessionId(session.id);
    setEvents(session.events);
    setActivityEvents(session.activityEvents ?? []);
    if (session.workspaceId) setWorkspaceId(session.workspaceId);
    if (session.alias) setAlias(session.alias);
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
        <button className="primary" onClick={newSession}>+ New agent conversation</button>
        <div className="agent-session-list">
          {sessions.length === 0 && <p className="muted small">No saved agent conversations.</p>}
          {sessions.map((session) => (
            <button key={session.id} className={`agent-session ${session.id === sessionId ? 'active' : ''}`} onClick={() => openSession(session)}>
              <strong>{session.title}</strong>
              <span>{new Date(session.updatedAt).toLocaleString()}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="agent-controls">
        <div className="field">
          <label htmlFor="agent-role">Role</label>
          <select id="agent-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="coding">Coding agent</option>
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
          <label htmlFor="agent-alias">Model</label>
          <select id="agent-alias" value={alias} onChange={(e) => setAlias(e.target.value)}>
            {agentAliases.map((entry) => (
              <option key={entry.alias} value={entry.alias}>
                {entry.alias} — {entry.model}{(modelCapabilities[entry.alias] ?? entry.agentCapability) === 'verified' ? '' : ' · verify on selection'}
              </option>
            ))}
          </select>
          <p className="muted small">
            {imageGenerationRequest
              ? 'Direct image generation does not depend on the selected text model’s tool channel.'
              : checkingModel === alias ? 'Verifying structured tool support…' : selectedModelCapability === 'verified'
              ? 'Verified for conversational coding and tool use.'
              : 'This model must pass tool verification before Run is enabled.'}
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
      </details>

      <div className="agent-workspace">
        <div className="agent-log" ref={logScroll.ref} onScroll={logScroll.onScroll}>
          {events.length === 0 && !running && (
            <div className="empty">
              <h2>Agent mode</h2>
              <p className="muted">
                The model inspects your workspace with real tools. Every call passes the permission
                engine first, and each step appears here as it happens.
              </p>
            </div>
          )}

          {events.map((event, index) => (
            <AgentStep key={index} event={event} workspaceId={workspaceId} answered={answered} onDecide={decide} onApproveAll={approveAll} />
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
              disabled={!prompt.trim() || !workspaceId || (!imageGenerationRequest && (selectedModelCapability !== 'verified' || Boolean(checkingModel)))}
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
}: {
  event: AgentEvent;
  workspaceId: string;
  answered: Record<string, boolean>;
  onDecide: (id: string, approved: boolean) => void;
  onApproveAll?: (runId: string) => void;
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

