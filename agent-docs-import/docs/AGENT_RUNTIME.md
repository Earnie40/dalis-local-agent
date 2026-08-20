# Agent Runtime

This document defines the expected behavior of the local autonomous agent runtime.

## Core loop

A capable coding agent should operate approximately as:

```text
User task
  |
  v
Model
  |
  +--> tool call
         |
         v
      runtime executes tool
         |
         v
      result returned to model
         |
         v
      next decision
         |
         +--> more tools / edits / tests
         |
         +--> completion only after verification
```

A single model call that returns prose is a chatbot, not a full execution agent.

## Required runtime capabilities

The runtime should provide controlled access to capabilities such as:

- list directory
- repository search
- read file
- create file
- edit file
- delete file when authorized
- run command
- Git status/diff
- diagnostics
- test execution
- database inspection
- RAG retrieval

## Tool calls

Tool calls must be:
- structured
- validated
- scoped
- permission checked
- observable
- bounded by time/step/resource limits

Never execute arbitrary model-generated shell text without passing it through the execution policy.

## Task lifecycle

Prefer explicit states:

- queued
- planning
- running
- waiting_for_approval
- blocked
- failed
- completed
- cancelled

## Completion

The model saying "done" is not enough.

Completion should consider:
- requested files changed
- tests/checks run when applicable
- failures handled
- diff inspected
- verifier satisfied

## Context

Load context intentionally:

1. system instructions
2. root `AGENTS.md`
3. nearest nested `AGENTS.md`
4. current task
5. relevant repository files
6. relevant documentation
7. retrieved RAG context

Do not inject the entire repository or every Markdown file into every prompt.

## Model roles

Smaller local models may be useful for:
- classification
- file selection
- summaries
- simple edits
- retrieval queries

Stronger models should handle:
- planning
- implementation
- debugging
- multi-step tool use
- verification reasoning

The architecture should not depend on a single specific model size.
