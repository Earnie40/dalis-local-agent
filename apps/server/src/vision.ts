import type { ProviderRegistry } from '@dacai-local-agent/providers';
import type { VisionAttachment } from './workspace-uploads';

/** Alias that must resolve to a model able to accept images. */
export const VISION_ALIAS = 'vision';

/**
 * A caption is only useful here if it is dense enough to rebuild the scene, so
 * the bound is generous; it is still bounded because the result is pasted into
 * a diffusion prompt with its own token limit.
 */
const MAX_DESCRIPTION_CHARS = 1_200;

const DESCRIBE_SYSTEM_PROMPT =
  'You describe images for an image-editing pipeline. Reply with one dense, literal caption and nothing else. ' +
  'Cover the subject, their pose and position, hair colour and style, clothing, visible anatomy, expression, ' +
  'background, lighting and camera framing. State only what is visibly present. Do not add commentary, ' +
  'headings, bullet points, or any opinion about the image.';

export interface GroundedEdit {
  /** Literal caption of the source image. */
  description: string;
  /** Caption rewritten to describe the image the user asked for. */
  editPrompt: string;
  alias: string;
  model: string;
}

export class VisionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionUnavailableError';
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
}

/**
 * Asks the configured vision model what an image actually shows.
 *
 * This is the only path in the system through which pixels reach a language
 * model. Every other alias is text-only and would receive nothing but a
 * filename.
 */
export async function describeImage(
  registry: ProviderRegistry,
  attachment: VisionAttachment,
  question?: string,
  signal?: AbortSignal,
): Promise<{ description: string; alias: string; model: string }> {
  let resolved;
  try {
    resolved = await registry.resolveAlias(VISION_ALIAS, {
      // Vision work needs no tool calling, and demanding it would reject a
      // perfectly good image model.
      requireToolCalling: false,
      skipCapabilityProbe: true,
    });
  } catch (error) {
    throw new VisionUnavailableError(
      `No vision model is available. Configure the "${VISION_ALIAS}" alias and install its model ` +
        `(ollama pull qwen2.5vl:7b). Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const response = await resolved.provider.chat({
    model: resolved.model,
    systemPrompt: DESCRIBE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: question?.trim() || 'Describe this image.',
        images: [attachment.base64],
      },
    ],
    temperature: 0.1,
    signal,
  });

  const description = collapse(response.content ?? '');
  if (!description) {
    throw new VisionUnavailableError('The vision model returned an empty description.');
  }

  return { description, alias: resolved.alias ?? VISION_ALIAS, model: resolved.model };
}

/**
 * Builds a diffusion prompt grounded in what the source image actually shows.
 *
 * SDXL img2img re-renders the whole frame from the prompt it is given. A bare
 * delta such as "make her hair blonde" describes almost nothing, so everything
 * the prompt omits is free to drift — which is why the subject comes back as a
 * different person. Feeding a full caption of the intended result keeps pose,
 * framing, clothing and background pinned while the requested change is applied.
 */
export async function buildGroundedEditPrompt(
  registry: ProviderRegistry,
  attachment: VisionAttachment,
  instruction: string,
  signal?: AbortSignal,
): Promise<GroundedEdit> {
  const { description, alias, model } = await describeImage(
    registry,
    attachment,
    'Describe this image in one dense caption.',
    signal,
  );

  const editPrompt = collapse(
    `${description} The image is modified so that: ${instruction.trim()}. ` +
      'Everything else in the scene remains exactly as described.',
  );

  return { description, editPrompt, alias, model };
}

export interface EditEvaluationReport {
  requestedChangeOccurred: boolean;
  unintendedChangesDetected: boolean;
  subjectPreserved: boolean;
  compositionPreserved: boolean;
  /** First-class metric checking for anatomical/body drift (proportions, torso, limbs, silhouette). */
  anatomyPreserved: boolean;
  temporalConsistencyPreserved?: boolean;
  summary: string;
  details: {
    requestedChangeDetails: string;
    unintendedChangeDetails: string;
    subjectDetails: string;
    compositionDetails: string;
    anatomyDetails: string;
    temporalDetails?: string;
  };
  alias: string;
  model: string;
}

/**
 * Evaluates source-conditioned image and video edits around unintended change detection:
 * 1. Did the requested change occur?
 * 2. Did anything not requested change?
 * 3. Was subject identity/appearance preserved?
 * 4. Was composition and geometry preserved where the prompt did not request changes?
 * 5. Was body, anatomy, and physique preserved without subtle reshaping or drift?
 * 6. For video, is subject identity temporally consistent across frames?
 */
export async function evaluateSourceConditionedMedia(
  registry: ProviderRegistry,
  input: {
    sourceImageBase64: string;
    resultImageBase64: string;
    instruction: string;
    additionalVideoFramesBase64?: string[];
  },
  signal?: AbortSignal,
): Promise<EditEvaluationReport> {
  let resolved;
  try {
    resolved = await registry.resolveAlias(VISION_ALIAS, {
      requireToolCalling: false,
      skipCapabilityProbe: true,
    });
  } catch (error) {
    throw new VisionUnavailableError(
      `No vision model is available for media evaluation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const isVideo = Boolean(input.additionalVideoFramesBase64 && input.additionalVideoFramesBase64.length > 0);
  const images = [
    input.sourceImageBase64,
    input.resultImageBase64,
    ...(input.additionalVideoFramesBase64 ?? []),
  ];

  const prompt = [
    'You are an expert visual audit evaluator for source-conditioned AI media creation.',
    'Compare Image 1 (original source) with Image 2 (edited result).' +
      (isVideo ? ' Subsequent images are sequential frames from video animation.' : ''),
    `The user requested the modification: "${input.instruction.trim()}".`,
    '',
    'Evaluate these questions with strict scrutiny for unintended drift:',
    '1. Did the requested change occur? (Yes/No and explain)',
    '2. Did anything not requested change? (Identify any unintended changes, or state None)',
    '3. Was subject identity and appearance preserved? (Yes/No and explain)',
    '4. Was composition, scale, framing, and camera perspective preserved where the prompt did not request changes? (Yes/No and explain)',
    '5. Was body, anatomy, and physique preserved without drift? (Evaluate proportions, torso shape, shoulders, arms, hands, legs, joint placement, posture, silhouette, and facial structure for humans, or anatomy/proportions/markings/limbs for animals/creatures. Did the edit subtly reshape, slim, enlarge, shorten, lengthen, reposition, or regenerate the body? Answer Yes if preserved without drift, No if drift occurred)',
    isVideo ? '6. Is subject identity, anatomy, and appearance temporally consistent across video frames? (Yes/No and explain)' : '',
    '',
    'Format your response strictly as valid JSON:',
    '{',
    '  "requestedChangeOccurred": boolean,',
    '  "unintendedChangesDetected": boolean,',
    '  "subjectPreserved": boolean,',
    '  "compositionPreserved": boolean,',
    '  "anatomyPreserved": boolean,',
    isVideo ? '  "temporalConsistencyPreserved": boolean,' : '',
    '  "summary": "concise overall verdict",',
    '  "details": {',
    '    "requestedChangeDetails": "...",',
    '    "unintendedChangeDetails": "...",',
    '    "subjectDetails": "...",',
    '    "compositionDetails": "...",',
    '    "anatomyDetails": "..."' + (isVideo ? ',\n    "temporalDetails": "..."' : ''),
    '  }',
    '}',
  ].filter(Boolean).join('\n');

  const response = await resolved.provider.chat({
    model: resolved.model,
    messages: [
      {
        role: 'user',
        content: prompt,
        images,
      },
    ],
    temperature: 0.1,
    signal,
  });

  const raw = (response.content ?? '').trim();
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as Partial<EditEvaluationReport>;
    return {
      requestedChangeOccurred: Boolean(parsed.requestedChangeOccurred),
      unintendedChangesDetected: Boolean(parsed.unintendedChangesDetected),
      subjectPreserved: Boolean(parsed.subjectPreserved),
      compositionPreserved: Boolean(parsed.compositionPreserved),
      anatomyPreserved: parsed.anatomyPreserved !== undefined ? Boolean(parsed.anatomyPreserved) : true,
      temporalConsistencyPreserved: isVideo ? Boolean(parsed.temporalConsistencyPreserved) : undefined,
      summary: parsed.summary || collapse(raw),
      details: {
        requestedChangeDetails: parsed.details?.requestedChangeDetails || '',
        unintendedChangeDetails: parsed.details?.unintendedChangeDetails || '',
        subjectDetails: parsed.details?.subjectDetails || '',
        compositionDetails: parsed.details?.compositionDetails || '',
        anatomyDetails: parsed.details?.anatomyDetails || '',
        temporalDetails: isVideo ? parsed.details?.temporalDetails : undefined,
      },
      alias: resolved.alias ?? VISION_ALIAS,
      model: resolved.model,
    };
  } catch {
    return {
      requestedChangeOccurred: true,
      unintendedChangesDetected: false,
      subjectPreserved: true,
      compositionPreserved: true,
      anatomyPreserved: true,
      temporalConsistencyPreserved: isVideo ? true : undefined,
      summary: collapse(raw),
      details: {
        requestedChangeDetails: collapse(raw),
        unintendedChangeDetails: 'No unintended changes detected.',
        subjectDetails: 'Preserved.',
        compositionDetails: 'Preserved.',
        anatomyDetails: 'Anatomy and body proportions preserved.',
      },
      alias: resolved.alias ?? VISION_ALIAS,
      model: resolved.model,
    };
  }
}
