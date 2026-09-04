import { loadAppConfigResult } from '../packages/shared/src/config.ts';
import * as toolGroups from '../packages/tools/src/index.ts';
import { createCodexServerTools } from '../apps/server/src/codex-tools.ts';
import { createFinalReviewTools } from '../apps/server/src/final-review-tools.ts';
import { OllamaProvider } from '../packages/providers/src/ollama-provider.ts';

const config = loadAppConfigResult().config;
const instance = config.providerInstances.remote_gpu_ollama;
const model = config.models.gpu_coder?.model;

if (!instance?.baseUrl || !model) {
  throw new Error('remote_gpu_ollama and gpu_coder must be configured.');
}

const groupNames = [
  'FILESYSTEM_TOOLS', 'SHELL_TOOLS', 'WEB_TOOLS', 'MCP_TOOLS',
  'REPOSITORY_INTELLIGENCE_TOOLS', 'CODE_TOOLS', 'HOST_TOOLS', 'SKILL_TOOLS',
];
const tools = groupNames.flatMap((name) => toolGroups[name] ?? []).map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
}));
const allCanonicalTools = [
  ...Object.values(toolGroups).filter((value) => Array.isArray(value)).flat(),
  ...createCodexServerTools(config.port),
  ...createFinalReviewTools({ threadId: 'probe', workspaceRoot: process.cwd(), objective: 'probe' }),
];
const completeTools = [...new Map(allCanonicalTools.map((tool) => [tool.name, tool])).values()].map((tool) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
}));

function sanitize(value) {
  return value
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/g, '[REDACTED_URL]')
    .slice(0, 800);
}

async function probeBody(label, body, offeredTools) {
  try {
    const response = await fetch(`${instance.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify(body),
    });
    const responseBody = await response.text();
    console.log(JSON.stringify({
      label,
      status: response.status,
      toolCount: offeredTools?.length ?? 0,
      error: response.ok ? undefined : sanitize(responseBody),
    }));
    return response.ok;
  } catch (error) {
    console.log(JSON.stringify({
      label,
      status: 'unreachable-or-timeout',
      toolCount: offeredTools?.length ?? 0,
      error: sanitize(String(error)),
    }));
    return false;
  }
}

async function probe(label, offeredTools) {
  return probeBody(label, {
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    stream: false,
    options: { num_predict: 1 },
    ...(offeredTools ? { tools: offeredTools } : {}),
  }, offeredTools);
}

await probe('no-tools');
await probe('one-tool', tools.slice(0, 1));
await probe('full-canonical', tools);
await probe('complete-canonical', completeTools);

const replayPrefix = [
  { role: 'user', content: 'List the current directory, then reply OK.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'filesystem.list', arguments: { path: '.' } } }],
  },
];
await probeBody('broken-tool-history', {
  model,
  messages: [...replayPrefix.slice(0, 1), { role: 'assistant', content: '' }, { role: 'tool', content: 'README.md' }],
  tools,
  stream: false,
  options: { num_predict: 1 },
}, tools);
await probeBody('normalized-tool-history', {
  model,
  messages: [...replayPrefix, { role: 'tool', content: 'README.md', tool_name: 'filesystem.list' }],
  tools,
  stream: false,
  options: { num_predict: 1 },
}, tools);

try {
  const provider = new OllamaProvider(instance);
  await provider.chat({
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    maxTokens: 1,
    tools: [...new Map(allCanonicalTools.map((tool) => [tool.name, tool])).values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
  console.log(JSON.stringify({ label: 'provider-boundary-complete', status: 200, toolCount: completeTools.length }));
} catch (error) {
  console.log(JSON.stringify({
    label: 'provider-boundary-complete',
    status: 'failed',
    toolCount: completeTools.length,
    error: sanitize(error instanceof Error ? error.message : String(error)),
  }));
}
