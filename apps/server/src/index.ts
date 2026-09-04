import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { config as loadEnv } from 'dotenv';
import { loadAppConfigResult, redactDatabaseUrl, runMigrations, verifyConnection } from '@dacai-local-agent/shared';
import type { AppConfigLoadResult } from '@dacai-local-agent/shared';
import {
  groupModels,
  GpuAvailabilityProbe,
  PostgresCapabilityStore,
  ProviderRegistry,
} from '@dacai-local-agent/providers';
import { AnonymizedSourceDetector, AnonymizedSourceFeedRefresher, type AnonymizedSourceAudit } from '@dacai-local-agent/security';
import { AnonymizedSourceAuditStore } from '@dacai-local-agent/shared';
import { registerChatRoutes } from './routes/chat';
import { registerAgentRoutes } from './routes/agent';
import { registerTaskRoutes } from './routes/tasks';
import { registerSecurityRoutes } from './routes/security';
import { registerDefensiveRoutes } from './routes/defensive';
import { registerRagRoutes } from './routes/rag';
import { registerMemoryRoutes } from './routes/memory';
import { registerInfrastructureRoutes } from './routes/infrastructure';
import { registerIntelligenceRoutes } from './routes/intelligence';
import { registerStudioRoutes } from './routes/studio';
import { RunpodService } from './infrastructure/runpod-service';
import { resolveRunpodPodPresence } from './infrastructure/runpod-pod-status';
import { RunpodMediaManager } from './infrastructure/runpod-media-manager';
import { ApprovalRegistry } from './approvals';

// Resolved against this file, not the working directory: `pnpm dev` runs the
// server with cwd=apps/server, where neither .env nor config/ exists.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

loadEnv({ path: `${repoRoot}.env` });

let loaded: AppConfigLoadResult;
try {
  loaded = loadAppConfigResult(process.env, {
    modelAliasPath: `${repoRoot}config/models/default.yaml`,
  });
} catch (error) {
  // A raw schema dump is not an actionable error message.
  console.error('Configuration is invalid.\n');
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env, then provision the database:\n' +
        '  $env:PGSUPERPASSWORD="<superuser password>"; node scripts/provision-db.mjs\n' +
        '  Remove-Item Env:PGSUPERPASSWORD\n' +
        'Paste the printed DATABASE_URL into .env.\n',
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

const { config, warnings } = loaded;

const server = Fastify({
  logger: true,
});

// The web app is served from a different origin in development. Both spellings
// of loopback are allowed because the browser treats them as distinct origins,
// and the dev server prints one while a user may type the other. Nothing
// outside loopback is accepted.
const allowedOrigins = new Set([
  `http://localhost:${config.webPort}`,
  `http://127.0.0.1:${config.webPort}`,
  `http://localhost:4173`,
  `http://127.0.0.1:4173`,
]);

server.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Headers', 'content-type');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') reply.code(204).send();
});

const runpodService = new RunpodService();
const registry = new ProviderRegistry(config, new PostgresCapabilityStore());

/**
 * GPU-first routing. The probe answers "is the pod serving inference right
 * now", which is the only question that can decide a route: a pod can be
 * funded and RUNNING while its tunnel or Ollama service is down. When the
 * answer is no, the registry keeps the run on local Ollama and carries the
 * reason on the result instead of degrading silently.
 */
const gpuAvailabilityProbe = new GpuAvailabilityProbe({
  instance: config.providerInstances.remote_gpu_ollama,
  podPresence: () => resolveRunpodPodPresence(),
  // gpu-preferred is an explicit standing instruction to repair a stale
  // tunnel to an already-running pod. Other policies keep status probes
  // read-only and never start or provision billable infrastructure.
  recoverEndpoint:
    config.routingPolicy === 'gpu-preferred'
      ? async () => {
          await runpodService.initialize();
        }
      : undefined,
});
registry.setGpuAvailabilityProbe(gpuAvailabilityProbe);
/** Shared so a pending LIVE_VALIDATION approval (security.ts) surfaces through the same
 *  /api/approvals endpoints the UI already polls for interactive tool-call approvals. */
const approvals = new ApprovalRegistry();
const runpodMediaManager = new RunpodMediaManager();
server.addHook('onClose', async () => {
  runpodService.stop();
  runpodMediaManager.stop();
});

/** Real Tor/datacenter feeds, refreshed on an interval — see anonymized-source-refresher.ts. */
const anonymizedSourceFeedRefresher = new AnonymizedSourceFeedRefresher({
  onWarning: (warning) => server.log.warn(warning),
  onRefresh: (snapshot) =>
    server.log.info(
      { torExitNodes: snapshot.torExitNodes.length, datacenterRanges: snapshot.datacenterRanges.length },
      'Anonymized-source feeds refreshed',
    ),
});
const anonymizedSourceAuditStore = new AnonymizedSourceAuditStore();

/** Logging/audit only in this pass — see getRecommendedAction() for the throttle/block policy
 *  this does not yet act on. Scoped to the security-sensitive route prefixes. */
server.addHook('onRequest', async (request) => {
  if (!request.url.startsWith('/api/security') && !request.url.startsWith('/api/agent')) return;

  const detector = new AnonymizedSourceDetector(anonymizedSourceFeedRefresher.getConfig());
  const result = detector.detect({
    sourceIp: request.ip,
    userAgent: request.headers['user-agent'],
    endpoint: request.url,
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : (value ?? '')]),
    ),
  });

  if (!result.detected) return;
  void anonymizedSourceAuditStore
    .record({
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'],
      detectionMethod: result.detectionMethod as AnonymizedSourceAudit['detectionMethod'],
      classification: result.classification,
      endpoint: request.url,
      requestedAt: new Date(),
      actionTaken: 'logged',
    })
    .catch((error) => server.log.warn({ err: String(error) }, 'anonymized-source audit write failed'));
});

server.get('/health', async () => ({
  status: 'ok',
  service: 'dacai-local-agent-server',
  config: {
    nodeEnv: config.nodeEnv,
    port: config.port,
    routingPolicy: config.routingPolicy,
    database: redactDatabaseUrl(config.databaseUrl),
  },
}));

/**
 * Provider status never exposes credentials — only whether the named env var
 * resolved, never its value or a prefix of it.
 */
server.get('/api/providers', async () => {
  const health = await registry.health();
  const healthById = new Map(health.map((entry) => [entry.instanceId, entry]));

  return {
    routingPolicy: config.routingPolicy,
    instances: registry.listInstances().map((instance) => {
      const status = healthById.get(instance.id);
      return {
        id: instance.id,
        kind: instance.kind,
        usageClass: instance.usageClass,
        location: instance.usageClass === 'LOCAL_OLLAMA' ? 'Local' : 'Remote',
        transport: instance.transport,
        baseUrl: instance.baseUrl,
        enabled: instance.enabled,
        status: status?.status ?? 'not configured',
        version: status?.version,
        latencyMs: status?.latencyMs,
        error: status?.error,
        credentialConfigured: instance.authTokenEnvVar ? Boolean(process.env[instance.authTokenEnvVar]) : undefined,
        fallbackInstanceId: instance.fallbackInstanceId,
      };
    }),
  };
});

/**
 * Live inventory, grouped. A flat tag list is misleading: persona tags share
 * their base model's weights, so they are reported under it.
 */
server.get('/api/models', async () => {
  const models = await registry.listModels();
  const inventory = groupModels(models);
  const aliases = await Promise.all(Object.entries(config.models).map(async ([alias, model]) => {
    const agentCapability = await registry.getKnownToolCallingStatus(model.providerInstanceId, model.model);
    return {
      alias,
      providerInstanceId: model.providerInstanceId,
      model: model.model,
      enabled: model.enabled,
      agentCapability,
      agentLoopCapable: agentCapability === 'verified',
      classification: agentCapability === 'verified'
        ? 'agent-capable'
        : agentCapability === 'unsupported'
          ? 'advisory-class'
          : 'unverified',
    };
  }));

  return {
    tagCount: inventory.tagCount,
    baseCount: inventory.baseCount,
    groups: inventory.groups,
    aliases,
  };
});

/**
 * Capability for one alias. Probes lazily on a cache miss, so the first call
 * for a model costs one inference request and later calls cost nothing.
 */
server.get<{ Params: { alias: string } }>('/api/models/:alias/capabilities', async (request, reply) => {
  const modelConfig = config.models[request.params.alias];
  if (!modelConfig) {
    return reply.code(404).send({ error: `Unknown model alias "${request.params.alias}".` });
  }

  const capabilities = await registry.getCapabilities(modelConfig.providerInstanceId, modelConfig.model);

  return {
    alias: request.params.alias,
    providerInstanceId: modelConfig.providerInstanceId,
    model: modelConfig.model,
    capabilities,
    // The gate the agent loop applies, stated plainly for the UI.
    agentLoopCapable: capabilities.toolCalling === 'verified',
    classification: capabilities.toolCalling === 'verified' ? 'agent-capable' : 'advisory-class',
  };
});

/** Backs the "re-probe" action in Settings. */
server.post<{ Params: { alias: string } }>('/api/models/:alias/reprobe', async (request, reply) => {
  const modelConfig = config.models[request.params.alias];
  if (!modelConfig) {
    return reply.code(404).send({ error: `Unknown model alias "${request.params.alias}".` });
  }

  await registry.reprobe(modelConfig.providerInstanceId, modelConfig.model);
  const capabilities = await registry.getCapabilities(modelConfig.providerInstanceId, modelConfig.model);
  return { alias: request.params.alias, capabilities };
});

registerChatRoutes(server, { config, registry });
registerAgentRoutes(server, { config, registry, approvals, media: runpodMediaManager });
registerTaskRoutes(server, { config, registry });
registerSecurityRoutes(server, { config, approvals });
registerDefensiveRoutes(server, { config, approvals });
registerRagRoutes(server);
registerMemoryRoutes(server);
registerInfrastructureRoutes(server, runpodService, runpodMediaManager, registry);
registerIntelligenceRoutes(server, { config, registry });
registerStudioRoutes(server, { registry });

server.get('/api/status', async () => ({
  ok: true,
  message: 'DacaiLocalAgent server is initialized.',
  defaultEscalationMode: config.defaultEscalationMode,
  configWarnings: warnings,
}));

const start = async () => {
  try {
    // Fail fast and loudly: there is no silent fallback persistence layer.
    await verifyConnection(config.databaseUrl);
    const { applied, alreadyCurrent } = await runMigrations();
    server.log.info({ applied, alreadyCurrent: alreadyCurrent.length }, 'PostgreSQL schema is current');

    for (const warning of warnings) server.log.warn(warning);

    // Not awaited: two external HTTP fetches (Tor + AWS) must never delay the server
    // actually starting to listen. refreshAnonymizedSourceFeeds() never throws — a failed
    // fetch just logs a warning and leaves the detector with an empty (not fabricated) list
    // until the next interval.
    void anonymizedSourceFeedRefresher.start();

    const listenHost = process.env.DACAI_SERVER_HOST?.trim() || '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '0.0.0.0', '::'].includes(listenHost)) {
      throw new Error('DACAI_SERVER_HOST must be a local bind address.');
    }
    await server.listen({ port: config.port, host: listenHost });
    runpodMediaManager.start();
    // Report the routing decision once at boot. Under gpu-preferred this probe
    // also repairs a stale tunnel to an already-running, provisioned pod.
    void registry.gpuAvailability(true).then((availability) => {
      if (availability) {
        server.log.info(
          { routingPolicy: config.routingPolicy, gpuUsable: availability.usable, reason: availability.reason },
          availability.detail,
        );
      }
    }).catch(() => {
      server.log.warn('RunPod startup probe failed; local providers remain active.');
    });
    console.log(`DacaiLocalAgent server listening on port ${config.port}`);
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
};

start();
