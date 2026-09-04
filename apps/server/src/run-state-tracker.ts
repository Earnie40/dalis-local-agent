import {
  saveWorkingState,
  type AgentWorkingState,
} from '@dacai-local-agent/context';

import {
  rememberFailure,
} from '@dacai-local-agent/memory';
import { extractChangedPaths, isMutationTool } from '@dacai-local-agent/agent-core';

interface EventLike {
  type: string;
  turn: number;
  content?: string;
  message?: string;

  toolCall?: {
    name: string;
    arguments?: Record<string, unknown>;
  };

  result?: {
    success: boolean;
    denied?: boolean;
    output?: string;
    error?: string;
  };
}

function pushUnique(list: string[], value: string | undefined): void {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function argumentString(
  args: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!args) return undefined;

  for (const key of keys) {
    const value = args[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function safeFailureText(value: string): string {
  return value
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED_TOKEN]',
    )
    .replace(
      /\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*\S+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

export class RunStateTracker {
  private readonly state: AgentWorkingState;

  private pending: Promise<void> = Promise.resolve();

  constructor(
    threadId: string,
    objective: string,
  ) {
    this.state = {
      threadId,
      objective,
      plan: [],
      completedSteps: [],
      pendingSteps: [],
      inspectedFiles: [],
      relevantSymbols: [],
      changedFiles: [],
      knownErrors: [],
      architectureFacts: [],
      validationState: {
        status: 'running',
      },
    };
  }

  private queue(operation: () => Promise<void>): Promise<void> {
    this.pending = this.pending
      .then(operation)
      .catch((error) => {
        console.warn(
          'Run-state persistence failed:',
          error instanceof Error ? error.message : String(error),
        );
      });

    return this.pending;
  }

  private async persist(): Promise<void> {
    await saveWorkingState(this.state);
  }

  async initialize(): Promise<void> {
    await this.queue(async () => {
      await this.persist();
    });
  }

  record(event: EventLike): Promise<void> {
    return this.queue(async () => {
      const tool = event.toolCall?.name;
      const args = event.toolCall?.arguments;
      const result = event.result;

      if (tool && result?.success) {
        if (
          tool === 'filesystem.read' ||
          tool === 'filesystem.stat' ||
          tool === 'filesystem.search' ||
          tool === 'filesystem.list'
        ) {
          pushUnique(
            this.state.inspectedFiles ?? [],
            argumentString(args, 'path', 'filePath'),
          );
        }

        const preEditGate =
          result.output?.includes('"kind": "pre_edit_impact_gate"') ||
          result.output?.includes('"kind":"pre_edit_impact_gate"');

        if (
          !preEditGate &&
          isMutationTool(tool)
        ) {
          for (const path of extractChangedPaths(tool, args ?? {})) {
            pushUnique(this.state.changedFiles ?? [], path);
          }
        }

        if (
          tool === 'tests.run' ||
          tool === 'code.diagnostics'
        ) {
          this.state.validationState ??= {};

          this.state.validationState[tool] = {
            turn: event.turn,
            success: true,
            summary: safeFailureText(result.output ?? '').slice(0, 300),
          };
        }
      }

      if (tool && result && !result.success) {
        const raw =
          result.error ??
          result.output ??
          event.message ??
          'Unknown tool failure';

        const signature = safeFailureText(raw);

        this.state.knownErrors ??= [];

        this.state.knownErrors.push({
          turn: event.turn,
          tool,
          signature,
          denied: result.denied === true,
          recoveryRequired:
            result.denied !== true,
        });

        await rememberFailure({
          operation: tool,
          errorSignature: signature,
          attemptedApproach: `Tool invocation during turn ${event.turn}`,
          outcome: result.denied ? 'denied' : 'failed',
          metadata: {
            threadId: this.state.threadId,
            turn: event.turn,
          },
        });
      }

      if (
        event.type === 'plan_update' &&
        (event.content || event.message)
      ) {
        this.state.plan ??= [];

        this.state.plan.push({
          turn: event.turn,
          text: event.content ?? event.message,
        });
      }

      if (event.type === 'validation') {
        this.state.validationState ??= {};

        this.state.validationState.lastEvent = {
          turn: event.turn,
          content: event.content,
          message: event.message,
        };
      }

      if (event.type === 'error' && !tool) {
        const signature = safeFailureText(
          event.message ?? event.content ?? 'Agent runtime error',
        );

        this.state.knownErrors ??= [];

        this.state.knownErrors.push({
          turn: event.turn,
          operation: 'agent.run',
          signature,
        });

        await rememberFailure({
          operation: 'agent.run',
          errorSignature: signature,
          outcome: 'failed',
          metadata: {
            threadId: this.state.threadId,
            turn: event.turn,
          },
        });
      }

      await this.persist();
    });
  }

  async complete(stopReason: string): Promise<void> {
    await this.queue(async () => {
      this.state.validationState ??= {};

      this.state.validationState.runStatus = 'completed';
      this.state.validationState.stopReason = stopReason;
      this.state.validationState.completedAt =
        new Date().toISOString();

      await this.persist();
    });
  }

  async fail(message: string): Promise<void> {
    await this.queue(async () => {
      const signature = safeFailureText(message);

      this.state.knownErrors ??= [];
      this.state.knownErrors.push({
        operation: 'agent.run',
        signature,
      });

      this.state.validationState ??= {};
      this.state.validationState.runStatus = 'failed';
      this.state.validationState.failedAt =
        new Date().toISOString();

      await rememberFailure({
        operation: 'agent.run',
        errorSignature: signature,
        outcome: 'failed',
        metadata: {
          threadId: this.state.threadId,
        },
      });

      await this.persist();
    });
  }
}


