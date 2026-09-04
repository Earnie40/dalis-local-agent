import type { AgentEvent, ModelAlias, Workspace } from './api';

export type AgentCapabilityStatus = 'verified' | 'declared' | 'unsupported' | 'unknown';

export function chooseAgentWorkspace(workspaces: Workspace[], currentId: string): string {
  if (workspaces.some((workspace) => workspace.id === currentId)) return currentId;

  const productWorkspace = workspaces.find((workspace) =>
    workspace.displayName.toLowerCase() === 'dacailocalagent' ||
    /(?:^|[\\/])dacailocalagent[\\/]?$/i.test(workspace.rootPath),
  );
  return productWorkspace?.id ?? workspaces[0]?.id ?? '';
}

export function selectableAgentModels(
  aliases: ModelAlias[],
  statuses: Record<string, AgentCapabilityStatus>,
): ModelAlias[] {
  return aliases.filter((entry) => (statuses[entry.alias] ?? entry.agentCapability ?? 'unknown') !== 'unsupported');
}

/** Keep only visible user/assistant turns; tool traces and hidden reasoning never cross runs. */
export function agentConversationHistory(
  events: AgentEvent[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const event of events) {
    if (event.type === 'user_prompt' && event.content?.trim()) {
      history.push({ role: 'user', content: event.content.trim() });
    }
    if (event.type === 'done' && event.answer?.trim()) {
      history.push({ role: 'assistant', content: event.answer.trim() });
    }
  }
  return history.slice(-16);
}
