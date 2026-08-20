import type {
  ProviderInstance,
  ProviderKind,
  UsageClass,
} from '@dacai-local-agent/shared';

import nodeFetch, {
  type RequestInit as NodeFetchRequestInit,
} from 'node-fetch';

import { SocksProxyAgent } from 'socks-proxy-agent';

import type {
  CapabilityStatus,
  ModelChatRequest,
  ModelChatResponse,
  ModelDescriptor,
  ModelProvider,
  ModelStreamEvent,
  NormalizedToolCall,
  ProviderHealth,
  ToolSchema,
} from '@dacai-local-agent/agent-core';

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaMessage {
  role: string;
  content?: string;

  /**
   * Some reasoning-capable Ollama models expose their internal reasoning pass
   * separately.
   *
   * Hidden reasoning is deliberately never surfaced as assistant content or
   * persisted. Streaming only emits a `thinking` activity marker.
   */
  thinking?: string;

  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done?: boolean;
  model?: string;

  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;

  error?: string;
}

interface OllamaTagEntry {
  name: string;
  model?: string;
  digest?: string;
  size?: number;
  modified_at?: string;

  details?: {
    parent_model?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

/**
 * /api/show response.
 *
 * Ollama exposes declared capabilities and model-family information here.
 * Declared capabilities remain advisory until independently verified by the
 * runtime capability probe.
 */
interface OllamaShowResponse {
  capabilities?: string[];
  details?: OllamaTagEntry['details'];
  model_info?: Record<string, unknown>;
}

/**
 * Iterates either WHATWG ReadableStream bodies or async-iterable bodies.
 *
 * This keeps the provider compatible with both native fetch and node-fetch
 * response implementations.
 */
async function* responseChunks(
  body: Response['body'],
): AsyncIterable<Uint8Array> {
  if (!body) {
    return;
  }

  const candidate =
    body as unknown as {
      getReader?: () => ReadableStreamDefaultReader<Uint8Array>;

      [Symbol.asyncIterator]?:
        () => AsyncIterator<
          Uint8Array | string
        >;
    };

  if (candidate.getReader) {
    const reader =
      candidate.getReader();

    try {
      for (;;) {
        const {
          done,
          value,
        } = await reader.read();

        if (done) {
          return;
        }

        if (value) {
          yield value;
        }
      }
    } finally {
      await reader
        .cancel()
        .catch(
          () => undefined,
        );
    }
  }

  if (
    candidate[
      Symbol.asyncIterator
    ]
  ) {
    for await (
      const chunk of
      candidate as AsyncIterable<
        Uint8Array | string
      >
    ) {
      yield typeof chunk ===
      'string'
        ? new TextEncoder().encode(
            chunk,
          )
        : chunk;
    }
  }
}

export class OllamaProviderError extends Error {
  constructor(
    message: string,

    readonly instanceId: string,

    options?: {
      cause?: unknown;
    },
  ) {
    super(
      message,
      options,
    );

    this.name =
      'OllamaProviderError';
  }
}

/**
 * One provider implementation can back many Ollama-compatible instances.
 *
 * For example:
 *
 *   local CPU Ollama
 *   local GPU Ollama
 *   remote GPU VM
 *   SOCKS-routed private Ollama service
 *
 * The wire protocol remains the same; ProviderInstance supplies the physical
 * routing and usage metadata.
 */
export class OllamaProvider
  implements ModelProvider
{
  readonly instanceId: string;

  readonly kind: ProviderKind =
    'ollama';

  readonly usageClass: UsageClass;

  private readonly baseUrl: string;

  private readonly requestTimeoutMs: number;

  private readonly proxyAgent?:
    SocksProxyAgent;

  /**
   * Provider-declared capabilities by model tag.
   */
  private readonly declared =
    new Map<
      string,
      string[]
    >();

  /**
   * Weight/manifest digests learned from /api/tags.
   *
   * This lets chat responses carry a stronger model identity than a mutable tag
   * alone whenever inventory has already been loaded.
   */
  private readonly modelDigests =
    new Map<
      string,
      string
    >();

  private requestCount = 0;

  constructor(
    private readonly instance:
      ProviderInstance,
  ) {
    if (
      !instance.baseUrl
    ) {
      throw new OllamaProviderError(
        `Ollama instance "${instance.id}" has no baseUrl.`,
        instance.id,
      );
    }

    this.instanceId =
      instance.id;

    this.usageClass =
      instance.usageClass;

    this.baseUrl =
      instance.baseUrl.replace(
        /\/+$/,
        '',
      );

    this.requestTimeoutMs =
      instance.requestTimeoutMs;

    if (
      instance.proxyRequired &&
      !instance.proxyUrl
    ) {
      throw new OllamaProviderError(
        `Ollama instance "${instance.id}" requires SOCKS5 routing, but no proxyUrl is configured.`,
        instance.id,
      );
    }

    if (
      instance.proxyUrl
    ) {
      this.proxyAgent =
        new SocksProxyAgent(
          instance.proxyUrl,
        );
    }
  }

  /**
   * Resolve credentials at request time.
   *
   * The token itself therefore does not need to live in provider configuration.
   */
  private authHeaders():
    Record<
      string,
      string
    > {
    const token =
      this.instance.authTokenEnvVar
        ? process.env[
            this.instance
              .authTokenEnvVar
          ]
        : undefined;

    return token
      ? {
          Authorization:
            `Bearer ${token}`,
        }
      : {};
  }

  /**
   * Perform one Ollama HTTP request with:
   *
   * - provider timeout
   * - caller cancellation
   * - optional SOCKS routing
   * - request-time auth lookup
   *
   * Timeout, cancellation, and connectivity failures are reported separately.
   */
  private async request(
    path: string,

    init:
      RequestInit & {
        signal?: AbortSignal;
      } = {},
  ): Promise<Response> {
    const timeout =
      AbortSignal.timeout(
        this.requestTimeoutMs,
      );

    const signal =
      init.signal
        ? AbortSignal.any([
            init.signal,
            timeout,
          ])
        : timeout;

    let response:
      Response;

    try {
      const requestInit = {
        ...init,

        signal,

        headers: {
          'Content-Type':
            'application/json',

          ...this.authHeaders(),

          ...(init.headers ??
            {}),
        },
      };

      response =
        this.proxyAgent
          ? ((await nodeFetch(
              `${this.baseUrl}${path}`,
              {
                ...requestInit,

                agent:
                  this.proxyAgent,
              } as NodeFetchRequestInit,
            )) as unknown as Response)
          : await globalThis.fetch(
              `${this.baseUrl}${path}`,
              requestInit,
            );
    } catch (error) {
      if (
        timeout.aborted &&
        !init.signal?.aborted
      ) {
        throw new OllamaProviderError(
          `Ollama instance "${this.instanceId}" did not respond within ` +
            `${this.requestTimeoutMs}ms for ${path}. ` +
            'The provider may still be reachable but the model or request is taking too long.',
          this.instanceId,
          {
            cause:
              error,
          },
        );
      }

      if (
        init.signal?.aborted
      ) {
        throw new OllamaProviderError(
          `Ollama request to instance "${this.instanceId}" was cancelled.`,
          this.instanceId,
          {
            cause:
              error,
          },
        );
      }

      throw new OllamaProviderError(
        `Ollama instance "${this.instanceId}" is unreachable at ` +
          `${this.baseUrl} (${path}). Confirm the service and route are available.`,
        this.instanceId,
        {
          cause:
            error,
        },
      );
    }

    if (!response.ok) {
      /**
       * Deliberately avoid including the raw response body in the thrown
       * exception.
       *
       * Provider bodies can contain prompt fragments, gateway diagnostics, or
       * other environment-specific material that should not automatically
       * enter logs.
       */
      throw new OllamaProviderError(
        `Ollama instance "${this.instanceId}" returned HTTP ${response.status} for ${path}.`,
        this.instanceId,
      );
    }

    return response;
  }

  async chat(
    input: ModelChatRequest,
  ): Promise<ModelChatResponse> {
    const startedAt =
      Date.now();

    this.requestCount += 1;

    const response =
      await this.request(
        '/api/chat',
        {
          method: 'POST',

          body:
            JSON.stringify(
              this.buildChatBody(
                input,
                false,
              ),
            ),

          signal:
            input.signal,
        },
      );

    const payload =
      (await response.json()) as OllamaChatResponse;

    if (payload.error) {
      throw new OllamaProviderError(
        'Ollama returned an application-level model error.',
        this.instanceId,
      );
    }

    let content =
      payload.message
        ?.content ?? '';

    let toolCalls =
      normalizeToolCalls(
        payload.message
          ?.tool_calls,
      );

    let channel:
      | 'structured'
      | 'text-json'
      | undefined =
      toolCalls.length > 0
        ? 'structured'
        : undefined;

    /**
     * Some Ollama models emit a valid tool-call object in assistant text instead
     * of populating `tool_calls`.
     *
     * Recovery is strict and deterministic:
     *
     * - object must parse as JSON
     * - name must match a tool actually offered
     * - arguments must be an object
     *
     * The non-native channel is retained in metadata so it is never silently
     * confused with native structured tool calling.
     */
    if (
      toolCalls.length === 0 &&
      input.tools?.length
    ) {
      const recovered =
        parseTextToolCalls(
          content,

          input.tools.map(
            (tool) =>
              tool.name,
          ),
        );

      if (
        recovered.calls
          .length > 0
      ) {
        toolCalls =
          recovered.calls;

        content =
          recovered.remainingText;

        channel =
          'text-json';
      }
    }

    const model =
      payload.model ??
      input.model;

    return {
      content,

      toolCalls:
        toolCalls.length > 0
          ? toolCalls
          : undefined,

      toolCallChannel:
        channel,

      model,

      providerInstanceId:
        this.instanceId,

      usageClass:
        this.usageClass,

      modelDigest:
        this.modelDigests.get(
          model,
        ) ??
        this.modelDigests.get(
          input.model,
        ),

      durationMs:
        Date.now() -
        startedAt,

      usage: {
        inputTokens:
          payload.prompt_eval_count ??
          0,

        outputTokens:
          payload.eval_count ??
          0,
      },
    };
  }

  async *stream(
    input: ModelChatRequest,
  ): AsyncIterable<ModelStreamEvent> {
    this.requestCount += 1;

    const response =
      await this.request(
        '/api/chat',
        {
          method:
            'POST',

          body:
            JSON.stringify(
              this.buildChatBody(
                input,
                true,
              ),
            ),

          signal:
            input.signal,
        },
      );

    if (!response.body) {
      yield {
        type:
          'error',

        error:
          'Ollama returned an empty stream body.',
      };

      return;
    }

    /**
     * Ollama streams NDJSON.
     *
     * Chunks can split JSON lines arbitrarily, so buffer until a full newline
     * is available.
     */
    let buffer = '';

    const decoder =
      new TextDecoder();

    /**
     * When tools are offered, text is temporarily buffered until we know whether
     * it is ordinary assistant content or a text-JSON tool call.
     */
    let pendingText = '';

    let sawStructuredToolCall =
      false;

    const offeredToolNames =
      input.tools?.map(
        (tool) =>
          tool.name,
      ) ?? [];

    /**
     * Flush ordinary buffered assistant content.
     */
    const flushPendingText =
      function* (): Generator<ModelStreamEvent> {
        if (
          pendingText
            .length > 0
        ) {
          yield {
            type:
              'chunk',

            content:
              pendingText,
          };

          pendingText =
            '';
        }
      };

    /**
     * At the end of a response, try deterministic text-JSON tool-call recovery
     * if no provider-native tool call appeared.
     */
    const flushRecoveredToolCalls =
      function* (): Generator<ModelStreamEvent> {
        if (
          !pendingText ||
          offeredToolNames.length ===
            0 ||
          sawStructuredToolCall
        ) {
          yield* flushPendingText();

          return;
        }

        const recovered =
          parseTextToolCalls(
            pendingText,
            offeredToolNames,
          );

        pendingText = '';

        if (
          recovered.calls
            .length === 0
        ) {
          if (
            recovered.remainingText
          ) {
            yield {
              type:
                'chunk',

              content:
                recovered.remainingText,
            };
          }

          return;
        }

        if (
          recovered.remainingText
        ) {
          yield {
            type:
              'chunk',

            content:
              recovered.remainingText,
          };
        }

        for (
          const call of
          recovered.calls
        ) {
          yield {
            type:
              'tool_call',

            toolCall:
              call,
          };
        }
      };

    try {
      for await (
        const value of
        responseChunks(
          response.body,
        )
      ) {
        buffer +=
          decoder.decode(
            value,
            {
              stream:
                true,
            },
          );

        const lines =
          buffer.split(
            '\n',
          );

        buffer =
          lines.pop() ??
          '';

        for (
          const line of
          lines
        ) {
          const trimmed =
            line.trim();

          if (!trimmed) {
            continue;
          }

          let payload:
            OllamaChatResponse;

          try {
            payload =
              JSON.parse(
                trimmed,
              ) as OllamaChatResponse;
          } catch {
            yield {
              type:
                'error',

              error:
                'Ollama returned malformed NDJSON.',
            };

            return;
          }

          if (
            payload.error
          ) {
            yield {
              type:
                'error',

              error:
                'Ollama reported an application-level model error.',
            };

            return;
          }

          const structuredCalls =
            normalizeToolCalls(
              payload.message
                ?.tool_calls,
            );

          if (
            structuredCalls
              .length > 0
          ) {
            /**
             * If ordinary prose was buffered before the first native tool call,
             * release it now; the appearance of a structured call tells us the
             * buffered content is not itself the fallback text-JSON channel.
             */
            yield* flushPendingText();

            sawStructuredToolCall =
              true;

            for (
              const call of
              structuredCalls
            ) {
              yield {
                type:
                  'tool_call',

                toolCall:
                  call,
              };
            }
          }

          /**
           * Hidden reasoning is represented only as activity.
           */
          if (
            payload.message
              ?.thinking
          ) {
            yield {
              type:
                'thinking',
            };
          }

          const content =
            payload.message
              ?.content;

          if (content) {
            if (
              offeredToolNames
                .length >
                0 &&
              !sawStructuredToolCall
            ) {
              pendingText +=
                content;
            } else {
              yield {
                type:
                  'chunk',

                content,
              };
            }
          }

          if (
            payload.done
          ) {
            yield* flushRecoveredToolCalls();

            yield {
              type:
                'done',

              usage: {
                inputTokens:
                  payload.prompt_eval_count ??
                  0,

                outputTokens:
                  payload.eval_count ??
                  0,
              },
            };

            return;
          }
        }
      }

      /**
       * Flush the decoder after the stream closes.
       */
      buffer +=
        decoder.decode();

      /**
       * Ollama normally terminates every NDJSON object with a newline, but accept
       * a final complete object even if the transport closes without one.
       */
      if (
        buffer.trim()
      ) {
        let payload:
          OllamaChatResponse;

        try {
          payload =
            JSON.parse(
              buffer.trim(),
            ) as OllamaChatResponse;
        } catch {
          yield {
            type:
              'error',

            error:
              'Ollama stream ended with malformed NDJSON.',
          };

          return;
        }

        if (
          payload.error
        ) {
          yield {
            type:
              'error',

            error:
              'Ollama reported an application-level model error.',
          };

          return;
        }

        const structuredCalls =
          normalizeToolCalls(
            payload.message
              ?.tool_calls,
          );

        if (
          structuredCalls
            .length >
            0
        ) {
          yield* flushPendingText();

          sawStructuredToolCall =
            true;

          for (
            const call of
            structuredCalls
          ) {
            yield {
              type:
                'tool_call',

              toolCall:
                call,
            };
          }
        }

        if (
          payload.message
            ?.thinking
        ) {
          yield {
            type:
              'thinking',
          };
        }

        const content =
          payload.message
            ?.content;

        if (content) {
          if (
            offeredToolNames
              .length >
              0 &&
            !sawStructuredToolCall
          ) {
            pendingText +=
              content;
          } else {
            yield {
              type:
                'chunk',

              content,
            };
          }
        }

        if (
          payload.done
        ) {
          yield* flushRecoveredToolCalls();

          yield {
            type:
              'done',

            usage: {
              inputTokens:
                payload.prompt_eval_count ??
                0,

              outputTokens:
                payload.eval_count ??
                0,
            },
          };

          return;
        }
      }

      /**
       * The transport ended without an explicit Ollama `done` record.
       *
       * Preserve any legitimate buffered assistant text/tool call before
       * signaling completion.
       */
      yield* flushRecoveredToolCalls();

      yield {
        type:
          'done',
      };
    } finally {
      await (
        response.body as unknown as
          | {
              cancel?: () =>
                Promise<void>;
            }
          | null
      )?.cancel?.()
        .catch(
          () => undefined,
        );
    }
  }

  private buildChatBody(
    input: ModelChatRequest,

    stream: boolean,
  ): Record<
    string,
    unknown
  > {
    const messages =
      input.systemPrompt
        ? [
            {
              role:
                'system',

              content:
                input.systemPrompt,
            },

            ...input.messages,
          ]
        : input.messages;

    const body:
      Record<
        string,
        unknown
      > = {
      model:
        input.model,

      messages:
        messages.map(
          (message) => ({
            role:
              message.role,

            content:
              message.content,
          }),
        ),

      stream,

      options: {
        ...(input.temperature !==
        undefined
          ? {
              temperature:
                input.temperature,
            }
          : {}),

        ...(input.maxTokens !==
        undefined
          ? {
              num_predict:
                input.maxTokens,
            }
          : {}),

        ...(input.contextWindowTokens !==
        undefined
          ? {
              num_ctx:
                input.contextWindowTokens,
            }
          : {}),
      },
    };

    if (
      input.tools?.length
    ) {
      body.tools =
        input.tools.map(
          toOllamaTool,
        );
    }

    /**
     * Only send the reasoning control when explicitly requested.
     */
    if (
      input.think !==
      undefined
    ) {
      body.think =
        input.think;
    }

    return body;
  }

  /**
   * Returns only provider-declared capability confidence.
   *
   * `/api/show` claiming tool support produces `declared`, never `verified`.
   * Verification belongs to the capability probe.
   */
  supportsTools(
    model?: string,
  ): CapabilityStatus {
    if (!model) {
      return 'unknown';
    }

    const declared =
      this.declared.get(
        model,
      );

    if (!declared) {
      return 'unknown';
    }

    return declared.includes(
      'tools',
    )
      ? 'declared'
      : 'unsupported';
  }

  /**
   * Fetch and cache provider-declared capability metadata for one model.
   */
  async showModel(
    model: string,
  ): Promise<OllamaShowResponse> {
    const response =
      await this.request(
        '/api/show',
        {
          method:
            'POST',

          body:
            JSON.stringify({
              model,
            }),
        },
      );

    const payload =
      (await response.json()) as OllamaShowResponse;

    if (
      payload.capabilities
    ) {
      this.declared.set(
        model,
        payload.capabilities,
      );
    }

    return payload;
  }

  /**
   * Return live provider inventory.
   *
   * `/api/tags` provides base inventory and digest information. `/api/show`
   * enriches each model with declared capabilities and model-family metadata.
   *
   * Enrichment is performed in small batches to avoid issuing an unbounded
   * number of concurrent `/api/show` requests.
   */
  async listModels():
    Promise<
      ModelDescriptor[]
    > {
    const response =
      await this.request(
        '/api/tags',
        {
          method:
            'GET',
        },
      );

    const {
      models = [],
    } =
      (await response.json()) as {
        models?:
          OllamaTagEntry[];
      };

    for (
      const entry of
      models
    ) {
      if (
        entry.digest
      ) {
        this.modelDigests.set(
          entry.name,
          entry.digest,
        );
      }
    }

    const enriched:
      ModelDescriptor[] = [];

    const ENRICHMENT_CONCURRENCY =
      4;

    for (
      let offset = 0;
      offset <
      models.length;
      offset +=
        ENRICHMENT_CONCURRENCY
    ) {
      const batch =
        models.slice(
          offset,

          offset +
            ENRICHMENT_CONCURRENCY,
        );

      const results =
        await Promise.all(
          batch.map(
            async (
              entry,
            ) => {
              let show:
                OllamaShowResponse = {};

              try {
                show =
                  await this.showModel(
                    entry.name,
                  );
              } catch {
                /**
                 * Inventory remains useful even when one model cannot be
                 * enriched.
                 */
              }

              const details =
                show.details ??
                entry.details ??
                {};

              const descriptor = {
                name:
                  entry.name,

                providerInstanceId:
                  this.instanceId,

                digest:
                  entry.digest,

                parentModel:
                  details.parent_model ||
                  undefined,

                family:
                  details.family,

                parameterSize:
                  details.parameter_size,

                quantization:
                  details.quantization_level,

                sizeBytes:
                  entry.size,

                declaredCapabilities:
                  show.capabilities ??
                  [],

                modifiedAt:
                  entry.modified_at,
              } satisfies ModelDescriptor;

              return descriptor;
            },
          ),
        );

      enriched.push(
        ...results,
      );
    }

    return enriched.sort(
      (
        left,
        right,
      ) =>
        left.name.localeCompare(
          right.name,
        ),
    );
  }

  async health():
    Promise<ProviderHealth> {
    const startedAt =
      Date.now();

    const location =
      this.usageClass ===
      'LOCAL_OLLAMA'
        ? 'Local'
        : 'Remote';

    if (
      !this.instance.enabled
    ) {
      return {
        status:
          'not configured',

        instanceId:
          this.instanceId,

        usageClass:
          this.usageClass,

        location,
      };
    }

    try {
      const response =
        await this.request(
          '/api/version',
          {
            method:
              'GET',
          },
        );

      const {
        version,
      } =
        (await response.json()) as {
          version?: string;
        };

      return {
        status:
          'connected',

        instanceId:
          this.instanceId,

        usageClass:
          this.usageClass,

        location,

        version,

        latencyMs:
          Date.now() -
          startedAt,
      };
    } catch (error) {
      return {
        status:
          'unavailable',

        instanceId:
          this.instanceId,

        usageClass:
          this.usageClass,

        location,

        latencyMs:
          Date.now() -
          startedAt,

        /**
         * Error class only.
         *
         * Never return raw provider bodies or credentials from health checks.
         */
        error:
          error instanceof Error
            ? error.name
            : 'UnknownError',
      };
    }
  }

  async getUsage():
    Promise<
      Record<
        string,
        number
      >
    > {
    return {
      requestCount:
        this.requestCount,
    };
  }
}

export interface TextToolCallParseResult {
  calls:
    NormalizedToolCall[];

  /**
   * Assistant text after recognized tool-call JSON objects are removed.
   */
  remainingText: string;
}

/**
 * Recover tool calls emitted as assistant text.
 *
 * This fallback channel is deliberately strict:
 *
 * - candidate must be valid JSON
 * - candidate must be a JSON object
 * - `name` must exactly match a tool offered in this request
 * - `arguments`/`parameters` must be an object
 *
 * Prose, malformed fragments, unknown tool names, and non-object arguments are
 * ignored.
 */
export function parseTextToolCalls(
  content: string,

  offeredToolNames:
    string[],
): TextToolCallParseResult {
  const empty:
    TextToolCallParseResult = {
    calls: [],
    remainingText:
      content,
  };

  if (
    !content.trim() ||
    offeredToolNames
      .length === 0
  ) {
    return empty;
  }

  const offered =
    new Set(
      offeredToolNames,
    );

  const calls:
    NormalizedToolCall[] = [];

  const consumedRanges:
    Array<
      [
        number,
        number,
      ]
    > = [];

  for (
    const [
      start,
      end,
    ] of findJsonObjectRanges(
      content,
    )
  ) {
    const candidate =
      content.slice(
        start,
        end,
      );

    let parsed:
      unknown;

    try {
      parsed =
        JSON.parse(
          candidate,
        );
    } catch {
      continue;
    }

    if (
      !parsed ||
      typeof parsed !==
        'object' ||
      Array.isArray(
        parsed,
      )
    ) {
      continue;
    }

    const record =
      parsed as Record<
        string,
        unknown
      >;

    const name =
      record.name;

    if (
      typeof name !==
        'string' ||
      !offered.has(name)
    ) {
      continue;
    }

    const rawArgs =
      record.arguments ??
      record.parameters ??
      {};

    if (
      typeof rawArgs !==
        'object' ||
      rawArgs === null ||
      Array.isArray(
        rawArgs,
      )
    ) {
      continue;
    }

    calls.push({
      id:
        `call_${calls.length + 1}`,

      name,

      arguments:
        rawArgs as Record<
          string,
          unknown
        >,
    });

    consumedRanges.push([
      start,
      end,
    ]);
  }

  if (
    calls.length ===
    0
  ) {
    return empty;
  }

  let remainingText =
    '';

  let cursor = 0;

  for (
    const [
      start,
      end,
    ] of consumedRanges
  ) {
    remainingText +=
      content.slice(
        cursor,
        start,
      );

    cursor =
      end;
  }

  remainingText +=
    content.slice(
      cursor,
    );

  return {
    calls,

    /**
     * Remove common formatting/template markers left behind after extracting
     * recognized JSON objects.
     */
    remainingText:
      remainingText
        .replace(
          /```(?:json)?/g,
          '',
        )
        .replace(
          /<\|[a-z_]+\|>/gi,
          '',
        )
        .trim(),
  };
}

/**
 * Returns byte-index ranges for balanced top-level JSON-looking `{...}` spans.
 *
 * Braces inside JSON strings are ignored.
 */
function findJsonObjectRanges(
  text: string,
): Array<
  [
    number,
    number,
  ]
> {
  const ranges:
    Array<
      [
        number,
        number,
      ]
    > = [];

  let depth = 0;
  let start = -1;

  let inString =
    false;

  let escaped =
    false;

  for (
    let index = 0;
    index <
    text.length;
    index += 1
  ) {
    const char =
      text[index];

    if (inString) {
      if (escaped) {
        escaped =
          false;
      } else if (
        char === '\\'
      ) {
        escaped =
          true;
      } else if (
        char === '"'
      ) {
        inString =
          false;
      }

      continue;
    }

    if (
      char === '"'
    ) {
      inString =
        true;

      continue;
    }

    if (
      char === '{'
    ) {
      if (
        depth === 0
      ) {
        start =
          index;
      }

      depth += 1;

      continue;
    }

    if (
      char === '}'
    ) {
      if (
        depth <= 0
      ) {
        continue;
      }

      depth -= 1;

      if (
        depth === 0 &&
        start >= 0
      ) {
        ranges.push([
          start,
          index + 1,
        ]);

        start = -1;
      }
    }
  }

  return ranges;
}

/**
 * Translate the provider-neutral tool schema into Ollama's function-tool
 * format.
 */
function toOllamaTool(
  tool: ToolSchema,
): Record<
  string,
  unknown
> {
  return {
    type:
      'function',

    function: {
      name:
        tool.name,

      description:
        tool.description,

      parameters:
        tool.inputSchema,
    },
  };
}

/**
 * Normalize Ollama tool calls into the provider-neutral shape.
 *
 * Ollama normally returns `arguments` as an object, but some model/template
 * combinations return a serialized JSON object instead. Both representations
 * are accepted.
 *
 * Malformed arguments are dropped rather than forwarded into the agent loop.
 */
export function normalizeToolCalls(
  calls:
    | OllamaToolCall[]
    | undefined,
): NormalizedToolCall[] {
  if (
    !calls?.length
  ) {
    return [];
  }

  const normalized:
    NormalizedToolCall[] = [];

  calls.forEach(
    (
      call,
      index,
    ) => {
      const name =
        call.function
          ?.name;

      if (!name) {
        return;
      }

      let args:
        Record<
          string,
          unknown
        > = {};

      const raw =
        call.function
          ?.arguments;

      if (
        typeof raw ===
        'string'
      ) {
        try {
          const parsed =
            JSON.parse(
              raw,
            ) as unknown;

          if (
            parsed &&
            typeof parsed ===
              'object' &&
            !Array.isArray(
              parsed,
            )
          ) {
            args =
              parsed as Record<
                string,
                unknown
              >;
          } else {
            return;
          }
        } catch {
          return;
        }
      } else if (
        raw &&
        typeof raw ===
          'object' &&
        !Array.isArray(
          raw,
        )
      ) {
        args =
          raw as Record<
            string,
            unknown
          >;
      } else if (
        raw !== undefined &&
        raw !== null
      ) {
        return;
      }

      normalized.push({
        id:
          `call_${index + 1}`,

        name,

        arguments:
          args,
      });
    },
  );

  return normalized;
}