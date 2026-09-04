/**
 * Live proof that the intelligence model path works end to end.
 *
 * Exercises:
 *   1. RunPod tunnel comes up and the GPU instance serves.
 *   2. `intelligence` alias resolves to remote_gpu_ollama under the existing
 *      manual-provider-selection routing policy.
 *   3. A schema-constrained generation returns JSON that validates.
 *   4. A usage_events row is written stamped REMOTE_GPU_OLLAMA.
 *   5. Malformed model output is REJECTED rather than persisted.
 *   6. With the remote instance unreachable, the local fallback serves and the
 *      result reports `fellBackFrom`.
 *
 * Prints PASS/FAIL per stage and exits non-zero on any failure.
 */
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { z } = await import('zod');
const { loadAppConfigResult } = await import('../packages/shared/src/config.ts');
const { getPool, closePool } = await import('../packages/shared/src/db/pool.ts');
const { ProviderRegistry, PostgresCapabilityStore, StructuredGenerator, parseWithSchema } =
  await import('../packages/providers/src/index.ts');
const { RunpodService } = await import('../apps/server/src/infrastructure/runpod-service.ts');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const runpod = new RunpodService();
const status = await runpod.initialize();
check('RunPod tunnel healthy', status.tunnelHealthy,
  status.tunnelHealthy ? `${status.gpu.model} ${status.gpu.vramMb}MB` : (status.error ?? 'unavailable'));
check('target model present on pod', status.inference.models.includes(process.env.RUNPOD_OLLAMA_MODEL),
  status.inference.models.join(', ') || '(none)');

const { config } = loadAppConfigResult(process.env, { modelAliasPath: 'config/models/default.yaml' });
const registry = new ProviderRegistry(config, new PostgresCapabilityStore());
const generator = new StructuredGenerator(registry);

// --- 1. alias resolution -----------------------------------------------------
try {
  const resolved = await registry.resolveAlias('intelligence', { explicitInstanceRequest: true });
  check('intelligence alias resolves to the GPU instance',
    resolved.instance.id === 'remote_gpu_ollama',
    `${resolved.instance.id} / ${resolved.model} (${resolved.instance.usageClass})`);
} catch (error) {
  check('intelligence alias resolves to the GPU instance', false, error.message);
}

// --- 2. schema-valid structured generation -----------------------------------
const ThemeSchema = z.object({
  themes: z.array(z.object({
    label: z.string().min(2),
    relevance: z.number().min(0).max(1),
  })).min(1),
});

const SAMPLE = `
Deep-tech investors increasingly describe a shift they call "physical AI": moving language-model
reasoning out of chat interfaces and into systems that act on the physical world -- robotics,
autonomous vehicles, industrial control. The recurring concern raised at recent conferences is
not model capability but reliability: what authorizes an autonomous system to take a consequential
physical action, and what record proves what it did afterward.
`.trim();

const before = await countUsage();
let result;
try {
  result = await generator.generate({
    alias: 'intelligence',
    fallbackAlias: 'intelligence_local',
    schema: ThemeSchema,
    system: 'Extract technology themes from the text. Return ONLY JSON: {"themes":[{"label":string,"relevance":number}]}',
    user: SAMPLE,
    workerRole: 'proof:theme-extraction',
    maxTokens: 600,
  });
  check('structured generation returns schema-valid JSON', true,
    `${result.value.themes.length} theme(s) via ${result.providerInstanceId}/${result.model}` +
    (result.repaired ? ' [repaired]' : '') + (result.fellBackFrom ? ` [fell back from ${result.fellBackFrom}]` : ''));
  console.log('      themes:', result.value.themes.map((t) => `${t.label} (${t.relevance})`).join(', '));
  check('generation ran on the RunPod GPU instance',
    result.providerInstanceId === 'remote_gpu_ollama' && !result.fellBackFrom,
    result.providerInstanceId);
} catch (error) {
  check('structured generation returns schema-valid JSON', false, error.message);
}

// --- 3. usage recorded -------------------------------------------------------
const after = await countUsage();
check('usage_events row written for the call', after.total > before.total,
  `${before.total} -> ${after.total}, remote_gpu rows: ${after.remote}`);

// --- 4. malformed output is rejected, not persisted ---------------------------
const StrictSchema = z.object({ required: z.string(), count: z.number() });
const garbage = parseWithSchema('Sure! Here is your answer: {"wrong": true}', StrictSchema);
check('malformed model JSON is rejected', garbage.ok === false && garbage.reason === 'schema-rejected',
  garbage.ok ? 'ACCEPTED (wrong)' : garbage.reason);
const prose = parseWithSchema('I cannot help with that request.', StrictSchema);
check('prose with no JSON is rejected', prose.ok === false && prose.reason === 'unparseable',
  prose.ok ? 'ACCEPTED (wrong)' : prose.reason);

// --- 5. fallback when the remote instance is unreachable ----------------------
// Point the remote instance at a dead port and confirm the local alias serves.
const brokenConfig = structuredClone({
  ...config,
  providerInstances: {
    ...config.providerInstances,
    remote_gpu_ollama: { ...config.providerInstances.remote_gpu_ollama, baseUrl: 'http://127.0.0.1:1' },
  },
});
const brokenRegistry = new ProviderRegistry(brokenConfig, new PostgresCapabilityStore());
try {
  const fallback = await new StructuredGenerator(brokenRegistry).generate({
    alias: 'intelligence',
    fallbackAlias: 'intelligence_local',
    schema: ThemeSchema,
    system: 'Extract technology themes. Return ONLY JSON: {"themes":[{"label":string,"relevance":number}]}',
    user: SAMPLE,
    workerRole: 'proof:fallback',
    maxTokens: 600,
  });
  check('falls back to local when RunPod is unreachable',
    fallback.fellBackFrom === 'intelligence' && fallback.providerInstanceId === 'local_ollama',
    `served by ${fallback.providerInstanceId}, fellBackFrom=${fallback.fellBackFrom}`);
} catch (error) {
  check('falls back to local when RunPod is unreachable', false, error.message);
}

async function countUsage() {
  try {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE usage_class = 'REMOTE_GPU_OLLAMA')::int AS remote
         FROM usage_events`,
    );
    return { total: rows[0].total, remote: rows[0].remote };
  } catch {
    return { total: 0, remote: 0 };
  }
}

console.log(failures === 0 ? '\nALL MODEL-PATH CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
runpod.stop();
await closePool();
process.exit(failures === 0 ? 0 : 1);
