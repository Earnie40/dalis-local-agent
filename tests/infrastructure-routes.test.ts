import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerInfrastructureRoutes } from '../apps/server/src/routes/infrastructure';

describe('infrastructure routes', () => {
  it('reconnects the existing RunPod service through an explicit POST route', async () => {
    const server = Fastify();
    const status = { configured: true, connected: true };
    const initialize = vi.fn(async () => status);
    registerInfrastructureRoutes(
      server,
      { status: vi.fn(async () => status), initialize } as never,
      { status: vi.fn(), initialize: vi.fn() } as never,
      { gpuAvailability: vi.fn(), routingPolicy: 'gpu-preferred', gpuPreferred: true } as never,
    );

    const response = await server.inject({ method: 'POST', url: '/api/infrastructure/runpod/reconnect' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(initialize).toHaveBeenCalledOnce();
    await server.close();
  });
});
