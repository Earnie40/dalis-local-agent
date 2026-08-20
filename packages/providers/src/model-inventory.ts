import type { ModelDescriptor } from '@dacai-local-agent/agent-core';

/**
 * A flat tag list is misleading: on this machine 28 Ollama tags resolve to only
 * three genuine weight artifacts. The rest are Modelfile personas layered on a
 * base (distinguished by `details.parent_model`) or literal aliases of the same
 * manifest (identical digest).
 *
 * Grouping matters beyond cosmetics — a persona inherits its base model's
 * weights, so its capabilities and its benchmark results belong to the base.
 */

export interface ModelGroup {
  /** The base model every member resolves to, e.g. 'qwen2.5-coder:latest'. */
  baseModel: string;
  providerInstanceId: string;
  family?: string;
  parameterSize?: string;
  digest?: string;
  /** Tags that are the same artifact under another name (same digest). */
  aliases: string[];
  /** Tags that layer a system prompt on this base via a Modelfile. */
  personas: string[];
  declaredCapabilities: string[];
  sizeBytes?: number;
}

export interface ModelInventory {
  groups: ModelGroup[];
  /** Total tags reported by the provider, before grouping. */
  tagCount: number;
  /** Distinct base artifacts — the number that actually matters. */
  baseCount: number;
}

export function groupModels(models: ModelDescriptor[]): ModelInventory {
  const byName = new Map(models.map((model) => [model.name, model]));
  const bases = models.filter((model) => !model.parentModel);
  const groups = new Map<string, ModelGroup>();

  for (const base of bases) {
    groups.set(base.name, {
      baseModel: base.name,
      providerInstanceId: base.providerInstanceId,
      family: base.family,
      parameterSize: base.parameterSize,
      digest: base.digest,
      aliases: [],
      personas: [],
      declaredCapabilities: base.declaredCapabilities,
      sizeBytes: base.sizeBytes,
    });
  }

  // Same manifest digest under a different tag is an alias, not a second model.
  for (const base of bases) {
    for (const other of bases) {
      if (other.name === base.name) continue;
      if (!base.digest || other.digest !== base.digest) continue;
      const group = groups.get(base.name);
      if (group && !group.aliases.includes(other.name)) group.aliases.push(other.name);
    }
  }

  // Collapse alias pairs so the same artifact is not listed twice as a base.
  const seenDigests = new Set<string>();
  for (const name of [...groups.keys()].sort()) {
    const group = groups.get(name)!;
    if (!group.digest) continue;
    if (seenDigests.has(group.digest)) {
      groups.delete(name);
      continue;
    }
    seenDigests.add(group.digest);
  }

  for (const model of models) {
    if (!model.parentModel) continue;

    // Personas can be layered on other personas, so the chain is followed to
    // the base artifact rather than stopping at the immediate parent.
    const parent = resolveGroupFor(model.parentModel, groups, byName);
    if (parent) {
      parent.personas.push(model.name);
      continue;
    }

    // A persona whose base is no longer installed still needs to be visible.
    groups.set(model.name, {
      baseModel: model.parentModel,
      providerInstanceId: model.providerInstanceId,
      family: model.family,
      parameterSize: model.parameterSize,
      digest: model.digest,
      aliases: [],
      personas: [model.name],
      declaredCapabilities: model.declaredCapabilities,
      sizeBytes: model.sizeBytes,
    });
  }

  const ordered = [...groups.values()].sort((a, b) => a.baseModel.localeCompare(b.baseModel));
  for (const group of ordered) {
    group.aliases.sort();
    group.personas.sort();
  }

  return { groups: ordered, tagCount: models.length, baseCount: ordered.length };
}

/**
 * Follows aliases and persona-on-persona chains to the group that actually owns
 * the base artifact. Bounded so a malformed cycle cannot spin.
 */
function resolveGroupFor(
  parentName: string,
  groups: Map<string, ModelGroup>,
  byName: Map<string, ModelDescriptor>,
): ModelGroup | undefined {
  const seen = new Set<string>();
  let current: string | undefined = parentName;

  while (current && !seen.has(current)) {
    seen.add(current);

    const direct = groups.get(current);
    if (direct) return direct;

    const descriptor: ModelDescriptor | undefined = byName.get(current);
    if (!descriptor) return undefined;

    if (descriptor.digest) {
      for (const group of groups.values()) {
        if (group.digest === descriptor.digest) return group;
        if (group.aliases.includes(current)) return group;
      }
    }

    // Not a base and not an alias of one — climb to its own parent.
    current = descriptor.parentModel;
  }

  return undefined;
}

/** Models that declare tool support — candidates worth spending a probe on. */
export function toolCapableModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return models.filter((model) => model.declaredCapabilities.includes('tools'));
}
