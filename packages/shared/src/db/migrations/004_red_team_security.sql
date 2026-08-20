-- Red Team / Blue Team / Purple Team Security Testing Framework
-- Enables authorized penetration testing, adversarial testing, and security regression.

-- Red Team Engagements: authorized time-bounded security testing campaigns
CREATE TABLE IF NOT EXISTS red_team_engagements (
  id                        TEXT PRIMARY KEY,
  customer_id               TEXT        NOT NULL,
  authorized_targets        JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- list of target names/domains
  authorized_environments   JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- list of env names (dev/staging/prod subset)
  allowed_test_categories   JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- auth, authz, business-logic, ai-security, etc.
  prohibited_actions        JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- what must never be attempted
  starts_at                 TIMESTAMPTZ NOT NULL,
  expires_at                TIMESTAMPTZ NOT NULL,
  human_approver            TEXT        NOT NULL,
  authorization_evidence_id TEXT,
  status                    TEXT        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','approved','active','paused','completed','revoked')),
  request_limit             INTEGER DEFAULT NULL,
  concurrency_limit         INTEGER DEFAULT NULL,
  rules_of_engagement       JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- custom ROE per engagement
  scope_breadth             TEXT        NOT NULL DEFAULT 'defined'
                            CHECK (scope_breadth IN ('defined','broad','internal-only')),
  threat_model_tags         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS red_team_engagements_customer_id_idx ON red_team_engagements (customer_id);
CREATE INDEX IF NOT EXISTS red_team_engagements_status_idx ON red_team_engagements (status);
CREATE INDEX IF NOT EXISTS red_team_engagements_created_at_idx ON red_team_engagements (created_at DESC);

-- Adversarial Mode Test Results
CREATE TABLE IF NOT EXISTS adversarial_test_results (
  id                 TEXT PRIMARY KEY,
  engagement_id      TEXT        REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  test_category      TEXT        NOT NULL,  -- auth, authz, tenant-isolation, injection, rate-limit, etc.
  test_scenario      TEXT        NOT NULL,
  target             TEXT        NOT NULL,
  passed             BOOLEAN     NOT NULL,
  observed_behavior  TEXT        NOT NULL,
  evidence           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  regression_test    BOOLEAN     NOT NULL DEFAULT FALSE,
  previous_issue_id  TEXT,  -- if this is a retest of a known issue
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adversarial_test_results_engagement_idx ON adversarial_test_results (engagement_id);
CREATE INDEX IF NOT EXISTS adversarial_test_results_category_idx ON adversarial_test_results (test_category);

-- Red Team Findings: candidate vulnerabilities discovered during engagement
CREATE TABLE IF NOT EXISTS red_team_findings (
  id                     TEXT PRIMARY KEY,
  engagement_id          TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  title                  TEXT        NOT NULL,
  description            TEXT        NOT NULL,
  severity               TEXT        NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  confidence             REAL        NOT NULL,  -- 0.0 to 1.0
  finding_type           TEXT        NOT NULL,  -- vulnerability, weakness, misconfiguration, etc.
  attack_vector          TEXT,       -- network, local, adjacent, physical
  affected_components    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  reproducibility_steps  TEXT,
  impact_assessment      TEXT,
  exploitation_difficulty TEXT DEFAULT 'unknown'
                         CHECK (exploitation_difficulty IN ('trivial','easy','moderate','difficult','impossible','unknown')),
  status                 TEXT        NOT NULL DEFAULT 'candidate'
                         CHECK (status IN ('candidate','verified','false-positive','remediated','retested','accepted-risk')),
  judge_decision         TEXT,  -- who/what validated this
  judge_confidence       REAL,
  evidence_ids           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  cve_id                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at            TIMESTAMPTZ,
  remediated_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS red_team_findings_engagement_idx ON red_team_findings (engagement_id);
CREATE INDEX IF NOT EXISTS red_team_findings_severity_idx ON red_team_findings (severity);
CREATE INDEX IF NOT EXISTS red_team_findings_status_idx ON red_team_findings (status);

-- Red Team Evidence: sanitized, auditable artifacts proving a finding
CREATE TABLE IF NOT EXISTS red_team_evidence (
  id                TEXT PRIMARY KEY,
  finding_id        TEXT        NOT NULL REFERENCES red_team_findings (id) ON DELETE CASCADE,
  engagement_id     TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  evidence_type     TEXT        NOT NULL,  -- request-response, log-excerpt, state-diff, screenshot, etc.
  sanitized_payload JSONB       NOT NULL,
  timestamp         TIMESTAMPTZ NOT NULL,
  agent_id          TEXT,
  tool_used         TEXT,
  target_system     TEXT,
  proof_of_impact   TEXT,  -- what happened as a result
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS red_team_evidence_finding_idx ON red_team_evidence (finding_id);
CREATE INDEX IF NOT EXISTS red_team_evidence_engagement_idx ON red_team_evidence (engagement_id);

-- Attack Paths: chains of observations that form a higher-risk composite attack
CREATE TABLE IF NOT EXISTS red_team_attack_paths (
  id                 TEXT PRIMARY KEY,
  engagement_id      TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  path_name          TEXT        NOT NULL,
  description        TEXT        NOT NULL,
  attack_chain       JSONB       NOT NULL,  -- ordered list of observations/findings
  steps_to_exploit   INTEGER     NOT NULL,  -- number of distinct actions required
  composite_severity TEXT        NOT NULL,  -- info, low, medium, high, critical
  composite_confidence REAL       NOT NULL,  -- average confidence across steps
  exploitability     TEXT        NOT NULL DEFAULT 'theoretical'
                     CHECK (exploitability IN ('theoretical','poc','demonstrated','weaponized')),
  business_impact    TEXT,
  remediation_blocking_finding TEXT,  -- which step prevents exploitation if fixed
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS red_team_attack_paths_engagement_idx ON red_team_attack_paths (engagement_id);

-- Scope Violations: when agent attempts to act outside authorized scope
CREATE TABLE IF NOT EXISTS red_team_scope_violations (
  id                TEXT PRIMARY KEY,
  engagement_id     TEXT        REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  agent_id          TEXT        NOT NULL,
  attempted_target  TEXT        NOT NULL,
  attempted_action  TEXT        NOT NULL,
  policy_rejection  TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS red_team_scope_violations_engagement_idx ON red_team_scope_violations (engagement_id);
CREATE INDEX IF NOT EXISTS red_team_scope_violations_created_at_idx ON red_team_scope_violations (created_at DESC);

-- Purple Team Observations: synchronized red/blue observations during coordinated testing
CREATE TABLE IF NOT EXISTS purple_team_observations (
  id                  TEXT PRIMARY KEY,
  engagement_id       TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  red_action_id       TEXT,  -- the red team action that triggered this
  blue_observation    TEXT        NOT NULL,
  attack_succeeded    BOOLEAN     NOT NULL,
  was_detected        BOOLEAN     NOT NULL,
  was_blocked         BOOLEAN     NOT NULL,
  time_to_detection   INTERVAL,
  time_to_response    INTERVAL,
  evidence_collected  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  detection_method    TEXT,
  remediation_action  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS purple_team_observations_engagement_idx ON purple_team_observations (engagement_id);

-- Security Testing Summary and Statistics
CREATE TABLE IF NOT EXISTS security_test_summaries (
  id                     TEXT PRIMARY KEY,
  engagement_id          TEXT        NOT NULL UNIQUE REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  total_test_attempts    INTEGER     NOT NULL DEFAULT 0,
  adversarial_tests_run  INTEGER     NOT NULL DEFAULT 0,
  adversarial_tests_passed INTEGER    NOT NULL DEFAULT 0,
  findings_count         INTEGER     NOT NULL DEFAULT 0,
  critical_count         INTEGER     NOT NULL DEFAULT 0,
  high_count             INTEGER     NOT NULL DEFAULT 0,
  medium_count           INTEGER     NOT NULL DEFAULT 0,
  low_count              INTEGER     NOT NULL DEFAULT 0,
  info_count             INTEGER     NOT NULL DEFAULT 0,
  false_positives        INTEGER     NOT NULL DEFAULT 0,
  attack_paths_found     INTEGER     NOT NULL DEFAULT 0,
  scope_violations       INTEGER     NOT NULL DEFAULT 0,
  purple_team_executions INTEGER     NOT NULL DEFAULT 0,
  detection_rate         REAL        DEFAULT NULL,  -- percentage of attacks detected
  block_rate             REAL        DEFAULT NULL,  -- percentage of attacks blocked
  mean_time_to_detection INTERVAL,
  mean_time_to_response  INTERVAL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_test_summaries_engagement_idx ON security_test_summaries (engagement_id);

-- Red Team Tool Audit: every security-relevant tool call during engagement
CREATE TABLE IF NOT EXISTS red_team_tool_audit (
  id                TEXT PRIMARY KEY,
  engagement_id     TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  agent_id          TEXT        NOT NULL,
  tool_name         TEXT        NOT NULL,
  proposed_action   TEXT        NOT NULL,
  scope_verified    BOOLEAN     NOT NULL,
  policy_allowed    BOOLEAN     NOT NULL,
  executed          BOOLEAN     NOT NULL,
  execution_result  JSONB,
  blocked_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS red_team_tool_audit_engagement_idx ON red_team_tool_audit (engagement_id);
CREATE INDEX IF NOT EXISTS red_team_tool_audit_agent_idx ON red_team_tool_audit (agent_id);

-- Engagement Approval Trail
CREATE TABLE IF NOT EXISTS red_team_approvals (
  id                 TEXT PRIMARY KEY,
  engagement_id      TEXT        NOT NULL REFERENCES red_team_engagements (id) ON DELETE CASCADE,
  approval_type      TEXT        NOT NULL,  -- start, step, escalation, expansion
  decision           BOOLEAN     NOT NULL,
  approver           TEXT        NOT NULL,
  reason             TEXT,
  requested_at       TIMESTAMPTZ NOT NULL,
  decided_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS red_team_approvals_engagement_idx ON red_team_approvals (engagement_id);
