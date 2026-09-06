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
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
  it('rejects rewritten instructions, missing regions, and conflicting numeric constraints', async () => {
    for (const response of [intentFixture('wrong instruction'), { ...intentFixture('change shirt'), changes: [{ action: 'change shirt', target: 'shirt' }] },
      { ...intentFixture('change shirt'), constraints: { width: 768, loop: false } }]) {
      const { registry, chat } = registryWith(response);
      await expect(planMediaIntent(registry, { kind: 'image', instruction: 'change shirt', sourceImageBase64: 'source', width: 512 })).rejects.toThrow('could not be grounded');
      expect(chat).toHaveBeenCalledTimes(2);
    }
  });
  it('rejects oversized prompts without truncation or provider calls', async () => {
    const { registry, chat } = registryWith({});
    await expect(planMediaIntent(registry, { kind: 'image', instruction: 'x'.repeat(4001) })).rejects.toThrow('never truncated');
    expect(chat).not.toHaveBeenCalled();
  });
  it('rejects invented dimensions and requires quoted support for inferred numeric constraints', async () => {
    const instruction = 'Generate three cubes.';
    const response = { ...intentFixture(instruction, { generate: true }), constraints: { width: 1024 } };
    await expect(planMediaIntent(registryWith(response).registry, { kind: 'image', instruction })).rejects.toThrow('supporting quote');
    const videoInstruction = 'Create a video lasting one minute.';
    const video = { ...intentFixture(videoInstruction, { generate: true }), kind: 'video', constraints: { durationSeconds: 60, evidence: { durationSeconds: 'one minute' } } };
    expect((await planMediaIntent(registryWith(video).registry, { kind: 'video', instruction: videoInstruction })).constraints.durationSeconds).toBe(60);
    expect(MediaIntentSchema.safeParse({ ...response, constraints: { durationSeconds: 10 } }).success).toBe(false);
  });
  it('keeps explicitly supplied loop and dimensions', async () => {
    const instruction = 'Generate a looping animation.';
    const response = { ...intentFixture(instruction, { generate: true }), kind: 'video' };
    const { registry } = registryWith(response);
    const result = await planMediaIntent(registry, { kind: 'video', instruction, width: 512, durationSeconds: 30, loop: true });
    expect(result.constraints).toMatchObject({ width: 512, durationSeconds: 30, loop: true });
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
    const ws = await workspace(); const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    await writeFile(join(ws.rootPath, 'source.png'), pngFixture(512, 512));
    const execute = writer(ws.rootPath, reason === 'unchanged' ? pngFixture(512, 512) : reason === 'wrong-size' ? pngFixture(768, 512) : pngFixture(512, 512, 123));
    const evidence = reason === 'malformed' ? { preserved: 'true' } : reason === 'missing-check' ? { ...report(intent), protectedAttributes: [] }
      : reason === 'repeated-check' ? { ...report(intent), protectedAttributes: intent.protectedAttributes.map(() => ({ subject: 'preservation', passed: true, evidence: 'Everything else is preserved.' })) }
      : report(intent, reason !== 'failed');
    const executor = new PrecisionMediaExecutor(inner(execute), { workspace: ws, plan: async () => intent, verify: vi.fn().mockResolvedValue(evidence) });
    const result = await executor.execute(call({ prompt: intent.instruction, sourcePath: 'source.png' }));
    expect(result.success).toBe(false); expect(result.output).toContain('after 3 compatible attempts');
    if (reason === 'failed') {
      const message = mediaRunFailureMessage(result, 'image');
      expect(message).toContain('Requested color is wrong.');
      expect(message).toContain('Change the shirt to the requested blue');
    }
    expect(await readdir(ws.rootPath)).toEqual(['source.png']);
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
});

describe('strict evaluator protocol', () => {
  it('requests constrained output but still validates all evidence', async () => {
    const intent = MediaIntentSchema.parse(intentFixture('change shirt'));
    const { registry, chat } = registryWith(report(intent));
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) }).mockResolvedValueOnce({ content: JSON.stringify({ observation: 'Continuous shirt and body edges.', defects: [], visuallyCoherent: true }) });
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
    chat.mockResolvedValueOnce({ content: JSON.stringify(report(intent)) }).mockResolvedValueOnce({ content: JSON.stringify({ observation: 'A rectangular shirt patch cuts across the neck.', defects: ['Neck and arm edges are discontinuous at the patch boundary.'], visuallyCoherent: false }) });
    const verification = await verifyMediaIntent(registry, { intent, sourceImages: ['source'], resultImages: ['result'], metadata: {} });
    expect(verification.composition.passed).toBe(false);
    expect(verification.correction).toContain('Neck and arm');
    expect(chat.mock.calls[1][0]).toMatchObject({ messages: [{ images: ['result'] }] });
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
