import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { resolveMediaConnection } from './media-connection';
import { decodeMp4, probeVideo, validateVideoConstraints, type VideoMetadata, type VideoProbe } from './media-artifacts';

interface FaceSwapServices {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  probeVideo?: VideoProbe;
}

const DEFAULT_SERVICES: FaceSwapServices = { env: process.env, fetch: globalThis.fetch };
const MAX_FACE_BYTES = 25 * 1024 * 1024;
const MAX_TARGET_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SECONDS = 120;

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const VIDEO_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

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

function containedPath(ctx: ToolExecutionContext, requested: unknown, name: string): { absolute: string; relative: string } {
  if (!ctx.workspaceRoot) throw new Error('video.faceSwap requires an active workspace.');
  const path = requiredText(requested, name, 600).replaceAll('\\', '/');
  if (isAbsolute(path)) throw new Error(`video.faceSwap ${name} must be workspace-relative.`);
  const root = resolveWithinWorkspace(ctx.workspaceRoot, '.');
  let absolute: string;
  try { absolute = resolveWithinWorkspace(root, path); }
  catch { throw new Error('Face swap path escaped the workspace.'); }
  return { absolute, relative: relative(root, absolute).replaceAll('\\', '/') };
}

function mimeType(path: string, table: Record<string, string>, message: string): string {
  const type = table[extname(path).toLowerCase()];
  if (!type) throw new Error(message);
  return type;
}

async function boundedFile(absolute: string, maxBytes: number, name: string): Promise<Buffer> {
  const data = await readFile(absolute);
  if (!data.byteLength || data.byteLength > maxBytes) {
    throw new Error(`${name} is empty or exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
  return data;
}

async function responseError(response: Response): Promise<string> {
  const message = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
  return message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`;
}

export function faceSwapConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DACAI_VIDEO_BACKEND?.trim().toLowerCase() === 'dacais-media';
}

/** Loopback/SSH media traffic is managed infrastructure, not public network access. */
export function faceSwapRequiresNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  return faceSwapConfigured(env) && env.DACAI_MEDIA_TRANSPORT?.trim().toLowerCase() === 'https';
}

/** Bound the GPU cost of a swap: every frame of the target is re-rendered. */
export function faceSwapMaxSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.DACAI_FACE_SWAP_MAX_SECONDS?.trim() || DEFAULT_MAX_SECONDS);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_SECONDS;
  return Math.min(600, configured);
}

export function createFaceSwapTools(services: FaceSwapServices = DEFAULT_SERVICES): ToolDefinition[] {
  return [{
    name: 'video.faceSwap',
    description:
      'Replace one character’s face in a workspace video with the face from a workspace image, using the DACAIS-owned GPU media service. '
      + 'Pass the face photo as facePath and the target clip as videoPath; both must already exist in the workspace, and an attachment is stored under .dacai/uploads. '
      + 'When the clip shows several people, identify the character to replace with targetReferencePath (a still of that person) or targetFaceIndex. '
      + 'Every frame keeps its original motion, lighting, and audio; only the selected identity changes. '
      + 'The verified MP4 is written inside the active workspace and never overwrites an existing file. '
      + 'Use this only on footage the user is authorized to alter, and keep the synthetic-media tag the service writes into the result.',
    inputSchema: {
      type: 'object',
      properties: {
        facePath: { type: 'string', minLength: 1, maxLength: 600, description: 'Workspace-relative PNG, JPEG, or WebP holding the face to apply.' },
        videoPath: { type: 'string', minLength: 1, maxLength: 600, description: 'Workspace-relative MP4, WebM, or MOV to edit.' },
        outputPath: { type: 'string', minLength: 1, maxLength: 600, pattern: '\\.mp4$' },
        targetReferencePath: { type: 'string', minLength: 1, maxLength: 600, description: 'Optional still of the character in the video whose face is replaced. Preferred over targetFaceIndex when the clip has several people.' },
        targetFaceIndex: { type: 'integer', minimum: 0, maximum: 15, default: 0, description: 'Which detected character to replace when no reference is given, ordered left to right in the first frame that shows a face.' },
        similarityThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.35, description: 'Minimum embedding similarity for a detected face to count as the tracked character.' },
        restoreFaces: { type: 'boolean', default: true, description: 'Run the face restorer over the swapped region for sharper detail at some GPU cost.' },
        keepAudio: { type: 'boolean', default: true, description: 'Copy the original audio track into the result.' },
      },
      required: ['facePath', 'videoPath', 'outputPath'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    autoApprove: true,
    requiresRead: true,
    requiresWrite: true,
    requiresNetwork: faceSwapRequiresNetwork(services.env),
    timeoutMs: 1_800_000,
    async execute(input, ctx) {
      if (!faceSwapConfigured(services.env)) {
        throw new Error('Face swapping is not enabled. Set DACAI_VIDEO_BACKEND=dacais-media.');
      }
      const output = containedPath(ctx, input.outputPath, 'outputPath');
      if (!output.relative.toLowerCase().endsWith('.mp4')) throw new Error('video.faceSwap outputPath must end in .mp4.');
      const face = containedPath(ctx, input.facePath, 'facePath');
      const target = containedPath(ctx, input.videoPath, 'videoPath');
      const reference = input.targetReferencePath === undefined
        ? undefined
        : containedPath(ctx, input.targetReferencePath, 'targetReferencePath');

      const faceMimeType = mimeType(face.relative, IMAGE_MIME_TYPES, 'facePath must be a PNG, JPEG, or WebP image.');
      const targetMimeType = mimeType(target.relative, VIDEO_MIME_TYPES, 'videoPath must be an MP4, WebM, or MOV video.');
      const referenceMimeType = reference && mimeType(reference.relative, IMAGE_MIME_TYPES, 'targetReferencePath must be a PNG, JPEG, or WebP image.');

      const faceData = await boundedFile(face.absolute, MAX_FACE_BYTES, 'The face image');
      const targetData = await boundedFile(target.absolute, MAX_TARGET_BYTES, 'The target video');
      const referenceData = reference && await boundedFile(reference.absolute, MAX_FACE_BYTES, 'The target reference image');

      // Probing the target first bounds the job before a large upload, and it
      // gives the finished swap something objective to be checked against: the
      // result must be the same clip, not a re-timed or re-framed one.
      const probe = services.probeVideo ?? probeVideo;
      const targetMetadata: VideoMetadata = await probe(target.absolute, ctx.signal);
      const maxSeconds = faceSwapMaxSeconds(services.env);
      if (targetMetadata.durationSeconds > maxSeconds) {
        throw new Error(
          `The target video is ${targetMetadata.durationSeconds.toFixed(1)}s; face swapping is limited to ${maxSeconds}s. `
          + 'Trim the clip or raise DACAI_FACE_SWAP_MAX_SECONDS.',
        );
      }

      const connection = resolveMediaConnection(services.env);
      const response = await services.fetch(`${connection.baseUrl}/v1/face-swap`, {
        method: 'POST',
        redirect: 'error',
        headers: connection.headers,
        signal: ctx.signal,
        body: JSON.stringify({
          jobId: `agent-${randomUUID()}`,
          faceMediaBase64: faceData.toString('base64'),
          faceMimeType,
          targetMediaBase64: targetData.toString('base64'),
          targetMimeType,
          targetReferenceBase64: referenceData?.toString('base64'),
          targetReferenceMimeType: referenceMimeType,
          targetFaceIndex: integer(input.targetFaceIndex, 0, 0, 15, 'targetFaceIndex'),
          similarityThreshold: decimal(input.similarityThreshold, 0.35, 0, 1, 'similarityThreshold'),
          restoreFaces: input.restoreFaces === undefined ? true : Boolean(input.restoreFaces),
          keepAudio: input.keepAudio === undefined ? true : Boolean(input.keepAudio),
        }),
      });
      if (!response.ok) throw new Error(`DACAIS media face swap failed: ${await responseError(response)}`);
      const body = await response.json() as {
        videoBase64?: unknown; model?: unknown; detector?: unknown; framesTotal?: unknown;
        framesSwapped?: unknown; meanSimilarity?: unknown; restoredFaces?: unknown;
        peakVramMb?: unknown; provider?: unknown; syntheticMediaTag?: unknown;
      };

      const video = decodeMp4(body.videoBase64, MAX_OUTPUT_BYTES);
      await mkdir(dirname(output.absolute), { recursive: true });
      await writeFile(output.absolute, video, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new Error('Face swap output already exists; choose a new outputPath.');
        throw error;
      });

      let metadata: VideoMetadata;
      const framesSwapped = Number(body.framesSwapped);
      try {
        metadata = await probe(output.absolute, ctx.signal);
        validateVideoConstraints(metadata, {
          width: targetMetadata.width,
          height: targetMetadata.height,
          durationSeconds: targetMetadata.durationSeconds,
        });
        // A clip returned untouched is the failure that reads as success: a
        // valid MP4, the right length, nobody swapped. The service has to
        // report the frames it actually rewrote.
        if (!Number.isInteger(framesSwapped) || framesSwapped < 1) {
          throw new Error(
            'The face swap service did not replace the selected character in any frame. '
            + 'Check that the character is visible in the clip, or select them with targetReferencePath.',
          );
        }
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
        model: typeof body.model === 'string' ? body.model : undefined,
        detector: typeof body.detector === 'string' ? body.detector : undefined,
        sourceFace: face.relative,
        sourceVideo: target.relative,
        framesTotal: typeof body.framesTotal === 'number' ? body.framesTotal : metadata.frames,
        framesSwapped,
        meanSimilarity: typeof body.meanSimilarity === 'number' ? body.meanSimilarity : undefined,
        restoredFaces: body.restoredFaces === true,
        peakVramMb: typeof body.peakVramMb === 'number' ? body.peakVramMb : undefined,
        // Which execution provider actually rendered. A CPU session is ~50x
        // slower per frame, so the caller should never have to infer it.
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        // Written into the MP4 metadata by the service, so the artifact carries
        // its own disclosure once it leaves the workspace.
        syntheticMediaTag: typeof body.syntheticMediaTag === 'string' ? body.syntheticMediaTag : undefined,
      };
    },
  }];
}

export const FACE_SWAP_TOOLS: ToolDefinition[] = createFaceSwapTools();
