import type { ProviderInstance, ProviderKind, UsageClass } from '@dacai-local-agent/shared';
import type {
  CapabilityStatus,
  ChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelDescriptor,
  ModelProvider,
  NormalizedToolCall,
  ProviderCapabilities,
  ProviderHealth,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL_ENDPOINT = 'https://api.openai.com/v1/models';
const SOL_MODEL = 'gpt-5.6-sol';

export type OpenAIProviderErrorCode =
  | 'missing-api-key'
  | 'authentication'
  | 'access-denied'
  | 'rate-limit'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'http'
  | 'malformed-response';

export class OpenAIProviderError extends Error {
  constructor(
    message: string,
    readonly instanceId: string,
    readonly code: OpenAIProviderErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OpenAIProviderError';
  }
}

interface OpenAIResponsePayload {
  model?: string;
  status?: string;
  output_text?: string;
  output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string } | null;
}

interface OpenAIErrorPayload {
  error?: {
    message?: unknown;
    type?: unknown;
    param?: unknown;
    code?: unknown;
  } | null;
}

interface OpenAIErrorDetails {
  message?: string;
  type?: string;
  param?: string;
  code?: string;
}

function errorString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 2_000) : undefined;
}

async function readOpenAIError(response: Response): Promise<OpenAIErrorDetails> {
  try {
    const payload = (await response.json()) as OpenAIErrorPayload;
    const error = payload?.error;
    if (!error || typeof error !== 'object') return {};
    return {
      message: errorString(error.message),
      type: errorString(error.type),
      param: errorString(error.param),
      code: errorString(error.code),
    };
  } catch {
    return {};
  }
}

function openAIErrorSummary(status: number, details: OpenAIErrorDetails): string {
  const fields = [
    ['type', details.type],
    ['param', details.param],
    ['code', details.code],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([name, value]) => `${name}=${value}`);
  const context = fields.length ? ` (${fields.join(', ')})` : '';
  const message = details.message ? ` ${details.message}` : '';
  return `OpenAI Responses API returned HTTP ${status}${context}.${message}`;
}

/**
 * Stateless OpenAI Responses API adapter for the `openai_sol` instance.
 * Every request is reconstructed from ModelChatRequest.messages. No mutable
 * previous_response_id is retained, so concurrent runs cannot mix state.
 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly instanceId: string;
  readonly kind: ProviderKind = 'openai';
  readonly usageClass: UsageClass;
  private requestCount = 0;

  constructor(private readonly instance: ProviderInstance) {
    this.instanceId = instance.id;
    this.usageClass = instance.usageClass;
  }

  private apiKey(): string | undefined {
    // Provider config stores only the variable name; the value is read at call time.
    return process.env.OPENAI_API_KEY;
  }

  private async fetchOpenAI(url: string, init: RequestInit, callerSignal?: AbortSignal): Promise<Response> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      throw new OpenAIProviderError(
        'OpenAI provider "openai_sol" is not configured: OPENAI_API_KEY is not set.',
        this.instanceId,
        'missing-api-key',
      );
    }

    const timeout = AbortSignal.timeout(this.instance.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        ...init,
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (cause) {
      if (callerSignal?.aborted) {
        throw new OpenAIProviderError('OpenAI Responses request was cancelled.', this.instanceId, 'cancelled', {
          cause,
        });
      }
      if (timeout.aborted) {
        throw new OpenAIProviderError(
          `OpenAI Responses request timed out after ${this.instance.requestTimeoutMs}ms.`,
          this.instanceId,
          'timeout',
          { cause },
        );
      }
      throw new OpenAIProviderError(
        'OpenAI Responses API is unreachable. Check network connectivity and outbound HTTPS access.',
        this.instanceId,
        'network',
        { cause },
      );
    }

    if (!response.ok) {
      const details = await readOpenAIError(response);
      if (response.status === 401) {
        throw new OpenAIProviderError(
          `${openAIErrorSummary(response.status, details)} Check OPENAI_API_KEY.`,
          this.instanceId,
          'authentication',
        );
      }
      if (response.status === 403) {
        throw new OpenAIProviderError(
          `${openAIErrorSummary(response.status, details)} Confirm the key can use model ${SOL_MODEL}.`,
          this.instanceId,
          'access-denied',
        );
      }
      if (response.status === 429) {
        throw new OpenAIProviderError(
          `${openAIErrorSummary(response.status, details)} Retry after the provider backoff period.`,
          this.instanceId,
          'rate-limit',
        );
      }
      throw new OpenAIProviderError(
        openAIErrorSummary(response.status, details),
        this.instanceId,
        'http',
      );
    }

    return response;
  }

  async chat(input: ModelChatRequest): Promise<ModelChatResponse> {
    const startedAt = Date.now();
    this.requestCount += 1;

    const request = buildOpenAIResponsesRequest(input);

    const response = await this.fetchOpenAI(
      OPENAI_RESPONSES_ENDPOINT,
      { method: 'POST', body: JSON.stringify(request.body) },
      input.signal,
    );

    let payload: OpenAIResponsePayload;
    try {
      payload = (await response.json()) as OpenAIResponsePayload;
    } catch (cause) {
      throw new OpenAIProviderError(
        'OpenAI Responses API returned malformed JSON.',
        this.instanceId,
        'malformed-response',
        { cause },
      );
    }

    const normalized = normalizeOpenAIResponse(
      payload,
      this.instanceId,
      input.model,
      request.internalToolNames,
    );
    return {
      ...normalized,
      usageClass: this.usageClass,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Sol uses the provider-native structured function-call channel. */
  supportsTools(model?: string): CapabilityStatus {
    return model === SOL_MODEL ? 'verified' : 'unsupported';
  }

  capabilities(model: string): ProviderCapabilities | undefined {
    if (model !== SOL_MODEL) return undefined;
    return {
      toolCalling: 'verified',
      toolCallChannel: 'structured',
      streaming: 'unsupported',
      systemPrompt: 'verified',
      multiTurn: 'verified',
      textInput: 'verified',
      textOutput: 'verified',
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        name: SOL_MODEL,
        providerInstanceId: this.instanceId,
        declaredCapabilities: ['completion', 'tools', 'structured-tools', 'responses-api'],
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    if (!this.instance.enabled || !this.apiKey()) {
      return {
        status: 'not configured',
        instanceId: this.instanceId,
        usageClass: this.usageClass,
        location: 'Remote',
      };
    }

    const startedAt = Date.now();
    try {
      await this.fetchOpenAI(`${OPENAI_MODEL_ENDPOINT}/${encodeURIComponent(SOL_MODEL)}`, { method: 'GET' });
      return {
        status: 'connected',
        instanceId: this.instanceId,
        usageClass: this.usageClass,
        location: 'Remote',
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: error instanceof OpenAIProviderError && error.code === 'rate-limit' ? 'rate limited' : 'unavailable',
        instanceId: this.instanceId,
        usageClass: this.usageClass,
        location: 'Remote',
        latencyMs: Date.now() - startedAt,
        error: error instanceof OpenAIProviderError ? error.code : 'UnknownError',
      };
    }
  }

  async getUsage(): Promise<Record<string, number>> {
    return { requestCount: this.requestCount };
  }
}

/** Build a complete Responses request from provider-neutral history. */
export function buildOpenAIResponsesBody(input: ModelChatRequest): Record<string, unknown> {
  return buildOpenAIResponsesRequest(input).body;
}

interface OpenAIResponsesRequest {
  body: Record<string, unknown>;
  internalToolNames: ReadonlyMap<string, string>;
}

function buildOpenAIResponsesRequest(input: ModelChatRequest): OpenAIResponsesRequest {
  const providerToolNames = new Map<string, string>();
  const internalToolNames = new Map<string, string>();

  for (const [index, tool] of (input.tools ?? []).entries()) {
    const providerName = providerToolName(tool.name, index);
    providerToolNames.set(tool.name, providerName);
    internalToolNames.set(providerName, tool.name);
  }

  const body: Record<string, unknown> = {
    model: input.model,
    input: toResponsesInput(input.messages, providerToolNames),
  };

  if (input.systemPrompt) body.instructions = input.systemPrompt;
  if (input.maxTokens !== undefined) body.max_output_tokens = input.maxTokens;
  if (input.temperature !== undefined && input.model !== SOL_MODEL) {
    body.temperature = input.temperature;
  }
  if (input.tools?.length) {
    body.tools = input.tools.map(
      (tool) => toOpenAIFunctionTool(tool, providerToolNames.get(tool.name) ?? tool.name),
    );
  }
  return { body, internalToolNames };
}

function providerToolName(internalName: string, index: number): string {
  const readable = internalName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const prefix = `dacai_${index + 1}_`;
  return `${prefix}${readable}`.slice(0, 64);
}

function toResponsesInput(
  messages: ChatMessage[],
  providerToolNames: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  const knownCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      // The Responses API requires a reasoning item emitted before a function
      // call to be replayed before that call in the next request. Only replay
      // opaque reasoning items captured from an OpenAI response; never turn
      // generic runtime data into a provider-native item.
      for (const item of message.providerContinuationItems ?? []) {
        if (item.type === 'reasoning') input.push({ ...item });
      }
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.toolCalls ?? []) {
        const callId = call.providerCallId ?? call.id;

        // Internal executor-generated calls may not have provider correlation.
        // OpenAI-originated function calls always provide providerCallId.
        if (!callId) {
          continue;
        }

        knownCallIds.add(callId);
        input.push({
          type: 'function_call',
          ...(call.providerCallId && call.id !== call.providerCallId ? { id: call.id } : {}),
          call_id: callId,
          name: providerToolNames.get(call.name) ?? call.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }

    if (message.role === 'tool') {
      if (message.toolCallId && knownCallIds.has(message.toolCallId)) {
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: message.content,
        });
      } else {
        // Compaction can leave an observation without its originating call.
        // Preserve it as evidence rather than manufacturing an invalid call pair.
        input.push({
          role: 'user',
          content: `${message.toolName ? `Tool ${message.toolName}` : 'Tool'} output:\n${message.content}`,
        });
      }
      continue;
    }

    input.push({ role: message.role, content: message.content });
  }

  return input;
}

function toOpenAIFunctionTool(tool: ToolSchema, providerName: string): Record<string, unknown> {
  const strictParameters = strictCompatibleSchema(tool.inputSchema);
  return {
    type: 'function',
    name: providerName,
    description: tool.description,
    parameters: strictParameters ?? tool.inputSchema,
    strict: Boolean(strictParameters),
  };
}

/** Use strict mode only when closing the schema does not make optional fields required. */
function strictCompatibleSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  const visit = (value: unknown): unknown | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...record };

    if (record.type === 'object' || record.properties) {
      const properties = record.properties;
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
      const names = Object.keys(properties as Record<string, unknown>);
      const required = Array.isArray(record.required)
        ? record.required.filter((item): item is string => typeof item === 'string')
        : [];
      if (names.some((name) => !required.includes(name))) return undefined;
      if (record.additionalProperties !== undefined && record.additionalProperties !== false) return undefined;

      const strictProperties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
        const visited = visit(property);
        if (visited === undefined) return undefined;
        strictProperties[name] = visited;
      }
      copy.properties = strictProperties;
      copy.required = names;
      copy.additionalProperties = false;
    }

    if (record.items !== undefined) {
      const items = visit(record.items);
      if (items === undefined) return undefined;
      copy.items = items;
    }

    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (record[keyword] === undefined) continue;
      if (!Array.isArray(record[keyword])) return undefined;
      const variants = (record[keyword] as unknown[]).map(visit);
      if (variants.some((variant) => variant === undefined)) return undefined;
      copy[keyword] = variants;
    }
    return copy;
  };

  const result = visit(schema);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

export function normalizeOpenAIResponse(
  payload: OpenAIResponsePayload,
  instanceId: string,
  requestedModel: string,
  internalToolNames?: ReadonlyMap<string, string>,
): Omit<ModelChatResponse, 'usageClass' | 'durationMs'> {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.output)) {
    throw new OpenAIProviderError(
      'OpenAI Responses output is malformed: expected an output array.',
      instanceId,
      'malformed-response',
    );
  }
  if (payload.error || payload.status === 'failed') {
    throw new OpenAIProviderError(
      'OpenAI Responses API reported a failed response.',
      instanceId,
      'http',
    );
  }

  const text: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  const providerContinuationItems: Array<Record<string, unknown>> = [];

  for (const rawItem of payload.output) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;

    if (item.type === 'reasoning') {
      // Preserve the original item verbatim enough for the next Responses API
      // continuation. In particular, do not synthesize ids or encrypted state.
      providerContinuationItems.push({ ...item });
      continue;
    }

    if (item.type === 'message') {
      if (!Array.isArray(item.content)) {
        throw new OpenAIProviderError(
          'OpenAI Responses message output is malformed.',
          instanceId,
          'malformed-response',
        );
      }
      for (const rawPart of item.content) {
        if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
        if (part.type === 'refusal' && typeof part.refusal === 'string') text.push(part.refusal);
      }
      continue;
    }

    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.arguments !== 'string'
      ) {
        throw new OpenAIProviderError(
          'OpenAI Responses function call is missing call_id, name, or arguments.',
          instanceId,
          'malformed-response',
        );
      }

      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch (cause) {
        throw new OpenAIProviderError(
          `OpenAI Responses function call "${item.name}" has malformed JSON arguments.`,
          instanceId,
          'malformed-response',
          { cause },
        );
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new OpenAIProviderError(
          `OpenAI Responses function call "${item.name}" arguments are not an object.`,
          instanceId,
          'malformed-response',
        );
      }

      const providerCallId = item.call_id;
      const normalizedId = typeof item.id === 'string' && item.id ? item.id : providerCallId;
      const normalizedName = internalToolNames?.get(item.name) ?? item.name;
      toolCalls.push({
        id: normalizedId,
        name: normalizedName,
        arguments: args as Record<string, unknown>,
        ...(normalizedId !== providerCallId ? { providerCallId } : {}),
      });
    }
  }

  const content = text.join('') || (typeof payload.output_text === 'string' ? payload.output_text : '');
  if (!content && toolCalls.length === 0) {
    throw new OpenAIProviderError(
      'OpenAI Responses output contained neither text nor a valid function call.',
      instanceId,
      'malformed-response',
    );
  }

  return {
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    providerContinuationItems: providerContinuationItems.length ? providerContinuationItems : undefined,
    toolCallChannel: toolCalls.length ? 'structured' : undefined,
    model: typeof payload.model === 'string' && payload.model ? payload.model : requestedModel,
    providerInstanceId: instanceId,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      ...(payload.usage?.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {}),
    },
  };
}
