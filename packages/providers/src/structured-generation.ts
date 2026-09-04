import type { ZodType, ZodTypeDef } from 'zod';
import { UsageStore } from '@dacai-local-agent/shared';
import type { ModelChatRequest } from '@dacai-local-agent/agent-core';
import { ProviderResolutionError, type ProviderRegistry, type ResolvedModel } from './provider-registry';

/**
 * Schema-validated generation over the existing provider registry.
 *
 * Two properties matter more than convenience here:
 *
 *  1. **No unvalidated model JSON ever escapes this function.** A response that
 *     does not satisfy the caller's schema is an error, not a partial success.
 *     Callers persist the parsed value, so a soft pass would put model-shaped
 *     garbage into the database.
 *  2. **Falling back is visible.** When a remote instance is unreachable the
 *     call is retried on a named local alias and the result says so, rather
 *     than silently answering from a different (smaller) model as if nothing
 *     happened.
 *
 * The registry, its routing policy, and its capability probes remain
 * authoritative — this adds a validation layer, it does not bypass resolution.
 */

export class StructuredGenerationError extends Error {
  constructor(
    message: string,
    readonly code: 'unresolvable' | 'provider-failed' | 'unparseable' | 'schema-rejected',
    readonly detail?: { raw?: string; issues?: string },
  ) {
    super(message);
    this.name = 'StructuredGenerationError';
  }
}

export interface StructuredRequest<T> {
  /** Preferred alias. Resolved as an explicit selection, satisfying manual-provider-selection. */
  alias: string;
  /** Local alias used when the preferred one cannot be resolved or reached. */
  fallbackAlias?: string;
  /**
   * Output type is what callers receive. Input is left `unknown` so schemas
   * using `.default()` or `.transform()` -- where parsed input and output
   * differ -- still satisfy the constraint.
   */
  schema: ZodType<T, ZodTypeDef, unknown>;
  system: string;
  user: string;
  /**
   * JSON Schema handed to providers that support constrained decoding. Omitted
   * means "ask for JSON generally" — validation is unchanged either way.
   */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
  /** Recorded on the usage row so intelligence traffic is attributable. */
  workerRole?: string;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  alias: string;
  model: string;
  providerInstanceId: string;
  /** Set when the preferred alias failed and a fallback served the request. */
  fellBackFrom?: string;
  /** True when the first response failed validation and a repair round-trip fixed it. */
  repaired: boolean;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Every balanced top-level JSON object in a block of model text.
 *
 * Models wrap payloads in prose, markdown fences, or one-element arrays even
 * when told not to. Scanning for balanced braces recovers the payload without
 * accepting whatever the model said around it.
 */
export function extractJsonCandidates(raw: string): unknown[] {
  const cleaned = raw.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          found.push(JSON.parse(cleaned.slice(start, index + 1)));
        } catch {
          // Braces balanced but the span is not JSON. Skip it rather than guess.
        }
        start = -1;
      }
    }
  }

  return found;
}

/**
 * Validates the largest candidate first: an explanatory envelope wrapping the
 * real payload is common, and the payload is the larger object.
 */
export function parseWithSchema<T>(
  raw: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): { ok: true; value: T } | { ok: false; reason: 'unparseable' | 'schema-rejected'; issues?: string } {
  const candidates = extractJsonCandidates(raw);
  if (!candidates.length) return { ok: false, reason: 'unparseable' };

  const bySize = [...candidates].sort((a, b) => safeLength(b) - safeLength(a));
  let issues: string | undefined;

  for (const candidate of bySize) {
    const result = schema.safeParse(candidate);
    if (result.success) return { ok: true, value: result.data };
    issues ??= result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
  }

  return { ok: false, reason: 'schema-rejected', issues };
}

function safeLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export class StructuredGenerator {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly usage = new UsageStore(),
  ) {}

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const attempts: string[] = [request.alias];
    if (request.fallbackAlias && request.fallbackAlias !== request.alias) {
      attempts.push(request.fallbackAlias);
    }

    let lastError: Error | undefined;

    for (const [index, alias] of attempts.entries()) {
      try {
        const result = await this.attempt(alias, request);
        return index === 0 ? result : { ...result, fellBackFrom: attempts[0] };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // A schema failure is the model's fault, not the transport's. Retrying
        // the identical prompt on a smaller local model would not fix it and
        // would misattribute the failure, so only reachability falls back.
        if (error instanceof StructuredGenerationError && error.code !== 'provider-failed') throw error;
        if (index === attempts.length - 1) break;
      }
    }

    throw new StructuredGenerationError(
      `No configured instance could serve structured generation for "${request.alias}"` +
        (request.fallbackAlias ? ` or its fallback "${request.fallbackAlias}"` : '') +
        `. Last error: ${lastError?.message ?? 'unknown'}`,
      'provider-failed',
    );
  }

  private async attempt<T>(alias: string, request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let resolved: ResolvedModel;
    try {
      // Advisory work: structured generation grants no tools, so verified tool
      // calling is not required and an advisory-class model is legitimate here.
      resolved = await this.registry.resolveAlias(alias, {
        explicitInstanceRequest: true,
        signal: request.signal,
      });
    } catch (error) {
      const code = error instanceof ProviderResolutionError && error.code === 'unknown-alias'
        ? 'unresolvable'
        : 'provider-failed';
      throw new StructuredGenerationError(
        `Alias "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        code,
      );
    }

    const useSchema =
      request.jsonSchema !== undefined &&
      (resolved.capabilities.jsonSchema === 'verified' || resolved.capabilities.strictJsonSchema === 'verified');

    const base: ModelChatRequest = {
      model: resolved.model,
      systemPrompt: request.system,
      messages: [{ role: 'user', content: request.user }],
      temperature: request.temperature ?? resolved.temperature,
      maxTokens: request.maxTokens ?? resolved.maxTokens,
      contextWindowTokens: request.contextWindowTokens,
      // Schema-constrained decoding only where the probe actually established
      // it. Sending a schema to a model that ignores it silently degrades to
      // free-form JSON, which is what 'json' asks for honestly.
      responseFormat: useSchema ? request.jsonSchema! : 'json',
      // Structured extraction does not benefit from an internal reasoning pass
      // and the tokens it spends come out of the response budget.
      think: false,
      thinkingCapability: resolved.capabilities.configurableThinking,
      signal: request.signal,
    };

    const startedAt = Date.now();
    const first = await this.chat(resolved, base, alias, request.workerRole, startedAt);
    const parsed = parseWithSchema(first.content, request.schema);

    if (parsed.ok) {
      return this.toResult(parsed.value, alias, resolved, first, false, Date.now() - startedAt);
    }

    // One repair round-trip. The model is shown its own output and the exact
    // validation failure; anything still invalid after that is a real failure
    // to report, not something to keep paying for.
    const repair = await this.chat(
      resolved,
      {
        ...base,
        messages: [
          { role: 'user', content: request.user },
          { role: 'assistant', content: first.content.slice(0, 8_000) },
          {
            role: 'user',
            content:
              'That response did not satisfy the required schema.\n' +
              (parsed.reason === 'unparseable'
                ? 'No JSON object could be located in it.'
                : `Validation errors: ${parsed.issues ?? 'unspecified'}`) +
              '\n\nReturn ONLY the corrected JSON object. No prose, no markdown fences.',
          },
        ],
      },
      alias,
      request.workerRole,
      Date.now(),
    );

    const second = parseWithSchema(repair.content, request.schema);
    if (second.ok) {
      return this.toResult(second.value, alias, resolved, repair, true, Date.now() - startedAt);
    }

    throw new StructuredGenerationError(
      `Model "${resolved.model}" on "${resolved.instance.id}" did not return schema-valid JSON after one repair attempt.`,
      second.reason,
      { raw: repair.content.slice(0, 2_000), issues: second.issues },
    );
  }

  private async chat(
    resolved: ResolvedModel,
    input: ModelChatRequest,
    alias: string,
    workerRole: string | undefined,
    startedAt: number,
  ) {
    try {
      const response = await resolved.provider.chat(input);
      // Awaited, not fire-and-forget: an unawaited insert is lost when the
      // process exits before it lands, which silently under-reports exactly the
      // long/expensive calls most worth measuring. UsageStore.record never
      // throws, so awaiting cannot fail the generation.
      await this.usage.record({
        providerInstanceId: resolved.instance.id,
        usageClass: resolved.instance.usageClass,
        model: response.model || resolved.model,
        modelDigest: response.modelDigest,
        source: 'internal',
        workerRole: workerRole ?? `structured:${alias}`,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        durationMs: response.durationMs ?? Date.now() - startedAt,
        fallbackFromInstanceId: resolved.fallbackFromInstanceId,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.usage.record({
        providerInstanceId: resolved.instance.id,
        usageClass: resolved.instance.usageClass,
        model: resolved.model,
        source: 'internal',
        workerRole: workerRole ?? `structured:${alias}`,
        durationMs: Date.now() - startedAt,
        providerError: message.slice(0, 500),
      });
      throw new StructuredGenerationError(
        `Provider instance "${resolved.instance.id}" failed for alias "${alias}": ${message}`,
        'provider-failed',
      );
    }
  }

  private toResult<T>(
    value: T,
    alias: string,
    resolved: ResolvedModel,
    response: { model: string; providerInstanceId: string; usage?: Partial<{ inputTokens: number; outputTokens: number }> },
    repaired: boolean,
    durationMs: number,
  ): StructuredResult<T> {
    return {
      value,
      alias,
      model: response.model || resolved.model,
      providerInstanceId: response.providerInstanceId || resolved.instance.id,
      repaired,
      durationMs,
      inputTokens: response.usage?.inputTokens,
      outputTokens: response.usage?.outputTokens,
    };
  }
}
