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

export class ApprovalRegistry {
  private readonly waiters = new Map<string, Waiter>();

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

    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean) => {
        const waiter = this.waiters.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
        resolve(approved);
      };

      const timer = setTimeout(() => settle(false), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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

  /** Denies every outstanding request for a run — used when the client leaves. */
  cancelRun(runId: string): number {
    let cancelled = 0;
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.approval.runId !== runId) continue;
      waiter.resolve(false);
      cancelled += 1;
    }
    return cancelled;
  }

  pending(): PendingApproval[] {
    return [...this.waiters.values()].map((waiter) => waiter.approval);
  }
}
