import type { FastifyInstance } from 'fastify';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import type { RunpodService } from '../infrastructure/runpod-service';
import type { RunpodMediaManager } from '../infrastructure/runpod-media-manager';
import { resolveRunpodPodPresence } from '../infrastructure/runpod-pod-status';

export function registerInfrastructureRoutes(
  server: FastifyInstance,
  runpod: RunpodService,
  media: RunpodMediaManager,
  registry: ProviderRegistry,
): void {
  server.get('/api/infrastructure/runpod/status', async () => runpod.status());
  server.get('/api/infrastructure/runpod/preflight', async () => {
    const presence = await resolveRunpodPodPresence();
    if (!presence) {
      return {
        checkedAt: new Date().toISOString(),
        status: 'unknown',
        funded: undefined,
        balanceUsd: undefined,
        pods: [],
        detail: 'RunPod account status could not be queried; local inference remains the safe fallback.',
      };
    }
    const running = presence.pods.filter((pod) => pod.status === 'RUNNING');
    const paused = presence.pods.filter((pod) => pod.status === 'EXITED');
    return {
      checkedAt: new Date().toISOString(),
      status: presence.funded === false ? 'unfunded' : running.length ? 'ready-to-route' : 'no-running-pod',
      funded: presence.funded,
      balanceUsd: presence.clientBalanceUsd,
      runningPods: running,
      pausedPods: paused,
      pods: presence.pods,
      detail: presence.funded === false
        ? 'RunPod has no positive prepaid balance; inference falls back locally.'
        : running.length
          ? 'RunPod has a funded account and a running pod; inference may route to GPU when Ollama is reachable.'
          : 'RunPod is funded but has no running pod; inference remains local without automatically starting billable compute.',
    };
  });
  server.get('/api/infrastructure/media/status', async () => media.status());
  server.post('/api/infrastructure/media/reconnect', async () => media.initialize());

  /**
   * Where model work is running, and when it is not on the GPU, why.
   * `refresh=1` re-probes instead of answering from the short-lived cache.
   */
  server.get<{ Querystring: { refresh?: string } }>('/api/infrastructure/gpu-routing', async (request) => {
    const force = request.query.refresh === '1' || request.query.refresh === 'true';
    const availability = await registry.gpuAvailability(force);
    return {
      routingPolicy: registry.routingPolicy,
      gpuPreferred: registry.gpuPreferred,
      availability: availability ?? null,
      detail:
        availability?.detail ??
        'GPU availability is not being probed; every alias resolves to its configured provider instance.',
    };
  });
}
