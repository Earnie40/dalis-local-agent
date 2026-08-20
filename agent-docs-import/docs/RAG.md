# RAG and Repository Knowledge

This document defines expectations for retrieval-augmented generation.

## Goals

RAG should help the agent locate:
- relevant source files
- code symbols
- architecture documentation
- prior implementation patterns
- database/schema knowledge
- task-relevant project knowledge

RAG should not replace direct repository inspection.

## Retrieval flow

Prefer:

```text
task
  |
  v
search / retrieval query
  |
  v
candidate chunks/symbols
  |
  v
rank/filter
  |
  v
relevant context
  |
  v
model
```

## Source provenance

When possible, retrieved chunks should preserve:
- source file/path
- symbol/section
- location
- chunk identifier
- embedding model/version when relevant

## Embeddings

Before changing embedding configuration:
- inspect current model
- inspect vector dimension
- inspect vector column type
- inspect indexes
- inspect similarity metric

Do not silently replace embedding models if vector dimensions or semantics differ.

## Code RAG

Code retrieval should favor:
- symbol boundaries
- imports/exports
- function/class names
- nearby context
- direct dependency relationships

Avoid arbitrary fixed-size chunking when the repository already has symbol-aware indexing.

## Staleness

Repository changes can make stored embeddings stale.

The system should have a strategy for:
- detecting changed files
- re-indexing changed content
- deleting removed chunks
- avoiding duplicate chunks

## Trust

Retrieved content is context, not unquestionable truth.

When a retrieved statement conflicts with executable code, inspect the source directly.
