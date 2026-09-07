import { useCallback, useRef, useState } from 'react';
import { api, uploadWorkspaceFiles, type AttachmentRole, type Upload } from './api';

interface AttachmentBarProps {
  workspaceId?: string;
  uploads: Upload[];
  onChange: (uploads: Upload[]) => void;
  disabled?: boolean;
  noWorkspaceHint?: string;
  mediaRoles?: boolean;
}

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function withRole(stored: Upload[], role?: AttachmentRole): Upload[] {
  if (!role || role === 'file') return stored;
  return stored.map((upload) => ({ ...upload, role }));
}

function roleLabel(upload: Upload): string {
  if (upload.role === 'face') return 'Face';
  if (upload.role === 'character') return 'Character';
  if (upload.role === 'video') {
    return upload.targetFaceIndex === undefined ? 'Clip' : `Clip · person ${upload.targetFaceIndex + 1}`;
  }
  if (upload.role === 'image') return 'Image';
  return upload.kind === 'binary' ? 'File' : 'Text';
}

export function AttachmentBar({
  workspaceId,
  uploads,
  onChange,
  disabled,
  noWorkspaceHint = 'Select a workspace to attach files.',
  mediaRoles = false,
}: AttachmentBarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingRole, setPendingRole] = useState<AttachmentRole>('file');
  const [accept, setAccept] = useState<string | undefined>();

  const addFiles = useCallback(async (files: FileList, role: AttachmentRole) => {
    if (!workspaceId || files.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const stored = withRole(await uploadWorkspaceFiles(workspaceId, Array.from(files)), role);
      onChange([...uploads, ...stored]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onChange, uploads, workspaceId]);

  const pick = useCallback((role: AttachmentRole, acceptTypes?: string) => {
    setPendingRole(role);
    setAccept(acceptTypes);
    queueMicrotask(() => fileRef.current?.click());
  }, []);

  const remove = useCallback((upload: Upload) => {
    onChange(uploads.filter((entry) => entry.id !== upload.id));
    if (workspaceId) void api.deleteUpload(workspaceId, upload.id).catch(() => undefined);
  }, [onChange, uploads, workspaceId]);

  const setRole = useCallback((upload: Upload, role: AttachmentRole) => {
    onChange(uploads.map((entry) => (
      entry.id === upload.id
        ? { ...entry, role, targetFaceIndex: role === 'video' ? entry.targetFaceIndex : undefined }
        : entry
    )));
  }, [onChange, uploads]);

  const setPerson = useCallback((upload: Upload, index: number) => {
    onChange(uploads.map((entry) => (
      entry.id === upload.id ? { ...entry, role: 'video', targetFaceIndex: index } : entry
    )));
  }, [onChange, uploads]);

  const setSwapTarget = useCallback((upload: Upload, swapTargetId: string) => {
    onChange(uploads.map((entry) => (
      entry.id === upload.id ? { ...entry, role: 'face', swapTargetId: swapTargetId || undefined } : entry
    )));
  }, [onChange, uploads]);

  const imageRoles: AttachmentRole[] = ['image', 'face', 'character'];
  const faces = uploads.filter((upload) => upload.role === 'face');
  const characters = uploads.filter((upload) => upload.role === 'character');
  const clip = uploads.find((upload) => upload.role === 'video');

  return (
    <div className="attachment-bar">
      <input
        ref={fileRef}
        hidden
        multiple
        type="file"
        accept={accept}
        onChange={(event) => {
          const { files } = event.currentTarget;
          if (files) void addFiles(files, pendingRole);
          event.currentTarget.value = '';
        }}
      />
      {workspaceId ? (
        <div className="attach-actions" role="group" aria-label="Attach files">
          <button type="button" className="attach-button" disabled={disabled || busy} onClick={() => pick('file')}>
            {busy ? 'Uploading…' : 'Attach'}
          </button>
          {mediaRoles && (
            <>
              <button type="button" className="attach-button" disabled={disabled || busy} onClick={() => pick('image', IMAGE_ACCEPT)}>Image</button>
              <button type="button" className="attach-button attach-face" disabled={disabled || busy} onClick={() => pick('face', IMAGE_ACCEPT)}>Face</button>
              <button type="button" className="attach-button attach-video" disabled={disabled || busy} onClick={() => pick('video', VIDEO_ACCEPT)}>Video</button>
              <button type="button" className="attach-button attach-character" disabled={disabled || busy} onClick={() => pick('character', IMAGE_ACCEPT)}>Character</button>
            </>
          )}
        </div>
      ) : (
        <span className="attachment-hint">{noWorkspaceHint}</span>
      )}
      {uploads.map((upload) => {
        const isImage = upload.mimeType.startsWith('image/');
        const isVideo = upload.mimeType.startsWith('video/');
        return (
          <span className={`attachment role-${upload.role ?? 'file'}`} key={upload.id} title={upload.path}>
            <span className="attachment-role">{roleLabel(upload)}</span>
            <span className="attachment-name">{upload.name}</span>
            <small> {formatBytes(upload.bytes)}</small>
            {mediaRoles && isImage && (
              <select aria-label={`Role for ${upload.name}`} value={upload.role && imageRoles.includes(upload.role) ? upload.role : 'image'} disabled={disabled} onChange={(event) => setRole(upload, event.target.value as AttachmentRole)}>
                <option value="image">Image to edit</option>
                <option value="face">Face to apply</option>
                <option value="character">Person in clip</option>
              </select>
            )}
            {mediaRoles && upload.role === 'face' && (
              <select
                aria-label={`Swap ${upload.name} onto which person`}
                value={upload.swapTargetId ?? (faces.length === 1 && clip?.targetFaceIndex !== undefined ? `person:${clip.targetFaceIndex}` : `person:${faces.findIndex((entry) => entry.id === upload.id)}`)}
                disabled={disabled}
                onChange={(event) => setSwapTarget(upload, event.target.value)}
              >
                <option value="person:0">Onto leftmost person</option>
                <option value="person:1">Onto 2nd from left</option>
                <option value="person:2">Onto 3rd from left</option>
                <option value="person:3">Onto 4th from left</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>Onto {character.name}</option>
                ))}
              </select>
            )}
            {mediaRoles && isVideo && faces.length <= 1 && (
              <select aria-label={`Which person in ${upload.name} to replace`} value={upload.targetFaceIndex ?? 0} disabled={disabled} onChange={(event) => setPerson(upload, Number(event.target.value))}>
                <option value={0}>Leftmost person</option>
                <option value={1}>2nd from left</option>
                <option value={2}>3rd from left</option>
                <option value={3}>4th from left</option>
              </select>
            )}
            <button type="button" onClick={() => remove(upload)} aria-label={`Remove ${upload.name}`}>×</button>
          </span>
        );
      })}
      {error && <span className="attachment-error">{error}</span>}
      {mediaRoles && faces.length > 0 && clip && (
        <p className="attachment-map">
          {faces.map((face, index) => {
            const target = face.swapTargetId;
            const character = characters.find((entry) => entry.id === target);
            const person = target?.startsWith('person:') ? Number(target.slice(7)) : (faces.length === 1 ? clip.targetFaceIndex ?? 0 : index);
            const onto = character ? character.name : `person ${(Number.isInteger(person) ? person : 0) + 1} from left`;
            return `${face.name} → ${onto}`;
          }).join(' · ')}
        </p>
      )}
    </div>
  );
}
