/**
 * Phase 2 live verification against the running Ollama instance.
 *
 *   node --import tsx scripts/ollama-verify.mjs
 *
 * Exercises real HTTP: version/health, tag discovery with /api/show enrichment,
 * base/persona/alias grouping, a non-streaming chat, a streaming chat, and the
 * capability probe — including a model that declares no tool support, which
 * must resolve to advisory-class rather than entering the agent loop.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAppConfigResult } from '../packages/shared/src/index.ts';
import {
  groupModels,
  InMemoryCapabilityStore,
  ProviderRegistry,
  ProviderResolutionError,
} from '../packages/providers/src/index.ts';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

const { config, warnings } = loadAppConfigResult(process.env, {
  modelAliasPath: fileURLToPath(new URL('../config/models/default.yaml', import.meta.url)),
});

for (const warning of warnings) console.log(`warning: ${warning}`);

const registry = new ProviderRegistry(config, new InMemoryCapabilityStore());
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 1. Health.
const health = await registry.health();
const local = health.find((entry) => entry.instanceId === 'local_ollama');
check('local Ollama reachable', local?.status === 'connected', `v${local?.version} in ${local?.latencyMs}ms`);
check(
  'remote instances report not configured',
  health.filter((h) => h.instanceId !== 'local_ollama').every((h) => h.status === 'not configured'),
);

// 2. Discovery + grouping.
const models = await registry.listModels();
const inventory = groupModels(models);
check('tag discovery returned models', models.length > 0, `${models.length} tags`);
check(
  'grouping collapses tags to fewer base artifacts',
  inventory.baseCount < inventory.tagCount,
  `${inventory.tagCount} tags → ${inventory.baseCount} bases`,
);

for (const group of inventory.groups) {
  const parts = [`${group.baseModel} (${group.family} ${group.parameterSize})`];
  if (group.aliases.length) parts.push(`aliases: ${group.aliases.join(', ')}`);
  if (group.personas.length) parts.push(`${group.personas.length} personas`);
  parts.push(`caps: [${group.declaredCapabilities.join(', ') || 'none'}]`);
  console.log(`      · ${parts.join(' | ')}`);
}

const qwen = inventory.groups.find((g) => g.baseModel.startsWith('qwen2.5-coder'));
check('qwen2.5-coder aliases collapse to one artifact', (qwen?.aliases.length ?? 0) >= 1, qwen?.aliases.join(', '));

// 3. Non-streaming chat — a real HTTP round trip, not a placeholder string.
const coder = await registry.resolveAlias('coder');
const reply = await coder.provider.chat({
  model: coder.model,
  messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  temperature: 0,
});
check('chat() performs a real inference call', reply.content.toLowerCase().includes('pong'), JSON.stringify(reply.content.slice(0, 60)));
check('response carries instance identity and usage class', reply.providerInstanceId === 'local_ollama' && reply.usageClass === 'LOCAL_OLLAMA');
check('token usage is reported', (reply.usage?.outputTokens ?? 0) > 0, `in=${reply.usage?.inputTokens} out=${reply.usage?.outputTokens}`);

// 4. Streaming.
let chunks = 0;
let streamed = '';
for await (const event of coder.provider.stream({
  model: coder.model,
  messages: [{ role: 'user', content: 'Count: one two three' }],
  temperature: 0,
  maxTokens: 32,
})) {
  if (event.type === 'chunk') {
    chunks += 1;
    streamed += event.content ?? '';
  }
  if (event.type === 'done') break;
}
check('stream() yields incremental chunks', chunks > 1, `${chunks} chunks, ${streamed.length} chars`);

// 5. Capability probe — established, not assumed.
console.log('      probing capabilities (one inference call per model)…');
const coderCaps = await registry.getCapabilities('local_ollama', coder.model);
check(
  'tool calling VERIFIED for the coder model',
  coderCaps.toolCalling === 'verified',
  `toolCalling=${coderCaps.toolCalling} streaming=${coderCaps.streaming}`,
);

const advisoryModel = models.find((m) => !m.declaredCapabilities.includes('tools'));
if (advisoryModel) {
  const caps = await registry.getCapabilities('local_ollama', advisoryModel.name);
  check(
    `tool-incapable model resolves advisory-class (${advisoryModel.name})`,
    caps.toolCalling === 'unsupported',
    `toolCalling=${caps.toolCalling}`,
  );

  let refused = false;
  try {
    await registry.resolve('local_ollama', advisoryModel.name, { requireToolCalling: true });
  } catch (error) {
    refused = error instanceof ProviderResolutionError && error.code === 'not-agent-capable';
  }
  check('agent loop refuses an advisory-class model', refused);

  const advisory = await registry.resolve('local_ollama', advisoryModel.name, { requireToolCalling: false });
  check('advisory-class model is still usable for non-tool work', advisory.model === advisoryModel.name);
} else {
  console.log('SKIP  no tool-incapable model installed to test the advisory-class path');
}

// 6. Probe caching — a second resolve must not spend another inference call.
const cachedStart = Date.now();
await registry.getCapabilities('local_ollama', coder.model);
check('probe result is cached', Date.now() - cachedStart < 50, `${Date.now() - cachedStart}ms`);

// 7. Routing guardrails.
let policyBlocked = false;
try {
  const localOnly = new ProviderRegistry({ ...config, routingPolicy: 'local-only' }, new InMemoryCapabilityStore());
  await localOnly.resolve('anthropic', 'claude-3-5-sonnet-20241022');
} catch (error) {
  policyBlocked = error instanceof ProviderResolutionError && error.code === 'policy-blocked';
}
check('local-only policy blocks a remote instance', policyBlocked);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
