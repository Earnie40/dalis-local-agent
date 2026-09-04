import type { ProviderInstance, ProviderKind, UsageClass } from '@dacai-local-agent/shared';
import type {
  CapabilityStatus,
  ChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelDescriptor,
  ModelProvider,
  NormalizedToolCall,
  ProviderHealth,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

export type AnthropicProviderErrorCode =
  | 'missing-api-key'
  | 'authentication'
  | 'access-denied'
  | 'rate-limit'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'http'
  | 'malformed-response';

export class AnthropicProviderError extends Error {
  constructor(
    message: string,
    readonly instanceId: string,
    readonly code: AnthropicProviderErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AnthropicProviderError';
  }
}

interface AnthropicErrorPayload {
  error?: { type?: unknown; message?: unknown } | null;
}

interface AnthropicErrorDetails {
  type?: string;
  message?: string;
}

interface AnthropicResponsePayload {
  type?: unknown;
  model?: unknown;
  content?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  error?: AnthropicErrorPayload['error'];
}

type AnthropicContentBlock = Record<string, unknown>;

interface AnthropicInputMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, 2_000) : undefined;
}

async function readAnthropicError(response: Response): Promise<AnthropicErrorDetails> {
  try {
    const payload = (await response.json()) as AnthropicErrorPayload;
    return { type: safeString(payload.error?.type), message: safeString(payload.error?.message) };
  } catch {
    return {};
  }
}

function anthropicErrorSummary(status: number, details: AnthropicErrorDetails): string {
  const type = details.type ? ` (type=${details.type})` : '';
  const message = details.message ? ` ${details.message}` : '';
  return `Anthropic Messages API returned HTTP ${status}${type}.${message}`;
}

function appendAnthropicMessage(
  messages: AnthropicInputMessage[],
  role: AnthropicInputMessage['role'],
  content: AnthropicContentBlock[],
): void {
  if (!content.length) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === role) {
    previous.content.push(...content);
    return;
  }
  messages.push({ role, content });
}

function textBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text };
}

/** Converts normalized history into Anthropic Messages API messages. */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicInputMessage[] {
  const result: AnthropicInputMessage[] = [];
  const knownToolUseIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (message.content) content.push(textBlock(message.content));
      for (const call of message.toolCalls ?? []) {
        const toolUseId = call.providerCallId ?? call.id;
        if (!toolUseId) continue;
        knownToolUseIds.add(toolUseId);
        content.push({ type: 'tool_use', id: toolUseId, name: call.name, input: call.arguments });
      }
      appendAnthropicMessage(result, 'assistant', content);
      continue;
    }

    if (message.role === 'tool') {
      if (message.toolCallId && knownToolUseIds.has(message.toolCallId)) {
        appendAnthropicMessage(result, 'user', [
          { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
        ]);
      } else {
        appendAnthropicMessage(result, 'user', [
          textBlock(`${message.toolName ? `Tool ${message.toolName}` : 'Tool'} output:\n${message.content}`),
        ]);
      }
      continue;
    }

    // System messages belong in ModelChatRequest.systemPrompt. Preserve a
    // historical one as user context rather than emitting an invalid API role.
    appendAnthropicMessage(result, 'user', [textBlock(message.content)]);
  }

  return result;
}

export function buildAnthropicMessagesBody(input: ModelChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens ?? 4_096,
    messages: toAnthropicMessages(input.messages),
  };
  if (input.systemPrompt?.trim()) body.system = input.systemPrompt;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.tools?.length) body.tools = input.tools.map((tool) => toAnthropicTool(tool));
  return body;
}

function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

/** Normalizes the public Messages API payload into the provider-neutral shape. */
export function normalizeAnthropicResponse(
  payload: AnthropicResponsePayload,
  instanceId: string,
  requestedModel: string,
): Omit<ModelChatResponse, 'usageClass' | 'durationMs'> {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.content)) {
    throw new AnthropicProviderError(
      'Anthropic Messages output is malformed: expected a content array.',
      instanceId,
      'malformed-response',
    );
  }
  if (payload.type === 'error' || payload.error) {
    throw new AnthropicProviderError('Anthropic Messages API reported a failed response.', instanceId, 'http');
  }

  const text: string[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  for (const rawBlock of payload.content) {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
      continue;
    }
    if (block.type !== 'tool_use') continue;
    if (
      typeof block.id !== 'string' || !block.id ||
      typeof block.name !== 'string' || !block.name ||
      !block.input || typeof block.input !== 'object' || Array.isArray(block.input)
    ) {
      throw new AnthropicProviderError(
        'Anthropic Messages tool_use is missing id, name, or object input.',
        instanceId,
        'malformed-response',
      );
    }
    toolCalls.push({ id: block.id, name: block.name, arguments: block.input as Record<string, unknown> });
  }

  const content = text.join('');
  if (!content && toolCalls.length === 0) {
    throw new AnthropicProviderError(
      'Anthropic Messages output contained neither text nor a valid tool_use block.',
      instanceId,
      'malformed-response',
    );
  }

  return {
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolCallChannel: toolCalls.length ? 'structured' : undefined,
    model: typeof payload.model === 'string' && payload.model ? payload.model : requestedModel,
    providerInstanceId: instanceId,
    usage: {
      inputTokens: typeof payload.usage?.input_tokens === 'number' ? payload.usage.input_tokens : 0,
      outputTokens: typeof payload.usage?.output_tokens === 'number' ? payload.usage.output_tokens : 0,
    },
  };
}

/** Stateless Anthropic Messages API adapter for configured Claude instances. */
export class AnthropicProvider implements ModelProvider {
  readonly instanceId: string;
  readonly kind: ProviderKind = 'anthropic';
  readonly usageClass: UsageClass;
  private readonly baseUrl: string;
  private requestCount = 0;

  constructor(private readonly instance: ProviderInstance) {
    this.instanceId = instance.id;
    this.usageClass = instance.usageClass;
    this.baseUrl = (instance.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  }

  /** Read the named environment variable at call time; never persist its value. */
  protected apiKey(): string | undefined {
    return this.instance.authTokenEnvVar ? process.env[this.instance.authTokenEnvVar] : undefined;
  }

  private async fetchAnthropic(init: RequestInit, callerSignal?: AbortSignal): Promise<Response> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      throw new AnthropicProviderError(
        `Anthropic provider "${this.instanceId}" is not configured: ${this.instance.authTokenEnvVar ?? 'ANTHROPIC_API_KEY'} is not set.`,
        this.instanceId,
        'missing-api-key',
      );
    }

    const timeout = AbortSignal.timeout(this.instance.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await globalThis.fetch(`${this.baseUrl}/messages`, {
        ...init,
        signal,
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'x-api-key': apiKey,
          ...(init.headers ?? {}),
        },
      });
    } catch (cause) {
      if (callerSignal?.aborted) {
        throw new AnthropicProviderError('Anthropic Messages request was cancelled.', this.instanceId, 'cancelled', { cause });
      }
      if (timeout.aborted) {
        throw new AnthropicProviderError(
          `Anthropic Messages request timed out after ${this.instance.requestTimeoutMs}ms.`,
          this.instanceId,
          'timeout',
          { cause },
        );
      }
      throw new AnthropicProviderError(
        'Anthropic Messages API is unreachable. Check network connectivity and outbound HTTPS access.',
        this.instanceId,
        'network',
        { cause },
      );
    }

    if (response.ok) return response;
    const details = await readAnthropicError(response);
    if (response.status === 401) {
      throw new AnthropicProviderError(
        `${anthropicErrorSummary(response.status, details)} Check ${this.instance.authTokenEnvVar ?? 'ANTHROPIC_API_KEY'}.`,
        this.instanceId,
        'authentication',
      );
    }
    if (response.status === 403) {
      throw new AnthropicProviderError(
        `${anthropicErrorSummary(response.status, details)} Confirm this key can use the configured Claude model.`,
        this.instanceId,
        'access-denied',
      );
    }
    if (response.status === 429) {
      throw new AnthropicProviderError(
        `${anthropicErrorSummary(response.status, details)} Retry after the provider backoff period.`,
        this.instanceId,
        'rate-limit',
      );
    }
    throw new AnthropicProviderError(anthropicErrorSummary(response.status, details), this.instanceId, 'http');
  }

  async chat(input: ModelChatRequest): Promise<ModelChatResponse> {
    const startedAt = Date.now();
    this.requestCount += 1;
    const response = await this.fetchAnthropic(
      { method: 'POST', body: JSON.stringify(buildAnthropicMessagesBody(input)) },
      input.signal,
    );

    let payload: AnthropicResponsePayload;
    try {
      payload = (await response.json()) as AnthropicResponsePayload;
    } catch (cause) {
      throw new AnthropicProviderError(
        'Anthropic Messages API returned malformed JSON.',
        this.instanceId,
        'malformed-response',
        { cause },
      );
    }

    return {
      ...normalizeAnthropicResponse(payload, this.instanceId, input.model),
      usageClass: this.usageClass,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Tool support is declared until the standard capability probe verifies this model. */
  supportsTools(): CapabilityStatus {
    return 'declared';
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const configuredModel = process.env.ANTHROPIC_MODEL?.trim();
    return configuredModel
      ? [{ name: configuredModel, providerInstanceId: this.instanceId, declaredCapabilities: ['completion', 'tools', 'messages-api'] }]
      : [];
  }

  /**
   * Anthropic has no unauthenticated health endpoint, but an authenticated
   * `GET /v1/models` is cheap, does not consume a completion, and proves the
   * key actually works rather than just being present.
   */
  async health(): Promise<ProviderHealth> {
    const apiKey = this.apiKey();
    if (!this.instance.enabled || !apiKey) {
      return {
        status: 'not configured',
        instanceId: this.instanceId,
        usageClass: this.usageClass,
        location: 'Remote',
      };
    }

    const startedAt = Date.now();
    try {
      const response = await globalThis.fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.instance.requestTimeoutMs, 10_000)),
        headers: { 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': apiKey },
      });
      if (!response.ok) {
        const details = await readAnthropicError(response);
        return {
          status: response.status === 429 ? 'rate limited' : 'unavailable',
          instanceId: this.instanceId,
          usageClass: this.usageClass,
          location: 'Remote',
          latencyMs: Date.now() - startedAt,
          error: anthropicErrorSummary(response.status, details),
        };
      }
      return {
        status: 'connected',
        instanceId: this.instanceId,
        usageClass: this.usageClass,
        location: 'Remote',
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        instanceId: this.instanceId,
        usageClass: this.usageClass,
        location: 'Remote',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'UnknownError',
      };
    }
  }

  async getUsage(): Promise<Record<string, number>> {
    return { requestCount: this.requestCount };
  }
}
