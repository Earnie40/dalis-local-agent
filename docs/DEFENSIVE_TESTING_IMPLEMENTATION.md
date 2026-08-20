# Defensive Testing Framework
## Complete Implementation Guide

**Date**: 2026-08-15  
**Status**: Full Implementation Complete  
**Architecture**: Automated defensive validation, Tor/proxy detection, Red Team blocking proof, Blue Team recommendations

---

## Overview

The Defensive Testing Framework provides **comprehensive security validation** by:

1. **Proving security controls work** through automated tests (DCT)
2. **Detecting anonymized requests** from Tor/proxies/VPNs
3. **Demonstrating defensive success** by capturing Red Team blocks
4. **Recommending improvements** through AI-powered analysis

It works **in concert with the Red Team framework** to create a complete security testing feedback loop.

---

## 4 Core Subsystems

### 1. Defensive Control Validation (DCT)

**Purpose**: Automated proof that security controls *actually work*.

Each scenario is a **guaranteed-to-fail test** — if it passes, the control is broken.

#### Built-in Scenarios (9 tests)

**Authentication (2)**
```
✓ Expired Token Rejection
  → Create expired token, verify it's rejected with 401
  → If passes: auth token expiration is enforced
  → If fails: CRITICAL — expired tokens accepted

✓ Malformed Token Rejection
  → Send garbage tokens and empty authorization
  → Verify all rejected with 401
  → If fails: CRITICAL — format validation broken
```

**Authorization (2)**
```
✓ User Isolation
  → User A tries reading User B's resource
  → Verify access denied (403)
  → If fails: HIGH — users can access each other's data

✓ Role-Based Access Enforcement
  → Normal user tries accessing admin endpoint
  → Verify access denied (403)
  → If fails: CRITICAL — privilege escalation possible
```

**Tenant Isolation (1)**
```
✓ Basic Tenant Isolation
  → User in tenant-A tries accessing tenant-B data
  → Verify cross-tenant access blocked
  → If fails: CRITICAL — data breach
```

**Rate Limiting (1)**
```
✓ Rate Limit Enforcement
  → Send requests exceeding configured limit
  → Verify 429 Too Many Requests returned
  → If fails: HIGH — DoS attacks possible
```

**Validation (3)**
```
✓ Required Field Validation
  → Omit required field in POST
  → Verify 400 Bad Request
  → If fails: MEDIUM — data quality compromised

✓ Type Validation
  → Send string where number expected
  → Verify 400 Bad Request with type error
  → If fails: MEDIUM — type checking missing

✓ Size/Length Validation
  → Send payload exceeding size limit
  → Verify rejection (400 or 413)
  → If fails: MEDIUM — buffer overflow risk
```

#### Results Format

```json
{
  "scenario": "auth-expired-token",
  "passed": true,
  "observedBehavior": "Control test 'Expired Token Rejection' passed: Request fails with 401 Unauthorized; token expiration is enforced",
  "evidence": {
    "timestamp": "2026-08-15T10:30:00Z",
    "httpStatus": 401,
    "duration_ms": 245
  }
}
```

#### Execution

```bash
# Run single test
POST /api/security/defensive/control-tests/auth-expired-token/run

# Run all tests in category
POST /api/security/defensive/control-tests/category/authentication/run-all

# Response
{
  "category": "authentication",
  "passed": 2,
  "failed": 0,
  "passRate": 100,
  "results": [...]
}
```

---

### 2. Anonymized Source Detection

**Purpose**: Identify Tor, proxy, VPN, and other anonymity-network requests.

#### Detection Methods

| Method | Indicator | Confidence |
|--------|-----------|------------|
| Tor Exit Node | IP matches known Tor exit | 95% |
| Proxy IP | IP in known proxy database | 85% |
| VPN Signature | User-Agent contains "vpn", "tor", etc. | 60% |
| Proxy Chain | X-Forwarded-For with 3+ hops | 70% |
| Browser Fingerprint | Accept-Language matches Tor Browser default | 60% |

#### Classification

```
Informational
├─ Single request from anonymized source
├─ Action: Log only
└─ Use case: Research, testing, privacy-conscious users

Suspicious
├─ Multiple requests from same anonymized source (pattern detected)
├─ Action: Log + optional throttle
└─ Possible: Automated reconnaissance

Hostile
├─ High-frequency pattern from anonymized source
├─ Action: Log + throttle or block
└─ Likely: Automated attack
```

#### Pattern Detection

```
Window: 60 seconds
Threshold: 50+ requests/min from same anonymized source
Action on hostile: block or challenge
Cleanup: Remove stale patterns (no activity for 5 min)
```

#### Results Format

```json
{
  "detected": true,
  "detectionMethod": "tor-exit-node",
  "sourceIp": "1.2.3.4",
  "classification": "informational",
  "confidence": 0.95,
  "reason": "IP 1.2.3.4 is a known Tor exit node"
}
```

#### API Usage

```bash
# List detected Tor/proxy sources
GET /api/security/defensive/anonymized-sources

# Filter by classification
GET /api/security/defensive/anonymized-sources?classification=hostile&limit=50

# Response
{
  "sources": [
    {
      "sourceIp": "1.2.3.4",
      "detectionMethod": "tor-exit-node",
      "classification": "hostile",
      "endpoint": "/api/auth/login",
      "requestedAt": "2026-08-15T10:30:00Z",
      "actionTaken": "throttled"
    }
  ],
  "statistics": {
    "total": 127,
    "byClassification": {
      "informational": 50,
      "suspicious": 45,
      "hostile": 32
    }
  }
}
```

---

### 3. Red Team Blocking Demonstration

**Purpose**: Generate proof that the Red Team framework successfully blocks attacks.

#### Scenarios (5 blocking demos)

All scenarios are **intentionally designed to be blocked** by the scope guard, risk gates, or approval requirements.

```
1. Out-of-Scope Target
   ├─ Attempt: API call to unauthorized.example.com
   ├─ Expected block: "Target not in authorized_targets list"
   └─ Severity: HIGH (prevents scope creep)

2. Prohibited Action
   ├─ Attempt: Execute destructive database operation
   ├─ Expected block: "Action in prohibited_actions list"
   └─ Severity: HIGH (prevents destructive attacks)

3. LEVEL_4 Operation Without Approval
   ├─ Attempt: Plant persistence / backdoor
   ├─ Expected block: "LEVEL_4_RESTRICTED requires human approval"
   └─ Severity: CRITICAL (no autonomous high-impact operations)

4. Expired Engagement Time Window
   ├─ Attempt: Tool execution after expiresAt
   ├─ Expected block: "Engagement expired; expiresAt passed"
   └─ Severity: HIGH (time-bounded authorization)

5. Revoked Engagement
   ├─ Attempt: Any tool call on revoked engagement
   ├─ Expected block: "Engagement status is revoked"
   └─ Severity: CRITICAL (stops compromised agents)
```

#### Results Format

```json
{
  "engagement": "eng_abc123",
  "evidence": [
    {
      "id": "dbe_xyz789",
      "redTeamAction": "Attempt to access unauthorized.example.com",
      "scopeGuardReason": "Target not in authorized_targets list",
      "targetAttempted": "unauthorized.example.com",
      "authorizationDeniedBecause": "Target 'unauthorized.example.com' not in authorized_targets: [test.example.com, staging.example.com]",
      "blockedAt": "2026-08-15T10:30:00Z"
    }
  ],
  "analysis": {
    "totalScenarios": 5,
    "successfulBlocks": 5,
    "blockingRate": 100,
    "proof": {
      "scopeViolationBlocks": 2,
      "level4Denials": 1,
      "prohibitedActionBlocks": 1,
      "timeWindowViolations": 1
    }
  }
}
```

#### Execution

```bash
# Generate blocking proof for engagement
POST /api/security/defensive/red-team-blocking/{engagementId}/demonstrate

# Get stored blocking evidence
GET /api/security/defensive/red-team-blocking/{engagementId}

# Response shows: 100% blocking rate (all attacks blocked as expected)
```

---

### 4. Defensive Agent (Blue Team)

**Purpose**: Analyze Red Team findings and recommend remediation.

#### Analysis Engine

```
Red Team Finding
  ↓
Map to Failed Defense (knowledge base)
  ↓
Identify Root Cause (missing-control, bypass, misconfiguration)
  ↓
Assess Severity (critical/high/medium/low)
  ↓
Estimate Effort (trivial/small/medium/large)
  ↓
Generate Recommendation (code-change, config-hardening, policy, process)
  ↓
Proof of Concept (steps to verify fix)
```

#### Finding-to-Defense Mapping

| Finding Type | Failed Control | Remediation Path |
|--------------|---|---|
| Authentication bypass | Authentication | Code-change |
| Authorization bypass | Authorization | Code-change |
| Tenant isolation breach | Tenant Isolation | Code-change |
| SQL injection | Input Validation | Code-change |
| Prompt injection | Prompt Filtering | Code-change |
| Privilege escalation | Role Enforcement | Code-change |
| Rate limit bypass | Rate Limiting | Config-hardening |
| Business logic flaw | Business Logic Validation | Code-change |

#### Recommendation Example

```json
{
  "id": "rec_abc123",
  "findingId": "fnd_xyz789",
  "failedDefense": "Input Validation",
  "attackCategory": "sql-injection",
  "remediationPath": "code-change",
  "recommendation": "Remediate Input Validation control to prevent sql-injection: Implement Input Validation check in affected code path",
  "severity": "critical",
  "effortEstimate": "small",
  "proofOfConcept": "1. Reproduce: Execute scenario from evidence\n2. Verify fix: Re-run same scenario, confirm it is now rejected\n3. Prove: Run defensive control test for Input Validation",
  "defensiveAgentId": "agent_def_123",
  "createdAt": "2026-08-15T10:30:00Z"
}
```

#### Severity Distribution

```json
{
  "critical": 2,
  "high": 5,
  "medium": 3,
  "low": 1
}
```

#### Execution

```bash
# Run Blue Team analysis
POST /api/security/defensive/defensive-agent/{engagementId}/analyze

# Get recommendations
GET /api/security/defensive/recommendations/{engagementId}

# Response
{
  "engagement": "eng_abc123",
  "recommendations": [...],
  "statistics": {
    "total": 11,
    "bySeverity": {
      "critical": 2,
      "high": 5,
      "medium": 3,
      "low": 1
    }
  }
}
```

---

## API Reference

### Control Test Validation

```
GET /api/security/defensive/control-tests
  Query: ?category=authentication
  Response: { tests: [...], total: 9 }

POST /api/security/defensive/control-tests/:scenarioId/run
  Params: { scenarioId: "auth-expired-token" }
  Response: { scenario: {...}, result: {...} }

POST /api/security/defensive/control-tests/category/:category/run-all
  Params: { category: "authentication" }
  Response: { category, results, passed, failed, passRate }
```

### Red Team Blocking

```
POST /api/security/defensive/red-team-blocking/:engagementId/demonstrate
  Params: { engagementId: "eng_abc123" }
  Response: { engagement, analysis: { blockingRate, proof } }

GET /api/security/defensive/red-team-blocking/:engagementId
  Response: { evidence: [...], analysis: {...} }
```

### Defensive Agent

```
POST /api/security/defensive/defensive-agent/:engagementId/analyze
  Response: { analysis: { recommendations, rootCauseAnalysis, severityDistribution } }

GET /api/security/defensive/recommendations/:engagementId
  Response: { recommendations: [...], statistics: {...} }
```

### Posture & Detection

```
GET /api/security/defensive/posture/:engagementId
  Response: { posture: { controlTestsRun, redTeamBlocks, criticalGaps, overallPosture } }

GET /api/security/defensive/anonymized-sources
  Query: ?classification=hostile&limit=100
  Response: { sources: [...], statistics: {...} }
```

---

## Operational Workflow

### Defensive Testing Cycle

```
Day 1: Create Engagement
  └─ Start Red Team testing within scope

Day 2: Validate Controls
  ├─ Run all DCT scenarios (control-tests)
  ├─ Verify auth, authz, rate limiting work
  └─ If failures: CRITICAL alert

Day 3: Monitor Sources
  ├─ Tor/proxy detection active
  ├─ Classify incoming requests
  └─ Throttle/block hostile patterns

Day 4: Generate Blocking Proof
  ├─ Run blocking demonstration
  ├─ Prove scope guard effective
  └─ Capture 100% blocking rate

Day 5: Analyze & Remediate
  ├─ Run defensive agent analysis
  ├─ Generate recommendations
  ├─ Developers implement fixes
  └─ Re-run control tests to verify

Day 6: Posture Assessment
  ├─ Review overall defensive health
  ├─ Gap analysis (critical gaps remaining?)
  └─ Report: grade (A+, A, B, C, D, F)
```

---

## Database Schema

### Tables

**defensive_control_tests**
```sql
id (UUID)
test_category (enum: auth, authz, tenant-isolation, rate-limit, validation)
test_scenario (string)
description (text)
created_at (timestamp)
```

**defensive_control_test_results**
```sql
id (UUID)
test_id (FK)
engagement_id (FK, nullable)
passed (boolean)
observed_behavior (text)
evidence (JSONB)
severity_if_failed (enum: critical, high, medium)
executed_at (timestamp)
created_at (timestamp)
```

**anonymized_source_audit**
```sql
id (UUID)
source_ip (INET)
user_agent (text, nullable)
detection_method (enum: tor-exit-node, proxy-ip, vpn-signature, etc.)
classification (enum: informational, suspicious, hostile)
endpoint (string)
requested_at (timestamp)
response_code (int, nullable)
action_taken (enum: logged, throttled, blocked, challenged)
engagement_id (FK, nullable)
created_at (timestamp)
```

**defense_blocking_evidence**
```sql
id (UUID)
engagement_id (FK)
red_team_action (text)
scope_guard_reason (text)
risk_level (enum: LEVEL_1-4, nullable)
target_attempted (text, nullable)
authorization_denied_because (text, nullable)
audit_log_entry (JSONB)
blocked_at (timestamp)
created_at (timestamp)
```

**defensive_recommendations**
```sql
id (UUID)
engagement_id (FK, nullable)
finding_id (FK, nullable)
failed_defense (text)
attack_category (text)
remediation_path (enum: code-change, config-hardening, policy-update, process-change)
recommendation (text)
severity (enum: critical, high, medium, low, info)
effort_estimate (enum: trivial, small, medium, large)
proof_of_concept (text, nullable)
defensive_agent_id (text, nullable)
created_at (timestamp)
accepted_at (timestamp, nullable)
```

**defensive_posture_summary**
```sql
id (UUID)
engagement_id (FK, unique)
control_tests_run (int)
control_tests_passed (int)
control_tests_failed (int)
anonymized_sources_detected (int)
red_team_blocks (int)
defense_blocking_rate (real)
recommendations_generated (int)
recommendations_accepted (int)
critical_gaps (int)
overall_posture (enum: unknown, weak, fair, strong, excellent)
updated_at (timestamp)
```

---

## Integration Points

### With Red Team Framework

```
Red Team Engagement
  ├─ Scope: authorized targets, categories, prohibited actions
  ├─ Findings: discovered vulnerabilities
  └─ Evidence: sanitized proof artifacts
       ↓
Defensive Framework
  ├─ Control Tests: Prove controls work
  ├─ Blocking Demo: Prove attacks are blocked
  ├─ Anonymized Detection: Detect hostile patterns
  └─ Agent Analysis: Recommend fixes
       ↓
Feedback Loop
  ├─ Developers implement recommendations
  ├─ Re-run control tests to verify
  ├─ Add regression tests
  └─ Update scope for next engagement
```

### With Agent Framework

```
DefensiveAgent
  ├─ Uses RedTeamFindingStore to read findings
  ├─ Maps findings to failed defenses
  ├─ Generates recommendations
  └─ Stores in defensive_recommendations table
```

### With Security Routes

```
/api/security/engagements/:id → gets Red Team engagement
/api/security/engagements/:id/findings → gets findings
  ↓
/api/security/defensive/defensive-agent/:id/analyze
  ├─ Analyzes findings
  ├─ Generates recommendations
  └─ Stores in defensive_recommendations
```

---

## Testing Checklist

- [ ] All 9 DCT scenarios create and store correctly
- [ ] Tor/proxy detection correctly classifies requests
- [ ] Pattern detection escalates from suspicious → hostile
- [ ] Red Team blocking demo generates 100% blocking rate
- [ ] Defensive agent analysis maps findings to defenses
- [ ] Recommendations have realistic effort estimates
- [ ] Posture summary aggregates metrics correctly
- [ ] All timestamps are accurate (UTC)
- [ ] No false positives in Tor detection (legitimate users not blocked)
- [ ] Complete audit trail (all operations logged with reason)

---

## Deployment Notes

1. **Database Migration**
   ```bash
   npm run db:migrate
   # Migration 005 creates defensive testing tables
   ```

2. **Server Registration**
   - Routes registered in `apps/server/src/index.ts`
   - Stores connected to shared pool
   - No additional env vars required

3. **First Run**
   ```bash
   # 1. Create engagement via /api/security/engagements
   # 2. Run control tests: POST /api/security/defensive/control-tests/category/authentication/run-all
   # 3. Demonstrate blocking: POST /api/security/defensive/red-team-blocking/{engagementId}/demonstrate
   # 4. Analyze findings: POST /api/security/defensive/defensive-agent/{engagementId}/analyze
   # 5. View recommendations: GET /api/security/defensive/recommendations/{engagementId}
   ```

4. **Monitoring**
   - Alert on control test failures (HIGH severity)
   - Track anonymized source patterns
   - Monitor recommendation acceptance rate
   - Review defensive posture grades

---

## Future Enhancements

1. **Automated Remediation**
   - Auto-apply low-risk fixes (config-hardening)
   - Open PRs for code-change recommendations
   - Notify team for policy-change recommendations

2. **Comparative Analysis**
   - Track defensive posture over time
   - Identify trends (improving/declining)
   - Compare against industry benchmarks

3. **Threat Model Integration**
   - Map recommendations to MITRE ATT&CK
   - Prioritize by threat model relevance
   - Generate compliance evidence (SOC 2, ISO 27001)

4. **Extended Detection**
   - GeoIP-based anomaly detection
   - Behavioral analysis (unusual endpoints, timing)
   - ML-based threat scoring

---

## Conclusion

The Defensive Testing Framework transforms security testing from **one-time assessments** into **continuous validation**:

✅ **Prove** that security controls work (DCT)  
✅ **Detect** malicious patterns (Tor/proxy detection)  
✅ **Demonstrate** defensive success (Red Team blocking)  
✅ **Recommend** improvements (Blue Team analysis)  
✅ **Verify** fixes work (regression testing)  

All within an **auditable, deterministic** system that treats findings as evidence and recommendations as actionable intelligence.
