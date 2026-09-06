# Media pipeline handoff — 2026-09-06

Continues `docs/media-pipeline-continuation.md`, which remains the authoritative
record of the audit and the fixes. That report was written while everything was
still uncommitted; this covers what happened after it, and what is still open.

Nothing here re-audits. Read the continuation report first for *what* was fixed;
read this for *where it now lives* and *what is left*.

## State

Both repositories are committed and pushed. They were entirely uncommitted when
the previous session ended at its usage limit.

| Repo | Branch | Head | Remote |
| --- | --- | --- | --- |
| `DacaiLocalAgent` | `execution-grounding-fixes` | `82dc56c` | pushed, tracking `origin/execution-grounding-fixes` |
| `deepbrain-avatar-poc` | `feat/realtime-avatar-and-generative-video` | `a6b8894` | pushed |

`execution-grounding-fixes` is **10 commits ahead of `origin/main`** and no pull
request has been opened. Nothing has merged to `main`.

Green as of `82dc56c`: **1086 tests** (89 files), typecheck, eslint and build.

## Commits added after the continuation report

| Commit | Repo | What |
| --- | --- | --- |
| `e77e5f7` | client | Untracked `generated/`. It is runtime output — `generated/<kind>-<runId>.<ext>`, `images/`, `videos/`, `media-inputs` — and 42 files / 32 MB had accumulated since `97d0c23` because this repo had no ignore rule. Every write path mkdirs recursively, so a clone rebuilds it. Files kept on disk. |
| `5f1fb15` | client | The continuation report's own work: independent inspection, structured JSON-schema planning/verification, per-attribute checks, SDXL VAE-slicing compatibility. |
| `a6b8894` | GPU | The Python half: `media_intent.py` contract, grounded masks, distinct-seed segments, decoded-frame continuation, control passthrough. |
| `82dc56c` | client | Per-entry evidence — see below. |

## The one defect found after the report

The preservation gate compared **counts**: N checks for N protected attributes,
each `passed`. The live shirt run satisfied that with a single sentence — *"The
subject's clothing and pose are preserved."* — returned **seven times for eight
attributes**, including `table`, `lighting` and `gray background`, which that
sentence does not address. Eight attributes, two distinct strings, and the gate
read it as eight verifications.

`82dc56c` makes indexed checks name the entry they examined (`subject`, max 120
chars so it is a label and not a sentence). A check counts only for its own
entry, and subjects and evidence must be distinct within each array.

This constrains the **evaluator's report**, not the request. `MediaIntentSchema`
is unchanged, and a failing report re-enters the existing retry-with-correction
loop. Regression: the `repeated-check` case in `tests/precision-media.test.ts`.

Worth knowing why it mattered: in the live run every attribute check and the
requested change came back `passed: true`. Only the independent inspection
caught the composite seams. A flawed edit **without** visible seams would have
published carrying eight checks that never looked at the named attributes.

## Open items

1. **Detached worktree, uncommitted.** `.dacai/tmp/media-tools` is a registered
   worktree at detached `3811781` with **11 uncommitted entries**. It was live
   throughout, so it was deliberately left untouched — nothing in the commits
   above came from it. It needs a decision: merge onto the branch, or discard.
   Being detached, its work is easy to lose.

2. **Model fidelity is the real ceiling, and it is not a code bug.** The
   continuation report's GPU findings stand: SDXL renders the wrong cup
   count/placement, Wan produces two balls plus background artifacts. The gates
   correctly *fail* these. No amount of verification hardening makes the
   generation correct.

3. **The verifier is a 7B local model.** `config/models/default.yaml` sets the
   `vision` alias to `local_ollama` / `qwen2.5vl:7b`. That is the model marking
   visibly flawed edits as passing — the root cause behind both the independent
   inspection and the per-entry evidence fix. Two mitigations are now in place;
   the underlying limitation is model capability, and a stronger verifier would
   address it more directly than further gate hardening.

4. **32 MB of media is permanent in pushed history.** `e77e5f7` stops new
   accumulation but the blobs live in the seven commits that precede it, which
   are now on the remote. Removing them requires a history rewrite plus
   force-push, which should not be attempted while an agent holds a worktree
   here. Judged an acceptable trade; it is untidy, not harmful.

5. **No PR.** `https://github.com/Earnie40/dalis-local-agent/pull/new/execution-grounding-fixes`

## Environment notes

- **Local Ollama contends with the test suite.** With inference active on
  `127.0.0.1:11434`, a run reported `13 failed | 1069 passed` in
  `domain-persistence.test.ts` and `smart-contract-tools.test.ts` — all
  timeouts, none real. The clean rerun was 1085/1085 in 6.57s versus 39.58s
  contended. Check for live inference before believing a timeout failure.
- **The Python lives in the other repo by design.** `scripts/runpod-media-up.mjs`
  deploys 12 files, 11 sourced from `deepbrain-avatar-poc/runpod`. The single
  exception is `sdxl_backdrop_runner.py`, deliberately overridden from
  `deploy/runpod-media/` to keep its GPU optimizations (`gpu_runtime`,
  `UNSLICED_DECODE_GIB`). This is intentional, not a stray fork.
- Live validation artifacts remain in `.dacai/tmp/media-live-validation/continued/`
  (ignored by `**/tmp`, so never committed).
