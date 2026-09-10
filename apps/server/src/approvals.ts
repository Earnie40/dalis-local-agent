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
 * There are two exceptions, both opt-in and off by default.
 *
 * The blunt one is single-operator mode (DACAI_AUTO_APPROVE_ALL). Where the
 * only user is also the only approver, the click adds no safety — it just
 * expires while the operator is still reading the prompt — so the gate resolves
 * immediately instead. It removes the human check on every call, everywhere.
 *
 * The narrow one is a scoped grant (`grantRun`). A prompt that already spells
 * out the work — "run the tests and commit" — has authorised those specific
 * tools at submission time, and re-asking per call is the same click the
 * operator already gave. So a run may pre-authorise an explicit list of tools
 * and nothing else: every tool outside the list, and every tool above the
 * granted tiers, still parks for a human. The grant is bounded three ways — by
 * tool name, optionally by call count, optionally by wall clock — and dies with
 * the run. Anything malformed matches nothing, so a bad grant fails closed
 * rather than open.
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

/**
 * The client payload for a pending approval.
 *
 * `runId` is not decoration: without it the UI cannot offer to settle the rest
 * of the run in one decision, so the operator is left approving every call by
 * hand. Building it from the approval itself — rather than assembling the
 * fields at each call site — is what keeps that field from going missing again.
 */
export function approvalRequestPayload(approval: PendingApproval): {
  id: string;
  runId: string;
  tool: string;
  tier: string;
  reason: string;
  input: Record<string, unknown>;
} {
  return {
    id: approval.id,
    runId: approval.runId,
    tool: approval.toolName,
    tier: approval.tier,
    reason: approval.reason,
    input: approval.input,
  };
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

/**
 * A run-scoped pre-authorisation for the specific tools a prompt asked for.
 *
 * Every field narrows; none widens. There is deliberately no wildcard — a grant
 * that cannot name the tools it covers is a grant nobody reasoned about, and
 * `approveAll` already exists for the case where the operator means "all of it".
 */
export interface ApprovalGrant {
  /** Exact tool names covered. Empty (or malformed) matches nothing. */
  tools: string[];
  /** Tiers this grant may auto-approve. Omitted means any tier these tools are
   *  gated at; supplying it is how a caller keeps, say, high-impact manual. */
  tiers?: string[];
  /** Stop auto-approving after this many calls. Omitted means no call cap. */
  maxCalls?: number;
  /** Epoch ms after which the grant no longer applies. */
  expiresAt?: number;
}

interface GrantState {
  tools: ReadonlySet<string>;
  tiers?: ReadonlySet<string>;
  maxCalls?: number;
  expiresAt?: number;
  used: number;
}

/** Drops anything unusable so a malformed grant can only ever narrow. */
function normalizeGrant(grant: ApprovalGrant): GrantState | undefined {
  const tools = Array.isArray(grant.tools)
    ? grant.tools.filter((name): name is string => typeof name === 'string' && name.length > 0)
    : [];
  if (tools.length === 0) return undefined;

  const tiers = Array.isArray(grant.tiers)
    ? grant.tiers.filter((tier): tier is string => typeof tier === 'string' && tier.length > 0)
    : undefined;

  const maxCalls =
    typeof grant.maxCalls === 'number' && Number.isFinite(grant.maxCalls) && grant.maxCalls > 0
      ? Math.floor(grant.maxCalls)
      : undefined;

  const expiresAt =
    typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt)
      ? grant.expiresAt
      : undefined;

  return {
    tools: new Set(tools),
    tiers: tiers && tiers.length > 0 ? new Set(tiers) : undefined,
    maxCalls,
    expiresAt,
    used: 0,
  };
}

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
  private readonly grants = new Map<string, GrantState>();
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

    // A scoped grant is announced the same way single-operator mode is, so the
    // activity journal still shows what ran and on whose authority.
    if (this.consumeGrant(input.runId, input.toolName, input.decision.tier)) {
      input.onRequested?.(approval);
      return Promise.resolve(true);
    }

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

  /**
   * Pre-authorise the named tools for one run — the tools a prompt already
   * asked for. Returns false when the grant carries no usable tool name, in
   * which case nothing is registered and every call still needs a human.
   *
   * Replaces any previous grant for the run rather than merging, so a second
   * call can only redefine the scope, never silently widen an existing one.
   */
  grantRun(runId: string, grant: ApprovalGrant): boolean {
    const normalized = normalizeGrant(grant);
    if (!normalized) {
      this.grants.delete(runId);
      return false;
    }
    this.grants.set(runId, normalized);
    return true;
  }

  /** The tools currently pre-authorised for a run, for display and audit. */
  grantedTools(runId: string): string[] {
    const grant = this.grants.get(runId);
    return grant ? [...grant.tools] : [];
  }

  /**
   * True when a live grant covers this exact call, counting it against the
   * grant's budget. Expiry and exhaustion drop the grant instead of lingering.
   */
  private consumeGrant(runId: string, toolName: string, tier: string): boolean {
    const grant = this.grants.get(runId);
    if (!grant) return false;

    if (grant.expiresAt !== undefined && Date.now() >= grant.expiresAt) {
      this.grants.delete(runId);
      return false;
    }
    if (!grant.tools.has(toolName)) return false;
    if (grant.tiers && !grant.tiers.has(tier)) return false;
    if (grant.maxCalls !== undefined && grant.used >= grant.maxCalls) {
      this.grants.delete(runId);
      return false;
    }

    grant.used += 1;
    if (grant.maxCalls !== undefined && grant.used >= grant.maxCalls) {
      this.grants.delete(runId);
    }
    return true;
  }

  /** Remove the run-scoped approval grants when the run ends. */
  clearRun(runId: string): void {
    this.approveAllRuns.delete(runId);
    this.grants.delete(runId);
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
