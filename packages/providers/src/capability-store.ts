import { getPool } from '@dacai-local-agent/shared';

import type {
  CapabilityStatus,
  ProviderCapabilities,
  ToolCallChannel,
} from '@dacai-local-agent/agent-core';

import {
  PROBE_VERSION,
} from './capability-probe';

/**
 * Capability probes are cached because some of them require real inference.
 *
 * Model digest is also checked because a mutable tag can point at different
 * weights before the TTL expires.
 */
export const CAPABILITY_TTL_MS =
  7 *
  24 *
  60 *
  60 *
  1000;

interface CapabilityRow {
  model_digest:
    string | null;

  provider_version:
    string | null;

  tool_calling:
    CapabilityStatus;

  streaming:
    CapabilityStatus;

  tool_call_channel:
    ToolCallChannel | null;

  parallel_tool_calls:
    CapabilityStatus;

  streaming_tool_calls:
    CapabilityStatus;

  tool_choice:
    CapabilityStatus;

  required_tool_choice:
    CapabilityStatus;

  structured_output:
    CapabilityStatus;

  json_mode:
    CapabilityStatus;

  json_schema:
    CapabilityStatus;

  strict_json_schema:
    CapabilityStatus;

  system_prompt:
    CapabilityStatus;

  multi_turn:
    CapabilityStatus;

  stop_sequences:
    CapabilityStatus;

  reasoning:
    CapabilityStatus;

  configurable_thinking:
    CapabilityStatus;

  text_input:
    CapabilityStatus;

  image_input:
    CapabilityStatus;

  audio_input:
    CapabilityStatus;

  file_input:
    CapabilityStatus;

  text_output:
    CapabilityStatus;

  image_output:
    CapabilityStatus;

  audio_output:
    CapabilityStatus;

  context_window:
    number | null;

  max_output_tokens:
    number | null;

  max_tools:
    number | null;

  max_tool_argument_bytes:
    number | null;

  tool_call_reliability:
    number | null;

  structured_output_reliability:
    number | null;

  average_latency_ms:
    number | null;

  last_probe_error:
    string | null;

  probed_at:
    Date;
}

export interface CapabilityStoreReadOptions {
  /**
   * When supplied, a cached record for another model digest is rejected even if
   * the model tag and TTL still match.
   */
  modelDigest?: string;
}

export interface CapabilityStore {
  read(
    instanceId: string,
    model: string,
    options?: CapabilityStoreReadOptions,
  ): Promise<
    ProviderCapabilities |
    undefined
  >;

  write(
    instanceId: string,
    model: string,
    capabilities:
      ProviderCapabilities,
  ): Promise<void>;

  clear(
    instanceId: string,
    model?: string,
  ): Promise<void>;
}

/**
 * Persistent capability cache.
 *
 * A probe result is accepted only when:
 *
 * - provider instance matches
 * - model tag matches
 * - probe schema/version matches
 * - record is inside TTL
 * - requested model digest matches, when supplied
 */
export class PostgresCapabilityStore
  implements CapabilityStore
{
  constructor(
    private readonly ttlMs:
      number =
      CAPABILITY_TTL_MS,
  ) {}

  async read(
    instanceId: string,
    model: string,
    options:
      CapabilityStoreReadOptions = {},
  ): Promise<
    ProviderCapabilities |
    undefined
  > {
    const {
      rows,
    } =
      await getPool().query<CapabilityRow>(
        `
        SELECT
          model_digest,
          provider_version,

          tool_calling,
          streaming,
          tool_call_channel,

          parallel_tool_calls,
          streaming_tool_calls,
          tool_choice,
          required_tool_choice,

          structured_output,
          json_mode,
          json_schema,
          strict_json_schema,

          system_prompt,
          multi_turn,
          stop_sequences,

          reasoning,
          configurable_thinking,

          text_input,
          image_input,
          audio_input,
          file_input,

          text_output,
          image_output,
          audio_output,

          context_window,
          max_output_tokens,
          max_tools,
          max_tool_argument_bytes,

          tool_call_reliability,
          structured_output_reliability,
          average_latency_ms,

          last_probe_error,
          probed_at

        FROM provider_capabilities

        WHERE provider_instance_id = $1
          AND model = $2
          AND probe_version = $3
        `,
        [
          instanceId,
          model,
          PROBE_VERSION,
        ],
      );

    const row =
      rows[0];

    if (!row) {
      return undefined;
    }

    const ageMs =
      Date.now() -
      row.probed_at.getTime();

    if (
      ageMs >
      this.ttlMs
    ) {
      return undefined;
    }

    if (
      options.modelDigest &&
      row.model_digest &&
      row.model_digest !==
        options.modelDigest
    ) {
      return undefined;
    }

    /*
     * If the caller supplied a digest but the old record has no digest, reject
     * it. Verification should never become weaker merely because an older row
     * lacks model identity.
     */
    if (
      options.modelDigest &&
      !row.model_digest
    ) {
      return undefined;
    }

    return {
      modelDigest:
        row.model_digest ??
        undefined,

      providerVersion:
        row.provider_version ??
        undefined,

      toolCalling:
        row.tool_calling,

      streaming:
        row.streaming,

      toolCallChannel:
        row.tool_call_channel ??
        undefined,

      parallelToolCalls:
        row.parallel_tool_calls,

      streamingToolCalls:
        row.streaming_tool_calls,

      toolChoice:
        row.tool_choice,

      requiredToolChoice:
        row.required_tool_choice,

      structuredOutput:
        row.structured_output,

      jsonMode:
        row.json_mode,

      jsonSchema:
        row.json_schema,

      strictJsonSchema:
        row.strict_json_schema,

      systemPrompt:
        row.system_prompt,

      multiTurn:
        row.multi_turn,

      stopSequences:
        row.stop_sequences,

      reasoning:
        row.reasoning,

      configurableThinking:
        row.configurable_thinking,

      textInput:
        row.text_input,

      imageInput:
        row.image_input,

      audioInput:
        row.audio_input,

      fileInput:
        row.file_input,

      textOutput:
        row.text_output,

      imageOutput:
        row.image_output,

      audioOutput:
        row.audio_output,

      contextWindow:
        row.context_window ??
        undefined,

      maxOutputTokens:
        row.max_output_tokens ??
        undefined,

      maxTools:
        row.max_tools ??
        undefined,

      maxToolArgumentBytes:
        row.max_tool_argument_bytes ??
        undefined,

      toolCallReliability:
        row.tool_call_reliability ??
        undefined,

      structuredOutputReliability:
        row.structured_output_reliability ??
        undefined,

      averageLatencyMs:
        row.average_latency_ms ??
        undefined,

      lastProbeError:
        row.last_probe_error ??
        undefined,

      probedAt:
        row.probed_at.toISOString(),

      probeVersion:
        PROBE_VERSION,
    };
  }

  async write(
    instanceId: string,
    model: string,
    capabilities:
      ProviderCapabilities,
  ): Promise<void> {
    await getPool().query(
      `
      INSERT INTO provider_capabilities (
        provider_instance_id,
        model,
        model_digest,
        provider_version,
        probe_version,

        tool_calling,
        streaming,
        tool_call_channel,

        parallel_tool_calls,
        streaming_tool_calls,
        tool_choice,
        required_tool_choice,

        structured_output,
        json_mode,
        json_schema,
        strict_json_schema,

        system_prompt,
        multi_turn,
        stop_sequences,

        reasoning,
        configurable_thinking,

        text_input,
        image_input,
        audio_input,
        file_input,

        text_output,
        image_output,
        audio_output,

        context_window,
        max_output_tokens,
        max_tools,
        max_tool_argument_bytes,

        tool_call_reliability,
        structured_output_reliability,
        average_latency_ms,

        last_probe_error,
        probed_at
      )

      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,
        $9,$10,$11,$12,
        $13,$14,$15,$16,
        $17,$18,$19,
        $20,$21,
        $22,$23,$24,$25,
        $26,$27,$28,
        $29,$30,$31,$32,
        $33,$34,$35,
        $36,
        now()
      )

      ON CONFLICT (
        provider_instance_id,
        model,
        probe_version
      )

      DO UPDATE SET
        model_digest =
          EXCLUDED.model_digest,

        provider_version =
          EXCLUDED.provider_version,

        tool_calling =
          EXCLUDED.tool_calling,

        streaming =
          EXCLUDED.streaming,

        tool_call_channel =
          EXCLUDED.tool_call_channel,

        parallel_tool_calls =
          EXCLUDED.parallel_tool_calls,

        streaming_tool_calls =
          EXCLUDED.streaming_tool_calls,

        tool_choice =
          EXCLUDED.tool_choice,

        required_tool_choice =
          EXCLUDED.required_tool_choice,

        structured_output =
          EXCLUDED.structured_output,

        json_mode =
          EXCLUDED.json_mode,

        json_schema =
          EXCLUDED.json_schema,

        strict_json_schema =
          EXCLUDED.strict_json_schema,

        system_prompt =
          EXCLUDED.system_prompt,

        multi_turn =
          EXCLUDED.multi_turn,

        stop_sequences =
          EXCLUDED.stop_sequences,

        reasoning =
          EXCLUDED.reasoning,

        configurable_thinking =
          EXCLUDED.configurable_thinking,

        text_input =
          EXCLUDED.text_input,

        image_input =
          EXCLUDED.image_input,

        audio_input =
          EXCLUDED.audio_input,

        file_input =
          EXCLUDED.file_input,

        text_output =
          EXCLUDED.text_output,

        image_output =
          EXCLUDED.image_output,

        audio_output =
          EXCLUDED.audio_output,

        context_window =
          EXCLUDED.context_window,

        max_output_tokens =
          EXCLUDED.max_output_tokens,

        max_tools =
          EXCLUDED.max_tools,

        max_tool_argument_bytes =
          EXCLUDED.max_tool_argument_bytes,

        tool_call_reliability =
          EXCLUDED.tool_call_reliability,

        structured_output_reliability =
          EXCLUDED.structured_output_reliability,

        average_latency_ms =
          EXCLUDED.average_latency_ms,

        last_probe_error =
          EXCLUDED.last_probe_error,

        probed_at =
          now()
      `,
      [
        instanceId,
        model,

        capabilities.modelDigest ??
          null,

        capabilities.providerVersion ??
          null,

        PROBE_VERSION,

        capabilities.toolCalling,
        capabilities.streaming,

        capabilities.toolCallChannel ??
          null,

        capabilities.parallelToolCalls,
        capabilities.streamingToolCalls,

        capabilities.toolChoice,
        capabilities.requiredToolChoice,

        capabilities.structuredOutput,
        capabilities.jsonMode,
        capabilities.jsonSchema,
        capabilities.strictJsonSchema,

        capabilities.systemPrompt,
        capabilities.multiTurn,
        capabilities.stopSequences,

        capabilities.reasoning,
        capabilities.configurableThinking,

        capabilities.textInput,
        capabilities.imageInput,
        capabilities.audioInput,
        capabilities.fileInput,

        capabilities.textOutput,
        capabilities.imageOutput,
        capabilities.audioOutput,

        capabilities.contextWindow ??
          null,

        capabilities.maxOutputTokens ??
          null,

        capabilities.maxTools ??
          null,

        capabilities.maxToolArgumentBytes ??
          null,

        capabilities.toolCallReliability ??
          null,

        capabilities.structuredOutputReliability ??
          null,

        capabilities.averageLatencyMs ??
          null,

        capabilities.lastProbeError ??
          null,
      ],
    );
  }

  async clear(
    instanceId: string,
    model?: string,
  ): Promise<void> {
    if (model) {
      await getPool().query(
        `
        DELETE
        FROM provider_capabilities
        WHERE provider_instance_id = $1
          AND model = $2
        `,
        [
          instanceId,
          model,
        ],
      );

      return;
    }

    await getPool().query(
      `
      DELETE
      FROM provider_capabilities
      WHERE provider_instance_id = $1
      `,
      [
        instanceId,
      ],
    );
  }
}

/**
 * In-memory implementation for tests and environments without PostgreSQL.
 *
 * TTL and digest behavior intentionally match the persistent store so tests do
 * not exercise weaker semantics than production.
 */
interface MemoryCapabilityEntry {
  capabilities:
    ProviderCapabilities;

  storedAt: number;
}

export class InMemoryCapabilityStore
  implements CapabilityStore
{
  private readonly entries =
    new Map<
      string,
      MemoryCapabilityEntry
    >();

  constructor(
    private readonly ttlMs:
      number =
      CAPABILITY_TTL_MS,
  ) {}

  private key(
    instanceId: string,
    model: string,
  ): string {
    return (
      `${instanceId}` +
      `::${model}` +
      `::${PROBE_VERSION}`
    );
  }

  async read(
    instanceId: string,
    model: string,
    options:
      CapabilityStoreReadOptions = {},
  ): Promise<
    ProviderCapabilities |
    undefined
  > {
    const entry =
      this.entries.get(
        this.key(
          instanceId,
          model,
        ),
      );

    if (!entry) {
      return undefined;
    }

    if (
      Date.now() -
        entry.storedAt >
      this.ttlMs
    ) {
      this.entries.delete(
        this.key(
          instanceId,
          model,
        ),
      );

      return undefined;
    }

    const storedDigest =
      entry.capabilities
        .modelDigest;

    if (
      options.modelDigest &&
      storedDigest !==
        options.modelDigest
    ) {
      return undefined;
    }

    return {
      ...entry.capabilities,
    };
  }

  async write(
    instanceId: string,
    model: string,
    capabilities:
      ProviderCapabilities,
  ): Promise<void> {
    this.entries.set(
      this.key(
        instanceId,
        model,
      ),
      {
        capabilities: {
          ...capabilities,

          probeVersion:
            PROBE_VERSION,

          probedAt:
            capabilities.probedAt ??
            new Date().toISOString(),
        },

        storedAt:
          Date.now(),
      },
    );
  }

  async clear(
    instanceId: string,
    model?: string,
  ): Promise<void> {
    if (model) {
      this.entries.delete(
        this.key(
          instanceId,
          model,
        ),
      );

      return;
    }

    for (
      const key of
      this.entries.keys()
    ) {
      if (
        key.startsWith(
          `${instanceId}::`,
        )
      ) {
        this.entries.delete(
          key,
        );
      }
    }
  }
}