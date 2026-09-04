import { createId, getPool } from '@dacai-local-agent/shared';
import { assertTemporalOrder } from '@dacai-local-agent/datasets';
import type { PredictionOutcome, PredictionRecord } from './predictions.js';
import { PredictionError } from './predictions.js';
import { ResearchScopeError, type TradeEvent, type TraderIdentity } from './trader-research.js';

/**
 * Persistence for market research observations and forecasts, over the tables
 * declared in migration 012.
 *
 * The invariants that matter are enforced in three places — the type layer, this
 * store, and CHECK constraints — because each catches a different mistake:
 * types catch a developer error, the store produces a readable message, and the
 * constraint stops a direct SQL write.
 */
export class MarketStore {
  async saveParticipant(identity: TraderIdentity): Promise<void> {
    if (identity.attribution && identity.attribution.evidence.length === 0) {
      throw new ResearchScopeError(
        `Refusing to attribute "${identity.participantId}" without cited public evidence.`,
      );
    }
    await getPool().query(
      `INSERT INTO market_participants (id, participant_kind, attributed_name, attribution_evidence, source_kinds, authorization_ref)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         participant_kind = $2, attributed_name = $3, attribution_evidence = $4,
         source_kinds = $5, authorization_ref = $6`,
      [
        identity.participantId,
        identity.kind,
        identity.attribution?.name ?? null,
        JSON.stringify(identity.attribution?.evidence ?? []),
        JSON.stringify(identity.sourceKinds),
        identity.authorizationRef ?? null,
      ],
    );
  }

  /**
   * Historical observations are validated for temporal ordering before they are
   * written. A record whose information predates its own event would poison
   * every split and backtest built on top of it.
   */
  async saveAction(event: TradeEvent): Promise<void> {
    assertTemporalOrder(event, event.id);

    if (event.statedRationale && event.statedRationale.assertionClass !== 'stated') {
      throw new ResearchScopeError(`statedRationale on ${event.id} must be a "stated" claim.`);
    }
    if (event.inferredRationale && event.inferredRationale.assertionClass !== 'inferred') {
      throw new ResearchScopeError(`inferredRationale on ${event.id} must be an "inferred" claim.`);
    }

    await getPool().query(
      `INSERT INTO market_actions (
         id, participant_id, instrument, direction, size_class, entry_time, exit_time,
         holding_period_ms, regime, context, stated_rationale, inferred_rationale, outcome,
         event_time, available_at, observed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        event.id, event.participantId, event.instrument, event.direction, event.sizeClass,
        event.entryTime, event.exitTime ?? null, event.holdingPeriodMs ?? null,
        event.context.regime, JSON.stringify(event.context),
        event.statedRationale ? JSON.stringify(event.statedRationale) : null,
        event.inferredRationale ? JSON.stringify(event.inferredRationale) : null,
        event.outcome ? JSON.stringify(event.outcome) : null,
        event.eventTime, event.availableAt, event.observedAt,
      ],
    );
  }

  /** Only actions knowable at `asOf`. Filters on availability, never event time. */
  async actionsVisibleAt(participantId: string, asOf: string): Promise<{ id: string; availableAt: string }[]> {
    const { rows } = await getPool().query(
      `SELECT id, available_at FROM market_actions
        WHERE participant_id = $1 AND available_at <= $2::timestamptz
        ORDER BY available_at`,
      [participantId, asOf],
    );
    return rows.map((r) => ({ id: r.id, availableAt: (r.available_at as Date).toISOString() }));
  }

  /**
   * Predictions are append-only. A second write for the same id is refused
   * rather than upserted — a forecast that can be edited after the fact is not
   * a forecast.
   */
  async savePrediction(record: PredictionRecord, domainId = 'forecasting'): Promise<void> {
    const existing = await getPool().query<{ prediction_hash: string }>(
      'SELECT prediction_hash FROM market_predictions WHERE id = $1',
      [record.predictionId],
    );
    if (existing.rows.length) {
      throw new PredictionError(
        existing.rows[0].prediction_hash === record.predictionHash
          ? `Prediction "${record.predictionId}" is already recorded.`
          : `Refusing to overwrite prediction "${record.predictionId}" with different content. Predictions are immutable.`,
      );
    }

    await getPool().query(
      `INSERT INTO market_predictions (
         id, domain_id, statement, instrument, probability, confidence, horizon_ms,
         conditions, invalidating_conditions, evidence, model_id, model_version,
         issued_at, resolves_at, prediction_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        record.predictionId, domainId, record.statement, record.instrument,
        record.probability, record.confidence, record.horizonMs,
        JSON.stringify(record.conditions), JSON.stringify(record.invalidatingConditions),
        JSON.stringify(record.evidence), record.modelId, record.modelVersion,
        record.issuedAt, record.resolvesAt, record.predictionHash,
      ],
    );
  }

  /**
   * The outcome binds to the prediction hash. If the forecast were ever edited,
   * the foreign key would no longer resolve and the tampering would be visible.
   */
  async saveOutcome(outcome: PredictionOutcome): Promise<void> {
    await getPool().query(
      `INSERT INTO market_prediction_outcomes (id, prediction_id, prediction_hash, status, realized_return, resolved_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        createId('out'), outcome.predictionId, outcome.predictionHash, outcome.status,
        outcome.realizedReturn ?? null, outcome.resolvedAt, outcome.notes ?? null,
      ],
    );
  }

  async getPrediction(predictionId: string): Promise<{ predictionHash: string; probability: number } | undefined> {
    const { rows } = await getPool().query(
      'SELECT prediction_hash, probability FROM market_predictions WHERE id = $1',
      [predictionId],
    );
    if (!rows.length) return undefined;
    return { predictionHash: rows[0].prediction_hash, probability: Number(rows[0].probability) };
  }

  async getOutcome(predictionId: string): Promise<{ status: string; predictionHash: string } | undefined> {
    const { rows } = await getPool().query(
      'SELECT status, prediction_hash FROM market_prediction_outcomes WHERE prediction_id = $1',
      [predictionId],
    );
    if (!rows.length) return undefined;
    return { status: rows[0].status, predictionHash: rows[0].prediction_hash };
  }
}
