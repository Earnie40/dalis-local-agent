import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelAlias, Upload, Workspace } from './api';
import { api, generateStudioProject } from './api';
import { AttachmentBar } from './AttachmentBar';
import { chooseAgentWorkspace } from './agent-ui-state';
import {
  buildStandaloneStudioDocument,
  buildStudioDocument,
  DEFAULT_STUDIO_FILES,
  isStudioFiles,
  parseStudioPreviewMessage,
  STUDIO_IFRAME_SANDBOX,
  STUDIO_MAX_FILE_CHARS,
  type StudioFileKey,
  type StudioFiles,
} from './studio-sandbox';

interface StudioPanelProps {
  aliases: ModelAlias[];
}

interface StudioChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  changedFiles?: string[];
  proposal?: StudioFiles;
}

interface ConsoleEntry {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

const FILES: Array<{ key: StudioFileKey; name: string; language: string }> = [
  { key: 'html', name: 'index.html', language: 'HTML' },
  { key: 'css', name: 'styles.css', language: 'CSS' },
  { key: 'javascript', name: 'main.js', language: 'JavaScript' },
];

const STORAGE_KEY = 'dacai.studio.project.v1';
const WORKSPACE_KEY = 'dacai.agent.workspace.v1';
// Mirrors STUDIO_MAX_ATTACHMENT_CHARS in apps/server/src/routes/studio.ts.
const MAX_ATTACHMENT_CHARS = 20_000;
const LAYOUT_KEY = 'dacai.studio.layout.v1';

function cloneFiles(files: StudioFiles): StudioFiles {
  return { html: files.html, css: files.css, javascript: files.javascript };
}

function loadFiles(): StudioFiles {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (isStudioFiles(parsed)) return cloneFiles(parsed);
  } catch {
    // Malformed or unavailable storage falls back to the known-good scene.
  }
  return cloneFiles(DEFAULT_STUDIO_FILES);
}

function loadLayout(): { assistantOpen: boolean; assistantWide: boolean } {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? 'null') as unknown;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.assistantOpen === 'boolean' && typeof record.assistantWide === 'boolean') {
        return { assistantOpen: record.assistantOpen, assistantWide: record.assistantWide };
      }
    }
  } catch {
    // Layout persistence is a convenience, never a launch requirement.
  }
  return { assistantOpen: true, assistantWide: false };
}

function createRunId(): string {
  return `studio_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sameFiles(left: StudioFiles, right: StudioFiles): boolean {
  return left.html === right.html && left.css === right.css && left.javascript === right.javascript;
}

export function StudioPanel({ aliases }: StudioPanelProps) {
  const initialFiles = useMemo(loadFiles, []);
  const initialLayout = useMemo(loadLayout, []);
  const [files, setFiles] = useState<StudioFiles>(initialFiles);
  const [runningFiles, setRunningFiles] = useState<StudioFiles>(cloneFiles(initialFiles));
  const [activeFile, setActiveFile] = useState<StudioFileKey>('javascript');
  const [revision, setRevision] = useState(0);
  const [undoStack, setUndoStack] = useState<StudioFiles[]>([]);
  const [runId, setRunId] = useState(createRunId);
  const [previewActive, setPreviewActive] = useState(true);
  const [previewStatus, setPreviewStatus] = useState<'booting' | 'ready' | 'error' | 'stopped' | 'unresponsive'>('booting');
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [viewport, setViewport] = useState<'fluid' | 'tablet' | 'mobile'>('fluid');
  const [autoRun, setAutoRun] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(initialLayout.assistantOpen);
  const [assistantWide, setAssistantWide] = useState(initialLayout.assistantWide);
  const [alias, setAlias] = useState('chat');
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<StudioChatMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string>();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const assistantToggleRef = useRef<HTMLButtonElement>(null);
  const generationAbortRef = useRef<AbortController | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(() => {
    try {
      return localStorage.getItem(WORKSPACE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [attachments, setAttachments] = useState<Upload[]>([]);
  const revisionRef = useRef(revision);
  const consoleCountRef = useRef(0);
  const consoleBytesRef = useRef(0);
  const consoleTruncatedRef = useRef(false);

  const selected = FILES.find((file) => file.key === activeFile) ?? FILES[0];
  const activeCode = files[activeFile];
  const dirty = !sameFiles(files, runningFiles);

  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  const bumpRevision = useCallback(() => {
    setRevision((current) => {
      const next = current + 1;
      // Keep the request-conflict guard current before React flushes effects.
      // A generation resolving in that window must not overwrite a newer draft.
      revisionRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!aliases.length) return;
    if (!aliases.some((entry) => entry.alias === alias)) {
      setAlias(aliases.find((entry) => entry.alias === 'chat')?.alias ?? aliases[0].alias);
    }
  }, [alias, aliases]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
      } catch {
        // A quota or privacy-mode failure leaves the live project untouched.
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [files]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ assistantOpen, assistantWide }));
    } catch {
      // Layout persistence is optional.
    }
  }, [assistantOpen, assistantWide]);

  const runFiles = useCallback((next: StudioFiles) => {
    setRunningFiles(cloneFiles(next));
    setRunId(createRunId());
    setPreviewActive(true);
    setPreviewStatus('booting');
    setConsoleEntries([]);
    consoleCountRef.current = 0;
    consoleBytesRef.current = 0;
    consoleTruncatedRef.current = false;
  }, []);

  useEffect(() => {
    if (!autoRun || !dirty) return;
    const timer = window.setTimeout(() => runFiles(files), 700);
    return () => window.clearTimeout(timer);
  }, [autoRun, dirty, files, runFiles]);

  useEffect(() => {
    if (!previewActive) return;
    const timer = window.setTimeout(() => {
      setPreviewStatus((current) => current === 'booting' ? 'unresponsive' : current);
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [previewActive, runId]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parseStudioPreviewMessage(event.data, runId);
      if (!message) return;

      if (message.type === 'ready') {
        setPreviewStatus('ready');
        return;
      }

      const bytes = new TextEncoder().encode(message.text).byteLength;
      if (consoleCountRef.current >= 100 || consoleBytesRef.current + bytes > 65_536) {
        if (!consoleTruncatedRef.current) {
          consoleTruncatedRef.current = true;
          setConsoleEntries((current) => [
            ...current,
            { id: Date.now(), level: 'warn', text: 'Console output limit reached; further messages were ignored.' },
          ]);
        }
        return;
      }

      consoleCountRef.current += 1;
      consoleBytesRef.current += bytes;
      setConsoleEntries((current) => [
        ...current,
        {
          id: Date.now() + consoleCountRef.current,
          level: message.type as ConsoleEntry['level'],
          text: message.text,
        },
      ]);
      if (message.type === 'error') setPreviewStatus('error');
    };

    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [runId]);

  useEffect(() => {
    const collapseOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !assistantOpen) return;
      setAssistantOpen(false);
      window.requestAnimationFrame(() => assistantToggleRef.current?.focus());
    };
    window.addEventListener('keydown', collapseOnEscape);
    return () => window.removeEventListener('keydown', collapseOnEscape);
  }, [assistantOpen]);

  const previewDocument = useMemo(
    () => buildStudioDocument(runningFiles, runId),
    [runId, runningFiles],
  );

  const pushUndo = useCallback((snapshot: StudioFiles) => {
    setUndoStack((current) => [...current.slice(-19), cloneFiles(snapshot)]);
  }, []);

  const applyProject = useCallback((next: StudioFiles, keepUndo = true) => {
    if (keepUndo) pushUndo(files);
    setFiles(cloneFiles(next));
    bumpRevision();
    runFiles(next);
  }, [bumpRevision, files, pushUndo, runFiles]);

  const updateActiveFile = (value: string) => {
    setFiles((current) => ({ ...current, [activeFile]: value }));
    bumpRevision();
  };

  const stopPreview = () => {
    setPreviewActive(false);
    setRunId(createRunId());
    setPreviewStatus('stopped');
  };

  const reset = () => {
    if (!window.confirm('Reset the three virtual files to the starter 3D scene?')) return;
    applyProject(cloneFiles(DEFAULT_STUDIO_FILES));
  };

  const undo = () => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setUndoStack((current) => current.slice(0, -1));
    applyProject(previous, false);
  };

  const exportHtml = () => {
    const blob = new Blob([buildStandaloneStudioDocument(files)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'dacais-studio.html';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  // Studio itself never touches the filesystem; the workspace is only the
  // store an uploaded file is written to before its text is inlined here.
  useEffect(() => {
    api
      .listWorkspaces()
      .then(({ workspaces: list }) => {
        setWorkspaces(list);
        setWorkspaceId((current) => chooseAgentWorkspace(list, current));
      })
      .catch(() => undefined);
  }, []);

  const sendToAssistant = async () => {
    const prompt = chatInput.trim();
    if (!prompt || generating) return;
    const requestRevision = revision;
    const requestFiles = cloneFiles(files);
    const userMessage: StudioChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: prompt,
    };
    const history = chatMessages.slice(-12).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 2_000),
    }));

    setChatMessages((current) => [...current, userMessage]);
    setChatInput('');
    setGenerating(true);
    setGenerationError(undefined);
    const controller = new AbortController();
    generationAbortRef.current = controller;

    try {
      const response = await generateStudioProject({
        prompt,
        alias,
        revision: requestRevision,
        files: requestFiles,
        history,
        // Only text can be inlined: the studio route has no filesystem access,
        // so a binary upload has no meaning here and is left out.
        attachments: attachments
          .filter((upload) => upload.kind === 'text' && upload.textPreview)
          .map((upload) => ({
            name: upload.name,
            text: (upload.textPreview ?? '').slice(0, MAX_ATTACHMENT_CHARS),
          })),
      }, controller.signal);
      const stale = revisionRef.current !== response.update.baseRevision;
      const changed = response.update.changedFiles.length > 0;
      if (changed && !stale) applyProject(response.update.files);

      setChatMessages((current) => [
        ...current,
        {
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: stale && changed
            ? `${response.update.message}\n\nThe draft changed while I was working, so I did not overwrite it. Apply the proposal when ready.`
            : response.update.message,
          changedFiles: response.update.changedFiles,
          proposal: stale && changed ? response.update.files : undefined,
        },
      ]);
    } catch (error) {
      if (!controller.signal.aborted) setGenerationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = undefined;
      setAttachments([]);
      setGenerating(false);
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = event.currentTarget.selectionStart;
      const end = event.currentTarget.selectionEnd;
      updateActiveFile(`${activeCode.slice(0, start)}  ${activeCode.slice(end)}`);
      window.requestAnimationFrame(() => {
        editorRef.current?.setSelectionRange(start + 2, start + 2);
      });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) {
      event.preventDefault();
      runFiles(files);
    }
  };

  return (
    <section className={`studio ${assistantOpen ? 'assistant-open' : 'assistant-closed'} ${assistantWide ? 'assistant-wide' : ''}`}>
      <header className="studio-toolbar">
        <div className="studio-title">
          <span className="studio-mark" aria-hidden="true">◇</span>
          <div>
            <strong>Sandbox Studio</strong>
            <span>browser-isolated · no network · virtual files only</span>
          </div>
        </div>
        <div className="studio-toolbar-actions">
          <button type="button" onClick={() => runFiles(files)} data-testid="studio-run">
            ▶ Run <kbd>Ctrl ↵</kbd>
          </button>
          <button type="button" onClick={stopPreview} disabled={!previewActive}>■ Stop</button>
          <button type="button" onClick={undo} disabled={!undoStack.length}>↶ Undo</button>
          <button type="button" onClick={reset}>Reset</button>
          <button type="button" onClick={exportHtml}>Export HTML</button>
          <label className="studio-auto-run">
            <input type="checkbox" checked={autoRun} onChange={(event) => setAutoRun(event.target.checked)} />
            Auto preview
          </label>
        </div>
      </header>

      <div className="studio-content">
        <div className={`studio-workbench ${previewMaximized ? 'preview-maximized' : ''}`}>
          <section className="studio-editor" aria-label="Code editor">
            <div className="studio-file-tabs" role="tablist" aria-label="Virtual files">
              {FILES.map((file) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFile === file.key}
                  className={activeFile === file.key ? 'active' : ''}
                  key={file.key}
                  onClick={() => setActiveFile(file.key)}
                >
                  <span className={`file-dot ${file.key}`} />
                  {file.name}
                </button>
              ))}
            </div>
            <div className="studio-editor-label">
              <span>{selected.language}</span>
              <span>{activeCode.split('\n').length} lines · {new TextEncoder().encode(activeCode).byteLength.toLocaleString()} bytes</span>
            </div>
            <textarea
              ref={editorRef}
              className="studio-code-editor"
              aria-label={`${selected.name} editor`}
              data-testid="studio-editor"
              value={activeCode}
              maxLength={STUDIO_MAX_FILE_CHARS}
              spellCheck={false}
              onChange={(event) => updateActiveFile(event.target.value)}
              onKeyDown={handleEditorKeyDown}
            />
            <footer className="studio-statusbar">
              <span>{dirty ? 'Draft has changes' : 'Preview is current'}</span>
              <span>UTF-8 · spaces: 2 · rev {revision}</span>
            </footer>
          </section>

          <section className="studio-preview" aria-label="Sandboxed preview">
            <header className="studio-preview-header">
              <div>
                <span className={`preview-light ${previewStatus}`} />
                <strong>3D / web preview</strong>
                <span className="muted small">{previewStatus}</span>
              </div>
              <div>
                <select aria-label="Preview viewport" value={viewport} onChange={(event) => setViewport(event.target.value as typeof viewport)}>
                  <option value="fluid">Fluid</option>
                  <option value="tablet">Tablet</option>
                  <option value="mobile">Mobile</option>
                </select>
                <button type="button" onClick={() => setPreviewMaximized((current) => !current)}>
                  {previewMaximized ? 'Show code' : 'Maximize'}
                </button>
              </div>
            </header>
            <div className="studio-preview-stage" data-viewport={viewport}>
              {previewActive ? (
                <iframe
                  key={runId}
                  ref={iframeRef}
                  title="Sandboxed 3D preview"
                  data-testid="studio-preview-frame"
                  sandbox={STUDIO_IFRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
                  srcDoc={previewDocument}
                />
              ) : (
                <div className="studio-preview-stopped">
                  <strong>Preview stopped</strong>
                  <button type="button" onClick={() => runFiles(files)}>Run project</button>
                </div>
              )}
            </div>
            <details className="studio-console" open={consoleEntries.some((entry) => entry.level === 'error')}>
              <summary>
                Console <span>{consoleEntries.length}</span>
              </summary>
              <div className="studio-console-lines" aria-live="polite">
                {consoleEntries.length === 0 && <p>No console output.</p>}
                {consoleEntries.map((entry) => (
                  <p className={entry.level} key={entry.id}><span>{entry.level}</span>{entry.text}</p>
                ))}
              </div>
            </details>
          </section>
        </div>

        <aside className="studio-assistant" aria-label="Studio assistant">
          <div className="studio-assistant-rail">
            <button
              ref={assistantToggleRef}
              type="button"
              className="studio-assistant-toggle"
              aria-expanded={assistantOpen}
              aria-controls="studio-assistant-content"
              aria-label={assistantOpen ? 'Retract studio assistant' : 'Expand studio assistant'}
              data-testid="studio-assistant-toggle"
              onClick={() => setAssistantOpen((current) => !current)}
            >
              {assistantOpen ? '›' : 'AI'}
            </button>
          </div>

          {assistantOpen && (
            <div id="studio-assistant-content" className="studio-assistant-content">
              <header>
                <div>
                  <strong>Build with AI</strong>
                  <span>Edits stay in this virtual project</span>
                </div>
                <button
                  type="button"
                  aria-label={assistantWide ? 'Narrow assistant' : 'Widen assistant'}
                  onClick={() => setAssistantWide((current) => !current)}
                >
                  {assistantWide ? '⇥' : '⇤'}
                </button>
              </header>

              <label className="studio-model-picker">
                <span>Model</span>
                <select value={alias} onChange={(event) => setAlias(event.target.value)}>
                  {aliases.length === 0 && <option value="chat">chat</option>}
                  {aliases.map((entry) => (
                    <option value={entry.alias} key={entry.alias}>{entry.alias} — {entry.model}</option>
                  ))}
                </select>
              </label>

              <div className="studio-assistant-messages" aria-live="polite">
                {chatMessages.length === 0 && (
                  <article className="assistant">
                    <span>studio assistant</span>
                    <p>Describe a scene, simulation, interface, game, or visualization. I’ll update the three virtual files and run the result.</p>
                    <div className="studio-suggestions">
                      {['Make the cube a solar system', 'Build a particle galaxy', 'Create a product configurator'].map((suggestion) => (
                        <button type="button" key={suggestion} onClick={() => setChatInput(suggestion)}>{suggestion}</button>
                      ))}
                    </div>
                  </article>
                )}
                {chatMessages.map((message) => (
                  <article className={message.role} key={message.id}>
                    <span>{message.role === 'assistant' ? 'studio assistant' : 'you'}</span>
                    <p>{message.content}</p>
                    {!!message.changedFiles?.length && (
                      <div className="studio-changed-files">
                        {message.changedFiles.map((file) => <code key={file}>{file}</code>)}
                      </div>
                    )}
                    {message.proposal && (
                      <button type="button" className="primary" onClick={() => applyProject(message.proposal as StudioFiles)}>
                        Apply proposal
                      </button>
                    )}
                  </article>
                ))}
                {generating && <p className="studio-thinking">Building a validated update…</p>}
              </div>

              {generationError && <div className="studio-assistant-error">{generationError}</div>}

              <form
                className="studio-assistant-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendToAssistant();
                }}
              >
                <textarea
                  value={chatInput}
                  maxLength={4_000}
                  rows={4}
                  placeholder="Build or change anything in the preview…"
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <AttachmentBar
                  workspaceId={workspaceId || undefined}
                  uploads={attachments}
                  onChange={setAttachments}
                  disabled={generating}
                  noWorkspaceHint="Register a workspace in the Agent tab to attach files."
                />
                <div>
                  <p>Current files are sent to the selected model. Do not include secrets.</p>
                  {generating ? (
                    <button type="button" className="danger" onClick={() => generationAbortRef.current?.abort()}>Stop</button>
                  ) : (
                    <button type="submit" className="primary" disabled={!chatInput.trim()}>Build</button>
                  )}
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
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
