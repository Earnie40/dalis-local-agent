import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createImageGenerationTools,
  imageEditRequiresAnatomyPipeline,
  imageGenerationConfigured,
  imageGenerationRequiresNetwork,
} from '../packages/tools/src/image-generation-tools';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dacai-image-'));
  cleanup.push(path);
  return path;
}

describe('photoreal image generation tool', () => {
  it('generates and hashes a workspace PNG through a local Automatic1111-compatible API', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({ prompt: 'photoreal portrait', width: 768, height: 1024, batch_size: 1 });
      expect(init?.redirect).toBe('error');
      return new Response(JSON.stringify({
        images: [PNG.toString('base64')],
        info: JSON.stringify({ seed: 42, sd_model_name: 'local-photo-model' }),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'automatic1111', DACAI_IMAGE_BASE_URL: 'http://127.0.0.1:7860' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();

    const result = await tool.execute({
      prompt: 'photoreal portrait', outputPath: 'output/person.png', width: 768, height: 1024,
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({
      path: 'output/person.png', format: 'png', bytes: PNG.byteLength,
      backend: 'automatic1111', model: 'local-photo-model', seed: 42,
    });
    expect(String(result.sha256)).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(root, 'output', 'person.png'))).toEqual(PNG);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7860/sdapi/v1/txt2img', expect.any(Object));
  });

  it('supports the paid OpenAI backend only when it is explicitly selected', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key-not-secret');
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'openai', OPENAI_API_KEY: 'test-key-not-secret' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();

    const result = await tool.execute({ prompt: 'studio portrait', outputPath: 'person.png' }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'person.png', backend: 'openai', model: 'gpt-image-1' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/images/generations', expect.any(Object));
  });

  it('generates and edits through /v1/instruct-edit by default in instruction mode', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/instruct-edit');
      expect(request).toMatchObject({ prompt: 'make her hair blonde', mode: 'auto', sourceMimeType: 'image/png' });
      expect(request.sourceMediaBase64).toBe(PNG.toString('base64'));
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer local-media-token');
      return new Response(JSON.stringify({
        imageBase64: PNG.toString('base64'), model: 'diffusers/sdxl-instructpix2pix-768', seed: 9,
      }), { status: 200 });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TOKEN: 'local-media-token' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);

    const result = await tool.execute({
      prompt: 'make her hair blonde', sourcePath: 'source.png', outputPath: 'edited.png', seed: 9,
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'edited.png', backend: 'dacais-media', seed: 9 });
  });

  it('routes body-geometry edits to the anatomy model without a generic SDXL fallback', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/anatomy-edit');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        prompt: 'make both people walk naturally with correct hands and legs',
        mode: 'anatomy',
        sourceMimeType: 'image/png',
      });
      return new Response(JSON.stringify({
        imageBase64: PNG.toString('base64'), model: 'Qwen/Qwen-Image-Edit-2511', seed: 17,
      }), { status: 200 });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);

    const result = await tool.execute({
      prompt: 'make both people walk naturally with correct hands and legs',
      sourcePath: 'source.png',
      outputPath: 'walking.png',
      seed: 17,
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ model: 'Qwen/Qwen-Image-Edit-2511', seed: 17 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes prompt-only human anatomy generation away from SDXL', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/anatomy-generate');
      return new Response(JSON.stringify({
        imageBase64: PNG.toString('base64'), model: 'Qwen/Qwen-Image-2512', seed: 31,
      }), { status: 200 });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch,
    })[0];

    const result = await tool.execute({
      prompt: 'adult full-body medical anatomy reference, side view', outputPath: 'anatomy.png', seed: 31,
    }, { workspaceRoot: await workspace() }) as Record<string, unknown>;

    expect(result).toMatchObject({ model: 'Qwen/Qwen-Image-2512', seed: 31 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the anatomy model is unavailable', async () => {
    const fetchMock = vi.fn(async () => new Response('anatomy model is not installed', { status: 501 }));
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);

    await expect(tool.execute({
      prompt: 'correct the full-body pose', sourcePath: 'source.png', outputPath: 'corrected.png',
    }, { workspaceRoot: root })).rejects.toThrow('Anatomy-capable image backend failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('detects anatomy-sensitive instructions without stealing ordinary semantic edits', () => {
    expect(imageEditRequiresAnatomyPipeline('fix her hands and make the full-body pose natural')).toBe(true);
    expect(imageEditRequiresAnatomyPipeline('make both people walk side by side')).toBe(true);
    expect(imageEditRequiresAnatomyPipeline('accurate adult vulva and perineal anatomy')).toBe(true);
    expect(imageEditRequiresAnatomyPipeline('male medical reference showing the glans and foreskin')).toBe(true);
    expect(imageEditRequiresAnatomyPipeline('make her hair blonde')).toBe(false);
    expect(imageEditRequiresAnatomyPipeline('replace the cloudy sky')).toBe(false);
  });

  it('generates and edits through the fallback img2img /v1/edit-image API', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/edit-image');
      expect(request).toMatchObject({ prompt: 'make the sky dramatic', strength: 0.4, sourceMimeType: 'image/png' });
      expect(request.sourceMediaBase64).toBe(PNG.toString('base64'));
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer local-media-token');
      return new Response(JSON.stringify({
        imageBase64: PNG.toString('base64'), model: 'stabilityai/stable-diffusion-xl-base-1.0', seed: 9,
      }), { status: 200 });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TOKEN: 'local-media-token', DACAI_IMAGE_EDIT_MODE: 'img2img' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);

    const result = await tool.execute({
      prompt: 'make the sky dramatic', sourcePath: 'source.png', outputPath: 'edited.png', strength: 0.4, seed: 9,
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'edited.png', backend: 'dacais-media', seed: 9 });
    expect(imageGenerationConfigured({ DACAI_IMAGE_BACKEND: 'dacais-media' })).toBe(true);
  });

  it('auto-approves bounded image writes and treats loopback media as internal infrastructure', () => {
    const loopback = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'ssh-tunnel' },
      fetch,
    })[0];
    expect(loopback).toMatchObject({ permissionTier: 'mutation', autoApprove: true, requiresWrite: true, requiresNetwork: false });
    expect(imageGenerationRequiresNetwork({ DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'https' })).toBe(true);
    expect(imageGenerationRequiresNetwork({ DACAI_IMAGE_BACKEND: 'openai' })).toBe(true);
  });

  it('retries transient media and tunnel failures before returning a PNG', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('tunnel reconnecting'))
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imageBase64: PNG.toString('base64') }), { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media', DACAI_MEDIA_TRANSPORT: 'ssh-tunnel' },
      fetch: fetchMock as typeof fetch,
      sleep,
    })[0];

    await expect(tool.execute({ prompt: 'portrait', outputPath: 'retried.png' }, { workspaceRoot: await workspace() }))
      .resolves.toMatchObject({ path: 'retried.png', backend: 'dacais-media' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed when no backend is explicitly configured', async () => {
    const fetchMock = vi.fn();
    const tool = createImageGenerationTools({ env: { OPENAI_API_KEY: 'present-but-not-consent' }, fetch: fetchMock as typeof fetch })[0];

    await expect(tool.execute({ prompt: 'person', outputPath: 'person.png' }, { workspaceRoot: await workspace() }))
      .rejects.toThrow('Photoreal image generation is not enabled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(imageGenerationConfigured({ OPENAI_API_KEY: 'present-but-not-consent' })).toBe(false);
  });

  it('rejects path escapes, non-PNG responses, and overwrites', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ images: [PNG.toString('base64')] }), { status: 200 }));
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'automatic1111' }, fetch: fetchMock as typeof fetch })[0];
    const root = await workspace();

    await expect(tool.execute({ prompt: 'person', outputPath: '../person.png' }, { workspaceRoot: root }))
      .rejects.toThrow('escaped the workspace');
    await expect(tool.execute({ prompt: 'person', outputPath: join(root, 'absolute.png') }, { workspaceRoot: root }))
      .rejects.toThrow('workspace-relative');

    const outside = await workspace();
    await symlink(outside, join(root, 'linked'), 'junction');
    await expect(tool.execute({ prompt: 'person', outputPath: 'linked/person.png' }, { workspaceRoot: root }))
      .rejects.toThrow('escaped the workspace');
    await tool.execute({ prompt: 'person', outputPath: 'person.png' }, { workspaceRoot: root });
    await expect(tool.execute({ prompt: 'person', outputPath: 'person.png' }, { workspaceRoot: root }))
      .rejects.toThrow('already exists');

    const invalid = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'automatic1111' },
      fetch: (async () => new Response(JSON.stringify({ images: [Buffer.from('not a valid png payload').toString('base64')] }), { status: 200 })) as typeof fetch,
    })[0];
    await expect(invalid.execute({ prompt: 'person', outputPath: 'invalid.png' }, { workspaceRoot: root }))
      .rejects.toThrow('valid PNG');
  });
});
