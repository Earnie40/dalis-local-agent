import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, streamAgent, type AgentEvent, type ModelAlias, type Workspace } from './api';

interface AgentSession {
  id: string;
  title: string;
  events: AgentEvent[];
  updatedAt: string;
}

const AGENT_SESSIONS_KEY = 'dacai.agent.sessions.v1';
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
  'workspace.open-file': 'Open file in VS Code',
  'terminal.open': 'Open PowerShell/CMD/WSL/Docker',
  'security.simulation.api-input': 'Synthetic API fuzzing',
  'security.simulation.prompt-injection': 'Synthetic prompt injection',
  'security.simulation.tenant-isolation': 'Synthetic tenant isolation',
  'security.simulation.network-boundary': 'Synthetic network boundary',
};

/**
 * Agent mode. Unlike chat, this runs the tool loop: the model inspects the
 * workspace with real filesystem/git/test tools, every call passes the
 * permission engine, and each step is shown as it happens.
 */
export function AgentPanel({ aliases }: { aliases: ModelAlias[] }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [alias, setAlias] = useState('coder');
  const [role, setRole] = useState<'coding' | 'adversarial-twin-simulator' | 'tomahawk1'>('coding');
  const [prompt, setPrompt] = useState('');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [attachment, setAttachment] = useState<{ name: string; content: string }>();
  const [selectedTools, setSelectedTools] = useState<string[]>([
    'filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'tests.run', 'system.network.info',
  ]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showNew, setShowNew] = useState(false);
  /** Approval ids already answered, so the buttons disable after one click. */
  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState({ displayName: '', rootPath: '', write: false, shell: false });

  const abortRef = useRef<AbortController | undefined>(undefined);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const refresh = useCallback(async () => {
    const { workspaces: list } = await api.listWorkspaces();
    setWorkspaces(list);
    setWorkspaceId((current) => current || list[0]?.id || '');
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  const run = useCallback(async () => {
    const text = `${prompt.trim()}${attachment ? `\n\nAttached file (${attachment.name}):\n${attachment.content}` : ''}`.trim();
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
      const next = { id: activeSessionId, title: existing?.title ?? text.slice(0, 70), events: nextEvents, updatedAt: new Date().toISOString() };
      return [next, ...current.filter((item) => item.id !== activeSessionId)];
    });
    setAnswered({});
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamAgent({ prompt: text, workspaceId, alias, role, tools: selectedTools }, (event) => {
        setEvents((current) => {
          const next = [...current, event];
          setSessions((saved) => saved.map((item) => item.id === activeSessionId ? { ...item, events: next, updatedAt: new Date().toISOString() } : item));
          return next;
        });
      }, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = undefined;
      setRunning(false);
    }
  }, [alias, attachment, events, prompt, role, running, selectedTools, sessionId, workspaceId]);

  const addWorkspace = useCallback(async () => {
    try {
      await api.createWorkspace({
        displayName: draft.displayName || draft.rootPath,
        rootPath: draft.rootPath,
        write: draft.write,
        shell: draft.shell,
      });
      setShowNew(false);
      setDraft({ displayName: '', rootPath: '', write: false, shell: false });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draft, refresh]);

  const decide = useCallback(async (id: string, approved: boolean) => {
    // Recorded before the request so a double-click cannot send two answers.
    setAnswered((current) => ({ ...current, [id]: approved }));
    try {
      await api.approve(id, approved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const active = workspaces.find((w) => w.id === workspaceId);
  const availableTools = useMemo(() => {
    const names = ['filesystem.list', 'filesystem.read', 'filesystem.search', 'filesystem.stat', 'git.run', 'system.network.info'];
    if (active?.capabilities.write) names.push('filesystem.edit', 'filesystem.write');
    if (active?.capabilities.shell) names.push('tests.run', 'shell.run');
    if (active?.capabilities.network) names.push('web.fetch', 'web.search', 'download.approved');
    names.push('mcp.list');
    if (active?.capabilities.shell) names.push('code.diagnostics', 'workspace.open-file', 'terminal.open');
    names.push(
      'code.symbol.search',
      'code.symbol.references',
      'code.symbol.callers',
      'code.symbol.callees',
      'code.symbol.impact',
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
    setPrompt('');
    setAttachment(undefined);
    setError(undefined);
  }, [running]);

  const openSession = useCallback((session: AgentSession) => {
    if (running) return;
    setSessionId(session.id);
    setEvents(session.events);
    setPrompt('');
    setAttachment(undefined);
  }, [running]);

  const readAttachment = useCallback((file: File) => {
    if (file.size > 1_000_000) {
      setError('Attachments are limited to 1 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAttachment({ name: file.name, content: String(reader.result ?? '') });
    reader.onerror = () => setError(`Could not read ${file.name}.`);
    reader.readAsText(file);
  }, []);

  const done = events.find((e) => e.type === 'done');

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
              {active.gitDetected ? ' · git' : ''}
              {active.detectedLanguages.length ? ` · ${active.detectedLanguages.join(', ')}` : ''}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="agent-alias">Model</label>
          <select id="agent-alias" value={alias} onChange={(e) => setAlias(e.target.value)}>
            {aliases.map((entry) => (
              <option key={entry.alias} value={entry.alias}>
                {entry.alias} — {entry.model}
              </option>
            ))}
          </select>
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
          <button className="primary" onClick={() => void addWorkspace()}>
            Register
          </button>
        </div>
      )}

      <details className="tool-picker" open>
        <summary>Tools for this run ({selectedTools.length})</summary>
        <div className="tool-options">
          {availableTools.map((tool) => (
            <label key={tool} className="check">
              <input
                type="checkbox"
                checked={selectedTools.includes(tool)}
                onChange={(e) => setSelectedTools((current) => e.target.checked ? [...current, tool] : current.filter((item) => item !== tool))}
              />
              {TOOL_LABELS[tool] ?? tool}
            </label>
          ))}
        </div>
      </details>

      <div className="agent-log" ref={logRef}>
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
          <AgentStep key={index} event={event} answered={answered} onDecide={decide} />
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {done && (
        <div className="agent-summary">
          <strong>{done.stopReason}</strong> · {done.turns} turns · {done.toolCalls} tool calls ·{' '}
          {Math.round((done.durationMs ?? 0) / 100) / 10}s
        </div>
      )}

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
        <input
          ref={fileRef}
          hidden
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) readAttachment(file);
            e.currentTarget.value = '';
          }}
        />
        <div className="actions">
          <button type="button" onClick={() => fileRef.current?.click()}>Attach</button>
          {running ? (
            <button type="button" className="danger" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!prompt.trim() || !workspaceId}>
              Run
            </button>
          )}
        </div>
        {attachment && (
          <span className="attachment">
            Attached: {attachment.name}{' '}
            <button type="button" onClick={() => setAttachment(undefined)}>×</button>
          </span>
        )}
      </form>
    </div>
  );
}

function AgentStep({
  event,
  answered,
  onDecide,
}: {
  event: AgentEvent;
  answered: Record<string, boolean>;
  onDecide: (id: string, approved: boolean) => void;
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
    return (
      <div className={`step result ${event.success ? '' : 'failed'}`}>
        <header>{event.denied ? 'denied' : event.success ? 'result' : 'error'}</header>
        <pre>{(event.output ?? '').slice(0, 1200)}</pre>
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



