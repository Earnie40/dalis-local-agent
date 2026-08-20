# Semantic Repository Intelligence

Use this skill when understanding, debugging, modifying, reviewing, or locating code in the repository.

## Preferred discovery order

Do not begin with a recursive whole-repository filesystem listing unless semantic and targeted search cannot answer the question.

Prefer:

1. repository architecture map
2. semantic symbol search
3. dependency impact
4. targeted filesystem search/read
5. recursive filesystem exploration only as a fallback

## Architecture map

Run:

node --env-file=.env --import tsx packages/repository-index/src/run-architecture-context.ts

Use this to understand packages, applications, important files, and repository structure.

## Semantic code search

Run:

node --env-file=.env --import tsx packages/repository-index/src/run-hybrid-search.ts "<query>"

Examples:

node --env-file=.env --import tsx packages/repository-index/src/run-hybrid-search.ts "delegated agent concurrency"

node --env-file=.env --import tsx packages/repository-index/src/run-hybrid-search.ts "Ollama request timeout"

node --env-file=.env --import tsx packages/repository-index/src/run-hybrid-search.ts "tool permission selection"

The search combines semantic embeddings with lexical symbol retrieval.

## Dependency impact

Before changing an important symbol, run:

node --env-file=.env --import tsx packages/repository-index/src/run-symbol-impact.ts "<symbol>"

Use its callers, callees, references, and related tests to determine the change surface.

## Modification rule

Before modifying an existing implementation:

1. identify the relevant symbol semantically
2. inspect the exact source
3. inspect dependency impact
4. make the smallest justified change
5. validate affected behavior

Do not rewrite entire files when a targeted edit is sufficient.

## Context discipline

Repository intelligence is evidence.

Prefer a small high-relevance context set over dumping hundreds of file paths or unrelated source into model context.
