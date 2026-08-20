# Advanced Capability Router

This router covers advanced DacaiLocalAgent capabilities **1-61 and 70-100**.

Capabilities 62-69 are intentionally excluded because they are implemented by the
Experience Intelligence / API discovery capability pack.

## Routing Rules

- Use `skills.read` on the exact capability skill before invoking an advanced
  workflow.
- Do not load the full catalog into every task.
- Select the smallest capability or capability set relevant to the current goal.
- Bounded-execution skills may use existing registered tools.
- Proposal-only skills may inspect and plan but cannot silently cross their
  high-impact boundary.
- Existing infrastructure permissions always override skill instructions.
- Resource limits remain authoritative.
- Never allow a skill to create an alternate permission path.

## Catalog

- 1: Autonomous Git branching/worktree agents [bounded_execution] -> `001-autonomous-git-branching-worktree-agents`
- 2: Multi-agent merge arbitration [bounded_execution] -> `002-multi-agent-merge-arbitration`
- 3: Automatic conflict resolution [bounded_execution] -> `003-automatic-conflict-resolution`
- 4: Patch ranking / best-of-N coding [bounded_execution] -> `004-patch-ranking-best-of-n-coding`
- 5: Self-training from successful coding traces [bounded_execution] -> `005-self-training-from-successful-coding-traces`
- 6: Automatic prompt evolution [proposal_only] -> `006-automatic-prompt-evolution`
- 7: Self-modifying agent architecture [proposal_only] -> `007-self-modifying-agent-architecture`
- 8: Automatic tool creation [proposal_only] -> `008-automatic-tool-creation`
- 9: Dynamic plugin installation [proposal_only] -> `009-dynamic-plugin-installation`
- 10: Automatic package upgrades [bounded_execution] -> `010-automatic-package-upgrades`
- 11: Automatic framework migrations [bounded_execution] -> `011-automatic-framework-migrations`
- 12: Autonomous database migrations [proposal_only] -> `012-autonomous-database-migrations`
- 13: Automatic database repair [proposal_only] -> `013-automatic-database-repair`
- 14: Automatic infrastructure provisioning [proposal_only] -> `014-automatic-infrastructure-provisioning`
- 15: Autonomous deployment [proposal_only] -> `015-autonomous-deployment`
- 16: Automatic CI/CD modification [bounded_execution] -> `016-automatic-ci-cd-modification`
- 17: Autonomous PR publishing/merging [proposal_only] -> `017-autonomous-pr-publishing-merging`
- 18: Production rollback orchestration [proposal_only] -> `018-production-rollback-orchestration`
- 19: Continuous production monitoring agent [bounded_execution] -> `019-continuous-production-monitoring-agent`
- 20: Automatic incident-response agent [proposal_only] -> `020-automatic-incident-response-agent`
- 21: Autonomous security remediation [proposal_only] -> `021-autonomous-security-remediation`
- 22: Automatic secret rotation [proposal_only] -> `022-automatic-secret-rotation`
- 23: Credential discovery/recovery agent [proposal_only] -> `023-credential-discovery-recovery-agent`
- 24: Unrestricted browser/computer-use agent [proposal_only] -> `024-unrestricted-browser-computer-use-agent`
- 25: Public-web browser automation [proposal_only] -> `025-public-web-browser-automation`
- 26: Autonomous account operations [proposal_only] -> `026-autonomous-account-operations`
- 27: General filesystem-cleanup agent [proposal_only] -> `027-general-filesystem-cleanup-agent`
- 28: System-administration agent [proposal_only] -> `028-system-administration-agent`
- 29: Automatic process killing beyond owned processes [proposal_only] -> `029-automatic-process-killing-beyond-owned-processes`
- 30: Privilege escalation helper [proposal_only] -> `030-privilege-escalation-helper`
- 31: Automatic Docker/container orchestration [bounded_execution] -> `031-automatic-docker-container-orchestration`
- 32: Automatic local service provisioning [bounded_execution] -> `032-automatic-local-service-provisioning`
- 33: Full autonomous environment recreation [proposal_only] -> `033-full-autonomous-environment-recreation`
- 34: Distributed multi-machine agent execution [bounded_execution] -> `034-distributed-multi-machine-agent-execution`
- 35: GPU-aware heterogeneous scheduling [bounded_execution] -> `035-gpu-aware-heterogeneous-scheduling`
- 36: Automatic cloud bursting [proposal_only] -> `036-automatic-cloud-bursting`
- 37: Cross-provider model auctions [bounded_execution] -> `037-cross-provider-model-auctions`
- 38: Speculative parallel inference [bounded_execution] -> `038-speculative-parallel-inference`
- 39: Model ensemble voting for ordinary decisions [bounded_execution] -> `039-model-ensemble-voting-for-ordinary-decisions`
- 40: Automatic model benchmarking/routing [bounded_execution] -> `040-automatic-model-benchmarking-routing`
- 41: Token-budget marketplace [bounded_execution] -> `041-token-budget-marketplace`
- 42: Agent economic accounting [bounded_execution] -> `042-agent-economic-accounting`
- 43: Long-term autonomous memory consolidation [bounded_execution] -> `043-long-term-autonomous-memory-consolidation`
- 44: Cross-project knowledge transfer [bounded_execution] -> `044-cross-project-knowledge-transfer`
- 45: Organization-wide codebase federation [bounded_execution] -> `045-organization-wide-codebase-federation`
- 46: Cross-repository autonomous refactoring [bounded_execution] -> `046-cross-repository-autonomous-refactoring`
- 47: Automatic architecture refactoring [bounded_execution] -> `047-automatic-architecture-refactoring`
- 48: Continuous code-quality agent [bounded_execution] -> `048-continuous-code-quality-agent`
- 49: Continuous dependency-vulnerability remediation [bounded_execution] -> `049-continuous-dependency-vulnerability-remediation`
- 50: Fuzz-testing generation [bounded_execution] -> `050-fuzz-testing-generation`
- 51: Mutation-testing orchestration [bounded_execution] -> `051-mutation-testing-orchestration`
- 52: Large-scale adversarial testing of the coding agent itself [bounded_execution] -> `052-large-scale-adversarial-testing-of-the-coding-agent-itself`
- 53: Formal verification integration [bounded_execution] -> `053-formal-verification-integration`
- 54: Symbolic execution [bounded_execution] -> `054-symbolic-execution`
- 55: Static taint-analysis engine integration [bounded_execution] -> `055-static-taint-analysis-engine-integration`
- 56: Runtime instrumentation/profiling agent [bounded_execution] -> `056-runtime-instrumentation-profiling-agent`
- 57: Automatic performance optimization [bounded_execution] -> `057-automatic-performance-optimization`
- 58: Load-test orchestration [bounded_execution] -> `058-load-test-orchestration`
- 59: Synthetic-user/browser fleets [bounded_execution] -> `059-synthetic-user-browser-fleets`
- 60: Accessibility automation beyond targeted checks [bounded_execution] -> `060-accessibility-automation-beyond-targeted-checks`
- 61: Visual pixel-diff baseline system [bounded_execution] -> `061-visual-pixel-diff-baseline-system`
- 70: Contract-test federation [bounded_execution] -> `070-contract-test-federation`
- 71: Data-generation agent [bounded_execution] -> `071-data-generation-agent`
- 72: Test-user lifecycle management [bounded_execution] -> `072-test-user-lifecycle-management`
- 73: Automatic feature-flag management [bounded_execution] -> `073-automatic-feature-flag-management`
- 74: Release-readiness scoring [bounded_execution] -> `074-release-readiness-scoring`
- 75: Autonomous release notes/changelog generation as a gate [bounded_execution] -> `075-autonomous-release-notes-changelog-generation-as-a-gate`
- 76: Automatic documentation synchronization [bounded_execution] -> `076-automatic-documentation-synchronization`
- 77: Automatic ADR generation [bounded_execution] -> `077-automatic-adr-generation`
- 78: Code ownership inference [bounded_execution] -> `078-code-ownership-inference`
- 79: Developer-behavior modeling [bounded_execution] -> `079-developer-behavior-modeling`
- 80: Predictive failure prevention [bounded_execution] -> `080-predictive-failure-prevention`
- 81: Monte Carlo planning [bounded_execution] -> `081-monte-carlo-planning`
- 82: Hierarchical manager-of-managers agents [bounded_execution] -> `082-hierarchical-manager-of-managers-agents`
- 83: Persistent autonomous agent teams [proposal_only] -> `083-persistent-autonomous-agent-teams`
- 84: Agent negotiation protocols [bounded_execution] -> `084-agent-negotiation-protocols`
- 85: Agent reputation/scoring [bounded_execution] -> `085-agent-reputation-scoring`
- 86: Automatic specialist generation [bounded_execution] -> `086-automatic-specialist-generation`
- 87: Self-healing orchestration topology [proposal_only] -> `087-self-healing-orchestration-topology`
- 88: Full event-sourced agent runtime [bounded_execution] -> `088-full-event-sourced-agent-runtime`
- 89: Workflow replay/time travel [bounded_execution] -> `089-workflow-replay-time-travel`
- 90: Forkable run histories [bounded_execution] -> `090-forkable-run-histories`
- 91: Human-approval policy learning [proposal_only] -> `091-human-approval-policy-learning`
- 92: Automatic permission expansion [proposal_only] -> `092-automatic-permission-expansion`
- 93: Organization/tenant policy learning [bounded_execution] -> `093-organization-tenant-policy-learning`
- 94: Blockchain/evidence anchoring of coding runs [bounded_execution] -> `094-blockchain-evidence-anchoring-of-coding-runs`
- 95: Cryptographic attestation of agent output [bounded_execution] -> `095-cryptographic-attestation-of-agent-output`
- 96: Remote attested execution [bounded_execution] -> `096-remote-attested-execution`
- 97: Autonomous billing/metering for agent labor [bounded_execution] -> `097-autonomous-billing-metering-for-agent-labor`
- 98: Full IDE-control agent [proposal_only] -> `098-full-ide-control-agent`
- 99: Voice-driven coding-agent interface [bounded_execution] -> `099-voice-driven-coding-agent-interface`
- 100: General-purpose computer agent mode [proposal_only] -> `100-general-purpose-computer-agent-mode`
