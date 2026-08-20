# DacaiLocalAgent Implementation Plan

## Phase 1: Repository scaffold
- Create monorepo, workspace packages, config, and docs.
- Establish TypeScript, testing, and build tooling.

## Phase 2: Ollama connection
- Add provider implementation for Ollama HTTP API.
- Validate local model discovery and health checks.

## Phase 3: Basic chat
- Build minimal chat API and UI for sending prompts.
- Wire streamed responses into the UI.

## Phase 4: Agent loop
- Implement the base agent lifecycle.
- Add message assembly, tool-call intervals, and output formatting.

## Phase 5: Tool calling
- Implement filesystem, shell, git, and search tools.
- Add audit logs and permission enforcement.

## Phase 6: Workspace access
- Support dynamic workspace registration and per-workspace permissions.
- Add project metadata and memory scopes.

## Phase 7: Claude API provider
- Implement Anthropic integration behind a provider abstraction.
- Add usage accounting and escalation path.

## Phase 8: Escalation router
- Expand the router with budgeted decisions and ask/automatic modes.
- Add review of expensive tasks before escalation.

## Phase 9: MCP client/server
- Add MCP consumer capabilities and server exposure for external clients.
- Define high-level tools for delegation and task status.

## Phase 10: Browser automation
- Add Playwright-backed browser tools.
- Expose navigation, click, read, and screenshot actions.

## Phase 11: Multi-agent parallelism
- Add worker pools and delegation logic.
- Add orchestration policies for parallel tasks.

## Phase 12: RAG and memory
- Add retrieval indexing and selective context building.
- Integrate project and session memory storage.

## Phase 13: Telemetry
- Expand usage accounting and performance analytics.
- Measure local inference vs. API escalation.

## Phase 14: Hardening
- Security review, permission checks, and fail-safe policy tuning.
- Cross-platform readiness and production reliability.
