export * from './registry';
export * from './roles';
export * from './security-scenario-registry';
export * from './adversarial-agent';
export * from './defensive-control-tests';
export * from './defensive-agent';
export * from './defensive-control-inspector';
export * from './defensive-regression-verifier';
export * from './red-team-blocking-verification';

export interface AgentDefinition {
  id: string;
  provider: string;
  systemPrompt: string;
  tools: string[];
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }
}
