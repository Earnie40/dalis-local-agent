import type { ProviderInstance, ProviderKind, UsageClass } from '@dacai-local-agent/shared';
import type {
  CapabilityStatus,
  ModelChatRequest,
  ModelChatResponse,
  ModelDescriptor,
  ModelProvider,
  ModelStreamEvent,
  ProviderHealth,
} from '@dacai-local-agent/agent-core';

interface ChatCompletionPayload {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: string | { message?: string };
}

/** Hugging Face Inference API adapter for advisory/chat workloads. */
export class HuggingFaceProvider implements ModelProvider {
  readonly instanceId: string;
  readonly kind: ProviderKind = 'huggingface';
  readonly usageClass: UsageClass;
  private requestCount = 0;

  constructor(private readonly instance: ProviderInstance, private readonly configuredModel?: string) {
    this.instanceId = instance.id;
    this.usageClass = instance.usageClass;
  }

  private model(inputModel?: string): string {
    const model = inputModel || this.configuredModel;
    if (!model) throw new Error('HF_DEFAULT_MODEL is not configured.');
    return model;
  }

  private base(): string {
    return (this.instance.baseUrl || 'https://router.huggingface.co/v1').replace(/\/+$/, '');
  }

  private endpoint(): string {
    return `${this.base()}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const token = this.instance.authTokenEnvVar ? process.env[this.instance.authTokenEnvVar] : undefined;
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async chat(input: ModelChatRequest): Promise<ModelChatResponse> {
    const model = this.model(input.model);
    this.requestCount += 1;
    const response = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: input.messages,
        max_tokens: input.maxTokens ?? 1024,
        temperature: input.temperature ?? 0.2,
        stream: false,
      }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const payload = (await response.json()) as ChatCompletionPayload;
    if (payload.error) throw new Error(`Hugging Face error: ${typeof payload.error === 'string' ? payload.error : payload.error.message ?? 'unknown error'}`);
    return {
      content: payload.choices?.[0]?.message?.content ?? '',
      model,
      providerInstanceId: this.instanceId,
      usageClass: this.usageClass,
      usage: { inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0 },
    };
  }

  async *stream(input: ModelChatRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.chat(input);
    if (response.content) yield { type: 'chunk', content: response.content };
    yield { type: 'done', usage: response.usage };
  }

  supportsTools(): CapabilityStatus { return 'unsupported'; }

  async listModels(): Promise<ModelDescriptor[]> {
    const model = this.model();
    return [{ name: model, providerInstanceId: this.instanceId, declaredCapabilities: ['completion'] }];
  }

  /** Real bounded probe against the router's model-listing endpoint — never asserts "connected" from config alone. */
  async health(): Promise<ProviderHealth> {
    const model = this.configuredModel;
    const token = this.instance.authTokenEnvVar ? process.env[this.instance.authTokenEnvVar] : undefined;
    if (!this.instance.enabled || !token || !model) return { status: 'not configured', instanceId: this.instanceId, usageClass: this.usageClass, location: 'Remote' };

    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.base()}/models`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(8_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (response.ok) return { status: 'connected', instanceId: this.instanceId, usageClass: this.usageClass, location: 'Remote', latencyMs };
      if (response.status === 401 || response.status === 403) {
        return { status: 'unavailable', instanceId: this.instanceId, usageClass: this.usageClass, location: 'Remote', latencyMs, error: `HTTP ${response.status}: auth token rejected` };
      }
      return { status: 'unavailable', instanceId: this.instanceId, usageClass: this.usageClass, location: 'Remote', latencyMs, error: `HTTP ${response.status}` };
    } catch (error) {
      return { status: 'unavailable', instanceId: this.instanceId, usageClass: this.usageClass, location: 'Remote', error: error instanceof Error ? error.name : 'UnknownError' };
    }
  }

  async getUsage(): Promise<Record<string, number>> { return { requestCount: this.requestCount }; }
}
