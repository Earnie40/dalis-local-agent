import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AgentPanel } from './AgentPanel';
import { DelegationPanel } from './DelegationPanel';
import { IntelligencePanel } from './IntelligencePanel';
import { MediaStudioPanel } from './MediaStudioPanel';
import {
  api,
  type Conversation,
  type MediaInfrastructureStatus,
  type Message,
  type ModelAlias,
} from './api';

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

export function App() {
  const [archivedConversations, setArchivedConversations] = useState<Conversation[]>([]);
  const [archivedConversationId, setArchivedConversationId] = useState<string>();
  const [archivedMessages, setArchivedMessages] = useState<Message[]>([]);
  const [chatArchiveError, setChatArchiveError] = useState<string>();
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  // Chat and agent work are one product surface. The unified panel decides
  // whether a message needs tools; users do not switch runtimes first.
  const [mode, setMode] = useState<'chat' | 'delegate' | 'intelligence' | 'studio' | 'media'>('chat');
  const [mediaStatus, setMediaStatus] = useState<MediaInfrastructureStatus | undefined>();

  const refreshArchivedConversations = useCallback(async () => {
    const { conversations } = await api.listConversations();
    setArchivedConversations(conversations);
  }, []);

  useEffect(() => {
    refreshArchivedConversations().catch((error) => setChatArchiveError(String(error)));
    api
      .listModels()
      .then(({ aliases: list }) => setAliases(list.filter((entry) => entry.enabled)))
      .catch(() => undefined);
  }, [refreshArchivedConversations]);

  useEffect(() => {
    if (!archivedConversationId) {
      setArchivedMessages([]);
      return;
    }
    api
      .getConversation(archivedConversationId)
      .then(({ messages }) => setArchivedMessages(messages))
      .catch((error) => setChatArchiveError(String(error)));
  }, [archivedConversationId]);

  const removeArchivedConversation = useCallback(async (id: string) => {
    try {
      await api.deleteConversation(id);
      setArchivedConversations((current) => current.filter((conversation) => conversation.id !== id));
      if (archivedConversationId === id) setArchivedConversationId(undefined);
    } catch (error) {
      setChatArchiveError(error instanceof Error ? error.message : String(error));
    }
  }, [archivedConversationId]);

  const removeAllArchivedConversations = useCallback(async () => {
    if (!window.confirm('Delete all archived Chat conversations? This cannot be undone.')) return;
    try {
      await api.deleteAllConversations();
      setArchivedConversations([]);
      setArchivedConversationId(undefined);
    } catch (error) {
      setChatArchiveError(error instanceof Error ? error.message : String(error));
    }
  }, []);

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
            Chat + Agent
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

        {/*
          * Unified conversation history renders here through a portal from
          * AgentPanel instead of becoming a horizontal strip above the panel.
          */}
        {mode === 'chat' && (
          <div className="sidebar-history" id="agent-history-slot" />
        )}

        {mode === 'chat' && archivedConversations.length > 0 && (
          <>
            <p className="muted small">Archived Chat conversations</p>
            <nav className="conversations" aria-label="Archived Chat conversations">
              {archivedConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`conversation ${conversation.id === archivedConversationId ? 'active' : ''}`}
                >
                  <button
                    type="button"
                    className="conversation-open"
                    onClick={() => setArchivedConversationId(conversation.id)}
                  >
                    <span className="conversation-title">{conversation.title}</span>
                    <span className="muted small">
                      {conversation.messageCount ?? 0} messages · {conversation.model ?? 'unknown model'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon"
                    title="Delete archived conversation"
                    aria-label={`Delete archived conversation ${conversation.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeArchivedConversation(conversation.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </nav>
            <button
              type="button"
              className="history-clear"
              onClick={() => void removeAllArchivedConversations()}
            >
              Clear archived conversations
            </button>
          </>
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
      ) : mode === 'chat' ? (
        <main className="chat">
          {archivedConversationId ? (
            <div className="transcript">
              <div className="empty">
                <h1>Archived Chat conversation</h1>
                <p className="muted">This transcript is preserved from before Chat and Agent were combined.</p>
                <button type="button" className="primary" onClick={() => setArchivedConversationId(undefined)}>
                  Return to Chat + Agent
                </button>
              </div>
              {archivedMessages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <header>
                    <span className="role">{message.role}</span>
                    {typeof message.metadata?.model === 'string' && (
                      <span className="muted small">{message.metadata.model as string}</span>
                    )}
                    {message.metadata?.cancelled === true && <span className="badge warn">stopped</span>}
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
              {chatArchiveError && <div className="error">{chatArchiveError}</div>}
            </div>
          ) : (
            <AgentPanel />
          )}
        </main>
      ) : mode === 'delegate' ? (
        <main className="chat">
          <DelegationPanel />
        </main>
      ) : null}
    </div>
  );
}
