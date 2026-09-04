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
const ANATOMY_MEDIA_INTENT =
  /\b(?:anatom(?:y|ical(?:ly)?)|full[- ]body|whole[- ]body|body\s+pose|pose|posture|skeleton|skeletal|limbs?|arms?|legs?|hands?|fingers?|thumbs?|feet|foot|toes?|joints?|pelvis|hips?|buttocks?|gluteal|perine(?:um|al)|pubic|genitals?|penis|penile|glans|foreskin|prepuce|scrotum|scrotal|testicles?|testes|vulva|vulvar|labia(?:l)?|clitoris|clitoral|vagina|vaginal|walk(?:ing)?|run(?:ning)?|danc(?:e|ing)|kneel(?:ing)?|crouch(?:ing)?|squat(?:ting)?|stand(?:ing)?|sit(?:ting)?|gestures?)\b/i;
const HUMAN_ANATOMY_CONTEXT =
  /\b(?:educational|medical|clinical|scientific|anatomical|character[- ]design|digital[- ]human|simulation|reference)\b[\s\S]{0,100}\b(?:adult|human|person|people|body|male|female|man|woman)\b|\b(?:adult|human|person|people|body|male|female|man|woman)\b[\s\S]{0,100}\b(?:educational|medical|clinical|scientific|anatomical|character[- ]design|digital[- ]human|simulation|reference)\b/i;

/**
 * Semantic SDXL editors are weak at edits that must reason about a human body's
 * topology. Keep this classifier deterministic so every caller selects the
 * same dedicated, non-SDXL editing lane for those requests.
 */
export function mediaRequiresAnatomyPipeline(prompt: string): boolean {
  const normalized = prompt.trim();
  return ANATOMY_MEDIA_INTENT.test(normalized) || HUMAN_ANATOMY_CONTEXT.test(normalized);
}

export function imageEditRequiresAnatomyPipeline(prompt: string): boolean {
  return mediaRequiresAnatomyPipeline(prompt);
}

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
): Promise<{ image: Buffer; model?: string; seed?: number; mode?: string; regionLocked?: boolean; regions?: string[] }> {
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
    mode?: string; editConcepts?: string[]; reverseConcepts?: string[];
  },
  signal?: AbortSignal,
): Promise<{ image: Buffer; model?: string; seed?: number; mode?: string; regionLocked?: boolean; regions?: string[] }> {
  const connection = resolveMediaConnection(services.env);
  const base = connection.baseUrl;
  const edit = Boolean(input.source);
  const editMode = (input.mode || services.env.DACAI_IMAGE_EDIT_MODE || 'auto').trim().toLowerCase();
  const anatomyRequest = (
    editMode === 'anatomy' ||
    (editMode === 'auto' && mediaRequiresAnatomyPipeline(input.prompt))
  );
  const preferInstruct = edit && editMode !== 'img2img' && !anatomyRequest;

  if (anatomyRequest) {
    const anatomyPayload = JSON.stringify({
      jobId: `agent-${randomUUID()}`,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      mode: 'anatomy',
      width: input.width,
      height: input.height,
      steps: input.steps,
      guidanceScale: input.guidance,
      seed: input.seed === -1 ? undefined : input.seed,
      strength: input.strength,
      sourceMediaBase64: input.source?.data.toString('base64'),
      sourceMimeType: input.source?.mimeType,
    });
    let anatomyResponse: Response | undefined;
    let anatomyFailure: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        anatomyResponse = await services.fetch(`${base}${edit ? '/v1/anatomy-edit' : '/v1/anatomy-generate'}`, {
          method: 'POST',
          redirect: 'error',
          headers: connection.headers,
          signal,
          body: anatomyPayload,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        anatomyFailure = error instanceof Error ? error : new Error(String(error));
      }
      if (anatomyResponse?.ok) break;
      if (anatomyResponse) {
        anatomyFailure = new Error(`Anatomy-capable image backend failed: ${await responseError(anatomyResponse)}`);
        if (!TRANSIENT_MEDIA_STATUSES.has(anatomyResponse.status)) break;
      }
      if (attempt < 2) await (services.sleep ?? wait)(500 * (attempt + 1));
    }
    if (!anatomyResponse?.ok) {
      throw anatomyFailure ?? new Error('The anatomy-capable image backend did not respond. Generic SDXL fallback was intentionally not used.');
    }
    const body = await anatomyResponse.json() as {
      imageBase64?: unknown; model?: unknown; seed?: unknown; mode?: unknown;
      regionLocked?: unknown; regions?: unknown;
    };
    return {
      image: decodePng(body.imageBase64),
      model: typeof body.model === 'string' ? body.model : undefined,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
      mode: typeof body.mode === 'string' ? body.mode : 'anatomy',
      regionLocked: typeof body.regionLocked === 'boolean' ? body.regionLocked : undefined,
      regions: Array.isArray(body.regions) ? body.regions.filter((value): value is string => typeof value === 'string') : undefined,
    };
  }

  const instructPayload = preferInstruct
    ? JSON.stringify({
        jobId: `agent-${randomUUID()}`,
        prompt: input.prompt,
        mode: ['instructpix2pix', 'ledits'].includes(editMode) ? editMode : 'auto',
        editConcepts: input.editConcepts,
        reverseConcepts: input.reverseConcepts,
        width: input.width,
        height: input.height,
        steps: input.steps,
        guidanceScale: input.guidance,
        seed: input.seed === -1 ? undefined : input.seed,
        sourceMediaBase64: input.source?.data.toString('base64'),
        sourceMimeType: input.source?.mimeType,
      })
    : null;

  const standardPayload = JSON.stringify({
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
  });

  let response: Response | undefined;
  let lastFailure: Error | undefined;

  // Try /v1/instruct-edit first when editing in instruction mode; fall back to /v1/edit-image if unavailable.
  if (preferInstruct && instructPayload) {
    try {
      const instructRequest = {
        method: 'POST',
        redirect: 'error',
        headers: connection.headers,
        signal,
        body: instructPayload,
      } satisfies RequestInit;
      response = await services.fetch(`${base}/v1/instruct-edit`, instructRequest);
      if (!response.ok && response.status !== 404 && response.status !== 501) {
        const failure = new Error(`DACAIS media image backend failed: ${await responseError(response)}`);
        if (!TRANSIENT_MEDIA_STATUSES.has(response.status)) throw failure;
        lastFailure = failure;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      lastFailure = error instanceof Error ? error : new Error(String(error));
    }
  }

  // Fallback to /v1/edit-image or /v1/generate-backdrop
  if (!response?.ok) {
    const request = {
      method: 'POST',
      redirect: 'error',
      headers: connection.headers,
      signal,
      body: standardPayload,
    } satisfies RequestInit;

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
      'Use this for photos, portraits, concept art, illustrations, and other raster requests; anatomy-sensitive edits are routed to the dedicated geometry-aware model and never fall back to generic SDXL. Do not substitute SVG when photorealism is requested.',
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
        mode: { type: 'string', enum: ['auto', 'anatomy', 'instructpix2pix', 'ledits', 'img2img'], description: 'Editing model mode. Auto selects the anatomy pipeline for body/pose/limb requests.' },
        editConcepts: { type: 'array', items: { type: 'string' }, description: 'Optional semantic concepts for LEdits++.' },
        reverseConcepts: { type: 'array', items: { type: 'string' }, description: 'Optional semantic concepts to remove for LEdits++.' },
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
        mode: typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : undefined,
        editConcepts: Array.isArray(input.editConcepts) ? input.editConcepts.map(String) : undefined,
        reverseConcepts: Array.isArray(input.reverseConcepts) ? input.reverseConcepts.map(String) : undefined,
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
        mode: 'mode' in generated ? generated.mode : undefined,
        regionLocked: 'regionLocked' in generated ? generated.regionLocked : undefined,
        regions: 'regions' in generated ? generated.regions : undefined,
        width: request.width,
        height: request.height,
        seed: 'seed' in generated ? generated.seed : undefined,
      };
    },
  }];
}

export const IMAGE_GENERATION_TOOLS: ToolDefinition[] = createImageGenerationTools();
