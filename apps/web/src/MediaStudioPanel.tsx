import { useEffect, useMemo, useState } from 'react';
import { agentArtifactUrl } from './agent-artifacts';
import { api, type MediaCharacterInput, type MediaUpload, type MediaVideoJob, type ModelAlias, type Workspace } from './api';

const DURATIONS = [
  [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'],
  [600, '10 minutes'], [900, '15 minutes'], [1800, '30 minutes'],
] as const;

type CharacterDraft = MediaCharacterInput & { consent: boolean };

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function nextCharacter(index: number, imagePath: string): CharacterDraft {
  return {
    id: `character-${index + 1}`,
    name: `Character ${index + 1}`,
    imagePath,
    voice: { kind: 'stock', voice: 'af_heart' },
    consent: false,
  };
}

export function MediaStudioPanel({ aliases }: { aliases: ModelAlias[] }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [uploads, setUploads] = useState<MediaUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [imagePrompt, setImagePrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [imageSource, setImageSource] = useState('');
  const [imageOutput, setImageOutput] = useState('');
  const [imageArtifact, setImageArtifact] = useState<{ path: string }>();
  const [imageBusy, setImageBusy] = useState(false);
  const [videoPrompt, setVideoPrompt] = useState('');
  const [durationSeconds, setDurationSeconds] = useState<30 | 60 | 120 | 300 | 600 | 900 | 1800>(30);
  const [videoOutput, setVideoOutput] = useState('');
  const [alias, setAlias] = useState('chat');
  const [characters, setCharacters] = useState<CharacterDraft[]>([]);
  const [sceneReferences, setSceneReferences] = useState<string[]>([]);
  const [job, setJob] = useState<MediaVideoJob>();

  const images = useMemo(() => uploads.filter((upload) => upload.kind === 'image'), [uploads]);
  const audio = useMemo(() => uploads.filter((upload) => upload.kind === 'audio'), [uploads]);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);

  useEffect(() => {
    api.listWorkspaces().then(({ workspaces: list }) => {
      setWorkspaces(list);
      const writable = list.find((entry) => entry.capabilities.read && entry.capabilities.write) ?? list[0];
      if (writable) setWorkspaceId(writable.id);
    }).catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!job || !['queued', 'planning', 'rendering'].includes(job.status)) return;
    const timer = window.setInterval(() => {
      api.mediaVideo(job.id).then(({ job: next }) => setJob(next)).catch((reason) => setError(String(reason)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [job]);

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !workspaceId) return;
    setError(undefined); setNotice(undefined); setUploading(true);
    try {
      const saved: MediaUpload[] = [];
      for (const file of Array.from(files)) {
        if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} exceeds the 25 MB upload limit.`);
        const dataBase64 = await readAsDataUrl(file);
        const response = await api.uploadMedia({ workspaceId, name: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 });
        saved.push(response.upload);
      }
      setUploads((current) => [...current, ...saved]);
      const firstImage = saved.find((upload) => upload.kind === 'image');
      if (firstImage && characters.length === 0) setCharacters([nextCharacter(0, firstImage.path)]);
      setNotice(`${saved.length} media file${saved.length === 1 ? '' : 's'} added to this workspace.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setUploading(false); }
  };

  const generateImage = async () => {
    if (!workspaceId || !imagePrompt.trim()) return;
    setError(undefined); setNotice(undefined); setImageBusy(true);
    try {
      const result = await api.generateMediaImage({
        workspaceId, prompt: imagePrompt, negativePrompt, sourcePath: imageSource || undefined,
        outputName: imageOutput || undefined,
      });
      setImageArtifact({ path: result.artifact.path });
      setUploads((current) => [...current, { path: result.artifact.path, bytes: result.artifact.bytes, kind: 'image' }]);
      setNotice(imageSource ? 'Edited PNG created and available for character or scene selection.' : 'Generated PNG created and available for character or scene selection.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setImageBusy(false); }
  };

  const updateCharacter = (index: number, patch: Partial<CharacterDraft>) => {
    setCharacters((current) => current.map((character, itemIndex) => itemIndex === index ? { ...character, ...patch } : character));
  };

  const updateVoice = (index: number, patch: Partial<CharacterDraft['voice']>) => {
    setCharacters((current) => current.map((character, itemIndex) => itemIndex === index ? { ...character, voice: { ...character.voice, ...patch } } : character));
  };

  const createVideo = async () => {
    if (!workspaceId || !videoPrompt.trim() || !characters.length) return;
    setError(undefined); setNotice(undefined);
    try {
      const payload = characters.map(({ consent, voice, ...character }) => ({
        ...character,
        voice: { ...voice, consent: voice.kind === 'cloned' ? consent : undefined },
      }));
      const result = await api.createMediaVideo({
        workspaceId, prompt: videoPrompt, durationSeconds, alias, outputName: videoOutput || undefined,
        characters: payload, referencePaths: sceneReferences,
      });
      setJob(result.job);
      setNotice('Storyboard queued. You can keep working while the media service renders scenes.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return (
    <section className="media-studio" aria-label="Media Studio">
      <header className="media-studio-header">
        <div>
          <p className="eyebrow">DACAIS GPU MEDIA</p>
          <h1>Image &amp; Video Studio</h1>
          <p>Generate or edit PNGs, then use supplied character images and consented voice references in a narrated, scene-based MP4.</p>
        </div>
        <label className="media-workspace">
          Workspace
          <select value={workspaceId} onChange={(event) => {
            setWorkspaceId(event.target.value);
            setUploads([]); setCharacters([]); setSceneReferences([]); setImageSource(''); setImageArtifact(undefined); setJob(undefined);
          }}>
            <option value="">Select a workspace</option>
            {workspaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
          </select>
        </label>
      </header>

      {!workspace?.capabilities.write && workspaceId && <p className="media-warning">Select a workspace with read and write permission to upload or create media.</p>}
      {error && <p className="media-error" role="alert">{error}</p>}
      {notice && <p className="media-notice">{notice}</p>}

      <div className="media-grid">
        <article className="media-card media-assets">
          <h2>1. Upload source media</h2>
          <p className="muted">PNG, JPEG, WebP, WAV, MP3, M4A, OGG, or WebM · 25 MB per file. Uploads are stored only in the selected workspace.</p>
          <label className="media-upload">
            <input type="file" accept="image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/webm" multiple disabled={!workspace?.capabilities.write || uploading} onChange={(event) => { void uploadFiles(event.target.files); event.currentTarget.value = ''; }} />
            {uploading ? 'Uploading…' : 'Upload images or voice references'}
          </label>
          <div className="media-assets-list">
            {uploads.length === 0 ? <span className="muted">No uploaded or generated media yet.</span> : uploads.map((upload) => <code key={upload.path}>{upload.kind} · {upload.path}</code>)}
          </div>
        </article>

        <article className="media-card">
          <h2>2. Generate or edit an image</h2>
          <textarea value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="Describe the image, or how to edit the selected image…" rows={4} />
          <input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="Optional negative prompt" />
          <label>Image to edit (optional)
            <select value={imageSource} onChange={(event) => setImageSource(event.target.value)}>
              <option value="">Create a new image</option>
              {images.map((image) => <option key={image.path} value={image.path}>{image.path}</option>)}
            </select>
          </label>
          <input value={imageOutput} onChange={(event) => setImageOutput(event.target.value)} placeholder="Optional output filename" />
          <button type="button" className="primary" disabled={!workspace?.capabilities.write || !imagePrompt.trim() || imageBusy} onClick={() => void generateImage()}>{imageBusy ? 'Creating image…' : imageSource ? 'Edit image' : 'Generate image'}</button>
          {imageArtifact && workspaceId && <img className="media-image-preview" src={agentArtifactUrl(workspaceId, imageArtifact.path)} alt="Generated media artifact" />}
        </article>
      </div>

      <article className="media-card media-video-card">
        <h2>3. Create a narrated AI video</h2>
        <p className="muted">For long videos, DACAIS plans and renders short narrated scenes, then joins them on the GPU volume. Each scene has one speaking supplied character; dialogue alternates characters.</p>
        <textarea value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} placeholder="Example: Generate a presentation with the two supplied characters taking turns explaining a walk through a city park." rows={4} />
        <div className="media-video-options">
          <label>Length
            <select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value) as typeof durationSeconds)}>
              {DURATIONS.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
            </select>
          </label>
          <label>Storyboard model
            <select value={alias} onChange={(event) => setAlias(event.target.value)}>
              {aliases.map((entry) => <option key={entry.alias} value={entry.alias}>{entry.alias} — {entry.model}</option>)}
            </select>
          </label>
          <label>Output filename
            <input value={videoOutput} onChange={(event) => setVideoOutput(event.target.value)} placeholder="Optional .mp4 name" />
          </label>
        </div>

        <div className="media-character-list">
          <div className="media-section-heading"><h3>Characters and voices</h3><button type="button" disabled={!images.length || characters.length >= 6} onClick={() => setCharacters((current) => [...current, nextCharacter(current.length, images[0]?.path ?? '')])}>+ Add character</button></div>
          {characters.length === 0 && <p className="muted">Upload or generate an image, then add a character.</p>}
          {characters.map((character, index) => (
            <fieldset key={`${character.id}-${index}`} className="media-character">
              <legend>Character {index + 1}</legend>
              <label>Name<input value={character.name} onChange={(event) => updateCharacter(index, { name: event.target.value })} /></label>
              <label>Image
                <select value={character.imagePath} onChange={(event) => updateCharacter(index, { imagePath: event.target.value })}>
                  {images.map((image) => <option key={image.path} value={image.path}>{image.path}</option>)}
                </select>
              </label>
              <label>Voice type
                <select value={character.voice.kind} onChange={(event) => updateVoice(index, { kind: event.target.value as 'stock' | 'cloned' })}>
                  <option value="stock">Built-in voice</option><option value="cloned">Consented cloned voice</option>
                </select>
              </label>
              {character.voice.kind === 'stock' ? <label>Built-in voice<select value={character.voice.voice ?? 'af_heart'} onChange={(event) => updateVoice(index, { voice: event.target.value })}><option value="af_heart">af_heart</option><option value="af_bella">af_bella</option><option value="am_adam">am_adam</option></select></label> : <>
                <label>Voice ID<input value={character.voice.voiceId ?? ''} onChange={(event) => updateVoice(index, { voiceId: event.target.value })} placeholder="e.g. alex-voice" /></label>
                <label>Reference recording<select value={character.voice.referencePath ?? ''} onChange={(event) => updateVoice(index, { referencePath: event.target.value })}><option value="">Select uploaded audio</option>{audio.map((track) => <option key={track.path} value={track.path}>{track.path}</option>)}</select></label>
                <label className="media-consent"><input type="checkbox" checked={character.consent} onChange={(event) => updateCharacter(index, { consent: event.target.checked })} /> I have permission to use this voice recording for synthesis.</label>
              </>}
              <button type="button" className="danger" onClick={() => setCharacters((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
            </fieldset>
          ))}
        </div>

        <div className="media-references">
          <h3>Optional scene references</h3>
          <p className="muted">Choose uploaded/generated images that the storyboard can use as background scenes. A character image may also be a scene reference if you intend that.</p>
          {images.map((image) => <label key={image.path}><input type="checkbox" checked={sceneReferences.includes(image.path)} onChange={(event) => setSceneReferences((current) => event.target.checked ? [...current, image.path] : current.filter((path) => path !== image.path))} /> {image.path}</label>)}
        </div>

        <button type="button" className="primary media-create-video" disabled={!workspace?.capabilities.write || !videoPrompt.trim() || !characters.length || ['queued', 'planning', 'rendering'].includes(job?.status ?? '')} onClick={() => void createVideo()}>
          {job && ['queued', 'planning', 'rendering'].includes(job.status) ? 'Rendering video…' : 'Create video'}
        </button>
        {job && <div className={`media-job ${job.status}`}>
          <strong>{job.status === 'complete' ? 'Video complete' : `Video ${job.status}`}</strong>
          <span>{job.progress?.message ?? job.error ?? 'Waiting for the media service.'}</span>
          {job.progress && <progress value={job.progress.completed} max={Math.max(1, job.progress.total)} />}
          {['queued', 'planning', 'rendering'].includes(job.status) && <button type="button" className="danger" onClick={() => void api.cancelMediaVideo(job.id)}>Cancel</button>}
          {job.artifact && workspaceId && <video controls preload="metadata" src={agentArtifactUrl(workspaceId, job.artifact.path)}><track kind="captions" /></video>}
        </div>}
      </article>
    </section>
  );
}
