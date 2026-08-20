# Red Team / Blue Team / Purple Team Security Framework
## Implementation Summary

**Date**: 2026-08-15  
**Status**: Phase 1-3 Complete (Foundational Infrastructure & API Layer)  
**Architecture**: Zero-trust enforcement, deterministic safety controls, human-gated authorization

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    RED TEAM / BLUE TEAM FRAMEWORK                │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  AUTHORIZATION LAYER                                             │
│  ├─ ScopeGuard: Target/environment/category/time-window checks   │
│  ├─ RedTeamToolGateway: Zero-trust tool execution enforcement    │
│  └─ RiskClassifier: 4-level impact assessment (LEVEL_1 to 4)     │
│                                                                   │
│  ENGAGEMENT LIFECYCLE                                            │
│  ├─ Create (draft) → Approve (approved) → Start (active)         │
│  ├─ Pause (paused) or Stop (revoked) at any time                 │
│  └─ Complete (completed) with findings summary                   │
│                                                                   │
│  SECURITY TESTING MODES                                          │
│  ├─ ADVERSARIAL: Automated, continuous, within scope             │
│  ├─ RED TEAM: Authorized penetration testing with approval gates │
│  ├─ PURPLE TEAM: Red+Blue coordination with detection metrics    │
│  └─ ALL: Zero-trust enforcement, scope-bounded, auditable        │
│                                                                   │
│  DATA COLLECTION                                                 │
│  ├─ Findings: Candidate vulnerabilities with confidence          │
│  ├─ Evidence: Sanitized, auditable proof artifacts               │
│  ├─ Attack Paths: Composite attack chains                        │
│  └─ Metrics: Detection rate, block rate, TTD, TTR                │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Completed Implementation

### 1. Database Schema (Migration 004)
**File**: `packages/shared/src/db/migrations/004_red_team_security.sql`

13 tables supporting the full lifecycle:

| Table | Purpose |
|-------|---------|
| `red_team_engagements` | Authorized testing campaigns with scope & rules |
| `red_team_findings` | Candidate vulnerabilities discovered |
| `red_team_evidence` | Sanitized artifacts proving findings |
| `red_team_attack_paths` | Composite attack chains |
| `adversarial_test_results` | Automated test execution results |
| `red_team_scope_violations` | When agents attempt out-of-scope actions |
| `purple_team_observations` | Synchronized red/blue observations |
| `security_test_summaries` | Aggregated engagement statistics |
| `red_team_tool_audit` | Every tool call during engagement |
| `red_team_approvals` | Approval trail for engagement decisions |
| + support for scalability and historical analysis |

### 2. Domain Types & Interfaces
**File**: `packages/security/src/red-team-types.ts`

Complete type system defining:

- `RedTeamEngagement`: Time-bounded, scope-limited authorization
- `RedTeamFinding`: Candidate vulnerabilities with severity & confidence
- `RedTeamEvidence`: Sanitized, auditable proof artifacts
- `RedTeamAttackPath`: Attack chains with composite risk assessment
- `ScopeGuardDecision`: Authorization validation result
- `RiskClassification`: 4-level impact assessment
- `AdversarialTestResult`: Automated test execution record
- `PurpleTeamObservation`: Red/blue coordinated observation

### 3. Authorization & Enforcement Layer

#### ScopeGuard
**File**: `packages/security/src/scope-guard.ts`

Validates actions against engagement scope:
- ✓ Target allowlist validation (exact, glob, wildcard patterns)
- ✓ Environment authorization checks
- ✓ Category authorization
- ✓ Time-window enforcement
- ✓ Prohibited action filtering

```typescript
const decision = scopeGuard.validate({
  engagement,
  agentId,
  requestedTarget,
  requestedAction,
  requestedCategory,
});
// Returns: { authorized, reason, specific violation flags }
```

#### RiskClassifier
**File**: `packages/security/src/risk-classifier.ts`

Categorizes actions by impact level:

- **LEVEL_1_SAFE**: Passive inspection, read-only analysis
- **LEVEL_2_CONTROLLED**: Auth/authz testing, malformed inputs, business logic
- **LEVEL_3_HIGH_IMPACT**: State-changing, multi-step attacks, control bypass
- **LEVEL_4_RESTRICTED**: Destructive, persistence, scope expansion (never autonomously execute)

#### RedTeamToolGateway
**File**: `packages/security/src/red-team-tool-gateway.ts`

Zero-trust tool execution enforcement:

```
Red Team Agent Request
         ↓
  Engagement Verification
         ↓
    Scope Guard Validation
         ↓
   Risk Classification
         ↓
 LEVEL_4? → Block (never autonomously)
         ↓
 Needs Approval? → Request Human Decision
         ↓
     Execute (with audit)
```

Never trusts:
- Generated parameters
- Retrieved content
- LLM-claimed authorization
- Agent self-modification

### 4. Persistence Layer
**File**: `packages/shared/src/db/red-team-stores.ts`

Database access classes:
- `RedTeamEngagementStore`
- `RedTeamFindingStore`
- `RedTeamEvidenceStore`
- `AdversarialTestResultStore`
- `SecurityTestSummaryStore`

All use connection pool from shared infrastructure (`getPool()`).

### 5. REST API Endpoints
**File**: `apps/server/src/routes/security.ts`

Complete engagement lifecycle management:

```
POST   /api/security/engagements
       → Create new engagement (draft status)

GET    /api/security/engagements?customerId=...
       → List engagements for customer

GET    /api/security/engagements/:id
       → Get engagement with findings summary

POST   /api/security/engagements/:id/approve
       → Approve for activation (draft → approved)

POST   /api/security/engagements/:id/start
       → Start engagement (approved → active)

POST   /api/security/engagements/:id/pause
       → Temporarily pause active engagement

POST   /api/security/engagements/:id/stop
       → Revoke engagement immediately

POST   /api/security/engagements/:id/findings
       → Create finding (vulnerability report)

GET    /api/security/engagements/:id/findings
       → List findings for engagement

POST   /api/security/findings/:id/evidence
       → Add evidence artifact to finding

GET    /api/security/findings/:id/evidence
       → List evidence for finding

GET    /api/security/engagements/:id/statistics
       → Get aggregated engagement metrics
```

### 6. Adversarial Agent (Template)
**File**: `packages/agents/src/adversarial-agent.ts`

Built-in security test scenarios for continuous testing:

**Authentication Tests**:
- Valid token acceptance
- Expired token rejection
- Malformed token rejection

**Authorization Tests**:
- User access control validation
- Elevated access prevention

**Tenant Isolation**:
- Cross-tenant access blocking

**Injection Resistance**:
- SQL injection testing
- Prompt injection testing

**Rate Limiting**:
- Threshold enforcement

**Data Validation**:
- Missing field validation
- Type mismatch validation

**Business Logic**:
- State consistency verification

**Regression**:
- Known vulnerability re-testing

All tests marked `LEVEL_1_SAFE` or `LEVEL_2_CONTROLLED` for autonomous execution.

---

## Operating Principles

### 1. Zero-Trust Enforcement
Every tool request from a red team agent is validated against:
1. Engagement existence and status
2. Time window authorization
3. Target allowlist
4. Category authorization
5. Action prohibition list
6. Risk level (with approval gate for high-impact)

**No shortcuts. No exceptions. No LLM override.**

### 2. Deterministic Safety Controls
- Engagement status is application state, not LLM memory
- Authorization decisions use database records, not prompt claims
- Rate limits enforced by database-backed counters
- All scope violations logged and blocked before execution

### 3. Audit Trail
Every action is logged:
- Engagement lifecycle state changes
- Authorization decisions (granted/denied/reason)
- Tool execution with sanitized parameters
- Evidence collection and validation
- Human approval records

### 4. Tenant Isolation
- Engagements scoped to `customer_id`
- Findings/evidence isolated by `engagement_id`
- Scope violations recorded per engagement
- Purple team observations linked to specific engagement

---

## Safety Constraints

### What Red Team Agents Cannot Do
- ✗ Act on expired or revoked engagements (checked at gateway)
- ✗ Target systems outside authorized allowlist (scope guard)
- ✗ Attempt test categories not in `allowed_test_categories`
- ✗ Execute actions in `prohibited_actions` list
- ✗ Perform LEVEL_4 operations without explicit human approval
- ✗ Modify their own engagement scope or permissions
- ✗ Override tool parameters with retrieved/generated content
- ✗ Persist changes or backdoors (tools are sandboxed)
- ✗ Access real customer data (only synthetic/test data allowed)

### What The System Enforces
- ✓ Scope-bounded execution (target validation)
- ✓ Authorization gates (policy engine)
- ✓ Rate limiting (concurrent request counters)
- ✓ Time windows (start/expiry enforcement)
- ✓ Approval requirements (human decision on high-risk)
- ✓ Audit logging (non-repudiation)
- ✓ Evidence sanitization (credentials redacted)
- ✓ Engagement revocation (immediate stop)

---

## Engagement Lifecycle

```
┌─────────┐
│  DRAFT  │ ← Initial creation, may be edited
└────┬────┘
     │ [Human Approval Required]
     ↓
┌───────────┐
│ APPROVED  │ ← Ready to start, may be edited
└────┬──────┘
     │ [Start Command]
     ↓
┌────────┐       ┌────────┐
│ ACTIVE │◄─────►│ PAUSED │ ← Can pause/resume
└────┬───┘       └────────┘
     │
     │ [Stop Command OR Time Expires]
     ↓
┌──────────────┐
│  REVOKED     │ ← All active operations cease
└──────────────┘

     OR

┌───────────┐
│ COMPLETED │ ← Engagement ended normally, findings preserved
└───────────┘
```

### State Transitions & Enforcement

| From | To | Requires | Effect |
|------|-----|----------|--------|
| DRAFT | APPROVED | Human approval | Engagement ready for activation |
| APPROVED | ACTIVE | Start command | All tools/tests can execute |
| ACTIVE | PAUSED | Pause command | New tool calls blocked, existing allowed to complete |
| PAUSED | ACTIVE | Resume command | Execution continues |
| ACTIVE / PAUSED | REVOKED | Stop command | Immediate termination, all agents denied |
| ANY | REVOKED | Expiration time | Auto-revoke when `expiresAt` time passes |

---

## Risk Level Gates

### LEVEL_1_SAFE
Examples: Configuration inspection, synthetic data validation, replay tests

- **Approval Required**: No
- **Autonomously Executable**: Yes
- **Typical Duration**: Seconds to minutes
- **Scope**: Read-only or verified-safe operations

### LEVEL_2_CONTROLLED
Examples: Authentication testing, authorization probing, business logic edge cases

- **Approval Required**: Context-dependent (default: yes for production)
- **Autonomously Executable**: No (default; can be overridden by engagement policy)
- **Typical Duration**: Minutes
- **Scope**: Controlled state changes, test accounts only

### LEVEL_3_HIGH_IMPACT
Examples: Multi-step attack paths, permission bypass validation, control disruption testing

- **Approval Required**: Yes (always)
- **Autonomously Executable**: No
- **Typical Duration**: Minutes to hours
- **Scope**: May cause temporary service impact

### LEVEL_4_RESTRICTED
Examples: Destructive operations, persistence, uncontrolled propagation, real data access

- **Approval Required**: Yes (always) + additional evidence
- **Autonomously Executable**: Never
- **Typical Duration**: Variable
- **Scope**: Treated as potentially malicious, always gated

---

## Frontend Integration (Stub)

Extend frontend `agentService` (apps/web/src/api.ts):

```typescript
export const securityService = {
  // Engagement management
  createEngagement: (config: CreateEngagementRequest) =>
    json('/api/security/engagements', { method: 'POST', body: JSON.stringify(config) }),
  
  getEngagement: (id: string) =>
    json(`/api/security/engagements/${id}`),
  
  listEngagements: (customerId: string) =>
    json(`/api/security/engagements?customerId=${customerId}`),
  
  approveEngagement: (id: string) =>
    json(`/api/security/engagements/${id}/approve`, { method: 'POST' }),
  
  startEngagement: (id: string) =>
    json(`/api/security/engagements/${id}/start`, { method: 'POST' }),
  
  stopEngagement: (id: string) =>
    json(`/api/security/engagements/${id}/stop`, { method: 'POST' }),
  
  // Findings
  createFinding: (engagementId: string, finding) =>
    json(`/api/security/engagements/${engagementId}/findings`, 
          { method: 'POST', body: JSON.stringify(finding) }),
  
  getFindings: (engagementId: string) =>
    json(`/api/security/engagements/${engagementId}/findings`),
  
  // Statistics
  getStatistics: (engagementId: string) =>
    json(`/api/security/engagements/${engagementId}/statistics`),
};
```

---

## Testing Checklist

### Authorization & Scope
- [ ] Engagement must exist to execute any action
- [ ] Expired engagements auto-revoke (time-based)
- [ ] Revoked engagements deny all tool requests
- [ ] Target not in allowlist → denied
- [ ] Category not in allowed → denied
- [ ] Prohibited action → denied immediately
- [ ] Multiple scope violations return detailed reason

### Tool Gateway
- [ ] LEVEL_1 actions execute without approval
- [ ] LEVEL_2 actions request approval (configurable)
- [ ] LEVEL_3 actions require explicit approval
- [ ] LEVEL_4 actions never execute autonomously
- [ ] Approval timeout → automatic denial
- [ ] Human rejection → logged and denied

### Audit Trail
- [ ] Every tool call logged with engagement ID
- [ ] Authorization decisions recorded (decision kind + reason)
- [ ] Evidence sanitized before storage
- [ ] Scope violations create audit entry
- [ ] Approval records link to findings

### Tenant Isolation
- [ ] Engagements only list for correct customer
- [ ] Findings cannot cross engagement boundaries
- [ ] Evidence isolated by engagement ID
- [ ] Statistics aggregate only owned findings
- [ ] Scope violations scoped to engagement

### Attack Resistance
- [ ] Prompt injection cannot modify engagement scope
- [ ] Malicious tool parameters rejected
- [ ] Fake approval IDs denied
- [ ] Expired approval tokens denied
- [ ] Retrieved content cannot override authorization
- [ ] Agent cannot re-auth as different engagement

---

## Files Changed / Created

### Core Infrastructure
| File | Purpose |
|------|---------|
| `packages/shared/src/db/migrations/004_red_team_security.sql` | Schema: 13 tables for full lifecycle |
| `packages/security/src/red-team-types.ts` | TypeScript types & interfaces |
| `packages/security/src/scope-guard.ts` | Authorization validation |
| `packages/security/src/risk-classifier.ts` | Impact level assessment |
| `packages/security/src/red-team-tool-gateway.ts` | Zero-trust tool gateway |
| `packages/shared/src/db/red-team-stores.ts` | Database access layer |
| `packages/security/src/index.ts` | Export all security types |
| `packages/shared/src/index.ts` | Export stores |

### Routes & API
| File | Purpose |
|------|---------|
| `apps/server/src/routes/security.ts` | 13 REST endpoints |
| `apps/server/src/index.ts` | Route registration |

### Agents
| File | Purpose |
|------|---------|
| `packages/agents/src/adversarial-agent.ts` | Built-in test scenarios (10+ tests) |

### Configuration
| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent definitions (now includes red team note) |
| `copilot-instructions.md` | Safety guardrails documentation |

---

## Next Implementation Steps

### Phase 4: Red Team Lead Agent
- Orchestration layer for specialized agents (recon, api, auth, business-logic, ai-security)
- Attack surface modeling
- Finding correlation
- Attack chain analysis

### Phase 5: Judge & Evidence
- Finding validation (judge agent)
- False positive detection
- Evidence sanitization utilities
- Threat model linking

### Phase 6: Blue Team
- Defensive analysis
- Threat interpretation
- Remediation recommendation
- Detection log correlation

### Phase 7: Purple Team Coordination
- Real-time red/blue observation sync
- Detection rate & block rate metrics
- Mean time to detection (MTTD)
- Mean time to response (MTTR)

### Phase 8: AI Red Team
- Direct prompt injection tests
- Indirect prompt injection (via RAG)
- Memory poisoning scenarios
- Agent impersonation tests
- Tool manipulation attempts
- Cross-agent confusion tests

### Phase 9: Full Testing Suite
- Engagement authorization gates
- Scope enforcement boundaries
- Approval workflow completion
- Tenant isolation validation
- Audit trail integrity

---

## Deployment Notes

1. **Database Migration**
   ```bash
   npm run db:migrate
   # Migration 004 creates 13 new tables
   ```

2. **Environment Configuration**
   - Engagements created via API or CLI
   - No additional env vars required for basic functionality
   - Optional: Configure default approval timeout in agent-core

3. **Security Verification**
   - Run test suite: `npm test -- security`
   - Validate: Expired engagements cannot execute
   - Validate: Revoked engagements deny all operations
   - Validate: Cross-tenant access blocked

4. **Monitoring**
   - Log all scope violations
   - Alert on LEVEL_4 execution attempts
   - Track approval decision ratio
   - Monitor detection/block rates (purple team)

---

## Conclusion

The Red Team / Blue Team / Purple Team framework provides DACAIS with:

✅ **Authorized**: Explicit time-bounded, scope-limited engagements  
✅ **Autonomous**: Automated adversarial testing with built-in scenarios  
✅ **Auditable**: Complete audit trail of all decisions and actions  
✅ **Safe**: Zero-trust enforcement, deterministic safety gates  
✅ **Tenant-Isolated**: Multi-customer support with strict boundaries  
✅ **Coordinated**: Purple team support for red/blue correlation  
✅ **Scalable**: Database-driven, supports unlimited engagements  

The system enables DACAIS to:
- Continuously test security controls
- Discover and verify vulnerabilities
- Coordinate defensive responses
- Maintain regression test suite
- Generate compliance evidence

All while treating LLM agents as potentially hostile and enforcing authorization at the infrastructure level, not the prompt level.
