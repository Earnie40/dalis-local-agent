export type AgentMessageRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool';

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  toolName?: string;
  timestamp?: number;
}

export interface AgentLoopTask {
  prompt: string;
  workspaceId: string;
  sessionId: string;

  /**
   * Optional explicit conversation history.
   *
   * If omitted, the AgentLoop implementation should restore the session
   * conversation from the memory/session store.
   */
  history?: AgentMessage[];

  /**
   * Optional execution controls.
   */
  maxTurns?: number;
  maxToolCalls?: number;

  signal?: AbortSignal;
}

export interface AgentExecutionResult {
  answer: string;

  sessionId: string;
  workspaceId: string;

  turns: number;
  toolCalls: number;

  stopReason:
    | 'final-answer'
    | 'max-turns'
    | 'tool-budget'
    | 'no-progress'
    | 'cancelled'
    | 'provider-error';

  /**
   * Conversation messages produced during this execution.
   */
  messages?: AgentMessage[];
}

export interface AgentLoop {
  execute(task: AgentLoopTask): Promise<AgentExecutionResult>;
}