import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { AgentPanel } from './AgentPanel';
import {
  api,
  streamChat,
  type AliasCapabilities,
  type Conversation,
  type Message,
  type ModelAlias,
} from './api';

interface StreamState {
  text: string;
  thinking: boolean;
  active: boolean;
  phase: 'idle' | 'connecting' | 'thinking' | 'generating';
  elapsedMs: number;
}

const EMPTY_STREAM: StreamState = {
  text: '',
  thinking: false,
  active: false,
  phase: 'idle',
  elapsedMs: 0,
};

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [alias, setAlias] = useState('chat');
  const [capabilities, setCapabilities] = useState<AliasCapabilities | undefined>();
  const [input, setInput] = useState('');
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const [error, setError] = useState<string | undefined>();
  const [mode, setMode] = useState<'chat' | 'agent'>('chat');

  const abortRef = useRef<AbortController | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement>(null);

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
  }, [refreshConversations]);

  // Capability is fetched per alias so the UI can say plainly whether a model
  // is agent-capable or advisory-class, rather than implying every model is equal.
  useEffect(() => {
    setCapabilities(undefined);
    api.capabilities(alias).then(setCapabilities).catch(() => undefined);
  }, [alias]);

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

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, stream.text]);

  useEffect(() => {
    if (!stream.active) return;
    const startedAt = Date.now() - stream.elapsedMs;
    const timer = window.setInterval(() => {
      setStream((current) =>
        current.active ? { ...current, elapsedMs: Date.now() - startedAt } : current,
      );
    }, 250);
    return () => window.clearInterval(timer);
  }, [stream.active]);

  const send = useCallback(
    async (options: { retry?: boolean } = {}) => {
      const text = input.trim();
      if ((!text && !options.retry) || stream.active) return;

      setError(undefined);
      setInput('');
      setStream({ text: '', thinking: false, active: true, phase: 'connecting', elapsedMs: 0 });

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
          { conversationId, message: text, alias, retry: options.retry },
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
            onThinking: () =>
              setStream((current) => ({ ...current, phase: 'thinking', thinking: true })),
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
    [activeId, alias, input, refreshConversations, stream.active],
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
      await api.deleteConversation(id).catch(() => undefined);
      if (id === activeId) startNew();
      await refreshConversations();
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
          <strong>DacaiLocalAgent</strong>
          <span className="badge local">local-first</span>
        </div>

        <div className="mode-switch">
          <button className={mode === 'chat' ? 'active' : ''} onClick={() => setMode('chat')}>
            Chat
          </button>
          <button className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')}>
            Agent
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
              <button className="conversation-open" onClick={() => setActiveId(conversation.id)}>
                <span className="conversation-title">{conversation.title}</span>
                <span className="muted small">
                  {conversation.messageCount ?? 0} messages · {conversation.model ?? 'unknown model'}
                </span>
              </button>
              <button
                className="icon"
                title="Delete conversation"
                onClick={() => void remove(conversation.id)}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        )}

        {mode === 'chat' && (
        <div className="model-picker">
          <label htmlFor="alias">Model</label>
          <select id="alias" value={alias} onChange={(event) => setAlias(event.target.value)}>
            {aliases.map((entry) => (
              <option key={entry.alias} value={entry.alias}>
                {entry.alias} — {entry.model}
              </option>
            ))}
          </select>

          {capabilities && (
            <p className="muted small">
              <span className={`badge ${capabilities.agentLoopCapable ? 'ok' : 'warn'}`}>
                {capabilities.classification}
              </span>{' '}
              tools: {capabilities.capabilities.toolCalling}
              {capabilities.capabilities.toolCallChannel
                ? ` (${capabilities.capabilities.toolCallChannel})`
                : ''}
            </p>
          )}
        </div>
        )}
      </aside>

      {mode === 'agent' ? (
        <main className="chat">
          <AgentPanel aliases={aliases} />
        </main>
      ) : (
      <main className="chat">
        <div className="transcript" ref={transcriptRef}>
          {messages.length === 0 && !stream.active && (
            <div className="empty">
              <h1>Local chat</h1>
              <p className="muted">
                Every token is generated on this machine. Conversations persist to PostgreSQL.
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
                    <span>{(stream.elapsedMs / 1000).toFixed(1)}s</span>
                  </p>
                )}
                <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {stream.text}
                </Markdown>
              </div>
            </article>
          )}
        </div>

        {error && <div className="error">{error}</div>}

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
          </div>
        </form>
      </main>
      )}
    </div>
  );
}
