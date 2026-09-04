import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoGenerationTools, videoGenerationConfigured } from '../packages/tools/src/video-generation-tools';

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('ftypisom')]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dacai-video-'));
  cleanup.push(path);
  return path;
}

describe('video generation tool', () => {
  it('generates a text-to-video MP4 through the Wan media service', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/anatomy-video');
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt: 'cinematic ocean', animate: true, frames: 20, mode: 'anatomy' });
      return new Response(JSON.stringify({
        videoBase64: MP4.toString('base64'), videoModel: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers', videoFrames: 20,
      }), { status: 200 });
    });
    const tool = createVideoGenerationTools({ env: { DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
    const root = await workspace();

    const result = await tool.execute({ prompt: 'cinematic ocean', outputPath: 'output/ocean.mp4', frames: 20 }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'output/ocean.mp4', format: 'mp4', backend: 'dacais-media', frames: 20 });
    expect(await readFile(join(root, 'output', 'ocean.mp4'))).toEqual(MP4);
  });

  it('animates a workspace image and fails closed when the backend is disabled', async () => {
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:18090/v1/animate-image');
      expect(JSON.parse(String(init?.body))).toMatchObject({ sourceMediaBase64: PNG.toString('base64'), sourceMimeType: 'image/png' });
      return new Response(JSON.stringify({ videoBase64: MP4.toString('base64') }), { status: 200 });
    });
    const tool = createVideoGenerationTools({
      env: { DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_BASE_URL: 'http://localhost:18090' }, fetch: fetchMock as typeof fetch,
    })[0];

    await tool.execute({ sourcePath: 'source.png', outputPath: 'animated.mp4' }, { workspaceRoot: root });
    expect(videoGenerationConfigured({ DACAI_VIDEO_BACKEND: 'dacais-media' })).toBe(true);

    const disabled = createVideoGenerationTools({ env: {}, fetch: fetchMock as typeof fetch })[0];
    await expect(disabled.execute({ prompt: 'x', outputPath: 'disabled.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('Video generation is not enabled');
  });

  it('routes anatomy-sensitive video prompts to the Wan human-motion lane', async () => {
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/anatomy-video');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        prompt: 'two adults walking side by side with consistent full-body anatomy',
        mode: 'anatomy', sourceMediaBase64: PNG.toString('base64'),
      });
      return new Response(JSON.stringify({
        videoBase64: MP4.toString('base64'),
        videoModel: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers', videoFrames: 25,
      }), { status: 200 });
    });
    const tool = createVideoGenerationTools({
      env: { DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch,
    })[0];

    const result = await tool.execute({
      prompt: 'two adults walking side by side with consistent full-body anatomy',
      sourcePath: 'source.png', outputPath: 'walking.mp4',
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ model: 'Wan-AI/Wan2.2-TI2V-5B-Diffusers', frames: 25 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires explicit authenticated HTTPS for production backends and rejects unsafe paths/data/overwrites', async () => {
    const root = await workspace();
    const remote = createVideoGenerationTools({
      env: { DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_BASE_URL: 'https://example.com' }, fetch: vi.fn() as typeof fetch,
    })[0];
    await expect(remote.execute({ prompt: 'x', outputPath: 'x.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('loopback URL');

    const productionFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer production-test-token');
      return new Response(JSON.stringify({ videoBase64: MP4.toString('base64') }), { status: 200 });
    });
    const production = createVideoGenerationTools({
      env: {
        DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'https',
        DACAI_MEDIA_BASE_URL: 'https://media.example.com', DACAI_MEDIA_TOKEN: 'production-test-token',
      },
      fetch: productionFetch as typeof fetch,
    })[0];
    await production.execute({ prompt: 'x', outputPath: 'production.mp4' }, { workspaceRoot: root });
    expect(productionFetch).toHaveBeenCalledWith('https://media.example.com/v1/anatomy-video', expect.any(Object));

    const invalid = createVideoGenerationTools({
      env: { DACAI_VIDEO_BACKEND: 'dacais-media' },
      fetch: (async () => new Response(JSON.stringify({ videoBase64: Buffer.from('invalid video').toString('base64') }), { status: 200 })) as typeof fetch,
    })[0];
    await expect(invalid.execute({ prompt: 'x', outputPath: '../x.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('escaped the workspace');
    await expect(invalid.execute({ prompt: 'x', outputPath: 'invalid.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('valid MP4');

    const valid = createVideoGenerationTools({
      env: { DACAI_VIDEO_BACKEND: 'dacais-media' },
      fetch: (async () => new Response(JSON.stringify({ videoBase64: MP4.toString('base64') }), { status: 200 })) as typeof fetch,
    })[0];
    await valid.execute({ prompt: 'x', outputPath: 'exists.mp4' }, { workspaceRoot: root });
    await expect(valid.execute({ prompt: 'x', outputPath: 'exists.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('already exists');
  });
});
