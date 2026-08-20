# DacaiLocalAgent Architecture

This document is the high-level architecture reference for the local agent.

Update it when major boundaries or execution flows change.

## Current visible application layout

```text
DacaiLocalAgent/
├── .github/
│   └── agents/
├── .qwen/
├── apps/
│   ├── server/
│   │   └── src/
│   │       └── routes/
│   └── web/
│       └── src/
└── docs/
```

## Logical architecture

The intended separation should remain approximately:

```text
User / Web UI
      |
      v
Server API
      |
      v
Agent Runtime
      |
      +--> Model Provider / Ollama
      |
      +--> Tool Registry
      |
      +--> Permission / Approval Layer
      |
      +--> Memory / RAG
      |
      +--> Verification / Evidence
      |
      v
Task Result
```

## Architectural principles

1. The LLM is not the application.
2. The runtime controls tool execution.
3. Tools are permissioned.
4. Privileged actions are auditable.
5. RAG and memory are explicit subsystems.
6. Provider-specific behavior stays behind adapters when practical.
7. The web UI does not enforce security boundaries.
8. Server routes should not bypass the runtime.
9. Database configuration is discovered from environment/configuration.
10. Completion should be based on verification, not model confidence.

## Update requirements

Update this file when introducing:
- a new major service
- a new persistent store
- a new model provider
- a new execution layer
- a new permission/security boundary
- a new agent lifecycle
- a new RAG architecture
