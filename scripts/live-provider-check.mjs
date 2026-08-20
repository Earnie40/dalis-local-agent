/**
 * Bounded, manually-triggered live acceptance check for the remote paid
 * providers (Sol/OpenAI, Claude/Anthropic).
 *
 *   node --import tsx scripts/live-provider-check.mjs [alias...]
 *
 * Each alias gets exactly one minimal chat call plus, where the harness
 * supports it, one read-only tool round trip through the same
 * provider-neutral agent loop used in production. This is NOT a benchmark:
 * it is a cheap "the credentials and wiring still work" smoke test intended
 * for workflow_dispatch, never for normal push/PR CI.
 */
import { fileURLToPath } from 'node:url';
import { loadAppConfigResult } from '../packages/shared/src/index.ts';
import { InMemoryCapabilityStore, ProviderRegistry } from '../packages/providers/src/index.ts';
import { runAgentLoop } from '../packages/agent-core/src/agent-loop.ts';
import {
  EvidencePacketCollector,
  executeParallelParticipants,
} from '../apps/server/src/parallel-model-executor.ts';

const args = process.argv.slice(2);
const runParallelSmoke = args.includes('--parallel');
const ALIASES = args.filter((a) => a !== '--parallel').length
  ? args.filter((a) => a !== '--parallel')
  : ['sol', 'claude'];

// Live validation never needs a real database; the schema only requires a
// non-empty string.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@localhost:5432/unused';

const { config } = loadAppConfigResult(process.env, {
  modelAliasPath: fileURLToPath(new URL('../config/models/default.yaml', import.meta.url)),
});
const registry = new ProviderRegistry(config, new InMemoryCapabilityStore());

const FILE = { path: 'package.json', content: '{"name":"dacai-local-agent"}' };

function readOnlyExecutor(log) {
  return {
    listTools: () => [
      {
        name: 'filesystem.read',
        description: 'Read a repository file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ],
    async execute(call) {
      log.push(call.name);
      return { output: FILE.content, success: true };
    },
  };
}

let failures = 0;

for (const alias of ALIASES) {
  let resolved;
  try {
    resolved = await registry.resolveAlias(alias, {
      requireToolCalling: true,
      explicitInstanceRequest: true,
    });
  } catch (error) {
    failures += 1;
    console.log(`${alias}: FAIL — could not resolve — ${error.message.split('\n')[0]}`);
    continue;
  }

  console.log(`\n${alias} -> instance=${resolved.instance.id} model=${resolved.model}`);

  try {
    const log = [];
    const result = await runAgentLoop({
      provider: resolved.provider,
      model: resolved.model,
      capabilities: resolved.capabilities,
      executor: readOnlyExecutor(log),
      prompt:
        'State your provider identity in one short sentence, then read package.json and report ' +
        'the "name" field. Use the tool; do not guess.',
      temperature: 0,
      maxTurns: 3,
    });

    const usedTool = log.includes('filesystem.read');
    const mentionsName = /dacai-local-agent/i.test(result.answer);
    const ok = result.stopReason === 'final-answer' && usedTool && mentionsName;
    if (!ok) failures += 1;

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  turns=${result.turns} toolCalls=${result.toolCalls} ` +
        `stop=${result.stopReason} usedTool=${usedTool}`,
    );
    console.log(`      answer: ${JSON.stringify(result.answer.replace(/\s+/g, ' ').slice(0, 160))}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  live request errored — ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (runParallelSmoke) {
  console.log(`\n${'='.repeat(72)}\nparallel sol+claude smoke test\n${'='.repeat(72)}`);
  try {
    const participants = [
      { alias: 'sol', providerInstanceId: 'openai_sol', model: config.models.sol?.model ?? 'gpt-5.6-sol' },
      { alias: 'claude', providerInstanceId: 'anthropic', model: config.models.claude?.model ?? '' },
    ];

    const result = await executeParallelParticipants({
      participants,
      objective: 'State your provider identity in one short sentence. Read-only; no changes.',
      runReadOnly: async (participant, role) => {
        const resolved = await registry.resolveAlias(participant.alias, {
          requireToolCalling: true,
          explicitInstanceRequest: true,
        });
        const log = [];
        const loopResult = await runAgentLoop({
          provider: resolved.provider,
          model: resolved.model,
          capabilities: resolved.capabilities,
          executor: readOnlyExecutor(log),
          prompt: 'State your provider identity in one short sentence. Do not use any tools.',
          temperature: 0,
          maxTurns: 1,
        });
        const collector = new EvidencePacketCollector(participant, 'identify provider', role);
        return { result: loopResult, packet: collector.complete(loopResult) };
      },
    });

    const identified = result.participants.every((entry) => entry.packet.status === 'completed');
    if (!identified) failures += 1;
    for (const entry of result.participants) {
      console.log(`${entry.packet.status === 'completed' ? 'PASS' : 'FAIL'}  ${entry.participant.alias}: ${entry.packet.findings.join(' ').slice(0, 160)}`);
    }
  } catch (error) {
    failures += 1;
    console.log(`FAIL  parallel smoke test errored — ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL LIVE PROVIDER CHECKS PASSED' : `${failures} LIVE PROVIDER CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
