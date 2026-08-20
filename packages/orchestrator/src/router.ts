import type { EscalationMode } from '@dacai-local-agent/shared';

export interface OrchestrationDecision {
  mode: EscalationMode;
  reason: string;
  approved: boolean;
}

export class TaskRouter {
  constructor(private readonly defaultMode: EscalationMode = 'ask') {}

  decide(taskDescription: string): OrchestrationDecision {
    const localReady = taskDescription.length > 0 && taskDescription.trim().length > 0;

    return {
      mode: localReady ? this.defaultMode : 'never',
      reason: localReady
        ? 'Default local-first policy: keep execution local unless the task requires escalation.'
        : 'No task description provided.',
      approved: localReady,
    };
  }
}
