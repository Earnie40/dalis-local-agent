-- Defensive Testing Framework
-- Validates that security controls work, detects anonymized sources,
-- demonstrates red team blocking, and coordinates defensive improvements.

-- Defensive Control Tests: Automated proof that security controls function
CREATE TABLE IF NOT EXISTS defensive_control_tests (
  id                TEXT PRIMARY KEY,
  test_category     TEXT        NOT NULL,  -- auth, authz, tenant-isolation, rate-limit, validation
  test_scenario     TEXT        NOT NULL,
  description       TEXT        NOT NULL,
  expected_behavior TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS defensive_control_tests_category_idx ON defensive_control_tests (test_category);

-- Defensive Control Test Results: Pass/fail proof for compliance
CREATE TABLE IF NOT EXISTS defensive_control_test_results (
  id                TEXT PRIMARY KEY,
  test_id           TEXT        NOT NULL REFERENCES defensive_control_tests (id) ON DELETE CASCADE,
  engagement_id     TEXT        REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  passed            BOOLEAN     NOT NULL,
  observed_behavior TEXT        NOT NULL,
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  severity_if_failed TEXT,  -- critical, high, medium
  executed_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS defensive_control_test_results_test_idx ON defensive_control_test_results (test_id);
CREATE INDEX IF NOT EXISTS defensive_control_test_results_passed_idx ON defensive_control_test_results (passed, created_at DESC);

-- Anonymized Source Detection: Tor/proxy/VPN request tracking
CREATE TABLE IF NOT EXISTS anonymized_source_audit (
  id                    TEXT PRIMARY KEY,
  source_ip             INET        NOT NULL,
  user_agent            TEXT,
  detection_method      TEXT        NOT NULL,  -- tor-exit-node, proxy-ip, vpn-signature, etc.
  classification        TEXT        NOT NULL DEFAULT 'suspicious'
                        CHECK (classification IN ('informational','suspicious','hostile')),
  endpoint              TEXT        NOT NULL,
  requested_at          TIMESTAMPTZ NOT NULL,
  response_code         INTEGER,
  action_taken          TEXT DEFAULT NULL,  -- logged, throttled, blocked, challenged
  engagement_id         TEXT        REFERENCES red_team_engagements (id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anonymized_source_audit_source_ip_idx ON anonymized_source_audit (source_ip);
CREATE INDEX IF NOT EXISTS anonymized_source_audit_classification_idx ON anonymized_source_audit (classification);
CREATE INDEX IF NOT EXISTS anonymized_source_audit_created_at_idx ON anonymized_source_audit (created_at DESC);

-- Defense Blocking Evidence: Proof that red team attacks were blocked
CREATE TABLE IF NOT EXISTS defense_blocking_evidence (
  id                TEXT PRIMARY KEY,
  engagement_id     TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  red_team_action   TEXT        NOT NULL,  -- the attack attempt
  scope_guard_reason TEXT       NOT NULL,  -- why it was blocked
  risk_level        TEXT,       -- LEVEL_1 through LEVEL_4
  target_attempted  TEXT,
  authorization_denied_because TEXT,
  audit_log_entry   JSONB       NOT NULL,
  blocked_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS defense_blocking_evidence_engagement_idx ON defense_blocking_evidence (engagement_id);
CREATE INDEX IF NOT EXISTS defense_blocking_evidence_blocked_at_idx ON defense_blocking_evidence (blocked_at DESC);

-- Defensive Recommendations: Blue team analysis and remediation suggestions
CREATE TABLE IF NOT EXISTS defensive_recommendations (
  id                    TEXT PRIMARY KEY,
  engagement_id         TEXT        REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  finding_id            TEXT        REFERENCES red_team_findings (id) ON DELETE CASCADE,
  failed_defense        TEXT        NOT NULL,  -- what control was bypassed or missing
  attack_category       TEXT        NOT NULL,  -- auth, injection, business-logic, etc.
  remediation_path      TEXT        NOT NULL,  -- code change, config, policy, etc.
  recommendation        TEXT        NOT NULL,
  severity              TEXT        NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('info','low','medium','high','critical')),
  effort_estimate       TEXT DEFAULT NULL,  -- trivial, small, medium, large
  proof_of_concept      TEXT,  -- steps to verify remediation works
  defensive_agent_id    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS defensive_recommendations_engagement_idx ON defensive_recommendations (engagement_id);
CREATE INDEX IF NOT EXISTS defensive_recommendations_severity_idx ON defensive_recommendations (severity);
CREATE INDEX IF NOT EXISTS defensive_recommendations_accepted_idx ON defensive_recommendations (accepted_at);

-- Defensive Posture Summary: Aggregated health of security defenses
CREATE TABLE IF NOT EXISTS defensive_posture_summary (
  id                        TEXT PRIMARY KEY,
  engagement_id             TEXT        NOT NULL UNIQUE REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  control_tests_run         INTEGER     NOT NULL DEFAULT 0,
  control_tests_passed      INTEGER     NOT NULL DEFAULT 0,
  control_tests_failed      INTEGER     NOT NULL DEFAULT 0,
  anonymized_sources_detected INTEGER    NOT NULL DEFAULT 0,
  red_team_blocks           INTEGER     NOT NULL DEFAULT 0,
  defense_blocking_rate     REAL,  -- percentage of red team attacks blocked
  recommendations_generated INTEGER     NOT NULL DEFAULT 0,
  recommendations_accepted  INTEGER     NOT NULL DEFAULT 0,
  critical_gaps             INTEGER     NOT NULL DEFAULT 0,
  overall_posture           TEXT        DEFAULT 'unknown'
                            CHECK (overall_posture IN ('unknown','weak','fair','strong','excellent')),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS defensive_posture_summary_engagement_idx ON defensive_posture_summary (engagement_id);
