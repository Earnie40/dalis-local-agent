---
name: repository-exploration
description: Map an unfamiliar repository using filename discovery, symbol retrieval, and exact source reads.
tags: [repository, exploration, rag, symbols]
---
# Repository Exploration

Start with repository structure and semantic symbol retrieval. Use `filesystem.list` for filename discovery, `filesystem.search` for text/symbol discovery, and `filesystem.read` for known files.

Prefer the existing `code_symbols` and `symbol_edges` context when available, then verify important facts with real file reads.

Return entry points, relevant modules, call/reference relationships, and the smallest set of files needed for the task.

## Repository intelligence

When source changes materially, refresh repository intelligence using:

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-repository-intelligence.ps1

This incrementally updates:

- repository files
- structural symbols
- symbol edges
- semantic symbol embeddings
- repository architecture map

Do not rebuild semantic embeddings that are already current.
