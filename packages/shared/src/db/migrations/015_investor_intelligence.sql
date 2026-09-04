-- DACAIS Investor Signal & Visibility Intelligence.
--
-- Public ecosystem signals -> themes -> relationship graph -> DACAIS capability
-- and evidence -> scored content opportunities -> drafts -> human approval.
--
-- Additive only. Nothing here alters an existing table. Signals reuse the one
-- pgvector corpus (knowledge_documents/knowledge_chunks) rather than introducing
-- a second vector store; intelligence_signals.knowledge_document_id is the join.
--
-- The CHECK constraints are the point. Three invariants must hold even against a
-- direct SQL insert, because they are the difference between research and
-- either surveillance or fraud:
--
--   1. An "observed" claim must cite a source. Provenance is not optional.
--   2. A capability that is not verified cannot be marked publicly shareable.
--   3. Content cannot reach PUBLISHED without a named human approver.
--
-- Mirrors packages/domain-knowledge/src/provenance.ts (AssertionClass) and the
-- capability status ladder in packages/investor-intelligence/src/capabilities.ts.

-- ---------------------------------------------------------------------------
-- Entities: firms, people, portfolio companies, communities, publications
--
-- Everything is database-driven. Adding a firm is an INSERT, never a code change.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_entities (
  id                     TEXT PRIMARY KEY,
  entity_type            TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  -- Stable slug for lookup and de-duplication across sources.
  slug                   TEXT NOT NULL UNIQUE,
  -- Professional role/affiliation ONLY. There is deliberately no column for
  -- personal contact details, location, employment history, or demographics:
  -- data that must not be collected has no field to be collected into.
  professional_summary   TEXT,
  primary_url            TEXT,
  -- False marks an entity that must never be researched: a private individual.
  -- Collection refuses on this flag before any network request is made.
  is_public_professional BOOLEAN NOT NULL DEFAULT true,
  watch_enabled          BOOLEAN NOT NULL DEFAULT true,
  notes                  TEXT,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_entities_type_check
    CHECK (entity_type IN (
      'investment_firm', 'person', 'portfolio_company', 'strategic_company',
      'community', 'publication', 'conference', 'government_body'
    ))
);

CREATE INDEX IF NOT EXISTS intelligence_entities_type_idx ON intelligence_entities (entity_type, display_name);
CREATE INDEX IF NOT EXISTS intelligence_entities_watch_idx ON intelligence_entities (watch_enabled) WHERE watch_enabled;

-- ---------------------------------------------------------------------------
-- Sources
--
-- source_kind is constrained to the ALLOWED public-source vocabulary. A private
-- group, an authenticated forum, a leaked dataset, or a purchased profile has no
-- representable kind, so it cannot be recorded even by a direct INSERT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_sources (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  source_kind   TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT,
  publisher     TEXT,
  -- Required. Unknown provenance is not the same as permitted provenance;
  -- packages/rag ingestion refuses without it and so does this table.
  license       TEXT NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetch_at TIMESTAMPTZ,
  last_status   TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (url),
  CONSTRAINT intelligence_sources_kind_check
    CHECK (source_kind IN (
      'public_website', 'public_blog', 'press_release', 'public_rss',
      'public_podcast', 'public_video_description', 'public_transcript',
      'public_interview', 'conference_listing', 'public_research_paper',
      'public_portfolio_page', 'public_investment_announcement',
      'public_github_activity', 'public_professional_post',
      'public_forum_thread', 'regulatory_disclosure', 'public_news_article'
    )),
  CONSTRAINT intelligence_sources_https_check CHECK (url LIKE 'https://%')
);

CREATE INDEX IF NOT EXISTS intelligence_sources_entity_idx ON intelligence_sources (entity_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS intelligence_sources_enabled_idx ON intelligence_sources (enabled, last_fetch_at);

-- ---------------------------------------------------------------------------
-- Signals
--
-- One retrieved, normalized, provenance-carrying observation. The embedding
-- lives in knowledge_chunks via knowledge_document_id -- there is exactly one
-- vector corpus in this platform.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_signals (
  id                    TEXT PRIMARY KEY,
  source_id             TEXT REFERENCES intelligence_sources (id) ON DELETE SET NULL,
  knowledge_document_id TEXT REFERENCES knowledge_documents (id) ON DELETE SET NULL,
  source_url            TEXT NOT NULL,
  source_kind           TEXT NOT NULL,
  title                 TEXT,
  excerpt               TEXT NOT NULL,
  summary               TEXT,
  published_at          TIMESTAMPTZ,
  retrieved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash          TEXT NOT NULL,
  -- Mirrors AssertionClass. A signal is what a source said, so it is 'observed'
  -- (the source published it) or 'stated' (a person said it about themselves).
  assertion_class       TEXT NOT NULL DEFAULT 'observed',
  confidence            DOUBLE PRECISION,
  source_count          INTEGER NOT NULL DEFAULT 1,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_hash),
  CONSTRAINT intelligence_signals_assertion_check
    CHECK (assertion_class IN ('observed', 'stated', 'inferred', 'estimated', 'predicted')),
  -- Invariant 1: a claim presented as observed fact must cite a source.
  CONSTRAINT intelligence_signals_observed_needs_source
    CHECK (assertion_class NOT IN ('observed', 'stated') OR source_count > 0),
  CONSTRAINT intelligence_signals_inferred_needs_confidence
    CHECK (assertion_class NOT IN ('inferred', 'estimated', 'predicted') OR confidence IS NOT NULL),
  CONSTRAINT intelligence_signals_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS intelligence_signals_published_idx ON intelligence_signals (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS intelligence_signals_retrieved_idx ON intelligence_signals (retrieved_at DESC);
CREATE INDEX IF NOT EXISTS intelligence_signals_hash_idx ON intelligence_signals (content_hash);

CREATE TABLE IF NOT EXISTS signal_entities (
  signal_id TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  -- How the entity came to be attached: named in the text, or inferred.
  attribution TEXT NOT NULL DEFAULT 'named',
  PRIMARY KEY (signal_id, entity_id),
  CONSTRAINT signal_entities_attribution_check CHECK (attribution IN ('named', 'inferred'))
);

-- ---------------------------------------------------------------------------
-- Topics / themes
--
-- Themes are INFERRED from signals. Importance and decay are computed in code
-- from signal count, recency, and source diversity -- the model proposes the
-- label, deterministic code produces every number.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_topics (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  description  TEXT,
  -- Themes are discovered from sources, not declared up front. This marks the
  -- few seeded by an operator so a discovered corpus stays distinguishable.
  operator_seeded BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_topics (
  signal_id  TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  topic_id   TEXT NOT NULL REFERENCES intelligence_topics (id) ON DELETE CASCADE,
  relevance  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (signal_id, topic_id),
  CONSTRAINT signal_topics_relevance_range CHECK (relevance >= 0 AND relevance <= 1)
);

-- Per-entity thematic strength, recomputed from signals. Never model-authored.
CREATE TABLE IF NOT EXISTS entity_topic_strength (
  entity_id     TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  topic_id      TEXT NOT NULL REFERENCES intelligence_topics (id) ON DELETE CASCADE,
  importance    DOUBLE PRECISION NOT NULL,
  time_decay    DOUBLE PRECISION NOT NULL,
  signal_count  INTEGER NOT NULL DEFAULT 0,
  source_count  INTEGER NOT NULL DEFAULT 0,
  newest_signal TIMESTAMPTZ,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, topic_id),
  CONSTRAINT entity_topic_importance_range CHECK (importance >= 0 AND importance <= 1),
  CONSTRAINT entity_topic_decay_range CHECK (time_decay >= 0 AND time_decay <= 1),
  -- A strength with no signals behind it is not a measurement.
  CONSTRAINT entity_topic_needs_signals CHECK (signal_count > 0)
);

-- ---------------------------------------------------------------------------
-- Relationship graph
--
-- Every edge carries its assertion class, so PUBLIC FACT, INFERENCE, DACAIS
-- INTERNAL CLAIM, and PROPOSED FUTURE CAPABILITY are never stored in a way that
-- lets them be read as the same kind of statement.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_relationships (
  id              TEXT PRIMARY KEY,
  from_entity_id  TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  to_entity_id    TEXT REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  to_topic_id     TEXT REFERENCES intelligence_topics (id) ON DELETE CASCADE,
  relationship    TEXT NOT NULL,
  assertion_class TEXT NOT NULL,
  confidence      DOUBLE PRECISION,
  source_count    INTEGER NOT NULL DEFAULT 0,
  rationale       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entity_relationships_target_check
    CHECK (num_nonnulls(to_entity_id, to_topic_id) = 1),
  CONSTRAINT entity_relationships_assertion_check
    CHECK (assertion_class IN ('observed', 'stated', 'inferred', 'estimated', 'predicted')),
  -- Invariant 1 again, on the graph: an edge asserted as public fact must have
  -- cited sources behind it.
  CONSTRAINT entity_relationships_observed_needs_source
    CHECK (assertion_class NOT IN ('observed', 'stated') OR source_count > 0),
  CONSTRAINT entity_relationships_inferred_needs_confidence
    CHECK (assertion_class NOT IN ('inferred', 'estimated', 'predicted') OR confidence IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS entity_relationships_from_idx ON entity_relationships (from_entity_id, relationship);
CREATE INDEX IF NOT EXISTS entity_relationships_to_entity_idx ON entity_relationships (to_entity_id);

CREATE TABLE IF NOT EXISTS relationship_sources (
  relationship_id TEXT NOT NULL REFERENCES entity_relationships (id) ON DELETE CASCADE,
  signal_id       TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  PRIMARY KEY (relationship_id, signal_id)
);

CREATE TABLE IF NOT EXISTS portfolio_relationships (
  id                TEXT PRIMARY KEY,
  investor_entity_id TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  company_entity_id  TEXT NOT NULL REFERENCES intelligence_entities (id) ON DELETE CASCADE,
  stage             TEXT,
  announced_at      TIMESTAMPTZ,
  assertion_class   TEXT NOT NULL DEFAULT 'observed',
  source_count      INTEGER NOT NULL DEFAULT 0,
  source_url        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (investor_entity_id, company_entity_id),
  CONSTRAINT portfolio_relationships_assertion_check
    CHECK (assertion_class IN ('observed', 'stated', 'inferred')),
  CONSTRAINT portfolio_relationships_observed_needs_source
    CHECK (assertion_class <> 'observed' OR source_count > 0)
);

-- ---------------------------------------------------------------------------
-- DACAIS capabilities and evidence
--
-- The status ladder is the guard against overclaiming. UNVERIFIED is the default
-- for anything an operator declares but the system cannot yet see evidence for.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dacais_capabilities (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'UNVERIFIED',
  -- True only where a working artifact can actually be shown to someone.
  demonstrable       BOOLEAN NOT NULL DEFAULT false,
  publicly_shareable BOOLEAN NOT NULL DEFAULT false,
  -- Present-tense language is only ever generated for PRODUCTION and
  -- WORKING_PROTOTYPE. Everything below gets future/intent framing.
  safe_phrasing      TEXT,
  -- Set when an operator declared this rather than the system deriving it from
  -- repository evidence. Declared capabilities start UNVERIFIED.
  operator_declared  BOOLEAN NOT NULL DEFAULT false,
  last_verified_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dacais_capabilities_status_check
    CHECK (status IN (
      'PRODUCTION', 'WORKING_PROTOTYPE', 'IN_DEVELOPMENT',
      'DESIGN_COMPLETE', 'RESEARCH', 'HORIZON', 'UNVERIFIED'
    )),
  -- Invariant 2: an unverified capability can never be marked shareable.
  CONSTRAINT dacais_capabilities_unverified_not_shareable
    CHECK (publicly_shareable = false OR status <> 'UNVERIFIED'),
  -- A capability cannot claim to be demonstrable below working-prototype.
  CONSTRAINT dacais_capabilities_demonstrable_requires_working
    CHECK (demonstrable = false OR status IN ('PRODUCTION', 'WORKING_PROTOTYPE'))
);

CREATE INDEX IF NOT EXISTS dacais_capabilities_status_idx ON dacais_capabilities (status);

CREATE TABLE IF NOT EXISTS dacais_evidence (
  id            TEXT PRIMARY KEY,
  capability_id TEXT REFERENCES dacais_capabilities (id) ON DELETE CASCADE,
  evidence_kind TEXT NOT NULL,
  -- Repository-relative path. Absolute host paths leak machine layout.
  file_path     TEXT,
  start_line    INTEGER,
  end_line      INTEGER,
  symbol_name   TEXT,
  test_name     TEXT,
  -- Excerpt is redacted through packages/security before it is written.
  excerpt       TEXT,
  locator       TEXT,
  content_hash  TEXT,
  -- FK into the existing Evidence Registry anchor table (migration 012).
  evidence_anchor_id TEXT REFERENCES evidence_anchors (id) ON DELETE SET NULL,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT dacais_evidence_kind_check
    CHECK (evidence_kind IN (
      'source_symbol', 'source_file', 'test', 'test_run', 'documentation',
      'migration', 'api_definition', 'benchmark', 'metric', 'deployment_config',
      'security_scan', 'screenshot', 'demo'
    )),
  CONSTRAINT dacais_evidence_line_order
    CHECK (start_line IS NULL OR end_line IS NULL OR end_line >= start_line)
);

CREATE INDEX IF NOT EXISTS dacais_evidence_capability_idx ON dacais_evidence (capability_id, evidence_kind);

-- Claims are the unit that appears in content. A claim with no evidence row is
-- structurally possible but is filtered out of every generation path.
CREATE TABLE IF NOT EXISTS dacais_claims (
  id             TEXT PRIMARY KEY,
  capability_id  TEXT REFERENCES dacais_capabilities (id) ON DELETE CASCADE,
  claim_text     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'UNVERIFIED',
  confidence     DOUBLE PRECISION,
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dacais_claims_status_check
    CHECK (status IN (
      'PRODUCTION', 'WORKING_PROTOTYPE', 'IN_DEVELOPMENT',
      'DESIGN_COMPLETE', 'RESEARCH', 'HORIZON', 'UNVERIFIED'
    )),
  CONSTRAINT dacais_claims_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id    TEXT NOT NULL REFERENCES dacais_claims (id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES dacais_evidence (id) ON DELETE CASCADE,
  -- Contradictory evidence is recorded, not discarded: a claim that has
  -- evidence against it must be able to show that on the evidence page.
  supports    BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (claim_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- Measurable numbers
--
-- The metric engine reads from real instrumentation. A metric with no
-- measurement is recorded as NEEDS_MEASUREMENT and carries a NULL value -- there
-- is no code path that writes a model-authored number here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metric_registry (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  unit          TEXT,
  status        TEXT NOT NULL DEFAULT 'NEEDS_MEASUREMENT',
  value_numeric DOUBLE PRECISION,
  value_text    TEXT,
  -- Where the number actually came from: a table, a command, a test run.
  measurement_source TEXT,
  measured_at   TIMESTAMPTZ,
  capability_id TEXT REFERENCES dacais_capabilities (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT metric_registry_status_check
    CHECK (status IN ('MEASURED', 'NEEDS_MEASUREMENT', 'STALE')),
  -- A measured metric must carry both a value and where it came from.
  CONSTRAINT metric_registry_measured_needs_value
    CHECK (status <> 'MEASURED' OR (value_numeric IS NOT NULL OR value_text IS NOT NULL)),
  CONSTRAINT metric_registry_measured_needs_source
    CHECK (status <> 'MEASURED' OR (measurement_source IS NOT NULL AND measured_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Semantic association model
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS semantic_associations (
  id            TEXT PRIMARY KEY,
  concept       TEXT NOT NULL UNIQUE,
  target_strength DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  current_strength DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Component evidence behind current_strength, all computed not asserted.
  published_content_count INTEGER NOT NULL DEFAULT 0,
  internal_evidence_count INTEGER NOT NULL DEFAULT 0,
  external_mention_count  INTEGER NOT NULL DEFAULT 0,
  topic_recurrence        DOUBLE PRECISION NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  computed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT semantic_associations_target_range CHECK (target_strength >= 0 AND target_strength <= 1),
  CONSTRAINT semantic_associations_current_range CHECK (current_strength >= 0 AND current_strength <= 1)
);

-- ---------------------------------------------------------------------------
-- Content opportunities
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_opportunities (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT REFERENCES intelligence_entities (id) ON DELETE SET NULL,
  topic_id            TEXT REFERENCES intelligence_topics (id) ON DELETE SET NULL,
  headline            TEXT NOT NULL,
  signal_summary      TEXT NOT NULL,
  why_it_matters      TEXT NOT NULL,
  dacais_intersection TEXT NOT NULL,
  missing_evidence    TEXT,
  recommended_asset_type TEXT NOT NULL,
  suggested_visual_kind  TEXT,
  suggested_visual       TEXT,
  suggested_metric_id TEXT REFERENCES metric_registry (id) ON DELETE SET NULL,
  risks               TEXT,
  -- Why this recommendation exists, assembled from the actual signals and
  -- evidence. A recommendation without a reason is not actionable.
  reasoning           TEXT NOT NULL,
  score               DOUBLE PRECISION NOT NULL,
  -- Per-component breakdown so a score can always be taken apart.
  score_components    JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence          DOUBLE PRECISION NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OPEN',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_opportunities_score_range CHECK (score >= 0 AND score <= 1),
  CONSTRAINT content_opportunities_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT content_opportunities_status_check CHECK (status IN ('OPEN', 'ACTIONED', 'DISMISSED', 'EXPIRED')),
  CONSTRAINT content_opportunities_visual_kind_check
    CHECK (suggested_visual_kind IS NULL OR suggested_visual_kind IN (
      'actual_screenshot', 'architecture_diagram', 'concept_visualization',
      'future_state_visualization', 'benchmark_chart', 'timeline',
      'control_loop_diagram', 'system_topology', 'agent_execution_path',
      'before_after_workflow', 'demo_recording'
    ))
);

CREATE INDEX IF NOT EXISTS content_opportunities_score_idx ON content_opportunities (status, score DESC);

CREATE TABLE IF NOT EXISTS opportunity_signals (
  opportunity_id TEXT NOT NULL REFERENCES content_opportunities (id) ON DELETE CASCADE,
  signal_id      TEXT NOT NULL REFERENCES intelligence_signals (id) ON DELETE CASCADE,
  PRIMARY KEY (opportunity_id, signal_id)
);

CREATE TABLE IF NOT EXISTS opportunity_evidence (
  opportunity_id TEXT NOT NULL REFERENCES content_opportunities (id) ON DELETE CASCADE,
  evidence_id    TEXT NOT NULL REFERENCES dacais_evidence (id) ON DELETE CASCADE,
  PRIMARY KEY (opportunity_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- Distribution channels
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS distribution_channels (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  channel_type   TEXT NOT NULL,
  url            TEXT,
  audience       TEXT,
  -- What genuinely belongs here, in the channel's own terms.
  fit_notes      TEXT,
  -- Community norms that make a post welcome or unwelcome. Recorded so the
  -- distribution agent answers "where does this belong", not "where can we post".
  norms          TEXT,
  -- Actual publishing stays disabled; export/copy is the implemented path.
  publishing_enabled BOOLEAN NOT NULL DEFAULT false,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT distribution_channels_type_check
    CHECK (channel_type IN (
      'owned_website', 'owned_blog', 'founder_social', 'company_social',
      'code_host', 'video_platform', 'aggregator', 'community_forum',
      'newsletter', 'press'
    ))
);

-- ---------------------------------------------------------------------------
-- Content assets and the approval gate
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_assets (
  id             TEXT PRIMARY KEY,
  opportunity_id TEXT REFERENCES content_opportunities (id) ON DELETE SET NULL,
  channel_id     TEXT REFERENCES distribution_channels (id) ON DELETE SET NULL,
  asset_type     TEXT NOT NULL,
  title          TEXT,
  body           TEXT NOT NULL,
  audience       TEXT,
  tone           TEXT,
  visual_kind    TEXT,
  visual_spec    TEXT,
  state          TEXT NOT NULL DEFAULT 'DRAFT',
  -- Deterministic risk-guard output. A draft that fails is never presented as
  -- ready; the reasons are kept so the operator can see what was caught.
  risk_findings  JSONB NOT NULL DEFAULT '[]'::jsonb,
  unsupported_statements JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Named human. Not a role, not a service account.
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  rejected_reason TEXT,
  exported_at    TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  generated_by_model TEXT,
  generated_by_instance TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_assets_state_check
    CHECK (state IN (
      'IDEA', 'DRAFT', 'EVIDENCE_CHECK', 'RISK_REVIEW', 'READY_FOR_REVIEW',
      'HUMAN_APPROVED', 'REJECTED', 'EXPORTED', 'PUBLISHED', 'MEASURED'
    )),
  -- Invariant 3: nothing reaches an approved-or-beyond state without a named
  -- human approver. This is enforced here as well as in application code
  -- because it is the control that prevents autonomous publication.
  CONSTRAINT content_assets_approval_requires_human
    CHECK (
      state NOT IN ('HUMAN_APPROVED', 'EXPORTED', 'PUBLISHED', 'MEASURED')
      OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    ),
  CONSTRAINT content_assets_published_requires_timestamp
    CHECK (state <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT content_assets_rejected_requires_reason
    CHECK (state <> 'REJECTED' OR rejected_reason IS NOT NULL),
  CONSTRAINT content_assets_visual_kind_check
    CHECK (visual_kind IS NULL OR visual_kind IN (
      'actual_screenshot', 'architecture_diagram', 'concept_visualization',
      'future_state_visualization', 'benchmark_chart', 'timeline',
      'control_loop_diagram', 'system_topology', 'agent_execution_path',
      'before_after_workflow', 'demo_recording'
    ))
);

CREATE INDEX IF NOT EXISTS content_assets_state_idx ON content_assets (state, updated_at DESC);

-- Provenance for every draft: which claims, which evidence, which public
-- sources. Kept internal; the human-readable draft stays clean.
CREATE TABLE IF NOT EXISTS content_claims (
  content_asset_id TEXT NOT NULL REFERENCES content_assets (id) ON DELETE CASCADE,
  claim_id         TEXT REFERENCES dacais_claims (id) ON DELETE SET NULL,
  signal_id        TEXT REFERENCES intelligence_signals (id) ON DELETE SET NULL,
  evidence_id      TEXT REFERENCES dacais_evidence (id) ON DELETE SET NULL,
  claim_text       TEXT NOT NULL,
  -- Set when the operator explicitly excluded this claim from the draft.
  excluded         BOOLEAN NOT NULL DEFAULT false,
  id               TEXT PRIMARY KEY,
  CONSTRAINT content_claims_needs_reference
    CHECK (num_nonnulls(claim_id, signal_id, evidence_id) >= 1)
);

CREATE INDEX IF NOT EXISTS content_claims_asset_idx ON content_claims (content_asset_id);

-- Append-only audit of every state transition. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS content_asset_audit (
  id               TEXT PRIMARY KEY,
  content_asset_id TEXT NOT NULL REFERENCES content_assets (id) ON DELETE CASCADE,
  from_state       TEXT,
  to_state         TEXT NOT NULL,
  action           TEXT NOT NULL,
  actor            TEXT NOT NULL,
  detail           TEXT,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_asset_audit_action_check
    CHECK (action IN (
      'created', 'generated', 'evidence_checked', 'risk_reviewed', 'submitted',
      'approved', 'rejected', 'edited', 'rewrite_requested', 'audience_changed',
      'tone_changed', 'channel_changed', 'claim_excluded', 'exported', 'published', 'measured'
    ))
);

CREATE INDEX IF NOT EXISTS content_asset_audit_asset_idx ON content_asset_audit (content_asset_id, occurred_at);

CREATE TABLE IF NOT EXISTS content_performance (
  id               TEXT PRIMARY KEY,
  content_asset_id TEXT NOT NULL REFERENCES content_assets (id) ON DELETE CASCADE,
  channel_id       TEXT REFERENCES distribution_channels (id) ON DELETE SET NULL,
  metric           TEXT NOT NULL,
  value_numeric    DOUBLE PRECISION,
  -- Performance numbers are operator-entered or API-retrieved. The source is
  -- recorded so a hand-typed figure is never mistaken for a measured one.
  measurement_source TEXT NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT content_performance_source_check
    CHECK (measurement_source IN ('operator_entered', 'channel_api', 'analytics_export'))
);

-- ---------------------------------------------------------------------------
-- Mock diligence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mock_diligence_sessions (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL,
  focus         TEXT,
  model         TEXT,
  provider_instance TEXT,
  overall_notes TEXT,
  question_count INTEGER NOT NULL DEFAULT 0,
  strong_count   INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  dangerous_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mock_diligence_sessions_role_check
    CHECK (role IN (
      'technical_partner', 'investment_partner', 'frontier_tech_partner',
      'skeptical_cto', 'enterprise_buyer', 'aerospace_technical_reviewer'
    ))
);

CREATE TABLE IF NOT EXISTS mock_diligence_questions (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES mock_diligence_sessions (id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answer       TEXT,
  score        TEXT NOT NULL,
  -- Number of claim_evidence rows behind the answer. A STRONG score with zero
  -- supporting evidence is refused by the constraint below.
  evidence_count INTEGER NOT NULL DEFAULT 0,
  better_answer TEXT,
  missing_evidence TEXT,
  required_action  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mock_diligence_questions_score_check
    CHECK (score IN ('STRONG', 'INCOMPLETE', 'UNSUPPORTED', 'DANGEROUS')),
  -- An answer cannot be graded STRONG on the model's say-so alone.
  CONSTRAINT mock_diligence_strong_requires_evidence
    CHECK (score <> 'STRONG' OR evidence_count > 0),
  CONSTRAINT mock_diligence_action_check
    CHECK (required_action IS NULL OR required_action IN (
      'better_answer', 'missing_evidence', 'test_required', 'metric_required',
      'documentation_required', 'architectural_gap'
    ))
);

CREATE INDEX IF NOT EXISTS mock_diligence_questions_session_idx ON mock_diligence_questions (session_id);
CREATE INDEX IF NOT EXISTS mock_diligence_questions_score_idx ON mock_diligence_questions (score);

-- ---------------------------------------------------------------------------
-- Investment memos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS investment_memos (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  -- Full section map. Stored structured so sections can be rendered and audited
  -- individually rather than as one blob of prose.
  sections        JSONB NOT NULL,
  recommendation  TEXT NOT NULL,
  bull_case       TEXT,
  bear_case       TEXT,
  evidence_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  public_source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  unresolved_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  model           TEXT,
  provider_instance TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investment_memos_recommendation_check
    CHECK (recommendation IN ('INVEST', 'CONTINUE_DILIGENCE', 'PASS'))
);

-- ---------------------------------------------------------------------------
-- Collection runs
--
-- Every research pass is recorded, including one that retrieved nothing. A run
-- that silently returned no signals is indistinguishable from one that never
-- happened, and "we found nothing" is a legitimate, reportable result.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intelligence_collection_runs (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT REFERENCES intelligence_entities (id) ON DELETE SET NULL,
  trigger           TEXT NOT NULL,
  providers_used    JSONB NOT NULL DEFAULT '[]'::jsonb,
  queries_issued    INTEGER NOT NULL DEFAULT 0,
  sources_discovered INTEGER NOT NULL DEFAULT 0,
  signals_ingested  INTEGER NOT NULL DEFAULT 0,
  duplicates        INTEGER NOT NULL DEFAULT 0,
  rejected          INTEGER NOT NULL DEFAULT 0,
  source_failures   INTEGER NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  error             TEXT,
  CONSTRAINT intelligence_collection_runs_trigger_check
    CHECK (trigger IN ('manual', 'api', 'scheduled', 'proof'))
);

CREATE INDEX IF NOT EXISTS intelligence_collection_runs_entity_idx
  ON intelligence_collection_runs (entity_id, started_at DESC);
