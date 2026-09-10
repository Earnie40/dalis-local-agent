import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createImageGenerationTools,
  imageGenerationConfigured,
  imageGenerationRequiresNetwork,
} from '../packages/tools/src/image-generation-tools';

import { pngFixture, intentFixture } from './media-fixtures';
const PNG = pngFixture();
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
    const PNG = pngFixture(768, 1024);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({ prompt: 'photoreal portrait', width: 768, height: 1024, batch_size: 1 });
      expect(request.prompt).not.toContain('Correction:');
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
      prompt: 'photoreal portrait', correction: 'retry metadata stays separate', outputPath: 'output/person.png', width: 768, height: 1024,
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
      intent: intentFixture('make both people walk naturally with correct hands and legs', { geometry: true }),
      outputPath: 'walking.png',
      seed: 17,
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ model: 'Qwen/Qwen-Image-Edit-2511', seed: 17 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses a reference board to generate one new multi-person scene without changing outer generation semantics', async () => {
    const prompt = 'Create both attached adults making pizza together on a date.';
    const outerIntent = intentFixture(prompt, { geometry: true, generate: true });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/anatomy-edit');
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(request.sourceMediaBase64).toBe(PNG.toString('base64'));
      expect(request.prompt).toBe(prompt);
      expect(request.intent).toEqual(outerIntent);
      expect(request.referenceSheet).toBe(true);
      return new Response(JSON.stringify({
        imageBase64: PNG.toString('base64'), model: 'Qwen/Qwen-Image-Edit-2511', seed: 23,
      }), { status: 200 });
    });
    const tool = createImageGenerationTools({
      env: { DACAI_IMAGE_BACKEND: 'dacais-media' },
      fetch: fetchMock as typeof fetch,
    })[0];
    const root = await workspace();
    await writeFile(join(root, 'references.png'), PNG);

    const result = await tool.execute({
      prompt,
      referenceSheetPath: 'references.png',
      intent: outerIntent,
      outputPath: 'date.png',
      seed: 23,
    }, { workspaceRoot: root }) as Record<string, unknown>;

    expect(result).toMatchObject({ path: 'date.png', model: 'Qwen/Qwen-Image-Edit-2511', seed: 23 });
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
      intent: intentFixture('adult full-body medical anatomy reference, side view', { geometry: true, generate: true }),
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
      intent: intentFixture('correct the full-body pose', { geometry: true }),
      prompt: 'correct the full-body pose', sourcePath: 'source.png', outputPath: 'corrected.png',
    }, { workspaceRoot: root })).rejects.toThrow('Anatomy-capable image backend failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps preservation-only anatomy words on the localized instruction-edit path', async () => {
    const prompt = 'Edit only the shirt color; preserve identity, face, body, skin, anatomy, pose, clothing cut, camera angle, and style.';
    const intent = intentFixture(prompt);
    intent.protectedAttributes = ['identity', 'face', 'body', 'skin', 'anatomy', 'pose', 'clothing cut', 'camera angle', 'style'];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/instruct-edit');
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({ prompt, intent, correction: 'Restore only the original shirt stitching.' });
      expect(request).not.toHaveProperty('maskDisabled');
      return new Response(JSON.stringify({
        imageBase64: PNG.toString('base64'), model: 'instruction-editor', regionLocked: true, regions: ['requested target'],
      }), { status: 200 });
    });
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);

    await expect(tool.execute({
      prompt, intent, correction: 'Restore only the original shirt stitching.',
      sourcePath: 'source.png', outputPath: 'localized.png',
    }, { workspaceRoot: root })).resolves.toMatchObject({
      path: 'localized.png', mode: 'instruction', regionLocked: true, regions: ['requested target'],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('passes provider-permitted mature image requests verbatim without an application negative prompt', async () => {
    const prompt = 'Fine-art nude figure study of a consenting adult model, natural skin texture and soft studio lighting.';
    const intent = intentFixture(prompt, { generate: true });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18090/v1/generate-backdrop');
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt, negativePrompt: '', intent });
      return new Response(JSON.stringify({ imageBase64: PNG.toString('base64'), model: 'provider-model' }), { status: 200 });
    });
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];

    await expect(tool.execute({ prompt, intent, outputPath: 'mature.png' }, { workspaceRoot: await workspace() }))
      .resolves.toMatchObject({ path: 'mature.png', model: 'provider-model' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends the reported supermodel request unchanged', async () => {
    const prompt = 'generate a picture of a supermodel';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt, negativePrompt: '' });
      return new Response(JSON.stringify({ imageBase64: PNG.toString('base64') }), { status: 200 });
    });
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];

    await expect(tool.execute({ prompt, outputPath: 'supermodel.png' }, { workspaceRoot: await workspace() }))
      .resolves.toMatchObject({ path: 'supermodel.png' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses explicitly configured img2img /v1/edit-image API', async () => {
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

  it.each([404, 501])('falls back from an unavailable automatic instruction editor after HTTP %s', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('editor unavailable', { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imageBase64: PNG.toString('base64'), model: 'sdxl-base' }), { status: 200 }));
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);
    await expect(tool.execute({ prompt: 'change only the shirt color', sourcePath: 'source.png', outputPath: 'edit.png' }, { workspaceRoot: root }))
      .resolves.toMatchObject({ path: 'edit.png', mode: 'img2img', model: 'sdxl-base' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/instruct-edit');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/v1/edit-image');
  });

  it.each([404, 501])('never widens a localized edit to img2img after HTTP %s', async (status) => {
    const prompt = 'change only the shirt color';
    const intent = intentFixture(prompt);
    const fetchMock = vi.fn(async () => new Response('instruction editor unavailable', { status }));
    const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
    const root = await workspace();
    await writeFile(join(root, 'source.png'), PNG);

    await expect(tool.execute({ prompt, intent, sourcePath: 'source.png', outputPath: 'edit.png' }, { workspaceRoot: root }))
      .rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not switch methods for a bad request or an explicitly selected editor', async () => {
    for (const input of [
      { status: 400, mode: undefined },
      { status: 501, mode: 'instructpix2pix' },
    ]) {
      const message = input.status === 400 ? 'provider safety control rejected request' : 'editor unavailable';
      const fetchMock = vi.fn(async () => new Response(message, { status: input.status }));
      const tool = createImageGenerationTools({ env: { DACAI_IMAGE_BACKEND: 'dacais-media' }, fetch: fetchMock as typeof fetch })[0];
      const root = await workspace();
      await writeFile(join(root, 'source.png'), PNG);
      await expect(tool.execute({ prompt: 'change only the shirt color', sourcePath: 'source.png', outputPath: 'edit.png', mode: input.mode }, { workspaceRoot: root }))
        .rejects.toThrow(input.status === 400 ? `HTTP 400: ${message}` : `HTTP ${input.status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
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
