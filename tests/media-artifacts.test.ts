import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPng, probeVideo } from '../packages/tools/src/media-artifacts';
import { createImageGenerationTools } from '../packages/tools/src/image-generation-tools';
import { createVideoGenerationTools } from '../packages/tools/src/video-generation-tools';
import { createStoryVideoGenerationTools } from '../packages/tools/src/story-video-generation-tools';
import { intentFixture, mockVideoProbe, pngFixture, VIDEO_FIXTURE } from './media-fixtures';

const cleanup: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), 'dacai-media-regression-')); cleanup.push(root); return root; }
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe('media precision regressions', () => {
  it('requires complete, checksum-correct and decompressible PNG data', () => {
    const image = pngFixture(1, 1);
    expect(inspectPng(image)).toEqual({ width: 1, height: 1 });
    expect(() => inspectPng(image.subarray(0, 8))).toThrow('valid PNG');
    expect(() => inspectPng(image.subarray(0, image.length - 12))).toThrow('valid PNG');
    const corrupt = Buffer.from(image); corrupt[45] ^= 255;
    expect(() => inspectPng(corrupt)).toThrow('valid PNG');
    expect(() => inspectPng(Buffer.concat([image, Buffer.from('garbage')]))).toThrow('valid PNG');
  });

  it('rejects a different actual image size before publishing a file', async () => {
    const root = await workspace();
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: vi.fn(async () => json({ imageBase64: pngFixture().toString('base64') })) as typeof fetch })[0];
    await expect(tool.execute({ prompt: 'exactly three subjects: two left, one right', width: 1536, height: 1536, outputPath: 'result.png' }, { workspaceRoot: root })).rejects.toThrow('1024x1024 do not match requested 1536x1536');
    await expect(readFile(join(root, 'result.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['change only the shirt color', false], ['fix only the fingers', true],
    ['remove the upper-right object', false],
    ['change the hair but preserve face, pose, clothing, lighting, and background', false],
  ])('routes %s from structured changes and forwards all edit controls', async (instruction, geometry) => {
    const root = await workspace(); await writeFile(join(root, 'source.png'), pngFixture());
    const intent = intentFixture(instruction, { geometry });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain(geometry ? '/v1/anatomy-edit' : '/v1/instruct-edit');
      expect(JSON.parse(String(init?.body))).toMatchObject({ intent, strength: 0.3, negativePrompt: 'avoid changing protected content', correction: 'Apply the target change more precisely.' });
      return json({ imageBase64: pngFixture().toString('base64') });
    });
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
    await tool.execute({ prompt: `${instruction}. Preserve every other subject, pose, hand, and limb.`, intent, strength: 0.3, negativePrompt: 'avoid changing protected content', correction: 'Apply the target change more precisely.', sourcePath: 'source.png', outputPath: 'result.png' }, { workspaceRoot: root });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains exact count and placement in the generation intent', async () => {
    const root = await workspace();
    const intent = { ...intentFixture('Exactly three red cubes: two left, one right', { generate: true }), constraints: { loop: false, subjects: [{ description: 'red cubes', count: 3, placement: 'two left, one right' }], explicit: ['plain white background'] } };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).intent).toEqual(intent);
      return json({ imageBase64: pngFixture().toString('base64') });
    });
    await createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0].execute({ prompt: intent.instruction, intent, outputPath: 'result.png' }, { workspaceRoot: root });
  });

  it('retries instruction editing on the same endpoint and never regenerates', async () => {
    const root = await workspace(); await writeFile(join(root, 'source.png'), pngFixture());
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(json({ imageBase64: pngFixture().toString('base64') }));
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch, sleep: async () => undefined })[0];
    await tool.execute({ prompt: 'change only the shirt color', sourcePath: 'source.png', outputPath: 'result.png' }, { workspaceRoot: root });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:18090/v1/instruct-edit', 'http://127.0.0.1:18090/v1/instruct-edit']);
  });

  it('rejects malformed intent and incompatible explicit img2img before inference', async () => {
    const root = await workspace(); await writeFile(join(root, 'source.png'), pngFixture());
    const fetchMock = vi.fn();
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
    await expect(tool.execute({ prompt: 'shirt', intent: { requiresBodyGeometry: 'false' }, outputPath: 'result.png' }, { workspaceRoot: root })).rejects.toThrow();
    await expect(tool.execute({ prompt: 'shirt', intent: intentFixture('shirt'), mode: 'img2img', sourcePath: 'source.png', outputPath: 'result.png' }, { workspaceRoot: root })).rejects.toThrow('protected content');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks actual MP4 decoded frames and rejects a signature-only container', async () => {
    const root = await workspace(); const path = join(root, 'fixture.mp4');
    await writeFile(path, VIDEO_FIXTURE);
    await expect(probeVideo(path)).resolves.toMatchObject({ width: 16, height: 16, durationSeconds: 1, frames: 8, fps: 8 });
    await writeFile(path, Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('ftypisom')]));
    await expect(probeVideo(path)).rejects.toThrow('Video validation failed');
  });

  it('forwards a short requested animation duration and disables unrequested looping', async () => {
    const root = await workspace(); await writeFile(join(root, 'source.png'), pngFixture());
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ durationSeconds: 4, loop: false });
      return json({ videoBase64: VIDEO_FIXTURE.toString('base64'), videoFrames: 999 });
    });
    const tool = createVideoGenerationTools({ env: { DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch, probeVideo: async () => ({ ...await mockVideoProbe(), durationSeconds: 4, frames: 64 }) })[0];
    await expect(tool.execute({ sourcePath: 'source.png', durationSeconds: 4, outputPath: 'result.mp4' }, { workspaceRoot: root })).resolves.toMatchObject({ durationSeconds: 4, frames: 64 });
  });

  it.each([{ durationSeconds: 1.5625 }, { width: 512 }])('rejects incorrect actual video constraints %s and removes only its output', async (override) => {
    const root = await workspace();
    const tool = createVideoGenerationTools({ env: { DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: vi.fn(async () => json({ videoBase64: VIDEO_FIXTURE.toString('base64') })) as typeof fetch, probeVideo: async () => ({ ...await mockVideoProbe(), ...override }) })[0];
    await expect(tool.execute({ prompt: 'progressing action', durationSeconds: 30, outputPath: 'result.mp4' }, { workspaceRoot: root })).rejects.toThrow(/does not match|do not match/);
    await expect(readFile(join(root, 'result.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an existing story video when the streamed exclusive write collides', async () => {
    const root = await workspace(); await writeFile(join(root, 'source.png'), pngFixture());
    const original = Buffer.from('original video must survive'); await writeFile(join(root, 'existing.mp4'), original);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('/artifacts/')) return new Response(VIDEO_FIXTURE);
      if (path.endsWith('/tts')) return json({ audioBase64: 'd2F2' });
      if (path.endsWith('/avatar')) return json({ videoBase64: VIDEO_FIXTURE.toString('base64') });
      return json({ ok: true });
    });
    const tool = createStoryVideoGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch, probeVideo: mockVideoProbe })[0];
    await expect(tool.execute({ durationSeconds: 30, characters: [{ id: 'a', name: 'A', imagePath: 'source.png', voice: { kind: 'stock' } }], segments: [{ characterId: 'a', narration: 'Hello', visualPrompt: 'studio', scenePath: 'source.png' }], outputPath: 'existing.mp4' }, { workspaceRoot: root })).rejects.toThrow('already exists');
    expect(await readFile(join(root, 'existing.mp4'))).toEqual(original);
  });
});
