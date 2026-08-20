import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ModelConfig } from './config';

/**
 * Model aliases decouple logical agent roles from physical model/provider tags.
 *
 * Example:
 *
 *   implementation -> anthropic-primary / <model-tag>
 *   architecture   -> anthropic-primary / <model-tag>
 *   local_worker   -> ollama-local / <model-tag>
 *
 * This lets agent configuration stay stable while the underlying provider or
 * model changes.
 */

const AliasEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    enabled: z.boolean().default(true),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

const AliasFileSchema = z
  .object({
    models: z.record(z.string(), AliasEntrySchema).default({}),
  })
  .strict();

export type ModelAliasLoadStatus = 'loaded' | 'missing' | 'invalid';

export interface ModelAliasLoadResult {
  models: Record<string, ModelConfig>;

  /**
   * Non-fatal configuration notices.
   *
   * Examples:
   * - alias file missing
   * - referenced environment variable not configured
   */
  warnings: string[];

  /**
   * Overall load state so the caller can apply its own startup policy.
   */
  status: ModelAliasLoadStatus;
}

/**
 * Resolves a whole-value ${VAR} environment reference.
 *
 * Examples:
 *
 *   "${MODEL_NAME}" -> value of MODEL_NAME
 *   "local-model"   -> unchanged
 *
 * Embedded interpolation such as "models/${MODEL_NAME}" is intentionally not
 * supported. Whole-value substitution keeps model configuration predictable.
 */
function interpolate(
  value: string,
  env: NodeJS.ProcessEnv,
): {
  value: string;
  unresolved?: string;
} {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/i.exec(trimmed);

  if (!match) {
    return { value };
  }

  const variableName = match[1];
  const resolved = env[variableName];

  if (resolved === undefined || resolved.trim() === '') {
    return {
      value,
      unresolved: variableName,
    };
  }

  return {
    value: resolved.trim(),
  };
}

/**
 * Formats all schema validation issues so the operator can fix a malformed
 * configuration in one pass rather than discovering errors one at a time.
 */
function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Loads model aliases from YAML.
 *
 * The loader itself does not throw for ordinary configuration problems.
 * Instead, it returns a status plus warnings and leaves startup policy to the
 * caller.
 *
 * Example policy:
 *
 *   development:
 *     missing -> continue
 *
 *   production:
 *     missing -> fail startup
 *
 *   invalid:
 *     fail alias registration
 */
export function loadModelAliases(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelAliasLoadResult {
  const warnings: string[] = [];

  if (!existsSync(configPath)) {
    return {
      models: {},
      warnings: [
        `Model alias config not found at ${configPath}; no aliases registered.`,
      ],
      status: 'missing',
    };
  }

  let parsed: unknown;

  try {
    const source = readFileSync(configPath, 'utf8');
    parsed = parse(source);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    return {
      models: {},
      warnings: [
        `Model alias config at ${configPath} is not valid YAML: ${message}`,
      ],
      status: 'invalid',
    };
  }

  const result = AliasFileSchema.safeParse(parsed);

  if (!result.success) {
    return {
      models: {},
      warnings: [
        `Model alias config at ${configPath} is invalid: ${formatValidationIssues(
          result.error,
        )}`,
      ],
      status: 'invalid',
    };
  }

  const models: Record<string, ModelConfig> = {};

  for (const [alias, entry] of Object.entries(result.data.models)) {
    const providerInterpolation = interpolate(entry.provider, env);
    const modelInterpolation = interpolate(entry.model, env);

    const unresolvedVariables = [
      providerInterpolation.unresolved,
      modelInterpolation.unresolved,
    ].filter((value): value is string => Boolean(value));

    if (unresolvedVariables.length > 0) {
      warnings.push(
        `Alias "${alias}" is disabled because the following environment variable(s) are not set: ${unresolvedVariables.join(
          ', ',
        )}.`,
      );
    }

    models[alias] = {
      providerInstanceId: providerInterpolation.value,
      model: modelInterpolation.value,
      enabled: entry.enabled && unresolvedVariables.length === 0,
      temperature: entry.temperature,
      maxTokens: entry.maxTokens,
    };
  }

  return {
    models,
    warnings,
    status: 'loaded',
  };
}