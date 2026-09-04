import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  StructuredGenerator,
  StructuredRequest,
  StructuredResult,
} from '@dacai-local-agent/providers';
import type {
  InvestmentExtraction,
  InvestmentSignalPipelineResult,
} from '@dacai-local-agent/investor-intelligence';

function loadEnv(): void {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {
    // DATABASE_URL may already be present in the test environment.
  }
}
loadEnv();

const { closePool, getPool, runMigrations } = await import('@dacai-local-agent/shared');
const {
  InvestmentFactExtractor,
  InvestmentPipeline,
  slugify,
} = await import('@dacai-local-agent/investor-intelligence');

const TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const RUN = `vcpipeline_${TOKEN}`;
const ids = {
  factSignal: `${RUN}_fact_signal`,
  noFactsSignal: `${RUN}_no_facts_signal`,
};
const names = {
  firm: `Pipeline Ventures ${TOKEN}`,
  company: `Pipeline Dynamics ${TOKEN}`,
  person: `Casey Morgan ${TOKEN}`,
  sector: `Orbital Systems ${TOKEN}`,
  topic: `Frontier Autonomy ${TOKEN}`,
};
const firmDomain = `pipelineventures${TOKEN}.example`;
const sourceUrl = `https://${firmDomain}/announcements/seed-round`;
const roundQuote = `${names.company} announced a $4.25 million seed round on January 7, 2026 led by ${names.firm}.`;
const founderQuote = `${names.person} founded ${names.company} and is a partner at ${names.firm}.`;
const sectorQuote = `${names.company} operates in ${names.sector}.`;
const thesisQuote = `${names.firm} invests in ${names.topic}.`;
const factExcerpt = [roundQuote, founderQuote, sectorQuote, thesisQuote].join(' ');
const noFactsExcerpt = 'This public update describes no venture investment activity or professional relationship.';
const sectorSlug = slugify(names.sector);
const topicSlug = slugify(names.topic);

const factExtraction: InvestmentExtraction = {
  entities: [
    {
      ref: 'firm_1',
      entityType: 'investment_firm',
      displayName: names.firm,
      identifiers: [{ kind: 'domain', value: firmDomain }],
      evidenceQuote: roundQuote,
    },
    {
      ref: 'company_1',
      entityType: 'company',
      displayName: names.company,
      // Deliberately unsafe for this company. The pipeline must not promote a
      // source owner/publisher's domain merely because the model copied it.
      identifiers: [{ kind: 'domain', value: firmDomain }],
      evidenceQuote: roundQuote,
    },
    {
      ref: 'person_1',
      entityType: 'person',
      displayName: names.person,
      identifiers: [],
      evidenceQuote: founderQuote,
    },
  ],
  sectors: [
    {
      ref: 'sector_1',
      label: names.sector,
      kind: 'sector',
      evidenceQuote: sectorQuote,
    },
    {
      ref: 'topic_1',
      label: names.topic,
      kind: 'investment_thesis',
      evidenceQuote: thesisQuote,
    },
  ],
  fundingRounds: [{
    ref: 'round_1',
    companyRef: 'company_1',
    roundType: 'seed',
    money: {
      currency: 'USD',
      amount: '4250000',
      sourceText: '$4.25 million',
    },
    evidenceQuote: roundQuote,
  }],
  facts: [
    {
      kind: 'round_participant',
      participantRef: 'firm_1',
      participantType: 'investment_firm',
      roundRef: 'round_1',
      role: 'lead',
      leadStatus: 'confirmed_lead',
      evidenceQuote: roundQuote,
    },
    {
      kind: 'founded',
      founderRef: 'person_1',
      companyRef: 'company_1',
      evidenceQuote: founderQuote,
    },
    {
      kind: 'partner_at',
      personRef: 'person_1',
      firmRef: 'firm_1',
      title: 'Partner',
      evidenceQuote: founderQuote,
    },
    {
      kind: 'operates_in',
      entityRef: 'company_1',
      sectorRef: 'sector_1',
      evidenceQuote: sectorQuote,
    },
    {
      kind: 'interested_in',
      entityRef: 'firm_1',
      sectorRef: 'topic_1',
      evidenceQuote: thesisQuote,
    },
  ],
};

const noFactsExtraction: InvestmentExtraction = {
  entities: [],
  sectors: [],
  fundingRounds: [],
  facts: [],
  noFactsReason: 'The document contains no supported venture investment facts.',
};

function fixedGenerator(
  extraction: InvestmentExtraction,
  onGenerate: () => void,
): Pick<StructuredGenerator, 'generate'> {
  return {
    async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
      onGenerate();
      return {
        value: request.schema.parse(extraction),
        alias: request.alias,
        model: 'fixture/investment-pipeline',
        providerInstanceId: `${RUN}_provider`,
        repaired: false,
        durationMs: 1,
      };
    },
  };
}

let dbAvailable = false;
let factGeneratorCalls = 0;
let noFactsGeneratorCalls = 0;
let persistedResult: InvestmentSignalPipelineResult;
let persistedRerun: InvestmentSignalPipelineResult;
let noFactsResult: InvestmentSignalPipelineResult;
let noFactsRerun: InvestmentSignalPipelineResult;

beforeAll(async () => {
  try {
    await getPool().query('SELECT 1');
    await runMigrations();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  await getPool().query(
    `INSERT INTO intelligence_signals (
       id, source_url, source_kind, title, excerpt, retrieved_at, content_hash,
       assertion_class, source_count, metadata
     ) VALUES
       ($1,$2,'public_investment_announcement','Pipeline seed round',$3,now(),$4,'observed',1,$5),
       ($6,$7,'public_news_article','Pipeline no-facts fixture',$8,now(),$9,'observed',1,$5)`,
    [
      ids.factSignal,
      sourceUrl,
      factExcerpt,
      `${RUN}_fact_hash`,
      JSON.stringify({ fixture: RUN }),
      ids.noFactsSignal,
      `https://example.test/${RUN}/no-facts`,
      noFactsExcerpt,
      `${RUN}_no_facts_hash`,
    ],
  );

  const factExtractor = new InvestmentFactExtractor(fixedGenerator(factExtraction, () => {
    factGeneratorCalls += 1;
  }));
  persistedResult = await new InvestmentPipeline(factExtractor).processSignal(ids.factSignal);
  // A new orchestrator instance proves the terminal boundary is durable in
  // PostgreSQL rather than held in process memory.
  persistedRerun = await new InvestmentPipeline(factExtractor).processSignal(ids.factSignal);

  const emptyExtractor = new InvestmentFactExtractor(fixedGenerator(noFactsExtraction, () => {
    noFactsGeneratorCalls += 1;
  }));
  noFactsResult = await new InvestmentPipeline(emptyExtractor).processSignal(ids.noFactsSignal);
  noFactsRerun = await new InvestmentPipeline(emptyExtractor).processSignal(ids.noFactsSignal);
});

afterAll(async () => {
  if (!dbAvailable) return;
  const pool = getPool();
  // Every canonical entity created by this test carries its unique source
  // signal. Removing those nodes first cascades their graph facts while the
  // signal still satisfies primary-signal RESTRICT constraints.
  await pool.query(
    `DELETE FROM intelligence_entities
      WHERE metadata->>'createdBy' = 'investment-pipeline'
        AND metadata->>'sourceSignalId' = $1`,
    [ids.factSignal],
  );
  await pool.query('DELETE FROM intelligence_signals WHERE id = ANY($1::text[])', [
    [ids.factSignal, ids.noFactsSignal],
  ]);
  await pool.query('DELETE FROM intelligence_topics WHERE slug = $1', [topicSlug]);
  await pool.query('DELETE FROM intelligence_sectors WHERE slug = $1', [sectorSlug]);
  await closePool();
});

const dbIt = (name: string, fn: () => Promise<void>) => it(name, async () => {
  if (!dbAvailable) {
    console.warn(`SKIPPED (no database): ${name}`);
    return;
  }
  await fn();
});

describe.sequential('InvestmentPipeline PostgreSQL integration', () => {
  dbIt('atomically persists typed graph facts with exact provenance and conservative identity', async () => {
    expect(persistedResult).toMatchObject({
      signalId: ids.factSignal,
      status: 'persisted',
      skipped: false,
    });
    expect(persistedResult.claimCount).toBeGreaterThan(0);
    expect(persistedResult.persistedCount).toBe(persistedResult.claimCount);

    const graph = await getPool().query<{
      entities: number;
      rounds: number;
      participants: number;
      relationships: number;
      sectors: number;
      persisted_claims: number;
    }>(
      `SELECT
         (SELECT count(*)::INTEGER FROM signal_entities WHERE signal_id = $1) AS entities,
         (SELECT count(*)::INTEGER FROM funding_round_sources WHERE signal_id = $1) AS rounds,
         (SELECT count(*)::INTEGER FROM funding_round_participant_sources WHERE signal_id = $1) AS participants,
         (SELECT count(*)::INTEGER FROM relationship_sources WHERE signal_id = $1) AS relationships,
         (SELECT count(*)::INTEGER FROM sector_assignment_sources WHERE signal_id = $1) AS sectors,
         (SELECT count(*)::INTEGER FROM intelligence_extraction_claims
           WHERE signal_id = $1 AND validation_status = 'persisted') AS persisted_claims`,
      [ids.factSignal],
    );
    expect(graph.rows[0]).toEqual({
      entities: 3,
      rounds: 1,
      participants: 1,
      relationships: 5,
      sectors: 1,
      persisted_claims: persistedResult.persistedCount,
    });

    const relationships = await getPool().query<{ relationship: string; evidence_text: string }>(
      `SELECT r.relationship, source.evidence_text
         FROM entity_relationships r
         JOIN relationship_sources source ON source.relationship_id = r.id
        WHERE source.signal_id = $1
        ORDER BY r.relationship`,
      [ids.factSignal],
    );
    expect(relationships.rows.map((row) => row.relationship)).toEqual([
      'founded',
      'interested_in',
      'invested_in',
      'operates_in',
      'partner_at',
    ]);
    expect(relationships.rows.every((row) => factExcerpt.includes(row.evidence_text))).toBe(true);

    const identifiers = await getPool().query<{
      entity_type: string;
      normalized_value: string;
      verified: boolean;
    }>(
      `SELECT entity.entity_type, identifier.normalized_value, identifier.verified
         FROM intelligence_entity_identifiers identifier
         JOIN intelligence_entities entity ON entity.id = identifier.entity_id
        WHERE identifier.source_signal_id = $1`,
      [ids.factSignal],
    );
    expect(identifiers.rows).toEqual([{
      entity_type: 'investment_firm',
      normalized_value: firmDomain,
      verified: true,
    }]);

    const enrichedRound = await getPool().query<{
      announced_on: string;
      announced_on_source: string;
    }>(
      `SELECT to_char(round.announced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS announced_on,
              round.metadata->>'announcedOnSource' AS announced_on_source
         FROM funding_rounds round
         JOIN funding_round_sources source ON source.funding_round_id = round.id
        WHERE source.signal_id = $1`,
      [ids.factSignal],
    );
    expect(enrichedRound.rows).toEqual([{
      announced_on: '2026-01-07',
      announced_on_source: 'evidence_quote_parser',
    }]);
  });

  dbIt('skips a persisted terminal signal without invoking extraction or duplicating graph rows', async () => {
    expect(persistedRerun).toMatchObject({ status: 'persisted', skipped: true });
    expect(factGeneratorCalls).toBe(1);

    const { rows } = await getPool().query<{
      attempt_count: number;
      rounds: number;
      participants: number;
      claims: number;
    }>(
      `SELECT extraction.attempt_count,
         (SELECT count(*)::INTEGER FROM funding_round_sources WHERE signal_id = $1) AS rounds,
         (SELECT count(*)::INTEGER FROM funding_round_participant_sources WHERE signal_id = $1) AS participants,
         (SELECT count(*)::INTEGER FROM intelligence_extraction_claims WHERE signal_id = $1) AS claims
       FROM intelligence_signal_extractions extraction
       WHERE extraction.signal_id = $1 AND extraction.schema_version = $2`,
      [ids.factSignal, persistedResult.schemaVersion],
    );
    expect(rows[0]).toEqual({
      attempt_count: 1,
      rounds: 1,
      participants: 1,
      claims: persistedResult.claimCount,
    });
  });

  dbIt('durably records no_facts and skips subsequent extraction attempts', async () => {
    expect(noFactsResult).toMatchObject({
      signalId: ids.noFactsSignal,
      status: 'no_facts',
      skipped: false,
      claimCount: 0,
      persistedCount: 0,
    });
    expect(noFactsRerun).toMatchObject({ status: 'no_facts', skipped: true });
    expect(noFactsGeneratorCalls).toBe(1);

    const { rows } = await getPool().query<{
      status: string;
      attempt_count: number;
      claim_count: number;
      persisted_count: number;
      completed: boolean;
      staged_claims: number;
    }>(
      `SELECT extraction.status, extraction.attempt_count, extraction.claim_count,
              extraction.persisted_count, extraction.completed_at IS NOT NULL AS completed,
              (SELECT count(*)::INTEGER FROM intelligence_extraction_claims claim
                WHERE claim.signal_id = extraction.signal_id) AS staged_claims
         FROM intelligence_signal_extractions extraction
        WHERE extraction.signal_id = $1 AND extraction.schema_version = $2`,
      [ids.noFactsSignal, noFactsResult.schemaVersion],
    );
    expect(rows[0]).toEqual({
      status: 'no_facts',
      attempt_count: 1,
      claim_count: 0,
      persisted_count: 0,
      completed: true,
      staged_claims: 0,
    });
  });

  dbIt('marks investment-created topic links without claiming theme extraction', async () => {
    const { rows } = await getPool().query<{
      slug: string;
      origins: string[];
      evidence_text: string;
    }>(
      `SELECT topic.slug, link.origins, source.evidence_text
         FROM intelligence_topics topic
         JOIN signal_topics link ON link.topic_id = topic.id
         JOIN entity_relationships relationship ON relationship.to_topic_id = topic.id
         JOIN relationship_sources source ON source.relationship_id = relationship.id
        WHERE link.signal_id = $1 AND source.signal_id = $1 AND topic.slug = $2`,
      [ids.factSignal, topicSlug],
    );
    expect(rows).toEqual([{
      slug: topicSlug,
      origins: ['investment_fact'],
      evidence_text: thesisQuote,
    }]);
  });
});
