import { describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import {
  buildGroundedEditPrompt,
  analyzeImageForEdit,
  interpretMediaInstruction,
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
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({
      sceneSummary: caption,
      requestedChange: 'make her hair blonde',
      targetRegions: ['hair at the top-center of the subject'],
      regions: [{ label: 'subject hair', location: 'top-center', box: { left: 0.35, top: 0.08, right: 0.7, bottom: 0.3 }, visibleDetails: 'brown hair' }],
    }) })));

    const grounded = await buildGroundedEditPrompt(registry, attachment, 'make her hair blonde');

    // The source scene survives into the diffusion prompt...
    expect(grounded.editPrompt).toContain('red coat');
    expect(grounded.editPrompt).toContain('brick wall');
    // ...alongside the requested change and an explicit preservation clause.
    expect(grounded.editPrompt).toContain('make her hair blonde');
    expect(grounded.editPrompt).toContain('remains exactly as described');
    expect(grounded.description).toBe(caption);
    expect(grounded.regions[0].location).toBe('top-center');
    expect(grounded.editPrompt).toContain('top-center');
  });

  it('collapses whitespace so the prompt stays a single line', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({ sceneSummary: 'A dog. Sitting on grass.', regions: [] }) })));
    const grounded = await buildGroundedEditPrompt(registry, attachment, 'add a red collar');
    expect(grounded.editPrompt).not.toMatch(/\s{2,}|\n/);
  });

  it('bounds the prompt so a runaway caption cannot flood the diffusion request', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({ sceneSummary: 'word '.repeat(5_000), regions: [] }) })));
    const grounded = await buildGroundedEditPrompt(registry, attachment, 'brighter');
    expect(grounded.description.length).toBeLessThanOrEqual(1_200);
    expect(grounded.editPrompt.length).toBeLessThanOrEqual(1_200);
  });
});

describe('analyzeImageForEdit', () => {
  it('returns structured target regions and normalized coordinates', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({
      sceneSummary: 'A person centered in a room.',
      requestedChange: 'change the upper-right lamp',
      targetRegions: ['upper-right lamp'],
      regions: [{ label: 'lamp', location: 'upper-right', box: { left: 0.72, top: 0.08, right: 0.95, bottom: 0.32 }, visibleDetails: 'a brass lamp' }],
    }) })));
    const result = await analyzeImageForEdit(registry, attachment, 'change the upper-right lamp');
    expect(result.targetRegions).toEqual(['upper-right lamp']);
    expect(result.regions[0].box).toEqual({ left: 0.72, top: 0.08, right: 0.95, bottom: 0.32 });
  });

  it('keeps analysis bounded when the model returns invalid or oversized regions', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({
      sceneSummary: 'A scene.',
      regions: [
        { label: 'invalid', location: 'center', box: { left: 2, top: 2, right: 1, bottom: 1 }, visibleDetails: 'ignored' },
        ...Array.from({ length: 20 }, (_, index) => ({ label: `region-${index}`, location: 'center', visibleDetails: 'visible' })),
      ],
    }) })));
    const result = await analyzeImageForEdit(registry, attachment, 'change the center region');
    expect(result.regions).toHaveLength(12);
    expect(result.regions[0].box).toBeUndefined();
  });
});

describe('interpretMediaInstruction', () => {
  it('turns conversational media wording into a bounded executable instruction', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({
      instruction: 'Change the subject outfit to a red evening gown while preserving the pose and beach background.',
      targetRegions: ['subject clothing'],
      preserve: ['pose', 'background', 'lighting'],
    }) })));
    const result = await interpretMediaInstruction(registry, 'Can you make her look ready for a gala but keep the beach?', 'User asked for a portrait edit.');
    expect(result.instruction).toContain('red evening gown');
    expect(result.targetRegions).toEqual(['subject clothing']);
    expect(result.preserve).toContain('background');
  });
});

describe('evaluateSourceConditionedMedia', () => {
  it('evaluates still image edits across the 5 key criteria', async () => {
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
      anatomyPreserved: true,
      temporalConsistencyPreserved: true,
      summary: 'Consistent motion with structural continuity.',
      details: {
        requestedChangeDetails: 'Motion applied smoothly.',
        unintendedChangeDetails: 'None.',
        subjectDetails: 'Subject consistent across frames.',
        compositionDetails: 'Perspective stable.',
        anatomyDetails: 'Body proportions and limbs remain consistent.',
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
    expect(report.anatomyPreserved).toBe(true);

    const request = chat.mock.calls[0][0] as { messages: Array<{ images?: string[] }> };
    expect(request.messages[0].images).toEqual(['c291cmNl', 'cmVzdWx0', 'ZnJhbWUx', 'ZnJhbWUy']);
  });

  const completeEvidence = {
    requestedChangeOccurred: true,
    unintendedChangesDetected: false,
    subjectPreserved: true,
    compositionPreserved: true,
    anatomyPreserved: true,
    summary: 'Requested change verified and source preserved.',
    details: {
      requestedChangeDetails: 'Hair changed to blonde.',
      unintendedChangeDetails: 'None detected.',
      subjectDetails: 'Identity preserved.',
      compositionDetails: 'Framing preserved.',
      anatomyDetails: 'Body proportions preserved.',
    },
  };
  const evaluationInput = {
    sourceImageBase64: 'c291cmNl', resultImageBase64: 'cmVzdWx0', instruction: 'make her hair blonde',
  };

  it.each(['requestedChangeOccurred', 'unintendedChangesDetected', 'subjectPreserved', 'compositionPreserved', 'anatomyPreserved'])
    ('rejects absent or string-valued %s instead of reporting verified preservation', async (field) => {
      for (const invalidValue of [undefined, 'true', 'false', null, 1]) {
        const content = JSON.stringify({ ...completeEvidence, [field]: invalidValue });
        const registry = registryWith(vi.fn(async () => ({ content })));
        await expect(evaluateSourceConditionedMedia(registry, evaluationInput)).rejects.toThrow(VisionUnavailableError);
      }
    });

  it.each(['requestedChangeDetails', 'unintendedChangeDetails', 'subjectDetails', 'compositionDetails', 'anatomyDetails'])
    ('rejects missing or blank %s', async (field) => {
      for (const invalidValue of [undefined, '', ' \n ']) {
        const content = JSON.stringify({ ...completeEvidence, details: { ...completeEvidence.details, [field]: invalidValue } });
        const registry = registryWith(vi.fn(async () => ({ content })));
        await expect(evaluateSourceConditionedMedia(registry, evaluationInput)).rejects.toThrow(/preservation was not verified/);
      }
    });

  it.each(['', 'not JSON', '{', 'null', '[]', '{}', JSON.stringify({ ...completeEvidence, summary: ' ' })])
    ('rejects malformed or incomplete evaluator evidence (%s)', async (content) => {
      const registry = registryWith(vi.fn(async () => ({ content })));
      await expect(evaluateSourceConditionedMedia(registry, evaluationInput)).rejects.toThrow(VisionUnavailableError);
    });

  it('requires explicit temporal evidence for video frames', async () => {
    for (const invalidTemporal of [undefined, 'true', 'false']) {
      const content = JSON.stringify({
        ...completeEvidence, temporalConsistencyPreserved: invalidTemporal,
        details: { ...completeEvidence.details, temporalDetails: 'No flicker detected.' },
      });
      const registry = registryWith(vi.fn(async () => ({ content })));
      await expect(evaluateSourceConditionedMedia(registry, {
        ...evaluationInput, additionalVideoFramesBase64: ['ZnJhbWUx'],
      })).rejects.toThrow(VisionUnavailableError);
    }
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({
      ...completeEvidence, temporalConsistencyPreserved: true,
    }) })));
    await expect(evaluateSourceConditionedMedia(registry, {
      ...evaluationInput, additionalVideoFramesBase64: ['ZnJhbWUx'],
    })).rejects.toThrow(VisionUnavailableError);
  });

  it('retains an explicit negative preservation verdict', async () => {
    const registry = registryWith(vi.fn(async () => ({ content: JSON.stringify({
      ...completeEvidence, anatomyPreserved: false, unintendedChangesDetected: true,
      details: { ...completeEvidence.details, anatomyDetails: 'Shoulder proportions drifted.', unintendedChangeDetails: 'Body shape changed.' },
    }) })));
    expect(await evaluateSourceConditionedMedia(registry, evaluationInput)).toMatchObject({
      anatomyPreserved: false, unintendedChangesDetected: true,
    });
  });
});
