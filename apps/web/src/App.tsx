import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AgentPanel } from './AgentPanel';
import { ChatMonitor } from './LiveMonitor';
import { useStickToBottom } from './use-stick-to-bottom';
import { DelegationPanel } from './DelegationPanel';
import { IntelligencePanel } from './IntelligencePanel';
import { MediaStudioPanel } from './MediaStudioPanel';
import {
  api,
  streamChat,
  type Conversation,
  type Message,
  type MediaInfrastructureStatus,
  type ModelAlias,
  type Upload,
  type Workspace,
} from './api';
import { AttachmentBar } from './AttachmentBar';
import { chooseAgentWorkspace } from './agent-ui-state';

const StudioPanel = lazy(() => import('./StudioPanel').then((module) => ({ default: module.StudioPanel })));

class StudioErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="studio-loading studio-load-error" role="alert">
          <strong>Sandbox Studio could not open.</strong>
          <span>The rest of DacaiLocalAgent is still available. Retry after checking the browser console.</span>
          <button type="button" onClick={() => this.setState({ failed: false })}>Retry Studio</button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface StreamState {
  text: string;
  thinking: boolean;
  active: boolean;
  phase: 'idle' | 'connecting' | 'thinking' | 'generating';
  /** Epoch ms the run started; 0 while idle. The elapsed display derives from
   *  this so ticking it never touches App state. */
  startedAt: number;
  thinkingText: string;
}

/**
 * The streaming elapsed counter, isolated so its 250 ms tick repaints one
 * <span> instead of re-rendering App. It previously lived in App state, which
 * meant four full-tree renders per second — and the composer textarea is
 * controlled, so every one of them reconciled the input the user was typing
 * into. That was felt as typing hesitation during a stream.
 */
function StreamElapsed({ startedAt }: { startedAt: number }) {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);

  useEffect(() => {
    setElapsedMs(Date.now() - startedAt);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return <span>{(elapsedMs / 1000).toFixed(1)}s</span>;
}

/**
 * Structural comparison for the polled media status. The payload is small and
 * flat, and this runs five times a minute, so serialising both sides is cheaper
 * than the render it prevents.
 */
function sameMediaStatus(
  a: MediaInfrastructureStatus | undefined,
  b: MediaInfrastructureStatus | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

const EMPTY_STREAM: StreamState = {
  text: '',
  thinking: false,
  active: false,
  phase: 'idle',
  startedAt: 0,
  thinkingText: '',
};

// The same key the agent panel persists, so choosing a workspace in one
// place does not silently disagree with the other.
const WORKSPACE_KEY = 'dacai.agent.workspace.v1';

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  // One user-facing agent; provider and specialist routing stay server-side.
  const alias = 'agent';
  const [input, setInput] = useState('');
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [error, setError] = useState<string | undefined>();
  const [mode, setMode] = useState<'chat' | 'agent' | 'delegate' | 'intelligence' | 'studio' | 'media'>('chat');
  const [mediaStatus, setMediaStatus] = useState<MediaInfrastructureStatus | undefined>();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => {
    try {
      return localStorage.getItem(WORKSPACE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [attachments, setAttachments] = useState<Upload[]>([]);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const transcriptScroll = useStickToBottom<HTMLDivElement>([messages, stream.text]);

  const refreshConversations = useCallback(async () => {
    const { conversations: list } = await api.listConversations();
    setConversations(list);
  }, []);

  useEffect(() => {
    refreshConversations().catch((e) => setError(String(e)));
    api
      .listModels()
      .then(({ aliases: list }) => setAliases(list.filter((entry) => entry.enabled)))
      .catch((e) => setError(String(e)));
    // Chat itself has no tools, but an attachment has to be stored somewhere;
    // uploads land in the selected workspace so the agent panel can act on them.
    api
      .listWorkspaces()
      .then(({ workspaces: list }) => {
        setWorkspaces(list);
        setWorkspaceId((current) => chooseAgentWorkspace(list, current));
      })
      .catch(() => undefined);
  }, [refreshConversations]);

  useEffect(() => {
    if (!workspaceId) return;
    try {
      localStorage.setItem(WORKSPACE_KEY, workspaceId);
    } catch {
      /* a browser with storage disabled just loses the preference */
    }
  }, [workspaceId]);

  useEffect(() => {
    let active = true;
    const refresh = () => api.mediaStatus().then((status) => {
      if (!active) return;
      // Each poll parses a fresh object, so storing it unconditionally gave the
      // state a new identity every 5 s and re-rendered the whole app — composer
      // included — even when the status had not changed at all. Keep the
      // previous object when the payload matches so React can bail out.
      setMediaStatus((current) => (sameMediaStatus(current, status) ? current : status));
    }).catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    api
      .getConversation(activeId)
      .then(({ messages: list }) => setMessages(list))
      .catch((e) => setError(String(e)));
  }, [activeId]);

  const send = useCallback(
    async (options: { retry?: boolean } = {}) => {
      const text = input.trim();
      if ((!text && !options.retry) || stream.active) return;

      setError(undefined);
      setInput('');
      setStream({ text: '', thinking: false, active: true, phase: 'connecting', startedAt: Date.now(), thinkingText: '' });

      if (!options.retry && text) {
        setMessages((current) => [
          ...current,
          {
            id: `pending_${Date.now()}`,
            role: 'user',
            content: text,
            metadata: {},
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      if (options.retry) {
        setMessages((current) => {
          const lastAssistant = [...current].reverse().find((m) => m.role === 'assistant');
          return lastAssistant ? current.filter((m) => m.id !== lastAssistant.id) : current;
        });
      }

      const controller = new AbortController();
      abortRef.current = controller;
      let conversationId = activeId;

      try {
        await streamChat(
          {
            conversationId,
            message: text,
            alias,
            retry: options.retry,
            workspaceId: workspaceId || undefined,
            attachments: attachments.length ? attachments.map((upload) => upload.id) : undefined,
          },
          {
            onStart: (meta) => {
              conversationId = meta.conversationId;
              setActiveId(meta.conversationId);
              setStream((current) => ({ ...current, phase: 'thinking' }));
            },
            onChunk: (chunk) =>
              setStream((current) => ({
                ...current,
                phase: 'generating',
                thinking: false,
                text: current.text + chunk,
              })),
            onThinking: (text) =>
              setStream((current) => ({
                ...current,
                phase: 'thinking',
                thinking: true,
                thinkingText: text ? `${current.thinkingText}${text}` : current.thinkingText,
              })),
            onDone: (payload) => {
              if (payload.error) setError(payload.error);
            },
          },
          controller.signal,
        );
      } catch (e) {
        // An aborted fetch is a deliberate stop, not a failure.
        if (!controller.signal.aborted) setError(String(e));
      } finally {
        abortRef.current = undefined;
        setStream(EMPTY_STREAM);
        setAttachments([]);
        // Re-read from the database so what is displayed is what was persisted.
        if (conversationId) {
          await api
            .getConversation(conversationId)
            .then(({ messages: list }) => setMessages(list))
            .catch(() => undefined);
        }
        await refreshConversations().catch(() => undefined);
      }
    },
    [activeId, alias, attachments, input, refreshConversations, stream.active, workspaceId],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const startNew = useCallback(() => {
    stop();
    setActiveId(undefined);
    setMessages([]);
    setError(undefined);
  }, [stop]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id);
        setConversations((current) => current.filter((conversation) => conversation.id !== id));
        if (id === activeId) startNew();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activeId, refreshConversations, startNew],
  );

  const canRetry = useMemo(
    () => !stream.active && messages.some((message) => message.role === 'assistant'),
    [messages, stream.active],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <strong>DACAIS</strong>
          <span className="badge local">local personal LLM</span>
        </div>

        {mediaStatus?.configured && (
          <button
            type="button"
            className={`media-infrastructure ${mediaStatus.ready ? 'ready' : mediaStatus.phase === 'error' ? 'failed' : 'starting'}`}
            title={mediaStatus.error ?? `Media transport: ${mediaStatus.transport ?? 'initializing'}`}
            onClick={() => {
              if (!mediaStatus.ready) void api.reconnectMedia().then(setMediaStatus).catch(() => undefined);
            }}
          >
            <span className="media-light" aria-hidden="true" />
            <span>
              <strong>GPU media</strong>
              <small>{mediaStatus.ready
                ? `Ready · ${mediaStatus.service.imageModel ? 'image' : ''}${mediaStatus.service.imageModel && mediaStatus.service.videoModel ? ' + ' : ''}${mediaStatus.service.videoModel ? 'video' : ''}`
                : mediaStatus.phase === 'error' ? 'Unavailable · click to retry' : mediaStatus.phase.replaceAll('-', ' ')}</small>
            </span>
          </button>
        )}

        <div className="mode-switch">
          <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
            Chat
          </button>
          <button className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')}>
            Agent
          </button>
          <button className={mode === 'delegate' ? 'active' : ''} onClick={() => setMode('delegate')}>
            Delegate
          </button>
          <button className={mode === 'intelligence' ? 'active' : ''} onClick={() => setMode('intelligence')}>
            Intelligence
          </button>
          <button className={mode === 'studio' ? 'active' : ''} onClick={() => setMode('studio')}>
            Studio
          </button>
          <button className={mode === 'media' ? 'active' : ''} onClick={() => setMode('media')}>
            Media
          </button>
        </div>

        {mode === 'chat' && (
          <button className="primary" onClick={startNew}>
            + New conversation
          </button>
        )}

        {mode === 'chat' && (
        <nav className="conversations">
          {conversations.length === 0 && <p className="muted">No conversations yet.</p>}
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`conversation ${conversation.id === activeId ? 'active' : ''}`}
            >
              <button type="button" className="conversation-open" onClick={() => setActiveId(conversation.id)}>
                <span className="conversation-title">{conversation.title}</span>
                <span className="muted small">
                  {conversation.messageCount ?? 0} messages · {conversation.model ?? 'unknown model'}
                </span>
              </button>
              <button
                type="button"
                className="icon"
                title="Delete conversation"
                aria-label={`Delete conversation ${conversation.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void remove(conversation.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        )}

        {mode === 'chat' && (
        <div className="model-picker">
          <label>Agent</label>
          <div className="agent-identity">
            <strong>DACAIS Agent</strong>
            <span>Local personal LLM — chat, coding, vision, media, and tools</span>
          </div>
        </div>
        )}
      </aside>

      {mode === 'studio' ? (
        <main className="studio-host">
          <StudioErrorBoundary>
            <Suspense fallback={<div className="studio-loading">Opening Sandbox Studio…</div>}>
              <StudioPanel aliases={aliases} />
            </Suspense>
          </StudioErrorBoundary>
        </main>
      ) : mode === 'media' ? (
        <main className="media-host">
          <MediaStudioPanel aliases={aliases} />
        </main>
      ) : mode === 'intelligence' ? (
        <main className="chat">
          <IntelligencePanel />
        </main>
      ) : mode === 'agent' ? (
        <main className="chat">
          <AgentPanel />
        </main>
      ) : mode === 'delegate' ? (
        <main className="chat">
          <DelegationPanel />
        </main>
      ) : (
      <main className="chat">
        <div className="transcript" ref={transcriptScroll.ref} onScroll={transcriptScroll.onScroll}>
          {messages.length === 0 && !stream.active && (
            <div className="empty">
              <h1>Local personal LLM</h1>
              <p className="muted">
                For you and people you personally allow on a local machine. Ordinary questions stay
                in conversation. Coding questions can use Agent mode with workspace tools. Tokens
                stay on this machine; conversations persist to PostgreSQL.
              </p>
            </div>
          )}

          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <header>
                <span className="role">{message.role}</span>
                {typeof message.metadata?.model === 'string' && (
                  <span className="muted small">{message.metadata.model as string}</span>
                )}
                {message.metadata?.cancelled === true && <span className="badge warn">stopped</span>}
                {typeof message.metadata?.durationMs === 'number' && (
                  <span className="muted small">{Math.round((message.metadata.durationMs as number) / 100) / 10}s</span>
                )}
              </header>
              <div className="body">
                {message.role === 'assistant' ? (
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {message.content || '_(empty response)_'}
                  </Markdown>
                ) : (
                  <pre className="plain">{message.content}</pre>
                )}
              </div>
            </article>
          ))}

          {stream.active && (
            <article className="message assistant streaming">
              <header>
                <span className="role">assistant</span>
                <span className="muted small">streaming…</span>
              </header>
              <div className="body">
                {!stream.text && (
                  <p className="muted stream-status">
                    {stream.phase === 'connecting' ? 'connecting to local Ollama…' : 'thinking…'}{' '}
                    <StreamElapsed startedAt={stream.startedAt} />
                  </p>
                )}
                {stream.thinking && <p className="muted small">The agent is processing the latest evidence…</p>}
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {stream.text}
                </Markdown>
              </div>
            </article>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <ChatMonitor
          active={stream.active}
          title="DACAIS · Chat monitor"
          thinking={stream.thinkingText}
          status={stream.phase === 'connecting' ? 'Connecting to the selected provider…' : stream.phase === 'thinking' ? 'Model is thinking…' : 'Generating response…'}
          onStop={stop}
        />

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            value={input}
            placeholder="Ask the local model…  (Enter to send, Shift+Enter for a new line)"
            rows={3}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <AttachmentBar
            workspaceId={workspaceId || undefined}
            uploads={attachments}
            onChange={setAttachments}
            disabled={stream.active}
            noWorkspaceHint="Register a workspace in the Agent tab to attach files."
          />
          <div className="actions">
            {stream.active ? (
              <button type="button" className="danger" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="primary" disabled={!input.trim()}>
                Send
              </button>
            )}
            <button type="button" disabled={!canRetry} onClick={() => void send({ retry: true })}>
              Retry
            </button>
            {workspaces.length > 0 && (
              <select
                className="composer-workspace"
                value={workspaceId}
                title="Workspace that stores attached files"
                onChange={(event) => setWorkspaceId(event.target.value)}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.displayName}</option>
                ))}
              </select>
            )}
          </div>
        </form>
      </main>
      )}
    </div>
  );
}
