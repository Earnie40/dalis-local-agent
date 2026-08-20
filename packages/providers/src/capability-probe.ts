import type {
  CapabilityStatus,
  ModelProvider,
  ProviderCapabilities,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

/**
 * Bumped whenever the probe itself changes, so cached results from an older
 * probe are re-run rather than trusted.
 */
export const PROBE_VERSION = 1;

/**
 * A trivial, side-effect-free tool. The model is asked to call it with one
 * string argument; anything less than a well-formed call leaves tool calling
 * un-verified.
 */
const PROBE_TOOL: ToolSchema = {
  name: 'probe_echo',
  description: 'Echo a single word back to the caller. Used to verify tool calling works.',
  inputSchema: {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'The word to echo back.' },
    },
    required: ['word'],
  },
};

const PROBE_PROMPT = 'Call the probe_echo tool exactly once with the word "ready". Do not reply with prose.';

export interface ProbeOptions {
  /** Probes are bounded so a slow or hung model cannot stall the caller. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Establishes capability rather than inheriting it from configuration.
 *
 * A model being configured, enabled, and even advertising `tools` in its
 * metadata says nothing about whether it will actually emit a well-formed tool
 * call. Only a response containing a parseable call to the probe tool raises
 * tool calling to `verified`.
 */
export async function probeCapabilities(
  provider: ModelProvider,
  model: string,
  options: ProbeOptions = {},
): Promise<ProviderCapabilities> {
  const declaredToolCalling = provider.supportsTools(model);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const capabilities: ProviderCapabilities = {
    toolCalling: declaredToolCalling,
    streaming: provider.stream ? 'declared' : 'unsupported',
    probedAt: new Date().toISOString(),
    probeVersion: PROBE_VERSION,
  };

  // A provider that declares no tool support is taken at its word: spending an
  // inference call to confirm a "no" is waste. Streaming is still probed below,
  // because advisory-class models are exactly the ones used for plain chat.
  if (declaredToolCalling === 'unsupported') {
    if (provider.stream) capabilities.streaming = await probeStreaming(provider, model, signal);
    return capabilities;
  }

  try {
    const response = await provider.chat({
      model,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      tools: [PROBE_TOOL],
      temperature: 0,
      signal,
    });

    capabilities.toolCalling = evaluateProbeResponse(response.toolCalls);
    if (capabilities.toolCalling === 'verified') {
      // Record how the call arrived. A text-channel model is admitted to the
      // agent loop, but the loop can see it is on the more fragile path.
      capabilities.toolCallChannel = response.toolCallChannel ?? 'structured';
    }
  } catch (error) {
    capabilities.toolCalling = declaredToolCalling === 'declared' ? 'declared' : 'unknown';
    capabilities.lastProbeError = error instanceof Error ? error.name : 'UnknownError';
  }

  if (provider.stream) {
    capabilities.streaming = await probeStreaming(provider, model, signal);
  }

  return capabilities;
}

/**
 * A call counts only if the name matches and the arguments parsed into an
 * object carrying the required field. Prose describing the call, a malformed
 * argument blob, or a call to a hallucinated tool all fail.
 */
function evaluateProbeResponse(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined): CapabilityStatus {
  if (!toolCalls?.length) return 'unsupported';

  const probeCall = toolCalls.find((call) => call.name === PROBE_TOOL.name);
  if (!probeCall) return 'unsupported';
  if (typeof probeCall.arguments !== 'object' || probeCall.arguments === null) return 'unsupported';
  if (typeof probeCall.arguments.word !== 'string') return 'unsupported';

  return 'verified';
}

async function probeStreaming(
  provider: ModelProvider,
  model: string,
  signal: AbortSignal,
): Promise<CapabilityStatus> {
  if (!provider.stream) return 'unsupported';

  try {
    let sawIncrementalContent = false;
    for await (const event of provider.stream({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      temperature: 0,
      // Reasoning models spend their whole budget thinking before emitting any
      // answer text, so thinking is disabled here and the budget left generous.
      // Judging a reasoning model on a 16-token window reports a false negative.
      think: false,
      maxTokens: 256,
      signal,
    })) {
      if (event.type === 'chunk' && event.content) sawIncrementalContent = true;
      if (event.type === 'error') return 'unsupported';
      if (event.type === 'done') break;
    }
    return sawIncrementalContent ? 'verified' : 'unsupported';
  } catch {
    return 'declared';
  }
}
