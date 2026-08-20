/**
 * Phase 4 live verification: a real multi-turn agent loop against Ollama.
 *
 *   node --import tsx scripts/agent-loop-verify.mjs [alias...]
 *
 * Uses throwaway in-memory tools rather than the real filesystem/shell tools
 * (Phases 5-6) so the loop itself is what is under test. Runs each model
 * through the same tasks so the qwen3-vs-qwen2.5-coder question gets evidence
 * from sustained multi-turn behaviour rather than single-call probes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAppConfigResult } from '../packages/shared/src/index.ts';
import { InMemoryCapabilityStore, ProviderRegistry } from '../packages/providers/src/index.ts';
import { runAgentLoop } from '../packages/agent-core/src/agent-loop.ts';
import { LoopTraceRecorder } from '../packages/training-traces/src/loop-recorder.ts';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const ALIASES = process.argv.slice(2).length ? process.argv.slice(2) : ['coder', 'structured_agent'];

const { config } = loadAppConfigResult(process.env, {
  modelAliasPath: fileURLToPath(new URL('../config/models/default.yaml', import.meta.url)),
});
const registry = new ProviderRegistry(config, new InMemoryCapabilityStore());

/** A tiny fake project the model must inspect to answer correctly. */
const FILES = {
  'src/config.ts': 'export const PORT = 8080;\nexport const RETRIES = 3;\n',
  'src/server.ts': "import { PORT } from './config';\nconsole.log(PORT);\n",
  'README.md': '# Demo\nA demo project.\n',
};

function makeExecutor(log) {
  return {
    listTools: () => [
      {
        name: 'list_files',
        description: 'List every file path in the project.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'read_file',
        description: 'Read one file. Returns its full contents.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path from list_files.' } },
          required: ['path'],
        },
      },
    ],
    async execute(call) {
      // Arguments matter as much as the name: choosing the wrong file is a
      // different failure from ignoring the observation.
      const args = Object.entries(call.arguments ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      log.push(args ? `${call.name}(${args})` : call.name);
      if (call.name === 'list_files') {
        return { output: Object.keys(FILES).join('\n'), success: true };
      }
      const path = String(call.arguments.path ?? '');
      const content = FILES[path];
      if (content === undefined) {
        return { output: `No such file: ${path}`, success: false, error: 'not-found' };
      }
      return { output: content, success: true };
    },
  };
}

const TASKS = [
  {
    name: 'two-step lookup',
    prompt:
      'What port does this project listen on? List the files, read the relevant one, then answer ' +
      'with just the number.',
    // Requires at least two dependent tool calls: list, then read.
    check: (result, log) => ({
      usedTools: log.length >= 2,
      correct: /8080/.test(result.answer),
    }),
  },
  {
    name: 'recovers from a bad path',
    prompt:
      'Read the file "src/nonexistent.ts". If it does not exist, list the files and tell me what ' +
      'files DO exist.',
    check: (result, log) => ({
      usedTools: log.length >= 1,
      correct: /config\.ts|server\.ts|README/i.test(result.answer),
    }),
  },
];

let failures = 0;

for (const alias of ALIASES) {
  let resolved;
  try {
    resolved = await registry.resolveAlias(alias, { requireToolCalling: true });
  } catch (error) {
    console.log(`\n${alias}: SKIPPED — ${error.message.split('\n')[0]}`);
    continue;
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${alias} → ${resolved.model} (tool channel: ${resolved.capabilities.toolCallChannel})`);
  console.log('='.repeat(72));

  for (const task of TASKS) {
    const log = [];
    const recorder = new LoopTraceRecorder({ source: 'internal' });
    const started = Date.now();

    const result = await runAgentLoop({
      provider: resolved.provider,
      model: resolved.model,
      capabilities: resolved.capabilities,
      executor: makeExecutor(log),
      prompt: task.prompt,
      systemPrompt:
        'You are a repository assistant. Use the provided tools to inspect files before answering. ' +
        'Answer only from what the tools return.',
      temperature: 0,
      // Reasoning models: skip the thinking pass to keep turn latency sane.
      think: false,
      maxTurns: 8,
      onEvent: (event) => recorder.record(event),
    });

    const { usedTools, correct } = task.check(result, log);
    const ok = usedTools && correct && result.stopReason === 'final-answer';
    if (!ok) failures += 1;

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${task.name}: ${result.turns} turns, ${result.toolCalls} calls ` +
        `[${log.join(' → ') || 'none'}], stop=${result.stopReason}, ${Math.round((Date.now() - started) / 100) / 10}s`,
    );
    console.log(`      rejected=${result.rejectedCalls} denied=${result.deniedCalls} ` +
      `tokens=${result.usage.inputTokens}/${result.usage.outputTokens}`);
    console.log(`      answer: ${JSON.stringify(result.answer.replace(/\s+/g, ' ').slice(0, 110))}`);

    const steps = recorder.collect();
    const modelTurns = steps.filter((s) => s.type === 'model_response');
    const leaked = steps.some((s) => JSON.stringify(s).includes('<think>'));
    console.log(
      `      trace: ${steps.length} steps (${modelTurns.length} model, ` +
        `${steps.filter((s) => s.type === 'tool_call').length} calls, ` +
        `${steps.filter((s) => s.type === 'tool_result').length} results), ` +
        `hidden reasoning stripped from ${recorder.strippedTurns} turn(s), leaked=${leaked}`,
    );
    if (leaked) failures += 1;
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
