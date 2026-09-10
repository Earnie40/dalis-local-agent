import { isMutationTool } from '@dacai-local-agent/agent-core';
import { isPersonalAllowedTool } from './personal-llm-task';

interface NamedTool {
  name: string;
}

/**
 * A transactional filesystem mutation invokes the authorized shell-backed
 * snapshot helper before it reaches the mutation tool. The helper is an
 * internal dependency, so an explicitly narrowed model tool list must retain
 * shell.run whenever it includes one of those mutations.
 */
export function selectAgentTools<T extends NamedTool>(
  enabled: readonly T[],
  requestedNames?: readonly string[],
): T[] {
  const requested = new Set(requestedNames ?? enabled.map((tool) => tool.name));
  const needsTransactionalSnapshot = [...requested].some((name) => isMutationTool(name));
  if (needsTransactionalSnapshot && enabled.some((tool) => tool.name === 'shell.run')) {
    requested.add('shell.run');
  }
  return enabled.filter((tool) => requested.has(tool.name));
}

/**
 * The public-web subset a personal/general question can be answered from.
 *
 * This is no longer a capability limit — a run is not narrowed to it, because
 * a classifier's guess about intent is not a good reason to tell the operator
 * their agent cannot read a file. It remains available for describing what a
 * personal answer *should* be able to cite.
 */
export function selectPersonalAgentTools<T extends NamedTool>(
  enabled: readonly T[],
): T[] {
  return enabled.filter((tool) => isPersonalAllowedTool(tool.name));
}
