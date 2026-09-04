import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredGenerationError } from '@dacai-local-agent/providers';
import {
  registerStudioRoutes,
  type StudioGenerate,
} from '../apps/server/src/routes/studio';

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const files = {
  html: '<canvas id="scene"></canvas>',
  css: 'canvas { width: 100%; }',
  javascript: 'console.log("before")',
};

function result(value: unknown) {
  return {
    value,
    alias: 'chat',
    model: 'test-model',
    providerInstanceId: 'test-provider',
    repaired: false,
    durationMs: 12,
  };
}

function makeServer(generate: StudioGenerate) {
  const server = Fastify();
  servers.push(server);
  registerStudioRoutes(server, { generate });
  return server;
}

describe('Studio generation route', () => {
  it('applies validated whole-file replacements and echoes the base revision', async () => {
    const generate = vi.fn<StudioGenerate>(async () => result({
      message: 'Added a star field.',
      files: { javascript: 'console.log("stars")' },
    }));
    const server = makeServer(generate);
    const response = await server.inject({
      method: 'POST',
      url: '/api/studio/generate',
      payload: {
        prompt: 'Add stars',
        alias: 'chat',
        revision: 7,
        files,
        history: [{ role: 'assistant', content: 'Ready.' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().update).toEqual({
      message: 'Added a star field.',
      files: { ...files, javascript: 'console.log("stars")' },
      changedFiles: ['main.js'],
      baseRevision: 7,
    });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Add stars',
      alias: 'chat',
      revision: 7,
      files,
    }));
    expect(generate.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('supports chat-only answers without fabricating file changes', async () => {
    const server = makeServer(async () => result({ message: 'The cube uses perspective projection.', files: {} }));
    const response = await server.inject({
      method: 'POST',
      url: '/api/studio/generate',
      payload: { prompt: 'How does this work?', alias: 'chat', revision: 0, files, history: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().update.files).toEqual(files);
    expect(response.json().update.changedFiles).toEqual([]);
  });

  it.each([
    {},
    { prompt: 42, alias: 'chat', revision: 0, files, history: [] },
    { prompt: 'x', alias: 'chat', revision: -1, files, history: [] },
    { prompt: 'x', alias: 'chat', revision: 0, files: { ...files, shader: 'unknown' }, history: [] },
    { prompt: 'x'.repeat(4_001), alias: 'chat', revision: 0, files, history: [] },
    { prompt: 'x', alias: 'chat', revision: 0, files: { ...files, javascript: 'x'.repeat(60_001) }, history: [] },
  ])('rejects malformed or oversized requests before generation', async (payload) => {
    const generate = vi.fn<StudioGenerate>();
    const server = makeServer(generate);
    const response = await server.inject({ method: 'POST', url: '/api/studio/generate', payload });
    expect(response.statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects secret-bearing virtual projects before they reach a model', async () => {
    const generate = vi.fn<StudioGenerate>();
    const server = makeServer(generate);
    const response = await server.inject({
      method: 'POST',
      url: '/api/studio/generate',
      payload: {
        prompt: 'Use this token',
        alias: 'chat',
        revision: 0,
        files: { ...files, javascript: 'const OPENAI_API_KEY=sk-123456789012345678901234;' },
        history: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it('fails closed when a model response violates the update schema or contains a secret', async () => {
    const invalid = makeServer(async () => result({ message: 'bad', files: { shell: 'rm' } }));
    const invalidResponse = await invalid.inject({
      method: 'POST', url: '/api/studio/generate',
      payload: { prompt: 'change it', alias: 'chat', revision: 0, files, history: [] },
    });
    expect(invalidResponse.statusCode).toBe(502);

    const secret = makeServer(async () => result({
      message: 'done',
      files: { javascript: 'const token = "ghp_123456789012345678901234567890";' },
    }));
    const secretResponse = await secret.inject({
      method: 'POST', url: '/api/studio/generate',
      payload: { prompt: 'change it', alias: 'chat', revision: 0, files, history: [] },
    });
    expect(secretResponse.statusCode).toBe(502);
  });

  it('sanitizes provider failures and never executes returned browser code on the server', async () => {
    delete (globalThis as Record<string, unknown>).studioExecuted;
    const code = 'globalThis.studioExecuted = true';
    const safe = makeServer(async () => result({ message: 'code only', files: { javascript: code } }));
    const safeResponse = await safe.inject({
      method: 'POST', url: '/api/studio/generate',
      payload: { prompt: 'change it', alias: 'chat', revision: 0, files, history: [] },
    });
    expect(safeResponse.statusCode).toBe(200);
    expect((globalThis as Record<string, unknown>).studioExecuted).toBeUndefined();

    const failed = makeServer(async () => {
      throw new StructuredGenerationError('provider leaked internal detail', 'provider-failed');
    });
    const failedResponse = await failed.inject({
      method: 'POST', url: '/api/studio/generate',
      payload: { prompt: 'change it', alias: 'chat', revision: 0, files, history: [] },
    });
    expect(failedResponse.statusCode).toBe(503);
    expect(failedResponse.body).not.toContain('internal detail');
  });
});
