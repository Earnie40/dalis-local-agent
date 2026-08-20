import type {
  AgentRole,
  ProviderKind,
  UsageClass,
} from '@dacai-local-agent/shared';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_for_approval';

export interface CompletionMessage {
  role: 'assistant' | 'user' | 'tool';
  content: string;
  toolName?: string;

  /** Structured requests made by this assistant turn, retained for replay. */
  toolCalls?: NormalizedToolCall[];

  /** Provider-neutral correlation id of the tool request this result answers. */
  toolCallId?: string;

  /**
   * Opaque provider output items required to continue a prior assistant turn.
   *
   * Some providers require an item they emitted (for example, a Responses API
   * reasoning item) to be replayed immediately before its dependent tool call.
   * The runtime only carries values supplied by a provider; adapters decide
   * which item types, if any, are safe and valid to replay.
   */
  providerContinuationItems?: Array<Record<string, unknown>>;
}

export interface AgentTask {
  id: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  prompt: string;
  context: string[];

  /**
   * Whether the runtime may move this task to a stronger or more expensive
   * configured model when the normal route cannot complete it.
   *
   * The core remains provider-neutral: escalation policy decides the physical
   * provider/model elsewhere.
   */
  allowModelEscalation: boolean;

  status: AgentRunStatus;
  createdAt: string;
}

export interface ToolCallResult {
  toolName: string;
  success: boolean;
  output: unknown;
  error?: string;
}

/**
 * Provider-neutral tool call.
 *
 * Provider-specific formats such as structured tool-call blocks are normalized
 * into this shape before they reach the agent loop.
 */
export interface NormalizedToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;

  /**
   * Provider correlation id when it differs from the normalized call id.
   * For example, OpenAI Responses returns both an output-item `id` and a
   * `call_id`; function_call_output must use the latter on the next request.
   */
  providerCallId?: string;
}

/**
 * Confidence level for a provider/model capability.
 *
 * declared
 *   Provider metadata claims the capability exists. This is only a hint.
 *
 * verified
 *   A live capability probe exercised the feature successfully.
 *
 * unsupported
 *   Metadata or a probe establishes that the capability is unavailable.
 *
 * unknown
 *   No reliable capability information is currently available.
 */
export type CapabilityStatus =
  | 'verified'
  | 'declared'
  | 'unsupported'
  | 'unknown';

/**
 * How a provider/model delivered a tool call.
 *
 * structured
 *   Provider-native tool-call field.
 *
 * text-json
 *   A deterministically parsed tool-call object emitted in assistant text.
 *   This is tracked separately so it is never silently treated as equivalent to
 *   a native structured channel.
 */
export type ToolCallChannel =
  | 'structured'
  | 'text-json';

export interface ProviderCapabilities {
  toolCalling: CapabilityStatus;
  streaming: CapabilityStatus;

  /**
   * Set when tool calling has been successfully verified.
   */
  toolCallChannel?: ToolCallChannel;

  contextWindow?: number;
  maxOutputTokens?: number;

  probedAt?: string;
  probeVersion?: number;

  /**
   * Sanitized probe error classification/message only.
   * Credentials or raw provider payloads should never be persisted here.
   */
  lastProbeError?: string;

  /**
   * Model/provider identity. A mutable model tag alone is not stable identity,
   * so a cached probe result is rejected when the digest no longer matches.
   */
  modelDigest?: string;
  providerVersion?: string;

  /**
   * Extended capability surface persisted by PostgresCapabilityStore.
   *
   * All optional and undefined until a probe actually establishes them —
   * probeCapabilities() currently verifies only toolCalling/streaming, so the
   * rest stay absent rather than defaulting to a value that would claim an
   * unverified capability.
   */
  parallelToolCalls?: CapabilityStatus;
  streamingToolCalls?: CapabilityStatus;
  toolChoice?: CapabilityStatus;
  requiredToolChoice?: CapabilityStatus;

  structuredOutput?: CapabilityStatus;
  jsonMode?: CapabilityStatus;
  jsonSchema?: CapabilityStatus;
  strictJsonSchema?: CapabilityStatus;

  systemPrompt?: CapabilityStatus;
  multiTurn?: CapabilityStatus;
  stopSequences?: CapabilityStatus;

  reasoning?: CapabilityStatus;
  configurableThinking?: CapabilityStatus;

  textInput?: CapabilityStatus;
  imageInput?: CapabilityStatus;
  audioInput?: CapabilityStatus;
  fileInput?: CapabilityStatus;

  textOutput?: CapabilityStatus;
  imageOutput?: CapabilityStatus;
  audioOutput?: CapabilityStatus;

  maxTools?: number;
  maxToolArgumentBytes?: number;

  toolCallReliability?: number;
  structuredOutputReliability?: number;
  averageLatencyMs?: number;
}

export const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
  toolCalling: 'unknown',
  streaming: 'unknown',
};

/**
 * Only models with verified tool calling may enter the tool-driven agent loop.
 *
 * Declared capability is not sufficient because metadata is advisory rather
 * than proof that the provider/model combination actually produces usable tool
 * calls.
 */
export function isAgentLoopCapable(
  capabilities: ProviderCapabilities,
): boolean {
  return capabilities.toolCalling === 'verified';
}

/**
 * Physical model identity as reported by the provider.
 *
 * Configuration aliases are intentionally separate from this descriptor.
 */
export interface ModelDescriptor {
  /**
   * Provider-reported model tag/name.
   *
   * Example:
   *   qwen2.5-coder:latest
   */
  name: string;

  providerInstanceId: string;

  /**
   * Weight or manifest digest where available.
   *
   * A mutable model tag alone is not a stable identity.
   */
  digest?: string;

  /**
   * Non-empty when this model/tag is layered on another physical model.
   */
  parentModel?: string;

  family?: string;
  parameterSize?: string;
  quantization?: string;
  sizeBytes?: number;

  /**
   * Provider-declared capability strings.
   *
   * These are informational and do not by themselves grant runtime capability.
   */
  declaredCapabilities: string[];

  modifiedAt?: string;
}

export type ProviderHealthStatus =
  | 'connected'
  | 'not configured'
  | 'unavailable'
  | 'rate limited';

export type ProviderLocation =
  | 'Local'
  | 'Remote';

export interface ProviderHealth {
  status: ProviderHealthStatus;

  instanceId: string;
  usageClass: UsageClass;
  location: ProviderLocation;

  version?: string;
  latencyMs?: number;

  /**
   * Sanitized error classification only.
   *
   * Never include credentials, authorization headers, raw provider responses,
   * or other sensitive material.
   */
  error?: string;
}

/**
 * Normalized token accounting used by the runtime.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;

  /**
   * Optional provider-specific counters may be retained without changing the
   * common accounting fields above.
   */
  [key: string]: number;
}

export interface ModelProvider {
  /**
   * Configured provider instance id.
   *
   * Examples:
   *   local_ollama
   *   anthropic_primary
   *   remote_gpu_01
   *
   * This identifies a configured provider instance, not merely a wire
   * protocol/provider family.
   */
  readonly instanceId: string;

  readonly kind: ProviderKind;

  readonly usageClass: UsageClass;

  chat(
    input: ModelChatRequest,
  ): Promise<ModelChatResponse>;

  stream?(
    input: ModelChatRequest,
  ): AsyncIterable<ModelStreamEvent>;

  /**
   * Reports capability confidence rather than a bare boolean.
   */
  supportsTools(
    model?: string,
  ): CapabilityStatus;

  listModels(): Promise<ModelDescriptor[]>;

  health(): Promise<ProviderHealth>;

  getUsage(): Promise<Record<string, number>>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatMessage {
  role:
    | 'user'
    | 'assistant'
    | 'system'
    | 'tool';

  content: string;

  toolName?: string;

  /** Structured requests made by this assistant turn, retained for replay. */
  toolCalls?: NormalizedToolCall[];

  /** Provider-neutral correlation id of the tool request this result answers. */
  toolCallId?: string;

  /** Opaque provider output items retained for a valid provider continuation. */
  providerContinuationItems?: Array<Record<string, unknown>>;
}

export interface ModelChatRequest {
  systemPrompt?: string;

  messages: ChatMessage[];

  tools?: ToolSchema[];

  model: string;

  temperature?: number;

  maxTokens?: number;
  /** Requested provider context window; providers may clamp to model limits. */
  contextWindowTokens?: number;

  /**
   * Some reasoning-capable models perform an internal reasoning pass.
   *
   * false asks compatible providers/models to disable that pass when supported.
   * Provider adapters remain responsible for translating this option into their
   * own wire format.
   */
  think?: boolean;

  /**
   * Cancels the provider request itself where the adapter supports AbortSignal.
   */
  signal?: AbortSignal;
}

export interface ModelStreamEvent {
  /**
   * thinking intentionally carries no hidden-reasoning content.
   *
   * The event only communicates that the provider is still actively processing
   * the request.
   */
  type:
    | 'chunk'
    | 'tool_call'
    | 'thinking'
    | 'done'
    | 'error';

  content?: string;

  toolCall?: NormalizedToolCall;

  usage?: Partial<ModelUsage>;

  error?: string;
}

export interface ModelChatResponse {
  content: string;

  toolCalls?: NormalizedToolCall[];

  /** Opaque provider output items retained for a valid provider continuation. */
  providerContinuationItems?: Array<Record<string, unknown>>;

  usage?: Partial<ModelUsage>;

  /**
   * Physical model reported by the provider for this response.
   */
  model: string;

  providerInstanceId: string;

  usageClass: UsageClass;

  /**
   * Weight/manifest digest where the provider exposes one.
   */
  modelDigest?: string;

  durationMs?: number;

  /**
   * Present when tool calls were recovered from assistant text rather than a
   * provider-native structured tool-call field.
   */
  toolCallChannel?: ToolCallChannel;
}

/**
 * Runtime binding for an agent role.
 *
 * Long term, this should normally point at a semantic model alias rather than
 * permanently coupling a role to one physical model.
 */
export interface AgentRuntimeConfig {
  id: string;

  role: AgentRole;

  providerInstanceId: string;
}
