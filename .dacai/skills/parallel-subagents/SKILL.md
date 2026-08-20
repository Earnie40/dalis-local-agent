---
name: parallel-subagents
description: Split independent repository work into parallel child agents with isolated worktrees.
tags: [parallel, subagent, worktree, coding]
---
# Parallel Subagents

Delegate only genuinely independent workstreams.

Use `agent.delegate` with `isolate: true` for child agents that may edit files. Each child receives its own registered workspace backed by a Git worktree.

Good child roles:
- `repo-explorer` for repository mapping.
- `debugger` for diagnosis.
- `coder` for bounded implementation.
- `test-engineer` for tests.
- `security-reviewer` for hypothesis-driven defensive review.
- `variant-hunter` for structural analog searches.
- `ci-fixer` for CI remediation.

Submit multiple child tasks before polling so they can run concurrently.

Do not have two mutating children edit the same files. Review child diffs before integration.
