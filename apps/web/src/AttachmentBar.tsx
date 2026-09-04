import { useCallback, useRef, useState } from 'react';
import { api, uploadWorkspaceFiles, type Upload } from './api';

interface AttachmentBarProps {
  /** Uploads are stored inside a registered workspace, so one must be chosen. */
  workspaceId?: string;
  uploads: Upload[];
  onChange: (uploads: Upload[]) => void;
  disabled?: boolean;
  /** Shown in place of the button when no workspace is selected. */
  noWorkspaceHint?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The upload control shared by the chat, agent and studio composers.
 *
 * Files are sent to the workspace upload endpoint immediately on selection, so
 * by the time a prompt is submitted the panel only has to pass the returned
 * ids. That keeps large files out of the prompt request itself.
 */
export function AttachmentBar({
  workspaceId,
  uploads,
  onChange,
  disabled,
  noWorkspaceHint = 'Select a workspace to attach files.',
}: AttachmentBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const addFiles = useCallback(
    async (files: FileList) => {
      if (!workspaceId || files.length === 0) return;
      setBusy(true);
      setError(undefined);
      try {
        const stored = await uploadWorkspaceFiles(workspaceId, Array.from(files));
        onChange([...uploads, ...stored]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChange, uploads, workspaceId],
  );

  const remove = useCallback(
    (upload: Upload) => {
      onChange(uploads.filter((entry) => entry.id !== upload.id));
      // Best effort: the prompt no longer references it either way, so a failed
      // delete leaves an orphaned file rather than a broken attachment.
      if (workspaceId) {
        void api.deleteUpload(workspaceId, upload.id).catch(() => undefined);
      }
    },
    [onChange, uploads, workspaceId],
  );

  return (
    <div className="attachment-bar">
      <input
        ref={fileRef}
        hidden
        multiple
        type="file"
        onChange={(event) => {
          const { files } = event.currentTarget;
          if (files) void addFiles(files);
          event.currentTarget.value = '';
        }}
      />

      {workspaceId ? (
        <button
          type="button"
          className="attach-button"
          disabled={disabled || busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? 'Uploading…' : 'Attach'}
        </button>
      ) : (
        <span className="attachment-hint">{noWorkspaceHint}</span>
      )}

      {uploads.map((upload) => (
        <span className="attachment" key={upload.id} title={upload.path}>
          {upload.kind === 'binary' ? '📎' : '📄'} {upload.name}
          <small> {formatBytes(upload.bytes)}</small>
          <button type="button" onClick={() => remove(upload)} aria-label={`Remove ${upload.name}`}>
            ×
          </button>
        </span>
      ))}

      {error && <span className="attachment-error">{error}</span>}
    </div>
  );
}
