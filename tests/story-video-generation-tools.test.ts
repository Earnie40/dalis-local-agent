import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStoryVideoGenerationTools,
  storyVideoGenerationConfigured,
  storyVideoGenerationRequiresNetwork,
} from '../packages/tools/src/story-video-generation-tools';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('ftypisom')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dacai-story-video-'));
  cleanup.push(root);
  return root;
}

describe('story video generation tool', () => {
  it('renders bounded scene jobs, concatenates on the media volume, and streams the final MP4 to the workspace', async () => {
    const root = await workspace();
    await writeFile(join(root, 'character.png'), PNG);
    const progress: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (path === '/v1/tts') return new Response(JSON.stringify({ audioBase64: 'd2F2' }), { status: 200 });
      if (path === '/v1/avatar') {
        expect(body.sourceMediaBase64).toBe(PNG.toString('base64'));
        return new Response(JSON.stringify({ videoBase64: MP4.toString('base64') }), { status: 200 });
      }
      if (path === '/v1/generate-backdrop') return new Response(JSON.stringify({ imageBase64: PNG.toString('base64') }), { status: 200 });
      if (path === '/v1/compose') {
        expect(body.returnBase64).toBe(false);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === '/v1/concat-video') {
        expect(body.segmentJobIds).toEqual([expect.stringMatching(/^story-.+-s1$/)]);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path.startsWith('/v1/artifacts/')) return new Response(MP4, { status: 200, headers: { 'Content-Length': String(MP4.byteLength) } });
      throw new Error(`Unexpected media request: ${path}`);
    });
    const tool = createStoryVideoGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media' },
      fetch: fetchMock as typeof fetch,
      onProgress: (event) => progress.push(event.phase),
    })[0];

    const result = await tool.execute({
      durationSeconds: 30,
      characters: [{ id: 'ava', name: 'Ava', imagePath: 'character.png', voice: { kind: 'stock', voice: 'af_heart' } }],
      segments: [{ characterId: 'ava', narration: 'Welcome to the park.', visualPrompt: 'A sunlit city park path, empty, documentary lighting.' }],
      outputPath: 'generated/videos/park.mp4',
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'generated/videos/park.mp4', format: 'mp4', backend: 'dacais-media', segments: 1 });
    expect(await readFile(join(root, 'generated', 'videos', 'park.mp4'))).toEqual(MP4);
    expect(progress).toContain('assembling');
    expect(progress).toContain('downloading');
  });

  it('requires explicit consent and a fully configured DACAIS image/video backend', async () => {
    const root = await workspace();
    await writeFile(join(root, 'character.png'), PNG);
    await writeFile(join(root, 'voice.wav'), Buffer.from('voice'));
    const tool = createStoryVideoGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: vi.fn() as typeof fetch })[0];
    await expect(tool.execute({
      durationSeconds: 30,
      characters: [{ id: 'ava', name: 'Ava', imagePath: 'character.png', voice: { kind: 'cloned', voiceId: 'ava-voice', referencePath: 'voice.wav', consent: false } }],
      segments: [{ characterId: 'ava', narration: 'Hello.', visualPrompt: 'A simple studio.' }], outputPath: 'story.mp4',
    }, { workspaceRoot: root })).rejects.toThrow('Explicit consent');
    expect(storyVideoGenerationConfigured({ DACAI_VIDEO_BACKEND: 'dacais-media' })).toBe(false);
    expect(storyVideoGenerationRequiresNetwork({ DACAI_MEDIA_TRANSPORT: 'https' })).toBe(true);
    expect(storyVideoGenerationRequiresNetwork({ DACAI_MEDIA_TRANSPORT: 'ssh-tunnel' })).toBe(false);
  });
});
