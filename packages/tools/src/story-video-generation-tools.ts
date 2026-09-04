import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { resolveMediaConnection } from './media-connection';
import { mediaRequiresAnatomyPipeline } from './image-generation-tools';

export const STORY_VIDEO_DURATIONS = [30, 60, 120, 300, 600, 900, 1800] as const;
export type StoryVideoDuration = typeof STORY_VIDEO_DURATIONS[number];

export interface StoryVideoProgress {
  phase: 'preparing' | 'warming-voices' | 'rendering-segment' | 'assembling' | 'downloading';
  completed: number;
  total: number;
  message: string;
}

interface StoryVideoServices {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  onProgress?: (progress: StoryVideoProgress) => void;
}

interface Character {
  id: string;
  name: string;
  imagePath: string;
  voice: {
    kind: 'stock' | 'cloned';
    voice?: string;
    voiceId?: string;
    referencePath?: string;
    consent?: boolean;
  };
}

interface Segment {
  characterId: string;
  narration: string;
  visualPrompt: string;
  scenePath?: string;
}

const DEFAULT_SERVICES: StoryVideoServices = { env: process.env, fetch: globalThis.fetch };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_FINAL_VIDEO_BYTES = 1_500 * 1024 * 1024;
const MAX_TOTAL_NARRATION_CHARS = 60_000;

function requiredText(value: unknown, name: string, maximum: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum) throw new Error(`${name} must be 1–${maximum} characters.`);
  return text;
}

function workspacePath(
  ctx: ToolExecutionContext,
  requested: unknown,
  name: string,
  allowedExtensions: readonly string[],
): { absolute: string; relative: string } {
  if (!ctx.workspaceRoot) throw new Error('video.story.generate requires an active workspace.');
  const value = requiredText(requested, name, 600).replaceAll('\\', '/');
  if (isAbsolute(value)) throw new Error(`${name} must be workspace-relative.`);
  if (!allowedExtensions.includes(extname(value).toLowerCase())) {
    throw new Error(`${name} must have one of: ${allowedExtensions.join(', ')}.`);
  }
  const root = resolveWithinWorkspace(ctx.workspaceRoot, '.');
  let absolute: string;
  try { absolute = resolveWithinWorkspace(root, value); }
  catch { throw new Error(`${name} escaped the workspace.`); }
  return { absolute, relative: relative(root, absolute).replaceAll('\\', '/') };
}

function imageMime(path: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: throw new Error('Character and scene images must be PNG, JPEG, or WebP.');
  }
}

function audioMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.ogg': return 'audio/ogg';
    case '.webm': return 'audio/webm';
    default: throw new Error('A cloned-voice reference must be WAV, MP3, M4A, OGG, or WebM.');
  }
}

function parseCharacters(value: unknown): Character[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new Error('characters must contain 1–6 character entries.');
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`characters[${index}] is invalid.`);
    const record = item as Record<string, unknown>;
    const id = requiredText(record.id, `characters[${index}].id`, 50);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('Character IDs must be unique letters, digits, _ or -.');
    ids.add(id);
    const rawVoice = record.voice;
    if (!rawVoice || typeof rawVoice !== 'object' || Array.isArray(rawVoice)) throw new Error(`characters[${index}].voice is required.`);
    const voice = rawVoice as Record<string, unknown>;
    const kind = voice.kind === 'cloned' ? 'cloned' : voice.kind === 'stock' ? 'stock' : undefined;
    if (!kind) throw new Error(`characters[${index}].voice.kind must be stock or cloned.`);
    if (kind === 'cloned' && voice.consent !== true) {
      throw new Error(`Explicit consent is required to synthesize ${id}'s cloned voice.`);
    }
    return {
      id,
      name: requiredText(record.name, `characters[${index}].name`, 120),
      imagePath: requiredText(record.imagePath, `characters[${index}].imagePath`, 600),
      voice: {
        kind,
        voice: typeof voice.voice === 'string' ? voice.voice.trim().slice(0, 100) : undefined,
        voiceId: typeof voice.voiceId === 'string' ? voice.voiceId.trim().slice(0, 100) : undefined,
        referencePath: typeof voice.referencePath === 'string' ? voice.referencePath.trim().slice(0, 600) : undefined,
        consent: voice.consent === true,
      },
    };
  });
}

function parseSegments(value: unknown, characters: Character[], durationSeconds: number): Segment[] {
  const maximumSegments = Math.min(60, Math.max(1, Math.ceil(durationSeconds / 8)));
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumSegments) {
    throw new Error(`segments must contain 1–${maximumSegments} entries for this duration.`);
  }
  const validCharacters = new Set(characters.map((character) => character.id));
  let narrationChars = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`segments[${index}] is invalid.`);
    const record = item as Record<string, unknown>;
    const characterId = requiredText(record.characterId, `segments[${index}].characterId`, 50);
    if (!validCharacters.has(characterId)) throw new Error(`segments[${index}] references an unknown character.`);
    const narration = requiredText(record.narration, `segments[${index}].narration`, 5_000);
    narrationChars += narration.length;
    if (narrationChars > MAX_TOTAL_NARRATION_CHARS) throw new Error('Total narration must not exceed 60,000 characters.');
    return {
      characterId,
      narration,
      visualPrompt: requiredText(record.visualPrompt, `segments[${index}].visualPrompt`, 2_000),
      scenePath: typeof record.scenePath === 'string' && record.scenePath.trim() ? record.scenePath.trim() : undefined,
    };
  });
}

async function responseError(response: Response): Promise<string> {
  const message = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 600);
  return message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`;
}

async function mediaJson(
  services: StoryVideoServices,
  path: string,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const connection = resolveMediaConnection(services.env);
  const response = await services.fetch(`${connection.baseUrl}${path}`, {
    method: 'POST', redirect: 'error', headers: connection.headers, signal,
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`DACAIS media service ${path} failed: ${await responseError(response)}`);
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`DACAIS media service ${path} returned invalid JSON.`);
  return body as Record<string, unknown>;
}

function requiredBase64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`DACAIS media service returned no ${field}.`);
  return value;
}

async function readBounded(path: string, maximum: number, label: string): Promise<Buffer> {
  const data = await readFile(path);
  if (!data.byteLength || data.byteLength > maximum) throw new Error(`${label} is empty or exceeds ${Math.round(maximum / 1024 / 1024)} MB.`);
  return data;
}

async function downloadFinalVideo(
  services: StoryVideoServices,
  jobId: string,
  output: { absolute: string; relative: string },
  signal: AbortSignal | undefined,
): Promise<{ bytes: number; sha256: string }> {
  const connection = resolveMediaConnection(services.env);
  const response = await services.fetch(`${connection.baseUrl}/v1/artifacts/${encodeURIComponent(jobId)}/video`, {
    method: 'GET', redirect: 'error', headers: connection.headers, signal,
  });
  if (!response.ok) throw new Error(`DACAIS media final-video download failed: ${await responseError(response)}`);
  if (!response.body) throw new Error('DACAIS media final-video response had no body.');
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_FINAL_VIDEO_BYTES) throw new Error('The final video exceeds the 1.5 GB workspace limit.');
  await mkdir(dirname(output.absolute), { recursive: true });
  let bytes = 0;
  let header = Buffer.alloc(0);
  const hash = createHash('sha256');
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_FINAL_VIDEO_BYTES) { callback(new Error('The final video exceeds the 1.5 GB workspace limit.')); return; }
      if (header.byteLength < 12) header = Buffer.concat([header, chunk]).subarray(0, 12);
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), guard, createWriteStream(output.absolute, { flags: 'wx' }));
  } catch (error) {
    await unlink(output.absolute).catch(() => undefined);
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EEXIST') throw new Error('Video output already exists; choose a new outputPath.');
    throw error;
  }
  if (header.byteLength < 8 || header.subarray(4, 8).toString('ascii') !== 'ftyp') {
    await unlink(output.absolute).catch(() => undefined);
    throw new Error('The media service final artifact was not a valid MP4 file.');
  }
  return { bytes, sha256: hash.digest('hex') };
}

export function storyVideoGenerationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DACAI_VIDEO_BACKEND?.trim().toLowerCase() === 'dacais-media'
    && env.DACAI_IMAGE_BACKEND?.trim().toLowerCase() === 'dacais-media';
}

/** A managed loopback/SSH tunnel is local infrastructure; authenticated HTTPS is workspace network use. */
export function storyVideoGenerationRequiresNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DACAI_MEDIA_TRANSPORT?.trim().toLowerCase() === 'https';
}

/**
 * Renders a planned, multi-scene story. The media service retains intermediate
 * segments on the GPU volume, so a 30-minute result is never moved through the
 * API as one massive base64 payload.
 */
export function createStoryVideoGenerationTools(services: StoryVideoServices = DEFAULT_SERVICES): ToolDefinition[] {
  return [{
    name: 'video.story.generate',
    description: 'Render a permissioned multi-scene MP4 from workspace character images, optional consented cloned voices, and a bounded storyboard. The final verified MP4 is written inside the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        durationSeconds: { type: 'integer', enum: [...STORY_VIDEO_DURATIONS] },
        characters: { type: 'array', minItems: 1, maxItems: 6 },
        segments: { type: 'array', minItems: 1, maxItems: 60 },
        outputPath: { type: 'string', minLength: 1, maxLength: 600, pattern: '\\.mp4$' },
      },
      required: ['durationSeconds', 'characters', 'segments', 'outputPath'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    autoApprove: true,
    requiresRead: true,
    requiresWrite: true,
    requiresNetwork: storyVideoGenerationRequiresNetwork(services.env),
    timeoutMs: 7_200_000,
    async execute(input, ctx) {
      if (!storyVideoGenerationConfigured(services.env)) {
        throw new Error('Story video generation requires DACAI_IMAGE_BACKEND=dacais-media and DACAI_VIDEO_BACKEND=dacais-media.');
      }
      const durationSeconds = Number(input.durationSeconds);
      if (!STORY_VIDEO_DURATIONS.includes(durationSeconds as StoryVideoDuration)) {
        throw new Error(`durationSeconds must be one of ${STORY_VIDEO_DURATIONS.join(', ')}.`);
      }
      const output = workspacePath(ctx, input.outputPath, 'outputPath', ['.mp4']);
      const characters = parseCharacters(input.characters);
      const segments = parseSegments(input.segments, characters, durationSeconds);
      const characterMedia = new Map<string, { image: Buffer; mimeType: string; voiceReference?: Buffer; voiceMimeType?: string }>();
      services.onProgress?.({ phase: 'preparing', completed: 0, total: segments.length, message: 'Validating character and voice assets.' });
      for (const character of characters) {
        const image = workspacePath(ctx, character.imagePath, `${character.name} imagePath`, ['.png', '.jpg', '.jpeg', '.webp']);
        const asset: { image: Buffer; mimeType: string; voiceReference?: Buffer; voiceMimeType?: string } = {
          image: await readBounded(image.absolute, MAX_IMAGE_BYTES, `${character.name} image`),
          mimeType: imageMime(image.relative),
        };
        if (character.voice.kind === 'cloned') {
          if (!character.voice.voiceId || !character.voice.referencePath) throw new Error(`${character.name}'s cloned voice needs voiceId and referencePath.`);
          const reference = workspacePath(ctx, character.voice.referencePath, `${character.name} voice referencePath`, ['.wav', '.mp3', '.m4a', '.ogg', '.webm']);
          asset.voiceReference = await readBounded(reference.absolute, MAX_AUDIO_BYTES, `${character.name} voice reference`);
          asset.voiceMimeType = audioMime(reference.relative);
        }
        characterMedia.set(character.id, asset);
      }

      const storyId = `story-${randomUUID()}`;
      const connection = resolveMediaConnection(services.env);
      services.onProgress?.({ phase: 'warming-voices', completed: 0, total: characters.length, message: 'Preparing consented cloned voices.' });
      for (let index = 0; index < characters.length; index += 1) {
        const character = characters[index];
        const media = characterMedia.get(character.id)!;
        if (character.voice.kind === 'cloned') {
          await mediaJson(services, '/v1/voice/warm', {
            voiceId: character.voice.voiceId,
            referenceMimeType: media.voiceMimeType,
            referenceMediaBase64: media.voiceReference!.toString('base64'),
          }, ctx.signal);
        }
        services.onProgress?.({ phase: 'warming-voices', completed: index + 1, total: characters.length, message: `Prepared ${character.name}'s voice.` });
      }

      const segmentJobIds: string[] = [];
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const character = characters.find((candidate) => candidate.id === segment.characterId)!;
        const media = characterMedia.get(character.id)!;
        const segmentJobId = `${storyId}-s${index + 1}`;
        services.onProgress?.({ phase: 'rendering-segment', completed: index, total: segments.length, message: `Rendering scene ${index + 1} of ${segments.length} with ${character.name}.` });
        const audio = character.voice.kind === 'cloned'
          ? await mediaJson(services, '/v1/voice/clone-synthesize', {
              jobId: segmentJobId, text: segment.narration, voiceId: character.voice.voiceId,
              referenceMimeType: media.voiceMimeType, language: 'en', speed: 1,
            }, ctx.signal)
          : await mediaJson(services, '/v1/tts', {
              jobId: segmentJobId, text: segment.narration, voice: character.voice.voice || 'af_heart', speed: 1,
            }, ctx.signal);
        const audioBase64 = requiredBase64(audio.audioBase64, 'narration audio');
        const avatar = await mediaJson(services, '/v1/avatar', {
          jobId: segmentJobId,
          sourceMediaBase64: media.image.toString('base64'), sourceMimeType: media.mimeType,
          audioBase64,
        }, ctx.signal);
        let backdropBase64: string | undefined;
        if (segment.scenePath) {
          const scene = workspacePath(ctx, segment.scenePath, `segments[${index}].scenePath`, ['.png', '.jpg', '.jpeg', '.webp']);
          backdropBase64 = (await readBounded(scene.absolute, MAX_IMAGE_BYTES, `segments[${index}] scene image`)).toString('base64');
        } else {
          const backdrop = await mediaJson(
            services,
            mediaRequiresAnatomyPipeline(segment.visualPrompt) ? '/v1/anatomy-generate' : '/v1/generate-backdrop',
            {
            jobId: `${segmentJobId}-bg`, prompt: segment.visualPrompt,
            width: 1280, height: 720, steps: 28, guidanceScale: 6.5,
            },
            ctx.signal,
          );
          backdropBase64 = requiredBase64(backdrop.imageBase64, 'scene image');
        }
        await mediaJson(services, '/v1/compose', {
          jobId: segmentJobId,
          videoBase64: requiredBase64(avatar.videoBase64, 'avatar video'), audioBase64,
          backdropBase64, cutout: true, returnBase64: false,
        }, ctx.signal);
        segmentJobIds.push(segmentJobId);
        services.onProgress?.({ phase: 'rendering-segment', completed: index + 1, total: segments.length, message: `Finished scene ${index + 1} of ${segments.length}.` });
      }

      services.onProgress?.({ phase: 'assembling', completed: segments.length, total: segments.length, message: 'Joining rendered scenes on the media volume.' });
      await mediaJson(services, '/v1/concat-video', { jobId: storyId, segmentJobIds }, ctx.signal);
      services.onProgress?.({ phase: 'downloading', completed: segments.length, total: segments.length, message: 'Copying the verified final MP4 into the workspace.' });
      const written = await downloadFinalVideo(services, storyId, output, ctx.signal);
      return {
        path: output.relative,
        format: 'mp4',
        bytes: written.bytes,
        sha256: written.sha256,
        backend: 'dacais-media',
        jobId: storyId,
        durationRequestedSeconds: durationSeconds,
        segments: segmentJobIds.length,
        transport: connection.transport,
      };
    },
  }];
}

export const STORY_VIDEO_GENERATION_TOOLS: ToolDefinition[] = createStoryVideoGenerationTools();
