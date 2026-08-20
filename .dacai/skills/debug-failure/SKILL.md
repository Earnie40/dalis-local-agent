---
name: debug-failure
description: Reproduce failures, form hypotheses, trace evidence, implement the smallest fix, and rerun validation.
tags: [debug, coding, testing]
---
# Debug Failure

1. Reproduce or inspect the exact failure.
2. Record the observed error verbatim enough to identify it.
3. Generate 2-4 plausible hypotheses.
4. Try to disprove each hypothesis with repository evidence.
5. Patch only the confirmed root cause.
6. Rerun the exact failing validation before broader validation.
7. Inspect the diff for accidental changes.
