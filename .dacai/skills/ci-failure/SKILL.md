---
name: ci-failure
description: Diagnose a failing CI check, reproduce it locally, patch the root cause, and verify before proposing a PR.
tags: [ci, github, debug, coding, testing]
---
# CI Failure

Use GitHub/gh check inspection when available. Identify the specific failing job/check first.

Reproduce the smallest equivalent validation locally. Trace the failure to source. Fix only the root cause. Rerun the targeted check and then the relevant package/repository validation.

If credentials or remote CI access are unavailable, stop at the local evidence boundary instead of inventing CI status.
