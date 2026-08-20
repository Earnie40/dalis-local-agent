import type { KillSwitchState, KillSwitchStateStore } from './live-validation-types.js';
import { FileKillSwitchStateStore } from './live-validation-audit.js';

export interface KillSwitchParticipant {
  emergencyStop(reason: string, operator: string, hardNetworkStop: boolean): Promise<void>;
}

export interface StopAllOptions {
  reason?: string;
  operator?: string;
  hardNetworkStop?: boolean;
}

export class LiveValidationStoppedError extends Error {
  constructor(message: string, public readonly state?: KillSwitchState) {
    super(message);
    this.name = 'LiveValidationStoppedError';
  }
}

function emergencyStopFromEnvironment(env: NodeJS.ProcessEnv): boolean {
  return ['true', '1', 'yes'].includes((env.TOMAHAWK1_EMERGENCY_STOP ?? '').toLowerCase());
}

/** Process-wide coordinator backed by a durable latch. */
export class LiveValidationKillSwitchCoordinator {
  private readonly participants = new Set<KillSwitchParticipant>();
  private loaded = false;
  private currentState: KillSwitchState | null = null;

  constructor(
    private readonly stateStore: KillSwitchStateStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.currentState = await this.stateStore.load();
    this.loaded = true;
  }

  async register(participant: KillSwitchParticipant): Promise<() => void> {
    await this.load();
    this.participants.add(participant);
    if (this.currentState?.stopped) {
      await participant.emergencyStop(this.currentState.reason, this.currentState.operator, false);
    }
    return () => this.participants.delete(participant);
  }

  async assertCanStart(): Promise<void> {
    await this.load();
    if (emergencyStopFromEnvironment(this.env)) {
      await this.stopAll({ reason: 'TOMAHAWK1_EMERGENCY_STOP environment latch is set.', operator: 'environment' });
    }
    if (this.currentState?.stopped) {
      throw new LiveValidationStoppedError(
        `LIVE_VALIDATION is stopped: ${this.currentState.reason}. An operator must explicitly restart it.`,
        this.currentState,
      );
    }
  }

  async stopAll(options: StopAllOptions = {}): Promise<KillSwitchState> {
    await this.load();
    const state: KillSwitchState = {
      stopped: true,
      reason: options.reason?.trim() || 'Operator requested emergency stop.',
      operator: options.operator?.trim() || 'unknown-operator',
      stoppedAt: new Date(),
    };
    this.currentState = state;
    // Begin persistence, but never wait for disk before cancelling live work.
    const persistence = this.stateStore.save(state);
    const stops = Promise.allSettled(
      [...this.participants].map((participant) =>
        participant.emergencyStop(state.reason, state.operator, Boolean(options.hardNetworkStop)),
      ),
    );
    await stops;
    // If persistence fails, callers learn that the durable latch is unhealthy,
    // but in-process workers have already been stopped fail-safe.
    await persistence;
    return structuredClone(state);
  }

  async restart(operator: string, acknowledgement: string): Promise<void> {
    await this.load();
    if (emergencyStopFromEnvironment(this.env)) {
      throw new LiveValidationStoppedError('Clear TOMAHAWK1_EMERGENCY_STOP before operator restart.');
    }
    if (!operator.trim() || acknowledgement.trim() !== 'RESTART LIVE VALIDATION') {
      throw new LiveValidationStoppedError(
        'Restart requires an operator identity and the exact acknowledgement "RESTART LIVE VALIDATION".',
      );
    }
    await this.stateStore.clear();
    this.currentState = null;
  }

  async getState(): Promise<KillSwitchState | null> {
    await this.load();
    return this.currentState ? structuredClone(this.currentState) : null;
  }
}

const globalKillSwitch = new LiveValidationKillSwitchCoordinator(new FileKillSwitchStateStore());

export function getGlobalLiveValidationKillSwitch(): LiveValidationKillSwitchCoordinator {
  return globalKillSwitch;
}

/** Runtime API used by the server route and by in-process supervisors. */
export async function stopAllLiveValidation(options: StopAllOptions = {}): Promise<KillSwitchState> {
  return globalKillSwitch.stopAll(options);
}

export async function restartAllLiveValidation(operator: string, acknowledgement: string): Promise<void> {
  return globalKillSwitch.restart(operator, acknowledgement);
}

export async function getLiveValidationStopState(): Promise<KillSwitchState | null> {
  return globalKillSwitch.getState();
}
