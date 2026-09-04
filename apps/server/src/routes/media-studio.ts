import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PermissionAuditStore } from '@dacai-local-agent/shared';
import {
  StructuredGenerationError,
  StructuredGenerator,
  withModelRequestSlot,
  type ProviderRegistry,
} from '@dacai-local-agent/providers';
import { PermissionEngine, resolveWithinWorkspace } from '@dacai-local-agent/security';
import { PostgresWorkspaceRegistry, type WorkspaceDescriptor } from '@dacai-local-agent/workspace';
import {
  createImageGenerationTools,
  createStoryVideoGenerationTools,
  PermissionedToolExecutor,
  ToolRegistry,
  type StoryVideoProgress,
  type ToolDefinition,
} from '@dacai-local-agent/tools';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.ogg', '.webm'] as const;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MEDIA_DIR = 'generated/media-inputs';

const ImageRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4_000),
  negativePrompt: z.string().trim().max(2_000).optional(),
  sourcePath: z.string().trim().min(1).max(600).optional(),
  outputName: z.string().trim().min(1).max(100).optional(),
  width: z.number().int().min(256).max(1536).default(1024),
  height: z.number().int().min(256).max(1536).default(1024),
  strength: z.number().min(.05).max(1).default(.65),
}).strict();

const UploadSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(100),
  dataBase64: z.string().min(1).max(Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 32),
}).strict();

const VoiceSchema = z.object({
  kind: z.enum(['stock', 'cloned']),
  voice: z.string().trim().min(1).max(100).optional(),
  voiceId: z.string().trim().min(1).max(100).optional(),
  referencePath: z.string().trim().min(1).max(600).optional(),
  consent: z.boolean().optional(),
}).strict();

const CharacterSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(50),
  name: z.string().trim().min(1).max(120),
  imagePath: z.string().trim().min(1).max(600),
  voice: VoiceSchema,
}).strict();

const VideoRequestSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4_000),
  durationSeconds: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(300), z.literal(600), z.literal(900), z.literal(1800)]),
  alias: z.string().trim().min(1).max(100).default('chat'),
  outputName: z.string().trim().min(1).max(100).optional(),
  characters: z.array(CharacterSchema).min(1).max(6),
  referencePaths: z.array(z.string().trim().min(1).max(600)).max(12).default([]),
}).strict().superRefine((request, context) => {
  if (new Set(request.characters.map((character) => character.id)).size !== request.characters.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Character IDs must be unique.', path: ['characters'] });
  }
  for (const [index, character] of request.characters.entries()) {
    if (character.voice.kind === 'cloned' && (!character.voice.voiceId || !character.voice.referencePath || character.voice.consent !== true)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'A cloned voice needs an ID, a reference recording, and explicit consent.', path: ['characters', index, 'voice'] });
    }
  }
});

const StoryboardSegmentSchema = z.object({
  characterId: z.string().trim().min(1).max(50),
  narration: z.string().trim().min(1).max(5_000),
  visualPrompt: z.string().trim().min(1).max(2_000),
  sceneReferenceIndex: z.number().int().min(-1).max(11).default(-1),
}).strict();

const StoryboardSchema = z.object({
  title: z.string().trim().min(1).max(160),
  segments: z.array(StoryboardSegmentSchema).min(1).max(60),
}).strict();

export interface MediaStudioJob {
  id: string;
  workspaceId: string;
  kind: 'video';
  status: 'queued' | 'planning' | 'rendering' | 'complete' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  progress?: StoryVideoProgress;
  error?: string;
  artifact?: { path: string; bytes: number; sha256: string; durationRequestedSeconds: number; segments: number };
}

export interface StoryboardInput {
  prompt: string;
  durationSeconds: number;
  characters: Array<{ id: string; name: string }>;
  referenceCount: number;
  alias: string;
  signal: AbortSignal;
}

export type GenerateStoryboard = (input: StoryboardInput) => Promise<z.infer<typeof StoryboardSchema>>;

interface MediaSupervisor {
  ensureImageReady(): Promise<{ ready: boolean; error?: string }>;
  ensureVideoReady(): Promise<{ ready: boolean; error?: string }>;
}

interface MediaStudioDependencies {
  registry?: ProviderRegistry;
  media: MediaSupervisor;
  generateStoryboard?: GenerateStoryboard;
}

function cleanOutputName(value: string | undefined, extension: '.png' | '.mp4', fallback: string): string {
  const candidate = (value?.trim() || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const base = candidate.replace(new RegExp(`${extension.replace('.', '\\.')}$`, 'i'), '') || fallback;
  return `${base}${extension}`;
}

function extensionForUpload(name: string, mimeType: string): string | undefined {
  const extension = extname(basename(name)).toLowerCase();
  if ([...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS].includes(extension as never)) return extension;
  const mime = mimeType.toLowerCase();
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return '.wav';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'audio/mp4') return '.m4a';
  if (mime === 'audio/ogg') return '.ogg';
  if (mime === 'audio/webm') return '.webm';
  return undefined;
}

function looksLikeImage(data: Buffer, extension: string): boolean {
  if (extension === '.png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === '.jpg' || extension === '.jpeg') return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (extension === '.webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  return true;
}

function workspaceRelativePath(workspace: WorkspaceDescriptor, requested: string, label: string): string {
  const value = requested.replaceAll('\\', '/');
  if (isAbsolute(value)) throw new Error(`${label} must be workspace-relative.`);
  try {
    const absolute = resolveWithinWorkspace(workspace.rootPath, value);
    return relative(resolveWithinWorkspace(workspace.rootPath, '.'), absolute).replaceAll('\\', '/');
  } catch { throw new Error(`${label} is outside the selected workspace.`); }
}

function makeStoryboardGenerator(deps: MediaStudioDependencies): GenerateStoryboard {
  if (deps.generateStoryboard) return deps.generateStoryboard;
  if (!deps.registry) throw new Error('Media Studio needs a provider registry or storyboard generator.');
  const generator = new StructuredGenerator(deps.registry);
  return async (input) => {
    const targetSegments = Math.max(1, Math.ceil(input.durationSeconds / 30));
    const result = await withModelRequestSlot(() => generator.generate({
      alias: input.alias,
      fallbackAlias: input.alias === 'chat' ? undefined : 'chat',
      schema: StoryboardSchema,
      jsonSchema: {
        type: 'object', additionalProperties: false, required: ['title', 'segments'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          segments: {
            type: 'array', minItems: targetSegments, maxItems: targetSegments,
            items: {
              type: 'object', additionalProperties: false,
              required: ['characterId', 'narration', 'visualPrompt', 'sceneReferenceIndex'],
              properties: {
                characterId: { type: 'string', enum: input.characters.map((character) => character.id) },
                narration: { type: 'string', minLength: 1, maxLength: 5_000 },
                visualPrompt: { type: 'string', minLength: 1, maxLength: 2_000 },
                sceneReferenceIndex: { type: 'integer', minimum: -1, maximum: Math.max(-1, input.referenceCount - 1) },
              },
            },
          },
        },
      },
      system: `You plan safe, realistic narrated video scenes for DACAIS Media Studio. Return JSON only. The renderer presents ONE supplied character at a time over an image backdrop, so use alternating characterId values for dialogue and never claim two supplied people are physically moving together in the same generated shot. Preserve the user's intended setting, actions, presentation points, and order. Each visualPrompt describes only the location, lighting, props, and camera composition behind the presenter; do not add people, text, watermarks, brands, celebrities, or real-person likenesses. Narration must be natural speech sized for roughly ${Math.round(input.durationSeconds / targetSegments)} seconds per scene. Select a non-negative sceneReferenceIndex only when a supplied reference is useful as the scene backdrop.`,
      user: JSON.stringify({ request: input.prompt, durationSeconds: input.durationSeconds, targetSegments, characters: input.characters, suppliedSceneReferenceCount: input.referenceCount }),
      temperature: .35,
      maxTokens: Math.min(12_000, 1_200 + targetSegments * 500),
      contextWindowTokens: 32_000,
      workerRole: 'media-storyboard-planner',
      signal: input.signal,
    }));
    const parsed = StoryboardSchema.safeParse(result.value);
    if (!parsed.success) throw new Error('The selected model did not return a valid video storyboard.');
    return parsed.data;
  };
}

function makeExecutor(workspace: WorkspaceDescriptor, auditStore: PermissionAuditStore, tools: ToolDefinition[], taskId: string): PermissionedToolExecutor {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return new PermissionedToolExecutor({
    registry,
    engine: new PermissionEngine({ autoApprove: ['safe', 'mutation'], requireApproval: ['high-impact'], deny: [] }),
    capabilities: workspace.capabilities,
    context: { workspaceId: workspace.id, workspaceRoot: workspace.rootPath, taskId },
    audit: {
      record: (entry) => auditStore.record({
        workspaceId: workspace.id, taskId, toolName: entry.toolName, tier: entry.decision.tier,
        decision: entry.decision.kind, reason: entry.decision.reason, input: entry.input,
      }),
    },
  });
}

function toolResult<T extends Record<string, unknown>>(result: { success: boolean; output: string }): T {
  if (!result.success) throw new Error(result.output.replace(/^Error from [^:]+:\s*/, ''));
  try { return JSON.parse(result.output) as T; }
  catch { throw new Error('The media tool completed without a parseable artifact result.'); }
}

function mediaError(error: unknown): { status: number; message: string } {
  if (error instanceof StructuredGenerationError) {
    return { status: error.code === 'unresolvable' ? 400 : 503, message: 'The selected planning model could not create a valid storyboard.' };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 503, message: message.slice(0, 600) || 'Media generation is unavailable.' };
}

/** UI-facing image/video routes. Generation always runs through the same permissioned tool executor as the agent. */
export function registerMediaStudioRoutes(server: FastifyInstance, deps: MediaStudioDependencies): void {
  const workspaces = new PostgresWorkspaceRegistry();
  const auditStore = new PermissionAuditStore();
  const storyboard = makeStoryboardGenerator(deps);
  const jobs = new Map<string, MediaStudioJob>();
  const controllers = new Map<string, AbortController>();

  server.post('/api/media/uploads', async (request, reply) => {
    const parsed = UploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid media upload.' });
    const workspace = await workspaces.get(parsed.data.workspaceId);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });
    if (!workspace.capabilities.read || !workspace.capabilities.write) return reply.code(403).send({ error: 'The selected workspace needs read and write permission for uploads.' });
    const extension = extensionForUpload(parsed.data.name, parsed.data.mimeType);
    if (!extension) return reply.code(400).send({ error: 'Upload a PNG, JPEG, WebP, WAV, MP3, M4A, OGG, or WebM file.' });
    let data: Buffer;
    try { data = Buffer.from(parsed.data.dataBase64.replace(/^data:[^;]+;base64,/i, ''), 'base64'); }
    catch { return reply.code(400).send({ error: 'Upload data is not valid base64.' }); }
    if (!data.byteLength || data.byteLength > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: 'Each media upload must be between 1 byte and 25 MB.' });
    if (!looksLikeImage(data, extension)) return reply.code(400).send({ error: 'The file content does not match its declared image type.' });
    const id = randomUUID();
    const path = `${MEDIA_DIR}/${id}${extension}`;
    const absolute = resolveWithinWorkspace(workspace.rootPath, path);
    await mkdir(resolveWithinWorkspace(workspace.rootPath, MEDIA_DIR), { recursive: true });
    await writeFile(absolute, data, { flag: 'wx' });
    await auditStore.record({ workspaceId: workspace.id, taskId: `media-upload-${id}`, toolName: 'media.upload', tier: 'mutation', decision: 'allowed', reason: 'Explicit UI upload to an authorized writable workspace.', input: { path, extension, bytes: data.byteLength } });
    return { upload: { path, bytes: data.byteLength, kind: IMAGE_EXTENSIONS.includes(extension as never) ? 'image' : 'audio' } };
  });

  server.post('/api/media/images', async (request, reply) => {
    const parsed = ImageRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid image request.' });
    const workspace = await workspaces.get(parsed.data.workspaceId);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });
    try {
      if (parsed.data.sourcePath) workspaceRelativePath(workspace, parsed.data.sourcePath, 'sourcePath');
      const ready = await deps.media.ensureImageReady();
      if (!ready.ready) throw new Error(ready.error ?? 'The GPU image service is not ready.');
      const taskId = `media-image-${randomUUID()}`;
      const executor = makeExecutor(workspace, auditStore, createImageGenerationTools(), taskId);
      const outputPath = `generated/images/${cleanOutputName(parsed.data.outputName, '.png', `image-${Date.now()}`)}`;
      const artifact = toolResult<{ path: string; bytes: number; sha256: string; model?: string }>(await executor.execute({
        id: randomUUID(), name: 'image.generate', arguments: {
          prompt: parsed.data.prompt, negativePrompt: parsed.data.negativePrompt ?? '', sourcePath: parsed.data.sourcePath,
          outputPath, width: parsed.data.width, height: parsed.data.height, strength: parsed.data.strength,
        },
      }));
      return { artifact };
    } catch (error) {
      const result = mediaError(error);
      return reply.code(result.status).send({ error: result.message });
    }
  });

  server.post('/api/media/videos', async (request, reply) => {
    const parsed = VideoRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid video request.', details: parsed.error.flatten() });
    const workspace = await workspaces.get(parsed.data.workspaceId);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });
    if (!workspace.capabilities.read || !workspace.capabilities.write) return reply.code(403).send({ error: 'The selected workspace needs read and write permission for video generation.' });
    try {
      for (const character of parsed.data.characters) {
        workspaceRelativePath(workspace, character.imagePath, `${character.name} imagePath`);
        if (character.voice.referencePath) workspaceRelativePath(workspace, character.voice.referencePath, `${character.name} referencePath`);
      }
      for (const reference of parsed.data.referencePaths) workspaceRelativePath(workspace, reference, 'referencePath');
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Invalid workspace media path.' });
    }
    const id = `media-video-${randomUUID()}`;
    const job: MediaStudioJob = { id, workspaceId: workspace.id, kind: 'video', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const controller = new AbortController();
    jobs.set(id, job); controllers.set(id, controller);
    const update = (patch: Partial<MediaStudioJob>) => Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    void (async () => {
      try {
        update({ status: 'planning' });
        const imageReady = await deps.media.ensureImageReady();
        if (!imageReady.ready) throw new Error(imageReady.error ?? 'The GPU image service is not ready.');
        const ready = await deps.media.ensureVideoReady();
        if (!ready.ready) throw new Error(ready.error ?? 'The GPU video service is not ready.');
        const plan = await storyboard({
          prompt: parsed.data.prompt, durationSeconds: parsed.data.durationSeconds,
          characters: parsed.data.characters.map(({ id: characterId, name }) => ({ id: characterId, name })),
          referenceCount: parsed.data.referencePaths.length, alias: parsed.data.alias, signal: controller.signal,
        });
        const segments = plan.segments.map((segment) => ({
          characterId: segment.characterId, narration: segment.narration, visualPrompt: segment.visualPrompt,
          scenePath: segment.sceneReferenceIndex >= 0 ? parsed.data.referencePaths[segment.sceneReferenceIndex] : undefined,
        }));
        update({ status: 'rendering', progress: { phase: 'preparing', completed: 0, total: segments.length, message: `Rendering ${plan.title}.` } });
        const executor = makeExecutor(workspace, auditStore, createStoryVideoGenerationTools({
          env: process.env, fetch: globalThis.fetch,
          onProgress: (progress) => update({ progress }),
        }), id);
        const artifact = toolResult<{ path: string; bytes: number; sha256: string; durationRequestedSeconds: number; segments: number }>(await executor.execute({
          id: randomUUID(), name: 'video.story.generate', arguments: {
            durationSeconds: parsed.data.durationSeconds,
            characters: parsed.data.characters,
            segments,
            outputPath: `generated/videos/${cleanOutputName(parsed.data.outputName, '.mp4', `video-${Date.now()}`)}`,
          },
        }, controller.signal));
        update({ status: 'complete', artifact, progress: { phase: 'downloading', completed: artifact.segments, total: artifact.segments, message: 'Final MP4 is ready in the workspace.' } });
      } catch (error) {
        if (controller.signal.aborted) update({ status: 'cancelled', error: 'Video generation was cancelled.' });
        else update({ status: 'failed', error: mediaError(error).message });
      } finally {
        controllers.delete(id);
      }
    })();
    return reply.code(202).send({ job });
  });

  server.get<{ Params: { id: string } }>('/api/media/videos/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'Media job not found.' });
    return { job };
  });

  server.post<{ Params: { id: string } }>('/api/media/videos/:id/cancel', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'Media job not found.' });
    controllers.get(job.id)?.abort();
    return { cancelled: true };
  });
}
