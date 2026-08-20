import type { EscalationMode } from '@dacai-local-agent/shared';

export interface EscalationPolicy {
  mode: EscalationMode;
  budgetUsd?: number;
  maxEscalationsPerSession?: number;
}

export interface ParallelTask {
  id: string;
  description: string;
  workerId: string;
}
