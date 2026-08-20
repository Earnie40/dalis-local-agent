---
name: coding-change
description: Implement bounded repository changes using inspect-edit-validate-review discipline.
tags: [coding, implementation, validation, git]
---
# Coding Change

Use for implementation, refactoring, configuration, and bug-fix tasks.

## Workflow
1. Read applicable `AGENTS.md` instructions.
2. Discover exact paths; never invent them.
3. Read surrounding implementation before editing.
4. Keep an explicit PENDING / COMPLETE / BLOCKED checklist.
5. Prefer targeted edits.
6. Validate with diagnostics, targeted tests, typecheck/build as appropriate.
7. Inspect the scoped Git diff.
8. Complete only after requested behavior is verified.

## Delegation
For a task with independent workstreams, delegate repository exploration, testing, or review to child agents. Use isolated worktrees for child agents that may edit code.

## Completion
Do not accept prose or a successful edit as proof. Mutation requires validation evidence.
