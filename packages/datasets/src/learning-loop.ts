/**
 * The autonomous learning loop, as an explicit state machine.
 *
 * OBSERVE -> RETRIEVE -> ANALYZE -> HYPOTHESIZE -> SIMULATE -> COMPARE ->
 * STORE_EXPERIENCE -> QUALITY_REVIEW -> TRAINING_CANDIDATE -> APPROVAL ->
 * DATASET -> FINE_TUNE -> EVALUATE -> PROMOTED | REJECTED
 *
 * The hard rule this enforces: nothing reaches training by accident. Stages
 * advance one at a time (no skipping), APPROVAL requires a named human, and
 * promotion is reachable only from EVALUATE with a passing evaluation. An
 * observation cannot become a weight without every intermediate step having
 * been recorded.
 */

export type LoopStage =
  | 'observe'
  | 'retrieve'
  | 'analyze'
  | 'hypothesize'
  | 'simulate'
  | 'compare'
  | 'store_experience'
  | 'quality_review'
  | 'training_candidate'
  | 'approval'
  | 'dataset'
  | 'fine_tune'
  | 'evaluate'
  | 'promoted'
  | 'rejected';

const PIPELINE: readonly LoopStage[] = [
  'observe',
  'retrieve',
  'analyze',
  'hypothesize',
  'simulate',
  'compare',
  'store_experience',
  'quality_review',
  'training_candidate',
  'approval',
  'dataset',
  'fine_tune',
  'evaluate',
];

export const TERMINAL_STAGES: readonly LoopStage[] = ['promoted', 'rejected'];

export interface StageTransition {
  from: LoopStage;
  to: LoopStage;
  at: string;
  /** Required for the approval stage. */
  actor?: string;
  note?: string;
}

export class LearningLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningLoopError';
  }
}

export interface AdvanceOptions {
  /** Human identifier. Mandatory when entering `approval`. */
  actor?: string;
  note?: string;
  at?: string;
}

/**
 * Tracks one candidate through the loop. Deliberately not persisted here — the
 * state machine is pure so its invariants can be tested without a database.
 */
export class LearningLoopCandidate {
  private readonly transitions: StageTransition[] = [];
  private current: LoopStage = 'observe';

  constructor(readonly candidateId: string) {}

  get stage(): LoopStage {
    return this.current;
  }

  get history(): readonly StageTransition[] {
    return this.transitions;
  }

  get isTerminal(): boolean {
    return TERMINAL_STAGES.includes(this.current);
  }

  advance(options: AdvanceOptions = {}): LoopStage {
    if (this.isTerminal) {
      throw new LearningLoopError(
        `Candidate ${this.candidateId} is already ${this.current}; it cannot advance further.`,
      );
    }
    const index = PIPELINE.indexOf(this.current);
    const next = PIPELINE[index + 1];
    if (!next) {
      throw new LearningLoopError(
        `Candidate ${this.candidateId} is at the end of the pipeline; use promote() or reject().`,
      );
    }
    if (next === 'approval' && !options.actor) {
      throw new LearningLoopError(
        `Entering "approval" requires a named human actor. Automated approval is not permitted.`,
      );
    }
    this.record(this.current, next, options);
    this.current = next;
    return next;
  }

  /**
   * Jump straight to a later stage — refused. Present so the failure mode is a
   * clear error at the call site rather than a quiet shortcut into training.
   */
  advanceTo(target: LoopStage, options: AdvanceOptions = {}): LoopStage {
    const from = PIPELINE.indexOf(this.current);
    const to = PIPELINE.indexOf(target);
    if (to !== from + 1) {
      throw new LearningLoopError(
        `Refusing to move candidate ${this.candidateId} from "${this.current}" to "${target}". Stages advance one at a time.`,
      );
    }
    return this.advance(options);
  }

  promote(options: AdvanceOptions & { evaluationPassed: boolean }): LoopStage {
    if (this.current !== 'evaluate') {
      throw new LearningLoopError(
        `Promotion is only reachable from "evaluate"; candidate ${this.candidateId} is at "${this.current}".`,
      );
    }
    if (!options.evaluationPassed) {
      throw new LearningLoopError(
        `Refusing to promote candidate ${this.candidateId}: its evaluation did not pass.`,
      );
    }
    if (!options.actor) {
      throw new LearningLoopError(`Promotion requires a named actor.`);
    }
    this.record(this.current, 'promoted', options);
    this.current = 'promoted';
    return this.current;
  }

  /** Available from any non-terminal stage — a candidate can always be dropped. */
  reject(options: AdvanceOptions & { reason: string }): LoopStage {
    if (this.isTerminal) {
      throw new LearningLoopError(`Candidate ${this.candidateId} is already ${this.current}.`);
    }
    this.record(this.current, 'rejected', { ...options, note: options.reason });
    this.current = 'rejected';
    return this.current;
  }

  private record(from: LoopStage, to: LoopStage, options: AdvanceOptions): void {
    this.transitions.push({
      from,
      to,
      at: options.at ?? new Date().toISOString(),
      actor: options.actor,
      note: options.note,
    });
  }
}

/** True when the candidate's recorded history contains a human approval. */
export function hasHumanApproval(candidate: LearningLoopCandidate): boolean {
  return candidate.history.some((t) => t.to === 'approval' && Boolean(t.actor));
}
