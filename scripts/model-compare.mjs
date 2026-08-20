/**
 * Head-to-head model evaluation against the running Ollama instance.
 *
 *   node --import tsx scripts/model-compare.mjs [modelA] [modelB] [--trials N]
 *
 * Nothing here trusts Ollama's declared metadata: every capability is measured
 * by actually calling the model. Reused in Phase 4 for the multi-turn agent-loop
 * comparison, so results stay comparable across phases.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAppConfigResult } from '../packages/shared/src/index.ts';
import { InMemoryCapabilityStore, ProviderRegistry } from '../packages/providers/src/index.ts';
import { probeCapabilities } from '../packages/providers/src/capability-probe.ts';
import { stripHiddenReasoning } from '../packages/training-traces/src/capture.ts';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
}

const argv = process.argv.slice(2);
const trialsFlag = argv.indexOf('--trials');
const TRIALS = trialsFlag > -1 ? Number(argv[trialsFlag + 1]) : 5;
// Drop the flag and its value so a trial count is never taken for a model tag.
const positional = argv.filter((arg, index) => {
  if (arg.startsWith('--')) return false;
  if (trialsFlag > -1 && index === trialsFlag + 1) return false;
  return true;
});
const MODELS = positional.length ? positional : ['qwen3:8b', 'qwen2.5-coder:7b'];

const { config } = loadAppConfigResult(process.env, {
  modelAliasPath: fileURLToPath(new URL('../config/models/default.yaml', import.meta.url)),
});
const registry = new ProviderRegistry(config, new InMemoryCapabilityStore());
const provider = registry.getProvider('local_ollama');
const baseUrl = process.env.OLLAMA_LOCAL_BASE_URL ?? 'http://127.0.0.1:11434';

const PROBE_TOOL = {
  name: 'probe_echo',
  description: 'Echo a single word back to the caller.',
  inputSchema: {
    type: 'object',
    properties: { word: { type: 'string', description: 'The word to echo back.' } },
    required: ['word'],
  },
};

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

/** Raw /api/chat so the structured vs text channel can be observed directly. */
async function rawChat(model, body) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, options: { temperature: 0 }, ...body }),
    signal: AbortSignal.timeout(420_000),
  });
  const payload = await response.json();
  return { payload, elapsedMs: Date.now() - started };
}

async function identity(model) {
  const [tags, show] = await Promise.all([
    fetch(`${baseUrl}/api/tags`).then((r) => r.json()),
    fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).then((r) => r.json()),
  ]);

  const entry = tags.models.find((m) => m.name === model || m.model === model) ?? {};
  const info = show.model_info ?? {};
  const contextKey = Object.keys(info).find((k) => k.endsWith('.context_length'));

  return {
    tag: model,
    digest: (entry.digest ?? '').slice(0, 12),
    family: show.details?.family,
    parameterSize: show.details?.parameter_size,
    quantization: show.details?.quantization_level,
    sizeGb: entry.size ? (entry.size / 1e9).toFixed(2) : '?',
    contextLength: contextKey ? info[contextKey] : undefined,
    declaredCapabilities: show.capabilities ?? [],
  };
}

/**
 * Runs the probe tool call N times and classifies each outcome. A single pass
 * can be luck; the rate is what matters for a multi-turn agent loop.
 */
async function toolCallTrials(model, trials) {
  const outcomes = { structured: 0, textJson: 0, malformed: 0, none: 0 };
  const latencies = [];
  let thinkingSeen = false;
  let sampleMalformed = '';

  for (let i = 0; i < trials; i += 1) {
    const { payload, elapsedMs } = await rawChat(model, {
      messages: [
        { role: 'user', content: 'Call the probe_echo tool exactly once with the word "ready". Do not reply with prose.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: PROBE_TOOL.name,
            description: PROBE_TOOL.description,
            parameters: PROBE_TOOL.inputSchema,
          },
        },
      ],
    });
    latencies.push(elapsedMs);

    const message = payload.message ?? {};
    if (message.thinking) thinkingSeen = true;
    const content = message.content ?? '';
    if (/<think>/i.test(content)) thinkingSeen = true;

    const structured = message.tool_calls?.[0]?.function;
    if (structured) {
      const args = structured.arguments;
      const ok =
        structured.name === PROBE_TOOL.name &&
        args &&
        typeof args === 'object' &&
        typeof args.word === 'string';
      if (ok) outcomes.structured += 1;
      else {
        outcomes.malformed += 1;
        sampleMalformed ||= JSON.stringify(structured).slice(0, 120);
      }
      continue;
    }

    // No structured call — did it emit a well-formed call as text?
    const { content: visible } = stripHiddenReasoning(content);
    const match = visible.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.name === PROBE_TOOL.name && typeof parsed.arguments?.word === 'string') {
          outcomes.textJson += 1;
          continue;
        }
      } catch {
        /* falls through to malformed */
      }
      outcomes.malformed += 1;
      sampleMalformed ||= visible.slice(0, 120);
      continue;
    }

    outcomes.none += 1;
    sampleMalformed ||= visible.slice(0, 120);
  }

  return {
    outcomes,
    thinkingSeen,
    sampleMalformed,
    meanLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  };
}

/**
 * Turn 1: model requests a tool. Turn 2: the result is fed back. A model
 * suitable for an agent loop must USE the result rather than re-calling the
 * tool or ignoring it.
 */
async function multiTurnSuitability(model) {
  const tools = [
    {
      type: 'function',
      function: {
        name: WEATHER_TOOL.name,
        description: WEATHER_TOOL.description,
        parameters: WEATHER_TOOL.inputSchema,
      },
    },
  ];

  const first = await rawChat(model, {
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
    tools,
  });

  const firstMessage = first.payload.message ?? {};
  const calledStructured = Boolean(firstMessage.tool_calls?.length);
  const firstContent = stripHiddenReasoning(firstMessage.content ?? '').content;

  let calledAtAll = calledStructured;
  if (!calledAtAll && /"name"\s*:\s*"get_weather"/.test(firstContent)) calledAtAll = true;
  if (!calledAtAll) {
    return { requestedTool: false, usedResult: false, reCalled: false, note: 'no tool call on turn 1' };
  }

  const assistantTurn = calledStructured
    ? { role: 'assistant', content: '', tool_calls: firstMessage.tool_calls }
    : { role: 'assistant', content: firstContent };

  const second = await rawChat(model, {
    messages: [
      { role: 'user', content: 'What is the weather in Paris? Use the tool.' },
      assistantTurn,
      { role: 'tool', content: '{"city":"Paris","temp_c":14,"condition":"light rain"}' },
      { role: 'user', content: 'Now answer in one short sentence using that result.' },
    ],
    tools,
  });

  const secondMessage = second.payload.message ?? {};
  const answer = stripHiddenReasoning(secondMessage.content ?? '').content;
  const reCalled = Boolean(secondMessage.tool_calls?.length);
  const usedResult = /14/.test(answer) && /rain/i.test(answer);

  return {
    requestedTool: true,
    structuredOnTurn1: calledStructured,
    usedResult,
    reCalled,
    answer: answer.replace(/\s+/g, ' ').slice(0, 110),
    elapsedMs: first.elapsedMs + second.elapsedMs,
  };
}

/** A deterministic coding task with objectively checkable constraints. */
async function codingInstructionFollowing(model) {
  const { payload, elapsedMs } = await rawChat(model, {
    messages: [
      {
        role: 'user',
        content:
          'Write a TypeScript function named clampToRange that takes (value: number, min: number, max: number) ' +
          'and returns the value clamped to the range. Output ONLY the code inside a single ```typescript fence. ' +
          'No explanation before or after.',
      },
    ],
  });

  const raw = payload.message?.content ?? '';
  const { content, stripped } = stripHiddenReasoning(raw);
  const fences = content.match(/```/g)?.length ?? 0;
  const codeBlock = content.match(/```(?:typescript|ts)?\s*([\s\S]*?)```/)?.[1] ?? '';
  const proseOutside = content.replace(/```[\s\S]*?```/g, '').trim();

  const checks = {
    hasFunction: /function\s+clampToRange|const\s+clampToRange/.test(codeBlock),
    correctSignature: /value\s*:\s*number/.test(codeBlock) && /max\s*:\s*number/.test(codeBlock),
    implementsClamp: /Math\.(min|max)/.test(codeBlock) || /[<>]=?/.test(codeBlock),
    singleFence: fences === 2,
    noProseOutsideFence: proseOutside.length < 20,
  };

  return {
    checks,
    passed: Object.values(checks).filter(Boolean).length,
    total: Object.keys(checks).length,
    emittedThinking: stripped,
    elapsedMs,
  };
}

/** Cold-load cost, warm latency, throughput, and resident size. */
async function performance(model) {
  await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => undefined);

  const cold = await rawChat(model, { messages: [{ role: 'user', content: 'Say: ok' }] });
  const warm = await rawChat(model, { messages: [{ role: 'user', content: 'Say: ok' }] });

  let firstChunkMs;
  const streamStart = Date.now();
  let chunks = 0;
  for await (const event of provider.stream({
    model,
    messages: [{ role: 'user', content: 'Count from one to five.' }],
    temperature: 0,
    think: false,
    maxTokens: 256,
  })) {
    if (event.type === 'chunk') {
      chunks += 1;
      firstChunkMs ??= Date.now() - streamStart;
    }
    if (event.type === 'done' || event.type === 'error') break;
  }

  const ps = await fetch(`${baseUrl}/api/ps`).then((r) => r.json()).catch(() => ({ models: [] }));
  const resident = (ps.models ?? []).find((m) => m.name === model || m.model === model);
  const evalCount = warm.payload.eval_count ?? 0;
  const evalSeconds = (warm.payload.eval_duration ?? 0) / 1e9;

  return {
    coldMs: cold.elapsedMs,
    loadMs: Math.round((cold.payload.load_duration ?? 0) / 1e6),
    warmMs: warm.elapsedMs,
    ttftMs: firstChunkMs,
    streamChunks: chunks,
    tokensPerSec: evalSeconds > 0 ? (evalCount / evalSeconds).toFixed(1) : '?',
    residentGb: resident?.size ? (resident.size / 1e9).toFixed(2) : '?',
    vramGb: resident?.size_vram ? (resident.size_vram / 1e9).toFixed(2) : '0.00',
  };
}

const results = [];

for (const model of MODELS) {
  console.log(`\n${'='.repeat(64)}\n${model}\n${'='.repeat(64)}`);

  const id = await identity(model);
  console.log(`identity      ${id.tag}  digest ${id.digest}  ${id.family} ${id.parameterSize} ${id.quantization}`);
  console.log(`size          ${id.sizeGb} GB on disk, context ${id.contextLength ?? '?'} tokens`);
  console.log(`declared      [${id.declaredCapabilities.join(', ')}]  (metadata only — not trusted)`);

  const caps = await probeCapabilities(provider, model, { timeoutMs: 420_000 });
  console.log(
    `probe         toolCalling=${caps.toolCalling}` +
      `${caps.toolCallChannel ? ` via ${caps.toolCallChannel}` : ''}  streaming=${caps.streaming}`,
  );

  const trials = await toolCallTrials(model, TRIALS);
  const { structured, textJson, malformed, none } = trials.outcomes;
  console.log(
    `tool trials   ${TRIALS} runs → structured=${structured} text-json=${textJson} malformed=${malformed} none=${none}` +
      `  (mean ${trials.meanLatencyMs}ms)`,
  );
  if (trials.sampleMalformed) console.log(`  sample bad   ${JSON.stringify(trials.sampleMalformed)}`);
  console.log(`thinking      emits hidden reasoning: ${trials.thinkingSeen ? 'YES' : 'no'}`);

  const multi = await multiTurnSuitability(model);
  console.log(
    `multi-turn    requestedTool=${multi.requestedTool} structuredTurn1=${multi.structuredOnTurn1 ?? false} ` +
      `usedResult=${multi.usedResult} reCalled=${multi.reCalled}`,
  );
  if (multi.answer) console.log(`  answer       ${JSON.stringify(multi.answer)}`);

  const coding = await codingInstructionFollowing(model);
  console.log(`coding        ${coding.passed}/${coding.total} checks in ${coding.elapsedMs}ms`);
  for (const [name, ok] of Object.entries(coding.checks)) console.log(`  ${ok ? '+' : '-'} ${name}`);

  const perf = await performance(model);
  console.log(
    `latency       cold ${perf.coldMs}ms (load ${perf.loadMs}ms) · warm ${perf.warmMs}ms · ` +
      `TTFT ${perf.ttftMs}ms · ${perf.tokensPerSec} tok/s`,
  );
  console.log(`memory        resident ${perf.residentGb} GB (VRAM ${perf.vramGb} GB)`);

  const malformedRate = (malformed + none) / TRIALS;
  const agentCapable = caps.toolCalling === 'verified' && malformedRate <= 0.2;
  console.log(`VERDICT       ${agentCapable ? 'AGENT-CAPABLE' : 'ADVISORY-CLASS'}` +
    `  (malformed/none rate ${(malformedRate * 100).toFixed(0)}%)`);

  results.push({ model, id, caps, trials, multi, coding, perf, agentCapable, malformedRate });
}

if (results.length === 2) {
  const [a, b] = results;
  const row = (label, x, y) => console.log(`${label.padEnd(26)} ${String(x).padEnd(26)} ${y}`);
  console.log(`\n${'='.repeat(80)}\nHEAD-TO-HEAD\n${'='.repeat(80)}`);
  row('', a.model, b.model);
  row('structured tool calls', `${a.trials.outcomes.structured}/${TRIALS}`, `${b.trials.outcomes.structured}/${TRIALS}`);
  row('text-json tool calls', `${a.trials.outcomes.textJson}/${TRIALS}`, `${b.trials.outcomes.textJson}/${TRIALS}`);
  row('malformed / none', `${a.trials.outcomes.malformed + a.trials.outcomes.none}/${TRIALS}`, `${b.trials.outcomes.malformed + b.trials.outcomes.none}/${TRIALS}`);
  row('coding checks', `${a.coding.passed}/${a.coding.total}`, `${b.coding.passed}/${b.coding.total}`);
  row('multi-turn uses result', a.multi.usedResult, b.multi.usedResult);
  row('warm latency', `${a.perf.warmMs}ms`, `${b.perf.warmMs}ms`);
  row('TTFT', `${a.perf.ttftMs}ms`, `${b.perf.ttftMs}ms`);
  row('throughput', `${a.perf.tokensPerSec} tok/s`, `${b.perf.tokensPerSec} tok/s`);
  row('cold load', `${a.perf.loadMs}ms`, `${b.perf.loadMs}ms`);
  row('resident', `${a.perf.residentGb} GB`, `${b.perf.residentGb} GB`);
  row('emits hidden reasoning', a.trials.thinkingSeen ? 'YES' : 'no', b.trials.thinkingSeen ? 'YES' : 'no');
  row('verdict', a.agentCapable ? 'AGENT-CAPABLE' : 'ADVISORY', b.agentCapable ? 'AGENT-CAPABLE' : 'ADVISORY');
}
