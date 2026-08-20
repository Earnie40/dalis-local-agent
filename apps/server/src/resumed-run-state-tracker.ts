import {
  loadWorkingState,
  saveWorkingState,
} from '@dacai-local-agent/context';
import type { AgentWorkingState } from '@dacai-local-agent/context';

/**
 * Broader than agent-core's `LoopEvent`: this tracker also receives
 * graph-level events (e.g. `plan_update`) whose `type` isn't part of
 * `LoopEvent`'s literal union. Mirrors the sibling `EventLike` used by
 * run-state-tracker.ts for the same reason.
 */
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

/**
 * Mutable working-state shape used only within this tracker: the same as
 * `AgentWorkingState`, but also tolerates the legacy snake_case
 * `validation_state` field some persisted rows still carry, and is not
 * `Readonly` since every mutator below pushes into it in place.
 */
type MutableWorkingState =
  AgentWorkingState & { validation_state?: Record<string, unknown> };

function validationState(
  state: MutableWorkingState,
): Record<string, unknown> {
  return (
    state.validationState ??
    state.validation_state ??
    {}
  );
}

function uniquePush(
  array: string[],
  value: string | undefined,
): void {
  if (
    value &&
    !array.includes(value)
  ) {
    array.push(value);
  }
}

function pathFromArguments(
  args: Record<string, unknown> | undefined,
): string | undefined {
  for (
    const key
    of [
      'path',
      'file',
      'filePath',
      'targetPath',
      'destination',
      'to',
    ]
  ) {
    const value =
      args?.[key];

    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      return value.trim();
    }
  }

  return undefined;
}

const MUTATION_TOOLS =
  new Set([
    'filesystem.edit',
    'filesystem.write',
    'filesystem.move',
    'filesystem.copy',
  ]);

const INSPECTION_TOOLS =
  new Set([
    'filesystem.read',
    'filesystem.list',
    'filesystem.search',
    'filesystem.stat',
    'code.symbol.search',
    'code.symbol.references',
    'code.symbol.callers',
    'code.symbol.callees',
    'code.symbol.impact',
    'code.architecture.context',
  ]);

export class ResumedRunStateTracker {
  private tail:
    Promise<void> =
      Promise.resolve();

  constructor(
    private readonly threadId:
      string,
  ) {}

  private queue(
    operation:
      () => Promise<void>,
  ): Promise<void> {
    this.tail =
      this.tail
        .catch(() => undefined)
        .then(operation);

    return this.tail;
  }

  private async mutate(
    operation:
      (state: MutableWorkingState) => void |
      Promise<void>,
  ): Promise<void> {
    const loaded =
      await loadWorkingState(
        this.threadId,
      );

    if (!loaded) {
      throw new Error(
        `Persisted resumed run "${this.threadId}" disappeared.`,
      );
    }

    const state = loaded as MutableWorkingState;

    await operation(state);

    await saveWorkingState({
      ...state,
      threadId:
        this.threadId,
    });
  }

  async initialize():
    Promise<void> {
    /*
     * Deliberately does not create/reset anything.
     */
    await this.queue(
      async () => {
        await this.mutate(
          (state) => {
            const validation =
              validationState(
                state,
              );

            state.validationState = {
              ...validation,

              runStatus:
                'running',

              resumedExecutionStartedAt:
                new Date()
                  .toISOString(),
            };
          },
        );
      },
    );
  }

  async record(
    event: EventLike,
  ): Promise<void> {
    await this.queue(
      async () => {
        await this.mutate(
          (state) => {
            state.inspectedFiles ??=
              [];

            state.changedFiles ??=
              [];

            state.knownErrors ??=
              [];

            const tool =
              event.toolCall
                ?.name;

            const args =
              event.toolCall
                ?.arguments ??
              {};

            const result =
              event.result;

            const path =
              pathFromArguments(
                args,
              );

            if (
              event?.type ===
                'tool_result' &&
              result?.success ===
                true &&
              tool !== undefined &&
              INSPECTION_TOOLS.has(
                tool,
              )
            ) {
              uniquePush(
                state.inspectedFiles,
                path,
              );
            }

            if (
              event?.type ===
                'tool_result' &&
              result?.success ===
                true &&
              result?.denied !==
                true &&
              tool !== undefined &&
              MUTATION_TOOLS.has(
                tool,
              ) &&
              !String(
                result?.output ??
                '',
              ).includes(
                'pre_edit_impact_gate',
              )
            ) {
              uniquePush(
                state.changedFiles,
                path,
              );
            }

            if (
              event?.type ===
                'tool_result' &&
              result?.success ===
                false
            ) {
              state.knownErrors
                .push({
                  turn:
                    event.turn,

                  operation:
                    tool,

                  signature:
                    String(
                      result.error ??
                      result.output ??
                      'tool failure',
                    ).slice(
                      0,
                      1200,
                    ),
                });

              state.knownErrors =
                state.knownErrors
                  .slice(-30);
            }

            if (
              event?.type ===
              'plan_update'
            ) {
              state.plan ??=
                [];

              state.plan.push({
                turn:
                  event.turn,

                text:
                  event.content ??
                  event.message,
              });

              state.plan =
                state.plan
                  .slice(-30);
            }

            const validation =
              validationState(
                state,
              );

            state.validationState = {
              ...validation,

              runStatus:
                'running',

              lastActivityAt:
                new Date()
                  .toISOString(),

              lastEvent: {
                type:
                  event?.type,
                turn:
                  event?.turn,
                tool,
                success:
                  result?.success,
              },
            };
          },
        );
      },
    );
  }

  async complete(
    stopReason: string,
  ): Promise<void> {
    await this.queue(
      async () => {
        await this.mutate(
          (state) => {
            const validation =
              validationState(
                state,
              );

            state.validationState = {
              ...validation,

              runStatus:
                'completed',

              stopReason,

              completedAt:
                new Date()
                  .toISOString(),
            };
          },
        );
      },
    );
  }

  async fail(
    message: string,
  ): Promise<void> {
    await this.queue(
      async () => {
        await this.mutate(
          (state) => {
            state.knownErrors ??=
              [];

            state.knownErrors
              .push({
                operation:
                  'agent.run',

                signature:
                  message.slice(
                    0,
                    1200,
                  ),
              });

            state.knownErrors =
              state.knownErrors
                .slice(-30);

            const validation =
              validationState(
                state,
              );

            state.validationState = {
              ...validation,

              runStatus:
                'failed',

              failedAt:
                new Date()
                  .toISOString(),
            };
          },
        );
      },
    );
  }
}
