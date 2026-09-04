import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import type { ToolDefinition, ToolExecutionContext } from './types';
import { resolveMediaConnection } from './media-connection';

type ImageBackend = 'automatic1111' | 'dacais-media' | 'openai';

interface ImageGenerationServices {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_SERVICES: ImageGenerationServices = { env: process.env, fetch: globalThis.fetch };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const TRANSIENT_MEDIA_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

function workspaceOutput(ctx: ToolExecutionContext, requested: unknown): { absolute: string; relative: string } {
  if (!ctx.workspaceRoot) throw new Error('image.generate requires an active workspace.');
  const path = requiredText(requested, 'outputPath', 600).replaceAll('\\', '/');
  if (!path.toLowerCase().endsWith('.png')) throw new Error('image.generate outputPath must end in .png.');
  if (isAbsolute(path)) throw new Error('image.generate outputPath must be workspace-relative.');

  const root = resolveWithinWorkspace(ctx.workspaceRoot, '.');
  let absolute: string;
  try {
    absolute = resolveWithinWorkspace(root, path);
  } catch {
    throw new Error('Image output path escaped the workspace.');
  }
  const fromRoot = relative(root, absolute);
  return { absolute, relative: fromRoot.replaceAll('\\', '/') };
}

function configuredBackend(env: NodeJS.ProcessEnv): ImageBackend {
  const backend = env.DACAI_IMAGE_BACKEND?.trim().toLowerCase();
  if (backend === 'automatic1111' || backend === 'dacais-media' || backend === 'openai') return backend;
  throw new Error(
    'Photoreal image generation is not enabled. Set DACAI_IMAGE_BACKEND=dacais-media for the DACAIS GPU media service, automatic1111 for a local Forge/Automatic1111 server, or explicitly select openai for the paid OpenAI Images API.',
  );
}

function endpoint(value: string, options: { loopbackOnly: boolean }): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The configured image-generation URL is invalid.');
  }
  if (options.loopbackOnly) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('The Automatic1111/Forge image backend must use a loopback URL.');
    }
  }
  return value.replace(/\/+$/, '');
}

async function responseError(response: Response): Promise<string> {
  const message = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
  return message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`;
}

function decodePng(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.trim()) throw new Error('The image backend returned no image data.');
  const encoded = value.replace(/^data:image\/png;base64,/i, '');
  const image = Buffer.from(encoded, 'base64');
  if (image.byteLength < 8 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('The generated image is empty or exceeds the 25 MB limit.');
  }
  if (!image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('The image backend did not return a valid PNG file.');
  }
  return image;
}

async function automatic1111Image(
  services: ImageGenerationServices,
  input: { prompt: string; negativePrompt: string; width: number; height: number; steps: number; guidance: number; seed: number },
  signal?: AbortSignal,
): Promise<{ image: Buffer; model?: string; seed?: number }> {
  const base = endpoint(services.env.DACAI_IMAGE_BASE_URL?.trim() || 'http://127.0.0.1:7860', { loopbackOnly: true });
  const response = await services.fetch(`${base}/sdapi/v1/txt2img`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal,
    body: JSON.stringify({
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      width: input.width,
      height: input.height,
      steps: input.steps,
      cfg_scale: input.guidance,
      seed: input.seed,
      batch_size: 1,
      n_iter: 1,
      save_images: false,
    }),
  });
  if (!response.ok) throw new Error(`Local image backend failed: ${await responseError(response)}`);
  const body = await response.json() as { images?: unknown[]; info?: string; parameters?: { seed?: number } };
  let info: { seed?: number; sd_model_name?: string } = {};
  try { if (body.info) info = JSON.parse(body.info) as typeof info; } catch { /* Optional backend metadata. */ }
  return {
    image: decodePng(body.images?.[0]),
    model: info.sd_model_name || services.env.DACAI_IMAGE_MODEL?.trim() || undefined,
    seed: info.seed ?? body.parameters?.seed,
  };
}

function imageMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  throw new Error('sourcePath must be a PNG, JPEG, or WebP image.');
}

async function sourceImage(ctx: ToolExecutionContext, requested: unknown): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (requested === undefined) return undefined;
  if (!ctx.workspaceRoot) throw new Error('image.generate requires an active workspace.');
  const path = requiredText(requested, 'sourcePath', 600).replaceAll('\\', '/');
  if (isAbsolute(path)) throw new Error('image.generate sourcePath must be workspace-relative.');
  const absolute = resolveWithinWorkspace(ctx.workspaceRoot, path);
  const data = await readFile(absolute);
  if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('The source image is empty or exceeds the 25 MB limit.');
  }
  return { data, mimeType: imageMimeType(path) };
}

async function dacaisMediaImage(
  services: ImageGenerationServices,
  input: {
    prompt: string; negativePrompt: string; width: number; height: number; steps: number;
    guidance: number; seed: number; strength: number; source?: { data: Buffer; mimeType: string };
  },
  signal?: AbortSignal,
): Promise<{ image: Buffer; model?: string; seed?: number }> {
  const connection = resolveMediaConnection(services.env);
  const base = connection.baseUrl;
  const edit = Boolean(input.source);
  const request = {
    method: 'POST',
    redirect: 'error',
    headers: connection.headers,
    signal,
    body: JSON.stringify({
      jobId: `agent-${randomUUID()}`,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      width: input.width,
      height: input.height,
      steps: input.steps,
      guidanceScale: input.guidance,
      seed: input.seed === -1 ? undefined : input.seed,
      strength: input.strength,
      sourceMediaBase64: input.source?.data.toString('base64'),
      sourceMimeType: input.source?.mimeType,
    }),
  } satisfies RequestInit;

  let response: Response | undefined;
  let lastFailure: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = undefined;
    try {
      response = await services.fetch(`${base}${edit ? '/v1/edit-image' : '/v1/generate-backdrop'}`, request);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (response?.ok) break;
    if (response) {
      const failure = new Error(`DACAIS media image backend failed: ${await responseError(response)}`);
      if (!TRANSIENT_MEDIA_STATUSES.has(response.status)) throw failure;
      lastFailure = failure;
    }
    if (attempt < 2) await (services.sleep ?? wait)(500 * (attempt + 1));
  }
  if (!response?.ok) throw lastFailure ?? new Error('DACAIS media image backend did not respond.');
  const body = await response.json() as { imageBase64?: unknown; model?: unknown; seed?: unknown };
  return {
    image: decodePng(body.imageBase64),
    model: typeof body.model === 'string' ? body.model : undefined,
    seed: typeof body.seed === 'number' ? body.seed : undefined,
  };
}

function openAiSize(width: number, height: number): '1024x1024' | '1536x1024' | '1024x1536' {
  if (width > height) return '1536x1024';
  if (height > width) return '1024x1536';
  return '1024x1024';
}

async function openAiImage(
  services: ImageGenerationServices,
  input: { prompt: string; width: number; height: number; quality: string },
  signal?: AbortSignal,
): Promise<{ image: Buffer; model: string }> {
  const apiKey = services.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when DACAI_IMAGE_BACKEND=openai.');
  const model = services.env.DACAI_IMAGE_MODEL?.trim() || 'gpt-image-1';
  const base = endpoint(services.env.DACAI_IMAGE_BASE_URL?.trim() || 'https://api.openai.com/v1', { loopbackOnly: false });
  const response = await services.fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({
      model,
      prompt: input.prompt,
      n: 1,
      size: openAiSize(input.width, input.height),
      quality: input.quality,
      output_format: 'png',
    }),
  });
  if (!response.ok) throw new Error(`OpenAI image backend failed: ${await responseError(response)}`);
  const body = await response.json() as { data?: Array<{ b64_json?: unknown }> };
  return { image: decodePng(body.data?.[0]?.b64_json), model };
}

export function imageGenerationConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['automatic1111', 'dacais-media', 'openai'].includes(env.DACAI_IMAGE_BACKEND?.trim().toLowerCase() ?? '');
}

/** Loopback media traffic is app infrastructure, not public workspace network access. */
export function imageGenerationRequiresNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  const backend = env.DACAI_IMAGE_BACKEND?.trim().toLowerCase();
  if (backend === 'openai') return true;
  return backend === 'dacais-media' && env.DACAI_MEDIA_TRANSPORT?.trim().toLowerCase() === 'https';
}

export function createImageGenerationTools(services: ImageGenerationServices = DEFAULT_SERVICES): ToolDefinition[] {
  return [{
    name: 'image.generate',
    description:
      'Generate or edit one photorealistic or artistic raster image with the explicitly configured image backend and write a verified PNG inside the workspace. ' +
      'Use this for photos, portraits, concept art, illustrations, and other raster requests; do not substitute SVG when photorealism is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4000 },
        negativePrompt: { type: 'string', maxLength: 2000 },
        sourcePath: { type: 'string', minLength: 1, maxLength: 600, description: 'Optional workspace-relative PNG, JPEG, or WebP to modify.' },
        outputPath: { type: 'string', minLength: 1, maxLength: 600, pattern: '\\.png$' },
        width: { type: 'integer', minimum: 256, maximum: 1536, default: 1024 },
        height: { type: 'integer', minimum: 256, maximum: 1536, default: 1024 },
        steps: { type: 'integer', minimum: 1, maximum: 100, default: 28 },
        guidance: { type: 'number', minimum: 1, maximum: 30, default: 7 },
        seed: { type: 'integer', minimum: -1, maximum: 2147483647, default: -1 },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], default: 'high' },
        strength: { type: 'number', minimum: 0.05, maximum: 1, default: 0.65, description: 'How strongly an edit may depart from sourcePath.' },
      },
      required: ['prompt', 'outputPath'],
      additionalProperties: false,
    },
    permissionTier: 'mutation',
    autoApprove: true,
    requiresRead: true,
    requiresWrite: true,
    requiresNetwork: imageGenerationRequiresNetwork(services.env),
    timeoutMs: 600_000,
    async execute(input, ctx) {
      const backend = configuredBackend(services.env);
      const output = workspaceOutput(ctx, input.outputPath);
      const request = {
        prompt: requiredText(input.prompt, 'prompt', 4000),
        negativePrompt: typeof input.negativePrompt === 'string' ? input.negativePrompt.trim().slice(0, 2000) : '',
        width: integer(input.width, 1024, 256, 1536, 'width'),
        height: integer(input.height, 1024, 256, 1536, 'height'),
        steps: integer(input.steps, 28, 1, 100, 'steps'),
        guidance: decimal(input.guidance, 7, 1, 30, 'guidance'),
        seed: integer(input.seed, -1, -1, 2147483647, 'seed'),
        quality: ['low', 'medium', 'high'].includes(String(input.quality ?? 'high')) ? String(input.quality ?? 'high') : 'high',
        strength: decimal(input.strength, 0.65, 0.05, 1, 'strength'),
        source: await sourceImage(ctx, input.sourcePath),
      };
      if (request.source && backend !== 'dacais-media') {
        throw new Error('sourcePath image editing currently requires DACAI_IMAGE_BACKEND=dacais-media.');
      }
      const generated = backend === 'automatic1111'
        ? await automatic1111Image(services, request, ctx.signal)
        : backend === 'dacais-media'
          ? await dacaisMediaImage(services, request, ctx.signal)
          : await openAiImage(services, request, ctx.signal);

      await mkdir(dirname(output.absolute), { recursive: true });
      await writeFile(output.absolute, generated.image, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw new Error('Image output already exists; choose a new outputPath.');
        throw error;
      });
      return {
        path: output.relative,
        format: 'png',
        bytes: generated.image.byteLength,
        sha256: createHash('sha256').update(generated.image).digest('hex'),
        backend,
        model: generated.model,
        width: request.width,
        height: request.height,
        seed: 'seed' in generated ? generated.seed : undefined,
      };
    },
  }];
}

export const IMAGE_GENERATION_TOOLS: ToolDefinition[] = createImageGenerationTools();
