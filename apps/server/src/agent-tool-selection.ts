import { isMutationTool } from '@dacai-local-agent/agent-core';

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
