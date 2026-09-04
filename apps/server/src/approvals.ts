import { randomUUID } from 'node:crypto';
import type { PermissionDecision } from '@dacai-local-agent/security';

/**
 * Pending human approvals for high-impact tool calls.
 *
 * The agent loop blocks on a promise here while the UI shows the exact command
 * and waits for a click. Everything about this is fail-closed: an unanswered
 * request denies on timeout, a disconnected client denies immediately, and an
 * unknown id resolves nothing. Approval is only ever granted by an explicit
 * decision arriving for a live request.
 *
 * The single exception is single-operator mode (DACAI_AUTO_APPROVE_ALL). Where
 * the only user is also the only approver, the click adds no safety — it just
 * expires while the operator is still reading the prompt — so the gate resolves
 * immediately instead. It stays opt-in and off by default, because it removes
 * the human check every other path here preserves.
 */

export interface PendingApproval {
  id: string;
  toolName: string;
  tier: string;
  reason: string;
  /** Redacted before it reaches here — never raw arguments. */
  input: Record<string, unknown>;
  requestedAt: string;
  runId: string;
}

interface Waiter {
  approval: PendingApproval;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalRequestInput {
  runId: string;
  toolName: string;
  decision: PermissionDecision;
  input: Record<string, unknown>;
  /** Deny automatically after this long with no answer. */
  timeoutMs?: number;
  onRequested?: (approval: PendingApproval) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ApprovalRegistryOptions {
  /** Resolve every approval-gated call immediately. Single-operator use only. */
  autoApproveAll?: boolean;
  /** Overrides the per-request deny-on-silence deadline. */
  defaultTimeoutMs?: number;
}

function truthy(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true' || value === '1';
}

/** Reads single-operator mode and the approval deadline from the environment. */
export function approvalOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ApprovalRegistryOptions {
  const configured = Number(env.DACAI_APPROVAL_TIMEOUT_MS);
  return {
    autoApproveAll: truthy(env.DACAI_AUTO_APPROVE_ALL),
    defaultTimeoutMs:
      Number.isFinite(configured) && configured > 0 ? configured : undefined,
  };
}

export class ApprovalRegistry {
  private readonly waiters = new Map<string, Waiter>();
  private readonly approveAllRuns = new Set<string>();
  private readonly autoApproveAll: boolean;
  private readonly defaultTimeoutMs: number;

  constructor(options: ApprovalRegistryOptions = {}) {
    this.autoApproveAll = options.autoApproveAll ?? false;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when the gate resolves everything without a human decision. */
  get isAutoApproving(): boolean {
    return this.autoApproveAll;
  }

  /**
   * Creates a pending request and resolves when a decision arrives, the
   * timeout expires, or the run is cancelled — whichever comes first.
   */
  request(input: ApprovalRequestInput): Promise<boolean> {
    // Unguessable id: an approval must not be forgeable by iterating numbers.
    const id = randomUUID();
    const approval: PendingApproval = {
      id,
      runId: input.runId,
      toolName: input.toolName,
      tier: input.decision.tier,
      reason: input.decision.reason,
      input: input.input,
      requestedAt: new Date().toISOString(),
    };

    // Single-operator mode still announces the call through onRequested, so the
    // activity journal records what ran and why. It just never parks the run
    // waiting for a click only this operator could give.
    if (this.autoApproveAll) {
      input.onRequested?.(approval);
      return Promise.resolve(true);
    }

    if (this.approveAllRuns.has(input.runId)) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        const waiter = this.waiters.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
        resolve(approved);
      };

      const timer = setTimeout(() => settle(false), input.timeoutMs ?? this.defaultTimeoutMs);
      this.waiters.set(id, { approval, resolve: settle, timer });

      input.onRequested?.(approval);
    });
  }

  /** Returns false when the id is unknown or already settled. */
  decide(id: string, approved: boolean): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    waiter.resolve(approved);
    return true;
  }

  /** Approve all current and future approval-gated calls for one live run. */
  approveAll(runId: string): number {
    this.approveAllRuns.add(runId);
    let approved = 0;
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.approval.runId !== runId) continue;
      waiter.resolve(true);
      approved += 1;
    }
    return approved;
  }

  /** Remove the run-scoped approval grant when the run ends. */
  clearRun(runId: string): void {
    this.approveAllRuns.delete(runId);
  }

  /** Denies every outstanding request for a run — used when the client leaves. */
  cancelRun(runId: string): number {
    let cancelled = 0;
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.approval.runId !== runId) continue;
      waiter.resolve(false);
      cancelled += 1;
    }
    this.clearRun(runId);
    return cancelled;
  }

  pending(): PendingApproval[] {
    return [...this.waiters.values()].map((waiter) => waiter.approval);
  }
}
