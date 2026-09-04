import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentActivityEvent } from './api';

export interface MonitorLine {
  id: string;
  kind: 'thinking' | 'tool' | 'terminal' | 'image' | 'status';
  title: string;
  detail?: string;
  time?: string;
}

interface LiveMonitorProps {
  active: boolean;
  title: string;
  lines: MonitorLine[];
  onStop?: () => void;
}

function monitorLines(events: AgentActivityEvent[]): MonitorLine[] {
  return events.map((event) => ({
    id: event.id,
    kind: event.toolName === 'image.generate' ? 'image'
      : event.type === 'command' || event.type === 'test' ? 'terminal'
        : event.type === 'model' || event.type === 'reasoning_summary' ? 'thinking' : 'tool',
    title: event.title,
    detail: [event.message, event.toolName && `tool: ${event.toolName}`, event.command && `$ ${event.command}`, event.filePath && `file: ${event.filePath}`]
      .filter(Boolean).join('\n'),
    time: new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }));
}

export function activityMonitorLines(events: AgentActivityEvent[]): MonitorLine[] {
  return monitorLines(events);
}

export function LiveMonitor({ active, title, lines, onStop }: LiveMonitorProps) {
  const [popup, setPopup] = useState<Window | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    popup?.close();
    setPopup(null);
    setContainer(null);
  }, [popup]);

  const open = useCallback(() => {
    const width = Math.max(360, Math.round(window.screen.availWidth * 0.28));
    const height = Math.max(300, Math.round(window.screen.availHeight * 0.42));
    const child = window.open('', 'dacai-live-monitor', `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=yes,left=${Math.max(0, window.screen.availWidth - width - 24)},top=24`);
    if (!child) return;
    child.document.title = `DACAIS · ${title}`;
    child.document.body.innerHTML = '<div id="dacai-monitor-root"></div>';
    child.document.body.style.margin = '0';
    child.document.body.style.background = '#090d14';
    child.document.body.style.color = '#dbe7f5';
    child.document.head.insertAdjacentHTML('beforeend', '<style>*,*::before,*::after{box-sizing:border-box}body{font:13px ui-monospace,Consolas,monospace}button{font:inherit}</style>');
    const root = child.document.getElementById('dacai-monitor-root') as HTMLDivElement;
    child.addEventListener('beforeunload', close);
    setPopup(child);
    setContainer(root);
  }, [close, title]);

  useEffect(() => {
    if (popup && popup.closed) close();
  });

  const content: ReactNode = (
    <section className="monitor-window" aria-label="Live execution monitor">
      <header className="monitor-header">
        <div><strong>{title}</strong><span className={active ? 'monitor-live' : 'monitor-idle'}>{active ? '● LIVE' : '● IDLE'}</span></div>
        <div>{active && onStop && <button type="button" className="danger" onClick={onStop}>Stop</button>}<button type="button" onClick={close}>Close</button></div>
      </header>
      <p className="monitor-note">Model-emitted previews and observable execution activity. Not private neural-network internals.</p>
      <div className="monitor-lines" aria-live="polite">
        {lines.length === 0 ? <p className="muted">Waiting for the first model/tool event…</p> : lines.map((line) => (
          <article className={`monitor-line ${line.kind}`} key={line.id}>
            <header><span>{line.kind}</span><time>{line.time}</time></header>
            <strong>{line.title}</strong>
            {line.detail && <pre>{line.detail}</pre>}
          </article>
        ))}
      </div>
    </section>
  );

  return (
    <>
      {!popup && <button type="button" className="monitor-launch" onClick={open}>↗ Pop out live monitor</button>}
      {popup && container && createPortal(content, container)}
    </>
  );
}

export function ChatMonitor({ active, title, thinking, status, onStop }: { active: boolean; title: string; thinking: string; status: string; onStop?: () => void }) {
  const lines = useMemo<MonitorLine[]>(() => [
    { id: 'status', kind: 'status', title: status },
    ...(thinking ? [{ id: 'thinking', kind: 'thinking' as const, title: 'Qwen reasoning preview', detail: thinking }] : []),
  ], [status, thinking]);
  return <LiveMonitor active={active} title={title} lines={lines} onStop={onStop} />;
}
