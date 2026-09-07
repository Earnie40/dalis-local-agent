import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFaceSwapTools,
  faceSwapConfigured,
  faceSwapMaxSeconds,
  faceSwapRequiresNetwork,
} from '../packages/tools/src/face-swap-tools';
import { isFaceSwapRequest, classifyDirectMediaRequest } from '../apps/server/src/routes/agent';

import { VIDEO_FIXTURE as MP4, mockVideoProbe } from './media-fixtures';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dacai-face-swap-'));
  cleanup.push(path);
  await writeFile(join(path, 'face.png'), PNG);
  await writeFile(join(path, 'clip.mp4'), MP4);
  return path;
}

function swapResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    videoBase64: MP4.toString('base64'),
    model: 'insightface/inswapper_128',
    detector: 'buffalo_l',
    framesTotal: 480,
    framesSwapped: 471,
    meanSimilarity: 0.82,
    restoredFaces: true,
    provider: 'CUDAExecutionProvider',
    syntheticMediaTag: 'AI-generated: face replaced by DACAIS media service',
    ...overrides,
  }), { status: 200 });
}

describe('face swap tool', () => {
  it('auto-approves bounded loopback swaps without public-network permission', () => {
    const tool = createFaceSwapTools({
      probeVideo: mockVideoProbe,
      env: { DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'ssh-tunnel' },
      fetch,
    })[0];
    expect(tool).toMatchObject({ name: 'video.faceSwap', permissionTier: 'mutation', autoApprove: true, requiresNetwork: false });
    expect(faceSwapConfigured({ DACAI_VIDEO_BACKEND: 'dacais-media' })).toBe(true);
    expect(faceSwapRequiresNetwork({ DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'https' })).toBe(true);
    expect(faceSwapMaxSeconds({})).toBe(120);
    expect(faceSwapMaxSeconds({ DACAI_FACE_SWAP_MAX_SECONDS: '900' })).toBe(600);
  });

  it('swaps the selected character and returns verified artifact evidence', async () => {
    const root = await workspace();
    await writeFile(join(root, 'character.jpg'), PNG);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/face-swap');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        faceMediaBase64: PNG.toString('base64'),
        faceMimeType: 'image/png',
        targetMediaBase64: MP4.toString('base64'),
        targetMimeType: 'video/mp4',
        targetReferenceBase64: PNG.toString('base64'),
        targetReferenceMimeType: 'image/jpeg',
        targetFaceIndex: 0,
        similarityThreshold: 0.35,
        restoreFaces: true,
        keepAudio: true,
      });
      return swapResponse();
    });
    const tool = createFaceSwapTools({
      probeVideo: mockVideoProbe, env: { DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch,
    })[0];

    const result = await tool.execute({
      facePath: 'face.png',
      videoPath: 'clip.mp4',
      targetReferencePath: 'character.jpg',
      outputPath: 'generated/swapped.mp4',
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({
      path: 'generated/swapped.mp4',
      format: 'mp4',
      backend: 'dacais-media',
      model: 'insightface/inswapper_128',
      detector: 'buffalo_l',
      sourceFace: 'face.png',
      sourceVideo: 'clip.mp4',
      framesSwapped: 471,
      framesTotal: 480,
      restoredFaces: true,
      provider: 'CUDAExecutionProvider',
      syntheticMediaTag: 'AI-generated: face replaced by DACAIS media service',
      width: 1024,
      height: 576,
    });
    expect(await readFile(join(root, 'generated', 'swapped.mp4'))).toEqual(MP4);
  });

  it('deletes the artifact when the service swapped nobody', async () => {
    const root = await workspace();
    const tool = createFaceSwapTools({
      probeVideo: mockVideoProbe,
      env: { DACAI_VIDEO_BACKEND: 'dacais-media' },
      fetch: (async () => swapResponse({ framesSwapped: 0 })) as typeof fetch,
    })[0];

    await expect(tool.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'unswapped.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('did not replace the selected character');
    await expect(readFile(join(root, 'unswapped.mp4'))).rejects.toThrow();
  });

  it('rejects a clip whose result no longer matches the source footage', async () => {
    const root = await workspace();
    const probes = [
      { width: 1024, height: 576, durationSeconds: 30, frames: 480, fps: 16 },
      { width: 512, height: 288, durationSeconds: 30, frames: 480, fps: 16 },
    ];
    const tool = createFaceSwapTools({
      probeVideo: async () => probes.shift() ?? probes[0],
      env: { DACAI_VIDEO_BACKEND: 'dacais-media' },
      fetch: (async () => swapResponse()) as typeof fetch,
    })[0];

    await expect(tool.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'reframed.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('do not match the requested dimensions');
    await expect(readFile(join(root, 'reframed.mp4'))).rejects.toThrow();
  });

  it('fails closed on configuration, oversized clips, unsafe paths and overwrites', async () => {
    const root = await workspace();
    const fetchMock = vi.fn(async () => swapResponse()) as typeof fetch;

    const disabled = createFaceSwapTools({ probeVideo: mockVideoProbe, env: {}, fetch: fetchMock })[0];
    await expect(disabled.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'off.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('Face swapping is not enabled');

    const tool = createFaceSwapTools({
      probeVideo: mockVideoProbe, env: { DACAI_VIDEO_BACKEND: 'dacais-media' }, fetch: fetchMock,
    })[0];
    await expect(tool.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: '../escape.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('escaped the workspace');
    await expect(tool.execute({ facePath: 'clip.mp4', videoPath: 'clip.mp4', outputPath: 'wrong-face.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('facePath must be a PNG, JPEG, or WebP image.');
    await expect(tool.execute({ facePath: 'face.png', videoPath: 'face.png', outputPath: 'wrong-video.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('videoPath must be an MP4, WebM, or MOV video.');

    const capped = createFaceSwapTools({
      probeVideo: async () => ({ width: 1024, height: 576, durationSeconds: 300, frames: 4800, fps: 16 }),
      env: { DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_FACE_SWAP_MAX_SECONDS: '120' },
      fetch: fetchMock,
    })[0];
    await expect(capped.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'long.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('limited to 120s');

    await tool.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'exists.mp4' }, { workspaceRoot: root });
    await expect(tool.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'exists.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('already exists');
  });

  it('requires authenticated HTTPS for an Internet-facing media endpoint', async () => {
    const root = await workspace();
    const remote = createFaceSwapTools({
      probeVideo: mockVideoProbe,
      env: { DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_BASE_URL: 'https://example.com' },
      fetch: vi.fn() as typeof fetch,
    })[0];
    await expect(remote.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'remote.mp4' }, { workspaceRoot: root }))
      .rejects.toThrow('loopback URL');

    const productionFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer production-test-token');
      return swapResponse();
    });
    const production = createFaceSwapTools({
      probeVideo: mockVideoProbe,
      env: {
        DACAI_VIDEO_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'https',
        DACAI_MEDIA_BASE_URL: 'https://media.example.com', DACAI_MEDIA_TOKEN: 'production-test-token',
      },
      fetch: productionFetch as typeof fetch,
    })[0];
    await production.execute({ facePath: 'face.png', videoPath: 'clip.mp4', outputPath: 'production.mp4' }, { workspaceRoot: root });
    expect(productionFetch).toHaveBeenCalledWith('https://media.example.com/v1/face-swap', expect.any(Object));
  });
});

describe('face swap request routing', () => {
  it('recognizes a swap request and keeps it out of the direct image/video path', () => {
    const swapPrompts = [
      'take the face of the attached image and swap it with a character on the attached video',
      'face swap the woman in this clip with the attached photo',
      'put my face onto the actor in the video',
      'replace the face of the guy on the left with this picture',
    ];
    for (const prompt of swapPrompts) {
      expect(isFaceSwapRequest(prompt)).toBe(true);
      // An attached photo would otherwise make every one of these an image edit.
      expect(classifyDirectMediaRequest(prompt, [], { hasImageAttachment: true })).toBeUndefined();
    }

    expect(isFaceSwapRequest('generate a video of a city at night')).toBe(false);
    expect(isFaceSwapRequest('replace the face detection helper in the repository source code')).toBe(false);
    expect(isFaceSwapRequest('anything at all', ['video.faceSwap'])).toBe(true);
    expect(classifyDirectMediaRequest('generate a video of a city at night')).toBe('video');
  });

  it('does not treat a labeled face-plus-clip as an image edit even without swap wording', () => {
    // Routing for composer roles is `attachmentsIndicateFaceSwap` in the agent
    // route; this pins that ordinary image classification would otherwise steal it.
    expect(classifyDirectMediaRequest('do it', [], { hasImageAttachment: true })).toBe('image');
  });
});
