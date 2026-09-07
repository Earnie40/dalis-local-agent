import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { resolveMediaConnection } from './media-connection';
import { parseMediaIntent } from '@dacai-local-agent/shared';
import { decodeMp4, probeVideo, validateVideoConstraints, type VideoProbe } from './media-artifacts';

interface VideoGenerationServices {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  probeVideo?: VideoProbe;
}

const DEFAULT_SERVICES: VideoGenerationServices = { env: process.env, fetch: globalThis.fetch };
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

function requiredText(value: unknown, name: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) throw new Error(`${name} must be 1–${maxLength} characters.`);
  return text;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return result;
}

function decimal(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}.`);
  }
  return result;
}

function containedPath(ctx: ToolExecutionContext, requested: unknown, extension?: string): { absolute: string; relative: string } {
  if (!ctx.workspaceRoot) throw new Error('video.generate requires an active workspace.');
  const path = requiredText(requested, extension ? 'outputPath' : 'sourcePath', 600).replaceAll('\\', '/');
  if (extension && !path.toLowerCase().endsWith(extension)) throw new Error(`video.generate outputPath must end in ${extension}.`);
  if (isAbsolute(path)) throw new Error(`video.generate ${extension ? 'outputPath' : 'sourcePath'} must be workspace-relative.`);
  const root = resolveWithinWorkspace(ctx.workspaceRoot, '.');
  let absolute: string;
  try { absolute = resolveWithinWorkspace(root, path); }
  catch { throw new Error('Video path escaped the workspace.'); }
  return { absolute, relative: relative(root, absolute).replaceAll('\\', '/') };
}

function sourceMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  throw new Error('sourcePath must be a PNG, JPEG, or WebP image.');
}

async function responseError(response: Response): Promise<string> {
  const message = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
  return message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`;
}

export function videoGenerationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DACAI_VIDEO_BACKEND?.trim().toLowerCase() === 'dacais-media';
}

/** Loopback/SSH media traffic is managed infrastructure, not public network access. */
export function videoGenerationRequiresNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DACAI_VIDEO_BACKEND?.trim().toLowerCase() === 'dacais-media'
    && env.DACAI_MEDIA_TRANSPORT?.trim().toLowerCase() === 'https';
}

export function createVideoGenerationTools(services: VideoGenerationServices = DEFAULT_SERVICES): ToolDefinition[] {
  return [{
    name: 'video.generate',
    description:
      'Generate a short photoreal MP4 from a text prompt, or animate an uploaded workspace image, using the DACAIS-owned GPU media service. ' +
      'The verified MP4 is written inside the active workspace and never overwrites an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000 },
        intent: { type: 'object', description: 'Validated structured video intent and constraints.' },
        correction: { type: 'string', maxLength: 2000 },
        loop: { type: 'boolean', default: false },
        sourcePath: { type: 'string', minLength: 1, maxLength: 600, description: 'Optional workspace-relative PNG, JPEG, or WebP to animate.' },
        outputPath: { type: 'string', minLength: 1, maxLength: 600, pattern: '\\.mp4$' },
        negativePrompt: { type: 'string', maxLength: 2000 },
        width: { type: 'integer', minimum: 512, maximum: 1536, default: 1024 },
        height: { type: 'integer', minimum: 512, maximum: 1536, default: 576 },
        steps: { type: 'integer', minimum: 1, maximum: 100, default: 28 },
        guidance: { type: 'number', minimum: 1, maximum: 30, default: 6.5 },
        seed: { type: 'integer', minimum: -1, maximum: 2147483647, default: -1 },
        frames: { type: 'integer', minimum: 5, maximum: 121, default: 121, description: 'Frames per Wan segment; long videos use newly generated continuation segments.' },
        durationSeconds: { type: 'number', minimum: 1, maximum: 120, default: 30, description: 'Requested output duration. Segments must progress temporally unless looping is explicitly requested.' },
        motionBucket: { type: 'integer', minimum: 1, maximum: 255, default: 60 },
        noiseAug: { type: 'number', minimum: 0, maximum: 1, default: 0.02 },
        sourceFps: { type: 'integer', minimum: 8, maximum: 24, default: 16 },
      },
      required: ['outputPath'],
      anyOf: [{ required: ['prompt'] }, { required: ['sourcePath'] }],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    autoApprove: true,
    requiresRead: true,
    requiresWrite: true,
    requiresNetwork: videoGenerationRequiresNetwork(services.env),
    timeoutMs: 1_800_000,
    async execute(input, ctx) {
      if (!videoGenerationConfigured(services.env)) {
        throw new Error('Video generation is not enabled. Set DACAI_VIDEO_BACKEND=dacais-media.');
      }
      const output = containedPath(ctx, input.outputPath, '.mp4');
      const source = input.sourcePath === undefined ? undefined : containedPath(ctx, input.sourcePath);
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (!source && !prompt.trim()) throw new Error('prompt is required when sourcePath is not provided.');
      if (prompt.length > 4000) throw new Error('prompt must be 4000 characters or fewer.');
      const intent = input.intent === undefined ? undefined : parseMediaIntent(input.intent);
      if (intent && intent.kind !== 'video') throw new Error('Video intent must describe a video.');
      const width = integer(input.width ?? intent?.constraints.width, 1024, 512, 1536, 'width');
      const height = integer(input.height ?? intent?.constraints.height, 576, 512, 1536, 'height');
      const durationSeconds = decimal(input.durationSeconds ?? intent?.constraints.durationSeconds, 30, 1, 120, 'durationSeconds');
      if (intent && ((intent.constraints.width !== undefined && width !== intent.constraints.width) || (intent.constraints.height !== undefined && height !== intent.constraints.height) || (intent.constraints.durationSeconds !== undefined && durationSeconds !== intent.constraints.durationSeconds))) throw new Error('Video constraints conflict with the structured intent.');
      if (input.loop !== undefined && typeof input.loop !== 'boolean') throw new Error('loop must be a boolean.');
      if (intent && input.loop !== undefined && input.loop !== intent.constraints.loop) throw new Error('loop conflicts with the structured intent.');
      if (input.correction !== undefined && (typeof input.correction !== 'string' || input.correction.length > 2000)) throw new Error('correction must be at most 2000 characters.');

      let sourceData: Buffer | undefined;
      let mimeType: string | undefined;
      if (source) {
        mimeType = sourceMimeType(source.relative);
        sourceData = await readFile(source.absolute);
        if (!sourceData.byteLength || sourceData.byteLength > MAX_SOURCE_BYTES) {
          throw new Error('The source image is empty or exceeds the 25 MB limit.');
        }
      }

      if (input.negativePrompt !== undefined && (typeof input.negativePrompt !== 'string' || input.negativePrompt.length > 2000)) throw new Error('negativePrompt must be at most 2000 characters.');
      const connection = resolveMediaConnection(services.env);
      const base = connection.baseUrl;
      const textToVideo = Boolean(prompt);
      const anatomyRequest = intent?.requiresBodyGeometry === true;
      const response = await services.fetch(`${base}${textToVideo ? '/v1/anatomy-video' : '/v1/animate-image'}`, {
        method: 'POST',
        redirect: 'error',
        headers: connection.headers,
        signal: ctx.signal,
        body: JSON.stringify({
          jobId: `agent-${randomUUID()}`,
          prompt,
          negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt : '',
          width, height, intent,
          correction: input.correction,
          loop: intent?.constraints.loop ?? input.loop ?? false,
          steps: integer(input.steps, 28, 1, 100, 'steps'),
          guidanceScale: decimal(input.guidance, 6.5, 1, 30, 'guidance'),
          seed: integer(input.seed, -1, -1, 2147483647, 'seed') === -1 ? undefined : Number(input.seed),
          frames: integer(input.frames, 121, 5, 121, 'frames'),
          durationSeconds,
          motionBucket: integer(input.motionBucket, 60, 1, 255, 'motionBucket'),
          noiseAug: decimal(input.noiseAug, 0.02, 0, 1, 'noiseAug'),
          sourceFps: integer(input.sourceFps, 16, 8, 24, 'sourceFps'),
          animate: true,
          mode: anatomyRequest ? 'anatomy' : 'auto',
          sourceMediaBase64: sourceData?.toString('base64'),
          sourceMimeType: mimeType,
        }),
      });
      if (!response.ok) throw new Error(`DACAIS media video backend failed: ${await responseError(response)}`);
      const body = await response.json() as {
        videoBase64?: unknown; videoModel?: unknown; model?: unknown; videoFrames?: unknown; peakVramMb?: unknown;
        anatomyValidation?: unknown;
      };
      const video = decodeMp4(body.videoBase64, MAX_VIDEO_BYTES);
      await mkdir(dirname(output.absolute), { recursive: true });
      await writeFile(output.absolute, video, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new Error('Video output already exists; choose a new outputPath.');
        throw error;
      });
      let metadata;
      try {
        metadata = await (services.probeVideo ?? probeVideo)(output.absolute, ctx.signal);
        validateVideoConstraints(metadata, { width, height, durationSeconds });
      } catch (error) {
        await unlink(output.absolute).catch(() => undefined);
        throw error;
      }
      return {
        ...metadata,
        path: output.relative,
        format: 'mp4',
        bytes: video.byteLength,
        sha256: createHash('sha256').update(video).digest('hex'),
        backend: 'dacais-media',
        model: typeof body.videoModel === 'string' ? body.videoModel : body.model,
        method: textToVideo ? 'wan' : 'svd',
        peakVramMb: typeof body.peakVramMb === 'number' ? body.peakVramMb : undefined,
        anatomyValidation: anatomyRequest && body.anatomyValidation && typeof body.anatomyValidation === 'object'
          ? body.anatomyValidation
          : undefined,
      };
    },
  }];
}

export const VIDEO_GENERATION_TOOLS: ToolDefinition[] = createVideoGenerationTools();
