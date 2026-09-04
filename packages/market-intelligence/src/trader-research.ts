import type { Claim } from '@dacai-local-agent/domain-knowledge';
import type { TemporalStamps } from '@dacai-local-agent/datasets';

/**
 * Research representation of market participant behaviour.
 *
 * Scope rules encoded here rather than left to prose:
 *
 *  - Participants are pseudonymous by default. A real-world identity may only
 *    be attached with cited public evidence, never inferred from an address.
 *  - Sources must be public or explicitly authorized. There is no field for
 *    private account data because it must not be collected.
 *  - Size is recorded as a class, not a raw notional, because the research
 *    question is behavioural and raw size invites mirroring.
 *  - Stated and inferred rationale are separate Claim fields and can never
 *    collapse into one another.
 *
 * This is a research schema. It intentionally produces no trade signal, no
 * ordering instruction, and no execution authority.
 */

export type ParticipantSourceKind =
  | 'public_onchain_activity'
  | 'authorized_account_export'
  | 'public_trade_disclosure'
  | 'public_portfolio_disclosure'
  | 'public_transaction_feed'
  | 'public_commentary'
  | 'public_market_research'
  | 'regulatory_disclosure'
  | 'timestamped_market_data';

export interface IdentityAttribution {
  /** Human-readable name being attributed to the pseudonym. */
  name: string;
  /** Public, checkable evidence. An attribution without evidence is refused. */
  evidence: readonly { kind: ParticipantSourceKind; locator: string }[];
}

export interface TraderIdentity {
  /** Stable pseudonymous handle. An address or account id is never the display identity. */
  participantId: string;
  kind: 'wallet' | 'account' | 'strategy' | 'institution-disclosure';
  /**
   * Absent unless a legitimate public attribution exists. Undefined means
   * "unknown", which is the correct and expected state for most participants.
   */
  attribution?: IdentityAttribution;
  sourceKinds: readonly ParticipantSourceKind[];
  /** Reference to the authorization record when a source required one. */
  authorizationRef?: string;
}

export class ResearchScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchScopeError';
  }
}

export function createTraderIdentity(identity: TraderIdentity): TraderIdentity {
  if (identity.attribution && identity.attribution.evidence.length === 0) {
    throw new ResearchScopeError(
      `Refusing to attribute participant "${identity.participantId}" to "${identity.attribution.name}" without cited public evidence.`,
    );
  }
  if (identity.sourceKinds.includes('authorized_account_export') && !identity.authorizationRef) {
    throw new ResearchScopeError(
      `Participant "${identity.participantId}" cites an authorized account export but carries no authorizationRef.`,
    );
  }
  return { ...identity, sourceKinds: [...identity.sourceKinds] };
}

export type Direction = 'long' | 'short' | 'flat';
export type SizeClass = 'minimal' | 'small' | 'moderate' | 'large' | 'dominant';
export type MarketRegime = 'trending-up' | 'trending-down' | 'range-bound' | 'high-volatility' | 'unknown';

export interface MarketContext {
  priceContext?: string;
  volumeContext?: string;
  volatilityContext?: string;
  onChainContext?: string;
  macroContext?: string;
  newsContext?: string;
  regime: MarketRegime;
}

export interface TradeOutcome {
  /** Realised return as a fraction, e.g. 0.043 for +4.3%. */
  return?: number;
  maximumAdverseExcursion?: number;
  maximumFavorableExcursion?: number;
  riskAdjustedOutcome?: number;
}

/**
 * One observed action by a participant, with its context and both rationales
 * kept apart.
 */
export interface TradeEvent extends TemporalStamps {
  id: string;
  participantId: string;
  instrument: string;
  direction: Direction;
  sizeClass: SizeClass;
  entryTime: string;
  exitTime?: string;
  holdingPeriodMs?: number;
  context: MarketContext;
  /** What the participant themselves said. Absent when they said nothing. */
  statedRationale?: Claim<string>;
  /** The platform's interpretation. Always inferred, always carries confidence. */
  inferredRationale?: Claim<string>;
  outcome?: TradeOutcome;
}

export function createTradeEvent(event: TradeEvent): TradeEvent {
  if (event.statedRationale && event.statedRationale.assertionClass !== 'stated') {
    throw new ResearchScopeError(
      `statedRationale on ${event.id} must be a "stated" claim, received "${event.statedRationale.assertionClass}".`,
    );
  }
  if (event.inferredRationale && event.inferredRationale.assertionClass !== 'inferred') {
    throw new ResearchScopeError(
      `inferredRationale on ${event.id} must be an "inferred" claim, received "${event.inferredRationale.assertionClass}".`,
    );
  }
  if (event.exitTime && Date.parse(event.exitTime) < Date.parse(event.entryTime)) {
    throw new ResearchScopeError(`Trade ${event.id} exits before it enters.`);
  }
  return event;
}

/**
 * Human-readable rendering that keeps the three layers visibly distinct. This
 * is the shape used in prompts and reports so a reader is never handed an
 * inferred motive that reads like a fact.
 */
export function describeTradeEvent(event: TradeEvent): string {
  const lines = [
    `OBSERVED: participant ${event.participantId} went ${event.direction} on ${event.instrument} ` +
      `(${event.sizeClass} size) at ${event.entryTime}; regime ${event.context.regime}.`,
  ];
  if (event.statedRationale) {
    lines.push(`STATED: ${event.statedRationale.value}`);
  }
  if (event.inferredRationale) {
    const confidence = event.inferredRationale.confidence ?? 0;
    lines.push(
      `INFERRED (confidence ${confidence.toFixed(2)}): ${event.inferredRationale.value}`,
    );
  }
  return lines.join('\n');
}
