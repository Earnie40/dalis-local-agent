import { describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import {
  buildGroundedEditPrompt,
  describeImage,
  evaluateSourceConditionedMedia,
  VISION_ALIAS,
  VisionUnavailableError,
} from '../apps/server/src/vision';
import type { VisionAttachment } from '../apps/server/src/workspace-uploads';

const attachment: VisionAttachment = {
  upload: {
    id: 'stored-id',
    name: 'portrait.png',
    path: '.dacai/uploads/stored-id',
    bytes: 2048,
    mimeType: 'image/png',
    kind: 'binary',
    uploadedAt: new Date().toISOString(),
  },
  base64: 'aGVsbG8=',
};

/** A registry whose vision alias resolves to a scripted provider. */
function registryWith(chat: ReturnType<typeof vi.fn>, alias = VISION_ALIAS): ProviderRegistry {
  return {
    resolveAlias: vi.fn(async () => ({
      alias,
      model: 'qwen2.5vl:7b',
      provider: { chat },
    })),
  } as unknown as ProviderRegistry;
}

describe('describeImage', () => {
  it('sends the image to the vision alias as raw base64', async () => {
    const chat = vi.fn(async () => ({ content: 'A woman with brown hair against a grey wall.' }));
    const registry = registryWith(chat);

    const result = await describeImage(registry, attachment);

    expect(result.description).toBe('A woman with brown hair against a grey wall.');
    expect(result.model).toBe('qwen2.5vl:7b');

    const request = chat.mock.calls[0][0] as { messages: Array<{ images?: string[] }> };
    // The decisive assertion: pixels reach the model, not a filename.
    expect(request.messages[0].images).toEqual(['aGVsbG8=']);
  });

  it('does not demand tool calling from an image model', async () => {
    const chat = vi.fn(async () => ({ content: 'A cat.' }));
    const registry = registryWith(chat);

    await describeImage(registry, attachment);

    const options = (registry.resolveAlias as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(options).toMatchObject({ requireToolCalling: false });
  });

  it('reports a missing vision model as an actionable error', async () => {
    const registry = {
      resolveAlias: vi.fn(async () => {
        throw new Error('Unknown model alias "vision".');
      }),
    } as unknown as ProviderRegistry;

    await expect(describeImage(registry, attachment)).rejects.toBeInstanceOf(VisionUnavailableError);
    await expect(describeImage(registry, attachment)).rejects.toThrow(/ollama pull qwen2\.5vl/);
  });

  it('rejects an empty description rather than grounding on nothing', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: '   ' })));
    await expect(describeImage(registry, attachment)).rejects.toBeInstanceOf(VisionUnavailableError);
  });
});

describe('buildGroundedEditPrompt', () => {
  it('describes the whole intended result, not just the delta', async () => {
    const caption = 'A woman in a red coat standing in front of a brick wall, brown hair, soft daylight.';
    const registry = registryWith(vi.fn(async () => ({ content: caption })));

    const grounded = await buildGroundedEditPrompt(registry, attachment, 'make her hair blonde');

    // The source scene survives into the diffusion prompt...
    expect(grounded.editPrompt).toContain('red coat');
    expect(grounded.editPrompt).toContain('brick wall');
    // ...alongside the requested change and an explicit preservation clause.
    expect(grounded.editPrompt).toContain('make her hair blonde');
    expect(grounded.editPrompt).toContain('remains exactly as described');
    expect(grounded.description).toBe(caption);
  });

  it('collapses whitespace so the prompt stays a single line', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: 'A dog.\n\n  Sitting   on grass.' })));
    const grounded = await buildGroundedEditPrompt(registry, attachment, 'add a red collar');
    expect(grounded.editPrompt).not.toMatch(/\s{2,}|\n/);
  });

  it('bounds the prompt so a runaway caption cannot flood the diffusion request', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: 'word '.repeat(5_000) })));
    const grounded = await buildGroundedEditPrompt(registry, attachment, 'brighter');
    expect(grounded.description.length).toBeLessThanOrEqual(1_200);
    expect(grounded.editPrompt.length).toBeLessThanOrEqual(1_200);
  });
});

describe('evaluateSourceConditionedMedia', () => {
  it('evaluates still image edits across the 4 key criteria', async () => {
    const mockAudit = {
      requestedChangeOccurred: true,
      unintendedChangesDetected: false,
      subjectPreserved: true,
      compositionPreserved: true,
      anatomyPreserved: true,
      summary: 'Hair color changed cleanly without unintended side effects.',
      details: {
        requestedChangeDetails: 'Hair changed to blonde.',
        unintendedChangeDetails: 'No unintended changes.',
        subjectDetails: 'Face, expression, and pose preserved.',
        compositionDetails: 'Background and lighting preserved.',
        anatomyDetails: 'Body proportions, torso, physique, and silhouette fully preserved.',
      },
    };
    const chat = vi.fn(async () => ({ content: JSON.stringify(mockAudit) }));
    const registry = registryWith(chat);

    const report = await evaluateSourceConditionedMedia(registry, {
      sourceImageBase64: 'c291cmNl',
      resultImageBase64: 'cmVzdWx0',
      instruction: 'make her hair blonde',
    });

    expect(report.requestedChangeOccurred).toBe(true);
    expect(report.unintendedChangesDetected).toBe(false);
    expect(report.subjectPreserved).toBe(true);
    expect(report.compositionPreserved).toBe(true);
    expect(report.anatomyPreserved).toBe(true);
    expect(report.details.anatomyDetails).toContain('Body proportions');
    expect(report.summary).toContain('Hair color changed cleanly');

    const request = chat.mock.calls[0][0] as { messages: Array<{ images?: string[] }> };
    expect(request.messages[0].images).toEqual(['c291cmNl', 'cmVzdWx0']);
  });

  it('evaluates video keyframes for temporal consistency across frames', async () => {
    const mockVideoAudit = {
      requestedChangeOccurred: true,
      unintendedChangesDetected: false,
      subjectPreserved: true,
      compositionPreserved: true,
      temporalConsistencyPreserved: true,
      summary: 'Consistent motion with structural continuity.',
      details: {
        requestedChangeDetails: 'Motion applied smoothly.',
        unintendedChangeDetails: 'None.',
        subjectDetails: 'Subject consistent across frames.',
        compositionDetails: 'Perspective stable.',
        temporalDetails: 'No flickering or warping.',
      },
    };
    const chat = vi.fn(async () => ({ content: JSON.stringify(mockVideoAudit) }));
    const registry = registryWith(chat);

    const report = await evaluateSourceConditionedMedia(registry, {
      sourceImageBase64: 'c291cmNl',
      resultImageBase64: 'cmVzdWx0',
      instruction: 'pan camera slightly left',
      additionalVideoFramesBase64: ['ZnJhbWUx', 'ZnJhbWUy'],
    });

    expect(report.temporalConsistencyPreserved).toBe(true);
    expect(report.subjectPreserved).toBe(true);

    const request = chat.mock.calls[0][0] as { messages: Array<{ images?: string[] }> };
    expect(request.messages[0].images).toEqual(['c291cmNl', 'cmVzdWx0', 'ZnJhbWUx', 'ZnJhbWUy']);
  });
});
