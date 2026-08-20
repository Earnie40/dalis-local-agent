export interface AgentDefinition {
  /**
   * Stable logical identifier for the agent.
   *
   * Examples:
   *   architect
   *   implementation-worker
   *   security-reviewer
   */
  id: string;

  /**
   * Semantic model alias resolved elsewhere.
   *
   * Examples:
   *   architecture
   *   implementation
   *   fast_analysis
   */
  modelAlias: string;

  /**
   * System instruction used when this agent is instantiated.
   */
  systemPrompt: string;

  /**
   * Tool names this agent is allowed to request.
   *
   * The tool registry and permission engine remain authoritative at runtime.
   * Listing a tool here does not bypass execution-time authorization.
   */
  tools: string[];
}

export class AgentRegistry {
  private readonly agents =
    new Map<string, AgentDefinition>();

  /**
   * Register a new agent definition.
   *
   * Duplicate IDs are rejected so an accidental second registration cannot
   * silently replace the original configuration.
   */
  register(
    agent: AgentDefinition,
  ): void {
    const id =
      agent.id.trim();

    if (!id) {
      throw new Error(
        'Agent id is required.',
      );
    }

    if (
      this.agents.has(id)
    ) {
      throw new Error(
        `Agent "${id}" is already registered.`,
      );
    }

    this.agents.set(
      id,
      {
        ...agent,
        id,
        modelAlias:
          agent.modelAlias.trim(),
        tools:
          [...agent.tools],
      },
    );
  }

  /**
   * Return all registered agents.
   */
  list(): AgentDefinition[] {
    return [
      ...this.agents.values(),
    ].map((agent) => ({
      ...agent,
      tools:
        [...agent.tools],
    }));
  }

  /**
   * Return one agent by id.
   */
  get(
    id: string,
  ): AgentDefinition | undefined {
    const agent =
      this.agents.get(id);

    if (!agent) {
      return undefined;
    }

    return {
      ...agent,
      tools:
        [...agent.tools],
    };
  }

  /**
   * Whether an agent id is registered.
   */
  has(
    id: string,
  ): boolean {
    return this.agents.has(id);
  }

  /**
   * Number of registered agent definitions.
   */
  get size(): number {
    return this.agents.size;
  }
}