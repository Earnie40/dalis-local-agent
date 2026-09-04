-- VC investment-activity knowledge graph.
--
-- This migration extends the PostgreSQL adjacency model introduced by 015. It
-- keeps free-form themes and existing entity relationships intact while adding
-- first-class funding rounds, evidence-backed participants, conservative entity
-- resolution, a normalized (but extensible) sector layer, and deterministic
-- derivations for portfolio and syndicate analysis.
--
-- Canonical investment facts live in funding_rounds and
-- funding_round_participants. portfolio_relationships remains a compatibility
-- aggregate; it is not used as a round event table.

-- ---------------------------------------------------------------------------
-- Entity identity and evidence-gated correction
-- ---------------------------------------------------------------------------

ALTER TABLE intelligence_entities
  DROP CONSTRAINT IF EXISTS intelligence_entities_type_check;

ALTER TABLE intelligence_entities
  ADD CONSTRAINT intelligence_entities_type_check
  CHECK (entity_type IN (
    'investment_firm', 'person', 'portfolio_company', 'strategic_company',
    'organization', 'community', 'publication', 'conference', 'government_body'
  ));

ALTER TABLE intelligence_entities
  ADD COLUMN IF NOT EXISTS canonical_name TEXT,
  ADD COLUMN IF NOT EXISTS normalized_name TEXT,
  ADD COLUMN IF NOT EXISTS domain TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS external_slug TEXT,
  ADD COLUMN IF NOT EXISTS headquarters_location TEXT;

UPDATE intelligence_entities
   SET canonical_name = COALESCE(NULLIF(btrim(canonical_name), ''), display_name),
       normalized_name = COALESCE(
         NULLIF(
           lower(btrim(regexp_replace(
             regexp_replace(replace(display_name, '&', ' and '), '[^a-z0-9]+', ' ', 'gi'),
             '\s+', ' ', 'g'
           ))),
           ''
         ),
         slug
       )
 WHERE canonical_name IS NULL OR btrim(canonical_name) = ''
    OR normalized_name IS NULL OR btrim(normalized_name) = '';

ALTER TABLE intelligence_entities
  ALTER COLUMN normalized_name SET NOT NULL;

ALTER TABLE intelligence_entities
  ADD CONSTRAINT intelligence_entities_domain_check
    CHECK (domain IS NULL OR (btrim(domain) <> '' AND domain = lower(domain))),
  ADD CONSTRAINT intelligence_entities_linkedin_url_check
    CHECK (linkedin_url IS NULL OR linkedin_url LIKE 'https://%linkedin.com/%'),
  ADD CONSTRAINT intelligence_entities_external_slug_check
    CHECK (external_slug IS NULL OR btrim(external_slug) <> ''),
  ADD CONSTRAINT intelligence_entities_person_has_no_headquarters
    CHECK (entity_type <> 'person' OR headquarters_location IS NULL);

CREATE INDEX IF NOT EXISTS intelligence_entities_normalized_name_idx
  ON intelligence_entities (entity_type, normalized_name);
CREATE INDEX IF NOT EXISTS intelligence_entities_domain_idx
  ON intelligence_entities (domain)
  WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS intelligence_entities_external_slug_idx
  ON intelligence_entities (external_slug)
  WHERE external_slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS intelligence_entity_aliases (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  alias             TEXT NOT NULL,
  normalized_alias  TEXT NOT NULL,
  alias_kind        TEXT NOT NULL DEFAULT 'common',
  source_signal_id  TEXT REFERENCES intelligence_signals (id) ON DELETE SET NULL,
  confidence        DOUBLE PRECISION,
  verified          BOOLEAN NOT NULL DEFAULT false,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (entity_id, normalized_alias),
  CONSTRAINT intelligence_entity_aliases_kind_check
    CHECK (alias_kind IN ('canonical', 'legal', 'common', 'acronym', 'former')),
  CONSTRAINT intelligence_entity_aliases_name_check
    CHECK (btrim(alias) <> '' AND btrim(normalized_alias) <> ''),
  CONSTRAINT intelligence_entity_aliases_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT intelligence_entity_aliases_observation_order
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS intelligence_entity_aliases_lookup_idx
  ON intelligence_entity_aliases (normalized_alias);
CREATE INDEX IF NOT EXISTS intelligence_entity_aliases_entity_idx
  ON intelligence_entity_aliases (entity_id, verified);

CREATE TABLE IF NOT EXISTS intelligence_entity_identifiers (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  identifier_kind   TEXT NOT NULL,
  raw_value         TEXT NOT NULL,
  normalized_value  TEXT NOT NULL,
  source_signal_id  TEXT REFERENCES intelligence_signals (id) ON DELETE SET NULL,
  confidence        DOUBLE PRECISION,
  verified          BOOLEAN NOT NULL DEFAULT false,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (identifier_kind, normalized_value),
  CONSTRAINT intelligence_entity_identifiers_kind_check
    CHECK (identifier_kind IN (
      'domain', 'website_url', 'linkedin_url', 'external_slug', 'external_id'
    )),
  CONSTRAINT intelligence_entity_identifiers_value_check
    CHECK (btrim(raw_value) <> '' AND btrim(normalized_value) <> ''),
  CONSTRAINT intelligence_entity_identifiers_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT intelligence_entity_identifiers_observation_order
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS intelligence_entity_identifiers_entity_idx
  ON intelligence_entity_identifiers (entity_id, verified);

CREATE TABLE IF NOT EXISTS intelligence_entity_corrections (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  previous_type  TEXT NOT NULL,
  corrected_type TEXT NOT NULL,
  signal_id      TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE RESTRICT,
  rationale      TEXT NOT NULL,
  corrected_by   TEXT NOT NULL,
  corrected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (entity_id, previous_type, corrected_type, signal_id),
  CONSTRAINT intelligence_entity_corrections_type_change
    CHECK (previous_type <> corrected_type),
  CONSTRAINT intelligence_entity_corrections_rationale_check
    CHECK (btrim(rationale) <> '' AND btrim(corrected_by) <> '')
);

CREATE INDEX IF NOT EXISTS intelligence_entity_corrections_entity_idx
  ON intelligence_entity_corrections (entity_id, corrected_at DESC);

-- The current Shahin Farshchi row can be corrected without trusting its name
-- alone: an already-ingested official Lux Capital professional profile is
-- attached to the entity. Record that evidence before changing the type.
INSERT INTO intelligence_entity_corrections (
  id, entity_id, previous_type, corrected_type, signal_id, rationale, corrected_by,
  metadata
)
SELECT
  'cor_' || substr(md5(e.id || ':' || official_signal.id || ':person'), 1, 20),
  e.id,
  e.entity_type,
  'person',
  official_signal.id,
  'Official Lux Capital professional profile identifies Shahin Farshchi as a person; correcting an investment_firm classification.',
  'migration:024_vc_investment_graph',
  jsonb_build_object('source_url', official_signal.source_url)
FROM intelligence_entities e
JOIN LATERAL (
  SELECT s.id, s.source_url
    FROM signal_entities se
    JOIN intelligence_signals s ON s.id = se.signal_id
   WHERE se.entity_id = e.id
     AND lower(rtrim(s.source_url, '/')) = 'https://www.luxcapital.com/people/shahin-farshchi'
   ORDER BY coalesce(s.published_at, s.retrieved_at), s.id
   LIMIT 1
) official_signal ON true
WHERE e.slug = 'shahin-farshchi'
  AND e.entity_type = 'investment_firm'
ON CONFLICT DO NOTHING;

UPDATE intelligence_entities e
   SET entity_type = 'person',
       primary_url = 'https://www.luxcapital.com/people/shahin-farshchi',
       updated_at = now()
 WHERE e.slug = 'shahin-farshchi'
   AND e.entity_type = 'investment_firm'
   AND EXISTS (
     SELECT 1
       FROM intelligence_entity_corrections c
      WHERE c.entity_id = e.id
        AND c.previous_type = 'investment_firm'
        AND c.corrected_type = 'person'
        AND c.corrected_by = 'migration:024_vc_investment_graph'
   );

-- Existing canonical names remain resolvable immediately after migration.
INSERT INTO intelligence_entity_aliases (
  id, entity_id, alias, normalized_alias, alias_kind, verified, metadata
)
SELECT
  'alias_' || substr(md5(id || ':' || normalized_name), 1, 20),
  id,
  display_name,
  normalized_name,
  'canonical',
  true,
  jsonb_build_object('origin', 'intelligence_entities.display_name')
FROM intelligence_entities
ON CONFLICT (entity_id, normalized_alias) DO NOTHING;

-- A primary URL is a useful candidate key, but legacy rows did not require
-- evidence when it was entered. Backfill it as unverified; the resolver may
-- promote it only after matching public evidence.
INSERT INTO intelligence_entity_identifiers (
  id, entity_id, identifier_kind, raw_value, normalized_value, verified, metadata
)
SELECT
  'eid_' || substr(md5(id || ':' || lower(rtrim(primary_url, '/'))), 1, 20),
  id,
  CASE WHEN lower(primary_url) LIKE '%linkedin.com/%' THEN 'linkedin_url' ELSE 'website_url' END,
  primary_url,
  lower(rtrim(primary_url, '/')),
  false,
  jsonb_build_object('origin', 'intelligence_entities.primary_url')
FROM intelligence_entities
WHERE primary_url LIKE 'https://%'
ON CONFLICT (identifier_kind, normalized_value) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Typed extraction staging
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_signal_extractions (
  signal_id            TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  schema_version       TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  extractor_model      TEXT,
  provider_instance_id TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 1,
  claim_count          INTEGER NOT NULL DEFAULT 0,
  persisted_count      INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (signal_id, schema_version),
  CONSTRAINT intelligence_signal_extractions_version_check
    CHECK (btrim(schema_version) <> ''),
  CONSTRAINT intelligence_signal_extractions_status_check
    CHECK (status IN (
      'pending', 'validated', 'ambiguous', 'rejected', 'persisted',
      'no_facts', 'failed'
    )),
  CONSTRAINT intelligence_signal_extractions_count_check
    CHECK (
      attempt_count > 0 AND claim_count >= 0 AND persisted_count >= 0
      AND persisted_count <= claim_count
    ),
  CONSTRAINT intelligence_signal_extractions_no_facts_check
    CHECK (status <> 'no_facts' OR (claim_count = 0 AND persisted_count = 0)),
  CONSTRAINT intelligence_signal_extractions_failed_error_check
    CHECK (status <> 'failed' OR (error IS NOT NULL AND btrim(error) <> '')),
  CONSTRAINT intelligence_signal_extractions_completion_check
    CHECK (status = 'pending' OR completed_at IS NOT NULL),
  CONSTRAINT intelligence_signal_extractions_completion_time_check
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS intelligence_signal_extractions_status_idx
  ON intelligence_signal_extractions (status, updated_at);

CREATE TABLE IF NOT EXISTS intelligence_extraction_claims (
  id                    TEXT PRIMARY KEY,
  signal_id             TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  schema_version        TEXT NOT NULL DEFAULT 'vc-v1',
  claim_kind            TEXT NOT NULL,
  claim_fingerprint     TEXT NOT NULL,
  payload               JSONB NOT NULL,
  evidence_text         TEXT NOT NULL,
  extraction_confidence DOUBLE PRECISION NOT NULL,
  validation_status     TEXT NOT NULL DEFAULT 'pending',
  validation_reason     TEXT,
  extractor_model       TEXT,
  provider_instance_id  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at          TIMESTAMPTZ,
  persisted_at          TIMESTAMPTZ,
  CONSTRAINT intelligence_extraction_claims_fingerprint_key
    UNIQUE (signal_id, schema_version, claim_fingerprint),
  CONSTRAINT intelligence_extraction_claims_version_check
    CHECK (btrim(schema_version) <> ''),
  CONSTRAINT intelligence_extraction_claims_kind_check
    CHECK (btrim(claim_kind) <> '' AND btrim(claim_fingerprint) <> ''),
  CONSTRAINT intelligence_extraction_claims_evidence_check
    CHECK (btrim(evidence_text) <> ''),
  CONSTRAINT intelligence_extraction_claims_confidence_range
    CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
  CONSTRAINT intelligence_extraction_claims_status_check
    CHECK (validation_status IN ('pending', 'validated', 'ambiguous', 'rejected', 'persisted')),
  CONSTRAINT intelligence_extraction_claims_validation_time_check
    CHECK (validated_at IS NULL OR validated_at >= created_at),
  CONSTRAINT intelligence_extraction_claims_persistence_time_check
    CHECK (persisted_at IS NULL OR persisted_at >= created_at)
);

CREATE INDEX IF NOT EXISTS intelligence_extraction_claims_status_idx
  ON intelligence_extraction_claims (validation_status, created_at);
CREATE INDEX IF NOT EXISTS intelligence_extraction_claims_signal_idx
  ON intelligence_extraction_claims (signal_id, claim_kind);

-- ---------------------------------------------------------------------------
-- Temporal and idempotent general graph edges
-- ---------------------------------------------------------------------------

ALTER TABLE entity_relationships
  ADD COLUMN IF NOT EXISTS relationship_basis TEXT,
  ADD COLUMN IF NOT EXISTS to_sector_id TEXT,
  ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_from DATE,
  ADD COLUMN IF NOT EXISTS valid_to DATE,
  ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE entity_relationships
  DROP CONSTRAINT IF EXISTS entity_relationships_target_check;

ALTER TABLE entity_relationships
  ADD CONSTRAINT entity_relationships_target_check
    CHECK (num_nonnulls(to_entity_id, to_topic_id, to_sector_id) = 1);

UPDATE entity_relationships
   SET relationship_basis = CASE
     WHEN relationship IN ('horizon_for', 'developing') THEN 'proposed_capability'
     WHEN assertion_class = 'stated' THEN 'internal_claim'
     WHEN assertion_class IN ('inferred', 'estimated', 'predicted') THEN 'inference'
     ELSE 'source_fact'
   END
 WHERE relationship_basis IS NULL;

ALTER TABLE entity_relationships
  ALTER COLUMN relationship_basis SET DEFAULT 'source_fact',
  ALTER COLUMN relationship_basis SET NOT NULL;

ALTER TABLE entity_relationships
  ADD CONSTRAINT entity_relationships_basis_check
    CHECK (relationship_basis IN (
      'source_fact', 'derived_fact', 'inference', 'internal_claim', 'proposed_capability'
    )),
  ADD CONSTRAINT entity_relationships_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  ADD CONSTRAINT entity_relationships_validity_order
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT entity_relationships_observation_order
    CHECK (last_observed_at >= first_observed_at),
  ADD CONSTRAINT entity_relationships_idempotency_key_check
    CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '');

-- Backfill one canonical key per pre-existing semantic edge. If an older
-- database already contains duplicates, leave later copies unkeyed so migration
-- remains additive and auditable instead of deleting history.
WITH ranked_relationships AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY from_entity_id, relationship, to_entity_id, to_topic_id, to_sector_id, relationship_basis
      ORDER BY created_at, id
    ) AS occurrence,
    'rel:' || encode(sha256(
      convert_to(from_entity_id, 'UTF8') || decode('00', 'hex') ||
      convert_to(coalesce(to_entity_id, ''), 'UTF8') || decode('00', 'hex') ||
      convert_to(coalesce(to_topic_id, ''), 'UTF8') || decode('00', 'hex') ||
      convert_to(coalesce(to_sector_id, ''), 'UTF8') || decode('00', 'hex') ||
      convert_to(relationship, 'UTF8') || decode('00', 'hex') ||
      convert_to(relationship_basis, 'UTF8') || decode('00', 'hex') ||
      convert_to(coalesce(valid_from::text, ''), 'UTF8') || decode('00', 'hex') ||
      convert_to(coalesce(valid_to::text, ''), 'UTF8')
    ), 'hex') AS canonical_key
  FROM entity_relationships
  WHERE idempotency_key IS NULL
)
UPDATE entity_relationships r
   SET idempotency_key = ranked_relationships.canonical_key
  FROM ranked_relationships
 WHERE r.id = ranked_relationships.id
   AND ranked_relationships.occurrence = 1;

CREATE UNIQUE INDEX IF NOT EXISTS entity_relationships_idempotency_idx
  ON entity_relationships (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_relationships_temporal_idx
  ON entity_relationships (from_entity_id, relationship, effective_at DESC NULLS LAST);

ALTER TABLE relationship_sources
  ADD COLUMN IF NOT EXISTS extraction_claim_id TEXT
    REFERENCES intelligence_extraction_claims (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_text TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS relationship_sources_signal_idx
  ON relationship_sources (signal_id, relationship_id);

-- ---------------------------------------------------------------------------
-- Funding rounds and their evidence-backed participants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS funding_rounds (
  id                     TEXT PRIMARY KEY,
  company_entity_id      TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  round_key              TEXT NOT NULL UNIQUE,
  round_type             TEXT NOT NULL DEFAULT 'unknown',
  announced_at           TIMESTAMPTZ,
  amount                 NUMERIC(24, 2),
  currency               TEXT,
  pre_money_valuation    NUMERIC(24, 2),
  post_money_valuation   NUMERIC(24, 2),
  assertion_class        TEXT NOT NULL DEFAULT 'observed',
  confidence             DOUBLE PRECISION,
  primary_signal_id      TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE RESTRICT,
  first_observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT funding_rounds_key_check CHECK (btrim(round_key) <> ''),
  CONSTRAINT funding_rounds_type_check
    CHECK (round_type IN (
      'pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'growth',
      'strategic', 'venture', 'unknown'
    )),
  CONSTRAINT funding_rounds_assertion_check
    CHECK (assertion_class IN ('observed', 'stated')),
  CONSTRAINT funding_rounds_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT funding_rounds_amount_check CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT funding_rounds_pre_money_check
    CHECK (pre_money_valuation IS NULL OR pre_money_valuation >= 0),
  CONSTRAINT funding_rounds_post_money_check
    CHECK (post_money_valuation IS NULL OR post_money_valuation >= 0),
  CONSTRAINT funding_rounds_currency_check
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT funding_rounds_observation_order
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS funding_rounds_company_date_idx
  ON funding_rounds (company_entity_id, announced_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS funding_rounds_date_type_idx
  ON funding_rounds (announced_at DESC NULLS LAST, round_type);

CREATE TABLE IF NOT EXISTS funding_round_sources (
  funding_round_id   TEXT NOT NULL REFERENCES funding_rounds (id) ON DELETE CASCADE,
  signal_id          TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  extraction_claim_id TEXT REFERENCES intelligence_extraction_claims (id) ON DELETE SET NULL,
  evidence_text      TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (funding_round_id, signal_id),
  CONSTRAINT funding_round_sources_evidence_check CHECK (btrim(evidence_text) <> '')
);

CREATE INDEX IF NOT EXISTS funding_round_sources_signal_idx
  ON funding_round_sources (signal_id, funding_round_id);

CREATE TABLE IF NOT EXISTS funding_round_participants (
  id                TEXT PRIMARY KEY,
  funding_round_id  TEXT NOT NULL REFERENCES funding_rounds (id) ON DELETE CASCADE,
  entity_id         TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  participant_type  TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'unknown',
  lead_status       TEXT NOT NULL DEFAULT 'unknown',
  assertion_class   TEXT NOT NULL DEFAULT 'observed',
  confidence        DOUBLE PRECISION,
  primary_signal_id TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE RESTRICT,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (funding_round_id, entity_id),
  CONSTRAINT funding_round_participants_type_check
    CHECK (participant_type IN ('investment_firm', 'person')),
  CONSTRAINT funding_round_participants_role_check
    CHECK (role IN ('lead', 'participant', 'associated_partner', 'unknown')),
  CONSTRAINT funding_round_participants_lead_status_check
    CHECK (lead_status IN ('confirmed_lead', 'confirmed_not_lead', 'unknown')),
  CONSTRAINT funding_round_participants_lead_consistency
    CHECK (
      (role = 'lead' AND lead_status = 'confirmed_lead')
      OR (role <> 'lead' AND lead_status <> 'confirmed_lead')
    ),
  CONSTRAINT funding_round_participants_assertion_check
    CHECK (assertion_class IN ('observed', 'stated')),
  CONSTRAINT funding_round_participants_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT funding_round_participants_observation_order
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS funding_round_participants_entity_idx
  ON funding_round_participants (entity_id, funding_round_id);
CREATE INDEX IF NOT EXISTS funding_round_participants_round_idx
  ON funding_round_participants (funding_round_id, role);

CREATE TABLE IF NOT EXISTS funding_round_participant_sources (
  participant_id     TEXT NOT NULL REFERENCES funding_round_participants (id) ON DELETE CASCADE,
  signal_id          TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  extraction_claim_id TEXT REFERENCES intelligence_extraction_claims (id) ON DELETE SET NULL,
  evidence_text      TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, signal_id),
  CONSTRAINT funding_round_participant_sources_evidence_check
    CHECK (btrim(evidence_text) <> '')
);

CREATE INDEX IF NOT EXISTS funding_round_participant_sources_signal_idx
  ON funding_round_participant_sources (signal_id, participant_id);

-- ---------------------------------------------------------------------------
-- Normalized sectors alongside free-form intelligence_topics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_sectors (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  label            TEXT NOT NULL,
  description      TEXT,
  parent_sector_id TEXT REFERENCES intelligence_sectors (id) ON DELETE SET NULL,
  active           BOOLEAN NOT NULL DEFAULT true,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_sectors_slug_check CHECK (btrim(slug) <> ''),
  CONSTRAINT intelligence_sectors_label_check CHECK (btrim(label) <> ''),
  CONSTRAINT intelligence_sectors_not_self_parent CHECK (parent_sector_id IS NULL OR parent_sector_id <> id)
);

CREATE INDEX IF NOT EXISTS intelligence_sectors_parent_idx
  ON intelligence_sectors (parent_sector_id, active);

ALTER TABLE entity_relationships
  ADD CONSTRAINT entity_relationships_to_sector_id_fkey
    FOREIGN KEY (to_sector_id) REFERENCES intelligence_sectors (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS entity_relationships_to_sector_idx
  ON entity_relationships (to_sector_id)
  WHERE to_sector_id IS NOT NULL;

INSERT INTO intelligence_sectors (id, slug, label, description, metadata) VALUES
  ('sec_artificial_intelligence', 'artificial-intelligence', 'Artificial Intelligence', 'Artificial intelligence systems, models, and applications.', '{"operatorSeeded":true}'::jsonb),
  ('sec_ai_infrastructure', 'ai-infrastructure', 'AI Infrastructure', 'Compute, data, tooling, and systems that support AI development and operation.', '{"operatorSeeded":true}'::jsonb),
  ('sec_aerospace', 'aerospace', 'Aerospace', 'Aircraft, launch, propulsion, avionics, and related aerospace systems.', '{"operatorSeeded":true}'::jsonb),
  ('sec_space', 'space', 'Space', 'Space infrastructure, spacecraft, satellites, and space-enabled services.', '{"operatorSeeded":true}'::jsonb),
  ('sec_defense', 'defense', 'Defense', 'Defense technologies, systems, and mission capabilities.', '{"operatorSeeded":true}'::jsonb),
  ('sec_autonomy', 'autonomy', 'Autonomy', 'Autonomous machines, vehicles, agents, and control systems.', '{"operatorSeeded":true}'::jsonb),
  ('sec_robotics', 'robotics', 'Robotics', 'Robotic hardware, software, perception, and manipulation.', '{"operatorSeeded":true}'::jsonb),
  ('sec_cybersecurity', 'cybersecurity', 'Cybersecurity', 'Security products, infrastructure, identity, and resilience.', '{"operatorSeeded":true}'::jsonb),
  ('sec_semiconductors', 'semiconductors', 'Semiconductors', 'Chips, semiconductor design, manufacturing, packaging, and tooling.', '{"operatorSeeded":true}'::jsonb),
  ('sec_energy', 'energy', 'Energy', 'Energy generation, storage, transmission, and enabling technologies.', '{"operatorSeeded":true}'::jsonb),
  ('sec_biotechnology', 'biotechnology', 'Biotechnology', 'Biological engineering, therapeutics, diagnostics, and life-science platforms.', '{"operatorSeeded":true}'::jsonb),
  ('sec_climate', 'climate', 'Climate', 'Climate mitigation, adaptation, measurement, and resource efficiency.', '{"operatorSeeded":true}'::jsonb),
  ('sec_fintech', 'fintech', 'Fintech', 'Financial products, infrastructure, insurance, and capital-markets technology.', '{"operatorSeeded":true}'::jsonb),
  ('sec_enterprise_software', 'enterprise-software', 'Enterprise Software', 'Software and platforms serving organizational workflows and operations.', '{"operatorSeeded":true}'::jsonb),
  ('sec_consumer', 'consumer', 'Consumer', 'Products, services, and platforms primarily serving individual consumers.', '{"operatorSeeded":true}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS entity_sector_assignments (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  sector_id         TEXT NOT NULL REFERENCES intelligence_sectors (id) ON DELETE CASCADE,
  assignment_basis  TEXT NOT NULL,
  assertion_class   TEXT NOT NULL,
  confidence        DOUBLE PRECISION,
  primary_signal_id TEXT REFERENCES intelligence_signals (id) ON DELETE RESTRICT,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (entity_id, sector_id, assignment_basis),
  CONSTRAINT entity_sector_assignments_basis_check
    CHECK (assignment_basis IN (
      'source_fact', 'investment_derived', 'public_signal_inference', 'operator'
    )),
  CONSTRAINT entity_sector_assignments_assertion_check
    CHECK (assertion_class IN ('observed', 'stated', 'inferred', 'estimated', 'predicted')),
  CONSTRAINT entity_sector_assignments_inferred_needs_confidence
    CHECK (
      assertion_class NOT IN ('inferred', 'estimated', 'predicted')
      OR confidence IS NOT NULL
    ),
  CONSTRAINT entity_sector_assignments_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT entity_sector_assignments_source_fact_needs_signal
    CHECK (assignment_basis <> 'source_fact' OR primary_signal_id IS NOT NULL),
  CONSTRAINT entity_sector_assignments_observation_order
    CHECK (last_observed_at >= first_observed_at)
);

CREATE INDEX IF NOT EXISTS entity_sector_assignments_entity_idx
  ON entity_sector_assignments (entity_id, assignment_basis, computed_at DESC);
CREATE INDEX IF NOT EXISTS entity_sector_assignments_sector_idx
  ON entity_sector_assignments (sector_id, assignment_basis, computed_at DESC);

CREATE TABLE IF NOT EXISTS sector_assignment_sources (
  assignment_id      TEXT NOT NULL REFERENCES entity_sector_assignments (id) ON DELETE CASCADE,
  signal_id           TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  extraction_claim_id TEXT REFERENCES intelligence_extraction_claims (id) ON DELETE SET NULL,
  evidence_text       TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, signal_id),
  CONSTRAINT sector_assignment_sources_evidence_check CHECK (btrim(evidence_text) <> '')
);

CREATE INDEX IF NOT EXISTS sector_assignment_sources_signal_idx
  ON sector_assignment_sources (signal_id, assignment_id);

-- ---------------------------------------------------------------------------
-- Legacy portfolio compatibility aggregate
-- ---------------------------------------------------------------------------

ALTER TABLE portfolio_relationships
  ADD COLUMN IF NOT EXISTS first_invested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_invested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS round_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latest_round_id TEXT REFERENCES funding_rounds (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disclosed_amounts_by_currency JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE portfolio_relationships
   SET first_invested_at = COALESCE(first_invested_at, announced_at),
       last_invested_at = COALESCE(last_invested_at, announced_at),
       round_count = CASE WHEN round_count = 0 THEN 1 ELSE round_count END,
       updated_at = now();

ALTER TABLE portfolio_relationships
  ADD CONSTRAINT portfolio_relationships_round_count_check CHECK (round_count >= 0),
  ADD CONSTRAINT portfolio_relationships_investment_order
    CHECK (
      last_invested_at IS NULL OR first_invested_at IS NULL
      OR last_invested_at >= first_invested_at
    ),
  ADD CONSTRAINT portfolio_relationships_disclosed_amounts_object
    CHECK (jsonb_typeof(disclosed_amounts_by_currency) = 'object');

CREATE INDEX IF NOT EXISTS portfolio_relationships_investor_recent_idx
  ON portfolio_relationships (investor_entity_id, last_invested_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS portfolio_relationships_company_recent_idx
  ON portfolio_relationships (company_entity_id, last_invested_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- Canonical, non-duplicated co-investment derivation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW co_investor_relationships AS
SELECT
  participant_a.entity_id AS firm_a_id,
  participant_b.entity_id AS firm_b_id,
  count(DISTINCT rounds.id)::INTEGER AS shared_round_count,
  count(DISTINCT rounds.company_entity_id)::INTEGER AS shared_company_count,
  min(rounds.announced_at) AS first_shared_round_at,
  max(rounds.announced_at) AS last_shared_round_at,
  array_agg(DISTINCT rounds.id ORDER BY rounds.id) AS shared_round_ids,
  array_agg(DISTINCT rounds.company_entity_id ORDER BY rounds.company_entity_id) AS shared_company_ids
FROM funding_round_participants participant_a
JOIN funding_round_participants participant_b
  ON participant_b.funding_round_id = participant_a.funding_round_id
 AND participant_a.entity_id < participant_b.entity_id
JOIN funding_rounds rounds
  ON rounds.id = participant_a.funding_round_id
JOIN intelligence_entities firm_a
  ON firm_a.id = participant_a.entity_id
 AND firm_a.entity_type = 'investment_firm'
JOIN intelligence_entities firm_b
  ON firm_b.id = participant_b.entity_id
 AND firm_b.entity_type = 'investment_firm'
WHERE participant_a.participant_type = 'investment_firm'
  AND participant_b.participant_type = 'investment_firm'
  AND participant_a.assertion_class IN ('observed', 'stated')
  AND participant_b.assertion_class IN ('observed', 'stated')
GROUP BY participant_a.entity_id, participant_b.entity_id;

COMMENT ON VIEW co_investor_relationships IS
  'Canonical unordered firm pairs derived from shared evidence-backed funding-round participation; firm_a_id is lexically less than firm_b_id.';
