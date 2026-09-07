import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutor, NormalizedToolCall } from '@dacai-local-agent/agent-core';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import type { WorkspaceDescriptor } from '@dacai-local-agent/workspace';
import { MediaIntentSchema, type MediaIntent, type MediaVerification } from '@dacai-local-agent/shared';
import { PrecisionMediaExecutor, planMediaIntent, verifyMediaIntent } from '../apps/server/src/precision-media';
import { mediaRunFailureMessage, verifiedGeneratedArtifact } from '../apps/server/src/routes/agent';
import { intentFixture, pngFixture, VIDEO_FIXTURE as MP4 } from './media-fixtures';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function workspace(): Promise<WorkspaceDescriptor> {
  const rootPath = await mkdtemp(join(tmpdir(), 'precision-media-')); roots.push(rootPath);
  return { id: 'test', displayName: 'test', rootPath, capabilities: { read: true, write: true, shell: false, network: false }, gitDetected: false, detectedLanguages: [], createdAt: '', updatedAt: '' };
}
function report(intent: MediaIntent, passed = true): MediaVerification {
  const check = { passed, evidence: passed ? 'Requested feature is visible and matches.' : 'Wrong requested feature is visible.' };
  const targeted = (subject: string) => ({ subject, passed,
    evidence: passed ? `${subject}: visible in the result and matching the source.` : `${subject}: visibly wrong in the result.` });
  return { requestedChanges: intent.changes.map((change) => targeted(change.target)), protectedAttributes: intent.protectedAttributes.map((attribute) => targeted(attribute)),
    explicitConstraints: intent.constraints.explicit.map((constraint) => targeted(constraint)), subjects: check, composition: check, temporalProgression: check,
    summary: passed ? 'Verified all requested features.' : 'Requested color is wrong.', correction: passed ? '' : 'Change the shirt to the requested blue; keep every protected attribute unchanged.' };
}
function registryWith(content: unknown) {
  const chat = vi.fn(async (_request: Record<string, unknown>) => ({ content: typeof content === 'string' ? content : JSON.stringify(content) }));
  const resolveAlias = vi.fn(async () => ({ provider: { chat }, model: 'test-vision' }));
  return { registry: { resolveAlias } as unknown as ProviderRegistry, chat, resolveAlias };
}
function visualDefect(description: string, options: { location?: string; presentInOriginal?: boolean; contradictsRequest?: boolean } = {}) {
  return {
    description,
    specificLocation: options.location ?? 'specified subject region',
    presentInOriginal: options.presentInOriginal ?? false,
    contradictsRequest: options.contradictsRequest ?? true,
  };
}
const call = (args: Record<string, unknown> = {}, name = 'image.generate'): NormalizedToolCall => ({ id: 'media-test', name, arguments: { prompt: 'Generate exactly two red cubes on the left.', outputPath: 'result.png', ...args } });
function writer(root: string, bytes = pngFixture(512, 512)) {
  return vi.fn(async (request: NormalizedToolCall) => {
    const path = String(request.arguments.outputPath);
    await writeFile(join(root, path), bytes, { flag: 'wx' });
    return { success: true, output: JSON.stringify({ path, method: 'instruction-edit' }) };
  });
}
function inner(execute: ToolExecutor['execute']): ToolExecutor { return { listTools: () => [], execute }; }

describe('precision intent planning', () => {
  it.each([
    ['change only the shirt color', false, 'shirt'],
    ['fix only the fingers', true, 'fingers'],
    ['remove the upper-right object', false, 'upper-right object'],
    ['change the hair but preserve face, pose, clothing, lighting, and background', false, 'hair'],
  ])('grounds %s without deriving routing from preservation keywords', async (instruction, geometry, target) => {
    const expected = intentFixture(instruction, { geometry }); expected.changes[0].target = target;
    const { registry, chat } = registryWith(expected);
    const intent = await planMediaIntent(registry, { kind: 'image', instruction, sourceImageBase64: 'source-pixels' });
    expect(intent).toMatchObject({ requiresBodyGeometry: geometry, changesPose: false, editScope: 'localized' });
    expect(intent.changes[0].target).toBe(target);
    expect(chat.mock.calls[0][0]).toMatchObject({ think: false, responseFormat: { type: 'object', required: expect.arrayContaining(['version', 'kind', 'changes']) } });
  });
  it('retains multi-part instructions, counts and placement', async () => {
    const instruction = 'Place exactly two red cubes on the left and one blue sphere on the right.';
    const expected = intentFixture(instruction, { generate: true });
    const parsed = MediaIntentSchema.parse(expected);
    parsed.constraints.subjects = [{ description: 'red cubes', count: 2, placement: 'left' }, { description: 'blue sphere', count: 1, placement: 'right' }];
    parsed.changes.push({ action: 'place one blue sphere', target: 'right' });
    const { registry } = registryWith(parsed);
    expect(await planMediaIntent(registry, { kind: 'image', instruction })).toEqual(parsed);
  });
  it('imposes caller-owned envelope fields and explicit controls before strict parsing', async () => {
    const response = { ...intentFixture('model rewrite'), version: 2, kind: 'video', operation: 'generate',
      editScope: 'none', constraints: { width: 768, height: 768, loop: true } };
    const { registry, chat } = registryWith(response);
    const intent = await planMediaIntent(registry, {
      kind: 'image', instruction: 'change shirt', sourceImageBase64: 'source', width: 512, height: 512, loop: false,
    });
    expect(intent).toMatchObject({ version: 1, kind: 'image', operation: 'edit', instruction: 'change shirt',
      constraints: { width: 512, height: 512, loop: false } });
    expect(chat).toHaveBeenCalledOnce();
  });
  it('never widens a localized edit when the planner omits its grounded region', async () => {
    const response = { ...intentFixture('change shirt'), changes: [{ action: 'change shirt', target: 'shirt' }] };
    const { registry, chat } = registryWith(response);
    await expect(planMediaIntent(registry, {
      kind: 'image', instruction: 'change shirt', sourceImageBase64: 'source',
    })).rejects.toThrow('could not be grounded without changing the request');
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('rejects oversized prompts without truncation or provider calls', async () => {
    const { registry, chat } = registryWith({});
    await expect(planMediaIntent(registry, { kind: 'image', instruction: 'x'.repeat(4001) })).rejects.toThrow('never truncated');
    expect(chat).not.toHaveBeenCalled();
  });
  it('drops invented dimensions and retains inferred constraints only with quoted support', async () => {
    const instruction = 'Generate three cubes.';
    const response = { ...intentFixture(instruction, { generate: true }), constraints: { width: 1024 } };
    expect((await planMediaIntent(registryWith(response).registry, { kind: 'image', instruction })).constraints.width).toBeUndefined();
    const videoInstruction = 'Create a video lasting one minute.';
    const video = { ...intentFixture(videoInstruction, { generate: true }), kind: 'video', constraints: { durationSeconds: 60, evidence: { durationSeconds: 'one minute' } } };
    expect((await planMediaIntent(registryWith(video).registry, { kind: 'video', instruction: videoInstruction })).constraints.durationSeconds).toBe(60);
    expect(MediaIntentSchema.safeParse({ ...response, constraints: { durationSeconds: 10 } }).success).toBe(false);
  });
  it('removes the live planner durationSeconds:0 default from image intents', async () => {
    const instruction = 'Create an image of a red cube on a white table.';
    const response = { ...intentFixture(instruction, { generate: true }), constraints: { durationSeconds: 0, loop: false } };
    const { registry, chat } = registryWith(response);
    const intent = await planMediaIntent(registry, { kind: 'image', instruction });
    expect(intent.constraints.durationSeconds).toBeUndefined();
    expect(chat).toHaveBeenCalledOnce();
    const schema = chat.mock.calls[0][0].responseFormat as Record<string, any>;
    expect(schema.properties.kind.enum).toEqual(['image']);
    expect(schema.properties.operation.enum).toEqual(['generate']);
    expect(schema.properties.constraints.properties.durationSeconds).toBeUndefined();
  });
  it('keeps explicitly supplied loop and dimensions', async () => {
    const instruction = 'Generate a looping animation.';
    const response = { ...intentFixture(instruction, { generate: true }), kind: 'video' };
    const { registry } = registryWith(response);
    const result = await planMediaIntent(registry, { kind: 'video', instruction, width: 512, durationSeconds: 30, loop: true });
    expect(result.constraints).toMatchObject({ width: 512, durationSeconds: 30, loop: true });
  });
  it('normalizes a planner guess of a conflicting editScope for a bare generate', async () => {
    // Reproduces the reported video.generate block: operation is fixed to
    // 'generate' because no source was supplied, but a small planner guesses the
    // required editScope enum as 'global'. That internal contradiction used to
    // fail strict parsing as "Generation has no source edit scope." and surface
    // as TASK_BLOCKED/TASK_FAILED. A generate has no source, so editScope must be
    // derived as 'none'.
    const instruction = 'fix the TASK_BLOCKED problem';
    const response = {
      ...intentFixture(instruction, { generate: true }),
      kind: 'video',
      editScope: 'global',
      protectedAttributes: ['identity', 'face', 'pose', 'clothing', 'background'],
    };
    const { registry } = registryWith(response);
    const intent = await planMediaIntent(registry, { kind: 'video', instruction });
    expect(intent).toMatchObject({
      operation: 'generate', kind: 'video', editScope: 'none', instruction, protectedAttributes: [],
    });
  });
  it('accepts a pure generate with an empty changes array; only an edit must describe a change', async () => {
    // A generate has no source, so it has no source edits to enumerate. The
    // schema used to require changes.min(1) on every intent, which forced the
    // planner to either invent a change list or return [] and fail with
    // "Array must contain at least 1 element(s)" on changes — every attempt.
    const instruction = 'render an abstract landscape';
    const { registry } = registryWith({ ...intentFixture(instruction, { generate: true }), kind: 'video', changes: [] });
    const intent = await planMediaIntent(registry, { kind: 'video', instruction });
    expect(intent).toMatchObject({ operation: 'generate', editScope: 'none', changes: [] });
    // An edit is still required to name at least one change.
    const edit = intentFixture('change shirt');
    expect(MediaIntentSchema.safeParse({ ...edit, changes: [] }).success).toBe(false);
    expect(MediaIntentSchema.safeParse(edit).success).toBe(true);
  });
  it('does not invent a global edit after two empty localized plans', async () => {
    const instruction = 'Change only the turquoise earring to red.';
    const response = { ...intentFixture(instruction), editScope: 'none', changes: [] };
    const { registry, chat } = registryWith(response);
    await expect(planMediaIntent(registry, { kind: 'image', instruction, sourceImageBase64: 'source' }))
      .rejects.toThrow('could not be grounded without changing the request');
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('retains reference identity constraints during generation', async () => {
    const instruction = 'Create a new portrait of both supplied adults together.';
    const response = { ...intentFixture(instruction, { generate: true }), protectedAttributes: ['identity', 'face', 'clothing'] };
    const intent = await planMediaIntent(registryWith(response).registry, {
      kind: 'image', instruction, referenceImagesBase64: ['person-a', 'person-b'],
    });
    expect(intent).toMatchObject({ operation: 'generate', editScope: 'none', protectedAttributes: ['identity', 'face', 'clothing'] });
  });
  it('verifies a generation with no requested changes', async () => {
    const intent = MediaIntentSchema.parse({ ...intentFixture('Generate a scene', { generate: true }), kind: 'video', changes: [] });
    const { registry, chat } = registryWith({ ...report(intent), requestedChanges: [] });
    chat.mockResolvedValueOnce({ content: JSON.stringify({ ...report(intent), requestedChanges: [] }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ observation: 'A coherent, artifact-free scene.', defects: [], visuallyCoherent: true }) });
    const verification = await verifyMediaIntent(registry, { intent, sourceImages: [], resultImages: ['result'], metadata: {} });
    expect(verification.requestedChanges).toEqual([]);
    expect(MediaIntentSchema.safeParse(intent).success).toBe(true);
  });
});

describe('verified artifact publication', () => {
  it('retries on the same source, intent, mode and controls; publishes only a passing candidate', async () => {
    const ws = await workspace(); await writeFile(join(ws.rootPath, 'source.png'), pngFixture(512, 512));
    // Different valid pixel content, same dimensions.
    const resultBytes = pngFixture(512, 512, 123);
    const intent = MediaIntentSchema.parse(intentFixture('change only the shirt color'));
    const execute = writer(ws.rootPath, resultBytes);
    const verify = vi.fn().mockResolvedValueOnce(report(intent, false)).mockResolvedValueOnce(report(intent));
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent, verify });
    const request = call({ prompt: intent.instruction, sourcePath: 'source.png', mode: 'anatomy', strength: 0.35, negativePrompt: 'extra fingers' });
    const result = await executor.execute(request);
    expect(result.success).toBe(true); expect(execute).toHaveBeenCalledTimes(2);
    for (const [attempt] of execute.mock.calls) expect(attempt.arguments).toMatchObject({ sourcePath: 'source.png', mode: 'anatomy', strength: .35, negativePrompt: 'extra fingers', intent, width: 512, height: 512 });
    expect(execute.mock.calls[1][0].arguments.correction).toContain('requested blue');
    expect(JSON.parse(result.output)).toMatchObject({ path: 'result.png', verificationAttempts: 2, verification: report(intent) });
    expect(verifiedGeneratedArtifact(result, 'result.png', 'png')).toMatchObject({ path: 'result.png', bytes: resultBytes.length });
    expect(await readFile(join(ws.rootPath, 'result.png'))).toEqual(resultBytes);
    expect(await readdir(ws.rootPath)).toEqual(['result.png', 'source.png']);
  });
  it.each(['malformed', 'failed', 'missing-check', 'repeated-check', 'unchanged', 'wrong-size'])('does not publish %s evidence', async reason => {
    vi.stubEnv('DACAI_MEDIA_VERIFICATION', 'enforce');
    const ws = await workspace(); const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    await writeFile(join(ws.rootPath, 'source.png'), pngFixture(512, 512));
    const execute = writer(ws.rootPath, reason === 'unchanged' ? pngFixture(512, 512) : reason === 'wrong-size' ? pngFixture(768, 512) : pngFixture(512, 512, 123));
    const evidence = reason === 'malformed' ? { preserved: 'true' } : reason === 'missing-check' ? { ...report(intent), protectedAttributes: [] }
      : reason === 'repeated-check' ? { ...report(intent), protectedAttributes: intent.protectedAttributes.map(() => ({ subject: 'preservation', passed: true, evidence: 'Everything else is preserved.' })) }
      : report(intent, reason !== 'failed');
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent, verify: vi.fn().mockResolvedValue(evidence) });
    const result = await executor.execute(call({ prompt: intent.instruction, sourcePath: 'source.png' }));
    expect(result.success).toBe(false);
    if (['failed', 'missing-check', 'repeated-check'].includes(reason)) {
      expect(result.output).toContain('after 3 compatible attempts');
      expect(execute).toHaveBeenCalledTimes(3);
    } else {
      expect(execute).toHaveBeenCalledOnce();
    }
    if (reason === 'failed') {
      const message = mediaRunFailureMessage(result, 'image');
      expect(message).toContain('Requested color is wrong.');
      expect(message).toContain('Change the shirt to the requested blue');
    }
    expect(await readdir(ws.rootPath)).toEqual(['source.png']);
  });
  it('publishes the corrected attempt when verification never passes', async () => {
    // The strict gate deleted every candidate and published nothing, so a vision
    // model calling a photograph "composited" destroyed a usable image. The
    // artifact now survives, carrying the objection rather than being replaced by
    // it.
    const ws = await workspace(); await writeFile(join(ws.rootPath, 'source.png'), pngFixture(512, 512));
    const resultBytes = pngFixture(512, 512, 123);
    const intent = MediaIntentSchema.parse(intentFixture('change only the shirt color'));
    const execute = writer(ws.rootPath, resultBytes);
    const verify = vi.fn().mockResolvedValue(report(intent, false));
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent, verify });

    const result = await executor.execute(call({ prompt: intent.instruction, sourcePath: 'source.png' }));

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.parse(result.output)).toMatchObject({ path: 'result.png', verified: false, verificationAttempts: 3 });
    expect(await readFile(join(ws.rootPath, 'result.png'))).toEqual(resultBytes);
    // The retained candidate is published, not left behind beside the result.
    expect(await readdir(ws.rootPath)).toEqual(['result.png', 'source.png']);
  });
  it('preserves preexisting outputs and collision races', async () => {
    const ws = await workspace(); const intent = MediaIntentSchema.parse(intentFixture('generate', { generate: true }));
    const execute = writer(ws.rootPath);
    const verify = vi.fn(async () => { await writeFile(join(ws.rootPath, 'result.png'), 'existing'); return report(intent); });
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent, verify });
    expect((await executor.execute(call())).success).toBe(false);
    expect(await readFile(join(ws.rootPath, 'result.png'), 'utf8')).toBe('existing');
    execute.mockClear();
    expect((await executor.execute(call())).success).toBe(false); expect(execute).not.toHaveBeenCalled();
  });
  it('propagates denial without retries or publication', async () => {
    const ws = await workspace(); const intent = MediaIntentSchema.parse(intentFixture('generate', { generate: true }));
    const execute = vi.fn(async () => ({ success: false, denied: true, output: 'denied' }));
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent });
    expect(await executor.execute(call())).toMatchObject({ success: false, denied: true });
    expect(execute).toHaveBeenCalledTimes(1); expect(await readdir(ws.rootPath)).toEqual([]);
  });
  it('verifies real decoded video duration and temporal evidence', async () => {
    vi.stubEnv('DACAI_MEDIA_VERIFICATION', 'enforce');
    const ws = await workspace(); const intent = MediaIntentSchema.parse({ ...intentFixture('moving cubes', { generate: true }), kind: 'video', constraints: { durationSeconds: 1, loop: false } });
    const execute = writer(ws.rootPath, MP4); const verify = vi.fn().mockResolvedValue({ ...report(intent), temporalProgression: { passed: false, evidence: 'Frames repeat the same positions.' } });
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent, verify, frames: async () => ['frame1', 'frame2'] });
    expect((await executor.execute(call({ outputPath: 'result.mp4' }, 'video.generate'))).success).toBe(false);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(verify.mock.calls[0][0].metadata).toMatchObject({ durationSeconds: 1, frames: 8 });
    expect(await readdir(ws.rootPath)).toEqual([]);
  });
  it('uses existing story scenes verbatim while supplying references to planning and evaluation', async () => {
    const ws = await workspace(); await writeFile(join(ws.rootPath, 'scene.png'), pngFixture(512, 512));
    const intent = MediaIntentSchema.parse({ ...intentFixture('Render story', { generate: true }), kind: 'video', constraints: { durationSeconds: 1 } });
    const plan = vi.fn(async () => intent); const verify = vi.fn(async () => report(intent));
    const executor = new PrecisionMediaExecutor(inner(writer(ws.rootPath, MP4)), { workspace: ws, plan, verify, frames: async () => ['frame'] });
    const result = await executor.execute(call({ outputPath: 'result.mp4', characters: [{ id: 'a', imagePath: 'scene.png' }], segments: [{ characterId: 'a', scenePath: 'scene.png', visualPrompt: 'Keep the scene', narration: 'Hello' }] }, 'video.story.generate'));
    expect(result.success).toBe(true); expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0][0].referenceImagesBase64).toHaveLength(2);
    expect(verify.mock.calls[0][0].sourceImages).toHaveLength(2);
    expect(verify.mock.calls[0][0].metadata.storyboard).toContain('Keep the scene');
  });

  it('combines separate image attachments for generation while retaining both as verification references', async () => {
    const ws = await workspace();
    await writeFile(join(ws.rootPath, 'person-a.png'), pngFixture(320, 480, 7));
    await writeFile(join(ws.rootPath, 'person-b.png'), pngFixture(480, 320, 11));
    const prompt = 'Create both attached adults making pizza together on a date.';
    const intent = MediaIntentSchema.parse(intentFixture(prompt, { generate: true, geometry: true }));
    const plan = vi.fn(async () => intent);
    const verify = vi.fn(async () => report(intent));
    const referenceSheet = vi.fn(async (input: { sources: string[]; output: string; width: number; height: number }) => {
      expect(input.sources).toEqual([join(ws.rootPath, 'person-a.png'), join(ws.rootPath, 'person-b.png')]);
      expect(input).toMatchObject({ width: 512, height: 512 });
      await writeFile(input.output, pngFixture(512, 512, 19), { flag: 'wx' });
    });
    const execute = vi.fn(async (request: NormalizedToolCall) => {
      expect(request.arguments).toMatchObject({
        prompt,
        width: 512,
        height: 512,
        intent: { operation: 'generate', protectedAttributes: [] },
      });
      expect(request.arguments.sourcePath).toBeUndefined();
      expect(String(request.arguments.referenceSheetPath)).toMatch(/^\.image-reference-[a-f0-9-]+\.png$/);
      const path = String(request.arguments.outputPath);
      await writeFile(join(ws.rootPath, path), pngFixture(512, 512, 23), { flag: 'wx' });
      return { success: true, output: JSON.stringify({ path, method: 'anatomy' }) };
    });
    const executor = new PrecisionMediaExecutor(inner(execute), {
      workspace: ws,
      plan,
      verify,
      referenceSheet,
    });

    const result = await executor.execute(call({
      prompt,
      referencePaths: ['person-a.png', 'person-b.png'],
      width: 512,
      height: 512,
    }));

    expect(result.success).toBe(true);
    expect(plan.mock.calls[0][0]).toMatchObject({ sourceImageBase64: undefined, referenceImagesBase64: expect.any(Array) });
    expect(plan.mock.calls[0][0].referenceImagesBase64).toHaveLength(2);
    expect(verify.mock.calls[0][0].sourceImages).toHaveLength(2);
    expect(referenceSheet).toHaveBeenCalledOnce();
    expect(await readdir(ws.rootPath)).toEqual(['person-a.png', 'person-b.png', 'result.png']);
  });
});

describe('strict evaluator protocol', () => {
  it('requests constrained output but still validates all evidence', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    const { registry, chat } = registryWith(report(intent));
    const clean = { content: JSON.stringify({ observation: 'Continuous shirt and body edges.', defects: [], visuallyCoherent: true }) };
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) }).mockResolvedValueOnce(clean).mockResolvedValueOnce(clean);
    await verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} });
    expect(chat.mock.calls[0][0]).toMatchObject({ responseFormat: { type: 'object', required: expect.arrayContaining(['requestedChanges', 'protectedAttributes', 'temporalProgression']) } });
    expect(JSON.stringify(chat.mock.calls[0][0].responseFormat)).not.toContain('maxLength');
    expect(chat.mock.calls[0][0]).toMatchObject({ responseFormat: { properties: {
      requestedChanges: { minItems: 1, maxItems: 1 }, protectedAttributes: { minItems: 3, maxItems: 3 }, explicitConstraints: { minItems: 0, maxItems: 0 },
    } } });
  });
  it('rejects an optimistic preservation verdict when independent inspection finds seams', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    const { registry, chat } = registryWith(report(intent));
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) })
      .mockResolvedValueOnce({ content: JSON.stringify({ observation: 'An intact, unedited subject.', defects: [], visuallyCoherent: true }) })
      .mockResolvedValueOnce({ content: JSON.stringify({
        observation: 'A rectangular shirt patch cuts across the neck.',
        defects: [visualDefect('Neck and arm edges are discontinuous at the patch boundary.', { location: 'shirt neckline and arm opening' })],
        visuallyCoherent: false,
      }) });
    const verification = await verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} });
    expect(verification.composition.passed).toBe(false);
    expect(verification.correction).toContain('Neck and arm');
    expect(chat.mock.calls[1][0]).toMatchObject({ messages: [{ images: ['source'] }] });
    expect(chat.mock.calls[2][0]).toMatchObject({ messages: [{ images: ['result'] }] });
  });
  it('excludes faults the unedited source already had from the result verdict', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    const { registry, chat } = registryWith(report(intent));
    const prior = 'The left hand has six fingers.';
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) })
      .mockResolvedValueOnce({ content: JSON.stringify({ observation: 'A person with a distinct left hand.', defects: [visualDefect(prior, { location: 'left hand', presentInOriginal: true })], visuallyCoherent: false }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ observation: 'The same subject wearing a new shirt.', defects: [], visuallyCoherent: true }) });
    const verification = await verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} });
    expect(verification.composition.passed).toBe(true);
    const baselineCall = chat.mock.calls[1][0] as unknown as { messages: { content: string }[] };
    const resultCall = chat.mock.calls[2][0] as unknown as { messages: { content: string }[] };
    // The baseline pass never sees the request; the result pass must exclude what the source already had.
    expect(baselineCall.messages[0].content).not.toContain(intent.instruction);
    expect(resultCall.messages[0].content).toContain(prior);
  });
  it('does not let a defect-free but false boolean override the paired verdict', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    const { registry, chat } = registryWith(report(intent));
    const inconsistent = { observation: 'No structural or compositing defects are visible.', defects: [], visuallyCoherent: false };
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) })
      .mockResolvedValue({ content: JSON.stringify(inconsistent) });
    const verification = await verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} });
    expect(verification.composition.passed).toBe(true);
    expect(verification.composition.evidence).toContain('inconclusive');
    // The paired report, then two rejected attempts for each of the baseline and result passes.
    expect(chat).toHaveBeenCalledTimes(5);
  });
  it('does not treat generic compositing criticism as a concrete structural defect', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('put both people in one kitchen scene'));
    const { registry, chat } = registryWith(report(intent));
    const subjective = {
      observation: 'The two people look digitally composited.',
      defects: [
        visualDefect('The images are not seamlessly blended.', { contradictsRequest: false }),
        visualDefect('The lighting and background do not match.', { contradictsRequest: false }),
        visualDefect('The transition between the subjects is abrupt.', { contradictsRequest: false }),
      ],
      visuallyCoherent: false,
    };
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) })
      .mockResolvedValue({ content: JSON.stringify(subjective) });

    const verification = await verifyMediaIntent(registry, {
      intent, sourceImages: ['source'], resultImages: ['result'], metadata: {},
    });

    expect(verification.composition.passed).toBe(true);
    expect(verification.composition.evidence).toContain('inconclusive');
  });
  it('does not reject unusual anatomy that the user explicitly requested', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('Give the fantasy character six fingers on each hand.'));
    const { registry, chat } = registryWith(report(intent));
    const requestedFeature = visualDefect('Each hand has six fingers.', {
      location: 'both hands',
      contradictsRequest: false,
    });
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) })
      .mockResolvedValue({ content: JSON.stringify({ observation: 'The requested six-finger design is visible.', defects: [requestedFeature], visuallyCoherent: false }) });

    const verification = await verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} });
    expect(verification.composition.passed).toBe(true);
    expect(verification.composition.evidence).toContain('inconclusive');
  });
  it('does not accept malformed independent inspection as preservation', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    const { registry, chat } = registryWith(report(intent));
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) }).mockResolvedValueOnce({ content: '{"visuallyCoherent":"true"}' });
    await expect(verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} })).rejects.toThrow();
  });
  it.each(['not json', '{}', '{"requestedChanges":[{"passed":"true","evidence":"ok"}]}'])('rejects %s', async content => {
    const { registry } = registryWith(content);
    await expect(verifyMediaIntent(registry, { intent: MediaIntentSchema.parse(intentFixture('change shirt')), sourceImages: ['source'], resultImages: ['result'], metadata: {} })).rejects.toThrow();
  });
});
