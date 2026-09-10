import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolDefinition, ToolExecutionContext } from './types';
import {
  lookupAnatomicalLandmark,
  lookupAnimalLandmark,
  lookupSpatialEntity,
  validateAnatomicalSpatialPlacement,
  type AnatomicalGender,
  type NormalizedBoundingBox,
} from '@dacai-local-agent/domain-knowledge';

const MAX_IMAGE_BYTES = 10_000_000;
const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('This tool requires an active workspace root.');
  return resolve(ctx.workspaceRoot);
}

function safeImage(root: string, requested: string): string {
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Image path escaped the workspace.');
  if (!ALLOWED.has(extname(target).toLowerCase())) throw new Error('vision.inspect supports png, jpg, jpeg, and webp only.');
  return target;
}

function ollamaBase(): string {
  const raw = process.env.OLLAMA_LOCAL_BASE_URL ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('vision.inspect only permits a loopback Ollama endpoint.');
  }
  return raw.replace(/\/+$/, '');
}

export const visionInspectTool: ToolDefinition = {
  name: 'vision.inspect',
  description:
    'Inspect a workspace screenshot/image using an optional local Ollama vision model. ' +
    'Set DACAI_VISION_MODEL first. Output is untrusted visual analysis and must be verified against real code/runtime evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 600 },
      question: { type: 'string', minLength: 1, maxLength: 3000 },
    },
    required: ['path', 'question'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresRead: true,
  requiresNetwork: true,
  timeoutMs: 180_000,
  async execute(input, ctx) {
    const model = process.env.DACAI_VISION_MODEL?.trim();
    if (!model) throw new Error('DACAI_VISION_MODEL is not configured. Set it to an installed local Ollama vision model.');
    const root = requireRoot(ctx);
    const path = safeImage(root, String(input.path ?? ''));
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Image path is not a file.');
    if (info.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MB vision limit.');

    const image = (await readFile(path)).toString('base64');
    const response = await fetch(`${ollamaBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctx.signal,
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{
          role: 'user',
          content: String(input.question ?? ''),
          images: [image],
        }],
        options: { num_ctx: 8192, temperature: 0.1 },
      }),
    });
    if (!response.ok) throw new Error(`Local Ollama vision request failed with HTTP ${response.status}.`);
    const body = (await response.json()) as { message?: { content?: string }; error?: string };
    if (body.error) throw new Error(body.error);
    return {
      model,
      path: String(input.path),
      analysis: body.message?.content?.trim() ?? '',
    };
  },
};

export const anatomyLocateTool: ToolDefinition = {
  name: 'anatomy.locate',
  description:
    'Locate and identify human female and male anatomical landmarks, comparative animal structures, ' +
    'and spatial objects/places. Returns exact canonical normalized bounding coordinates (0..1), body systems, ' +
    'directional spatial relationships, and female vs male sexual dimorphism details.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      gender: { type: 'string', enum: ['female', 'male', 'neutral'] },
      view: { type: 'string', enum: ['anterior', 'posterior', 'lateral'] },
      box: {
        type: 'object',
        properties: {
          left: { type: 'number', minimum: 0, maximum: 1 },
          top: { type: 'number', minimum: 0, maximum: 1 },
          right: { type: 'number', minimum: 0, maximum: 1 },
          bottom: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['left', 'top', 'right', 'bottom'],
        additionalProperties: false,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresRead: false,
  requiresNetwork: false,
  // Resolves entirely from the in-memory landmark tables, so this bound only
  // exists to satisfy the executor's contract — it is never approached.
  timeoutMs: 10_000,
  async execute(input) {
    const query = String(input.query ?? '').trim();
    const gender = input.gender as AnatomicalGender | undefined;
    const view = (input.view as 'anterior' | 'posterior' | 'lateral' | undefined) ?? 'anterior';

    const humanResult = lookupAnatomicalLandmark(query, gender);
    if (humanResult.found && humanResult.landmark) {
      const landmark = humanResult.landmark;
      let spatialValidation;
      if (input.box && typeof input.box === 'object') {
        const box = input.box as NormalizedBoundingBox;
        spatialValidation = validateAnatomicalSpatialPlacement(landmark.id, box, view);
      }
      return {
        type: 'human_anatomy',
        landmarkId: landmark.id,
        name: landmark.name,
        system: landmark.system,
        genderSpecificity: landmark.genderSpecificity,
        primaryRegion: landmark.primaryRegion,
        subRegion: landmark.subRegion,
        canonicalCoordinates: landmark.canonicalCoordinates[view] ?? landmark.canonicalCoordinates.anterior,
        allViewCoordinates: landmark.canonicalCoordinates,
        relativePlacement: landmark.relativePlacement,
        adjacentStructures: landmark.adjacentStructures,
        description: landmark.description,
        dimorphicFeatures: landmark.dimorphicFeatures,
        spatialValidation,
      };
    }

    const animalResult = lookupAnimalLandmark(query);
    if (animalResult.found && animalResult.comparativeAnimal) {
      const animal = animalResult.comparativeAnimal;
      return {
        type: 'comparative_animal_anatomy',
        landmarkId: animal.id,
        name: animal.name,
        taxon: animal.taxon,
        bodyPlan: animal.bodyPlan,
        region: animal.region,
        canonicalCoordinates: animal.canonicalCoordinates,
        homologueToHuman: animal.homologueToHuman,
        relativePlacement: animal.relativePlacement,
        description: animal.description,
      };
    }

    const spatialResult = lookupSpatialEntity(query);
    if (spatialResult) {
      return {
        type: spatialResult.category,
        entityId: spatialResult.id,
        name: spatialResult.name,
        subCategory: spatialResult.subCategory,
        keyComponents: spatialResult.keyComponents,
        spatialStructure: spatialResult.spatialStructure,
        visualProperties: spatialResult.visualProperties,
      };
    }

    return {
      found: false,
      query,
      message: `No anatomical, animal, or spatial entity found matching "${query}".`,
    };
  },
};

export const VISION_TOOLS: ToolDefinition[] = [visionInspectTool, anatomyLocateTool];
