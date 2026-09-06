# Media pipeline implementation and validation — 2026-09-06

Continued the supplied handoff without repeating the audit. Changes are integrated in `C:/Users/Kyleh/DacaiLocalAgent` and `C:/Users/Kyleh/deepbrain-avatar-poc`. Python worktree copies under `.dacai/tmp/media-backend` are synchronized. The running media service was not overwritten or restarted; real model checks used an isolated evaluation directory on the existing GPU.

## Confirmed issues and fixes

| Issue / cause | Implemented behavior |
| --- | --- |
| Output collision: failed exclusive video creation unlinked an existing destination. | Cleanup is limited to files created by the attempt. Final verified publication uses exclusive copying. Collision and race tests preserve existing bytes. |
| “Preserve pose” matched broad pose keywords and disabled local masking. | Structured requested changes and grounded regions determine routing/masks. Legacy pose detection requires an affirmative change. Local image edits restore source pixels outside the union of authorized boxes. |
| Long video duration came from repeating a short clip. | Generate new segments with distinct seeds, condition continuation on the decoded last frame, detect repeated decoded sequences, and trim the final timeline to the requested duration. Reuse requires explicit looping intent. |
| Failed instruction edits fell back to whole-image regeneration. | Failure stays explicit; retries keep the source, method, intent, and controls. Incompatible methods/controls fail before dispatch. No whole-image fallback after a precision edit fails. |
| Upload and source limits disagreed. | Image source and UI upload boundaries consistently accept up to 25 MiB, with JSON/base64 overhead handled at the upload route. |
| Strength, negative prompts, guidance and steps were ignored or clamped. | Controls reach compatible workers unchanged. SDXL uses native denoising strength; Qwen/Instruct use explicitly reported residual blending. Native strength zero preserves source pixels without zero-step inference. SVD/LEdits reject textual controls they cannot consume. |
| Readiness checked the wrong model family. | Workflow-specific availability distinguishes SDXL generation, instruction editing, Qwen generation/editing, Wan video and SVD animation. Asset availability is identified separately from proven inference. |
| Valid files were treated as successful edits; malformed evaluator output passed preservation. | Strictly typed per-change, per-protected-attribute and per-constraint visual evidence is required. Missing, malformed, false or incomplete evidence fails. Failed candidates are removed; at most three compatible attempts are made. Identical source bytes and wrong dimensions fail deterministically. |
| Prompt, dimensions and duration were silently changed. | Preserve the complete instruction within the 4,000-character request contract. Reject oversized/conflicting input. Use model-compatible inference dimensions, exact final delivery dimensions and truthful resampling metadata. Probe decoded video dimensions/frame count/duration. |
| Handoff integration omitted final hash evidence. | Verification publishes both visual evidence and the final artifact hash/path/format expected by the agent completion route. Regression exercises the actual route helper. |
| Existing story scenes were incorrectly compiled as edits; optional prompts broke source animation. | Supplied scenes remain verbatim references. Storyboard and character/scene references reach planning and verification. Source-only animation receives an explicit planning description. |
| Service synchronization omitted new dependencies and retained an older SDXL override. | Sync includes `media_intent.py` and the SVD runner; the deployment SDXL override receives the same intent, control, dimension and masking fixes while preserving its GPU optimizations. |
| Live SDXL startup failed on the installed Diffusers version. | Support VAE slicing through either the pipeline method or the newer VAE method. Real inference and regression tests pass after the fix. |
| Live vision planning emitted omitted fields and pixel coordinates despite the JSON prompt. | Request native JSON-schema output through the existing provider interface for both planning and evaluation; retain strict semantic Zod validation and explicit failure. |
| Live planning copied prompt-template placeholders and invented dimensions/duration; evaluation grouped all protected attributes into one check. | Remove placeholder examples, require request quotes for inferred numeric/loop constraints, reject duration on images, and constrain evaluator arrays to the exact requested cardinalities. Compact transport grammars avoid a live provider's bounded-string grammar compiler failure; Zod retains full validation limits. |
| Live paired evaluation marked a visibly flawed shirt edit as passing. | Localized edits now receive a separate result-only structural/compositing inspection. A failed or malformed independent inspection cannot be promoted to preservation success; its defect evidence drives compatible correction. Explicitly requested collage/overlay boundaries are allowed. |

No content bans or new moderation layers were added. Existing provider/infrastructure/authorization safeguards remain in place.

## Files changed

First repository, including completed handoff patches:

- `apps/server/src/precision-media.ts`
- `apps/server/src/routes/agent.ts`
- `apps/server/src/routes/media-studio.ts`
- `apps/server/src/vision.ts`
- `apps/server/src/infrastructure/runpod-media-manager.ts`
- `apps/server/package.json`, `pnpm-lock.yaml` (direct dependency on the already-used Zod-to-JSON-schema package)
- `apps/web/src/AgentPanel.tsx` (unused media-request variable)
- `packages/shared/src/media-intent.ts`, `packages/shared/src/index.ts`
- `packages/tools/src/image-generation-tools.ts`
- `packages/tools/src/video-generation-tools.ts`
- `packages/tools/src/story-video-generation-tools.ts`
- `packages/tools/src/media-artifacts.ts`, `packages/tools/src/index.ts`
- `deploy/runpod-media/sdxl_backdrop_runner.py`
- `scripts/runpod-media-up.mjs`
- `tests/precision-media.test.ts`
- `tests/image-generation-tools.test.ts`, `tests/video-generation-tools.test.ts`, `tests/story-video-generation-tools.test.ts`
- `tests/media-artifacts.test.ts`, `tests/media-fixtures.ts`
- `tests/runpod-media-manager.test.ts`, `tests/vision-grounding.test.ts`
- This implementation report.

Second repository:

- `runpod/media_intent.py`, `runpod/media_service.py`
- `runpod/anatomy_edit_runner.py`, `runpod/anatomy_video_runner.py`
- `runpod/instruct_edit_runner.py`
- `runpod/sdxl_backdrop_runner.py`, `runpod/svd_backdrop_runner.py`
- `runpod/Dockerfile.media`
- `runpod/test_media_precision.py`, `runpod/test_media_service.py`

Pre-existing generated-media deletions and unrelated `filters.ts` changes were not altered by this continuation. An external commit occurred during the work; no commits were created by this continuation.

## Automated validation

| Check | Result |
| --- | --- |
| First repository `pnpm test` | 89 files, 1,085 tests passed. A concurrent local-model run previously caused 13 timeout failures; the complete suite passed after that inference finished. |
| First repository `pnpm typecheck` and `pnpm build` | Passed. |
| Targeted ESLint on changed media implementation/tests | Passed. |
| First repository full `pnpm lint` | Two pre-existing `no-explicit-any` errors in `packages/agents/src/adversarial-agent.ts:172,226`; confirmed in the starting commit. |
| Second repository Python unittest discovery | 47 tests passed. |
| Deployment SDXL override, actual worker with mocked GPU/model boundaries | 4 behavioral tests passed, including both VAE APIs. |
| Python compilation and JavaScript sync-script syntax | Passed. |
| Second repository server typecheck/build | Passed. |
| Second repository web tests/lint/build | Passed; 4 tests. |
| Second repository server TypeScript tests | 84/85 passed. The unchanged branding assertion flags `deepbrain` in `docs/media-container-deployment.md`; left untouched per user direction. |
| Both repositories diff whitespace checks | Passed. |

Regressions cover shirt-only, fingers-only, upper-right removal, hair with protected attributes, multiple edit regions, exact counts/placement contract, invented constraints, strict evaluator failure, independent rejection of optimistic seam/preservation verdicts, retry source/method/control stability, publication/collision behavior, valid decoded files, exact dimensions/duration, and newly generated temporal continuations. GPU boundaries are mocked where needed; FFmpeg decoding and synthetic continuation checks run for real.

## Real GPU evidence and limits

Artifacts and machine-readable records are in `.dacai/tmp/media-live-validation/continued/`. The raw model worker event `complete` means inference completed, not that the user-facing visual verification gate passed.

- **SDXL generation:** after the VAE API fix, generated and decoded exactly **513×515** pixels from aligned **520×520** inference in 13.89 seconds. Visual inspection fails the requested cup count/placement: the output depicts one striped cup and a striped background instead of two red cups on the left and one blue cup on the right.
- **Qwen shirt edit:** **768×768**, 175.98 seconds, 83,380 changed pixels inside the supplied box and **zero changed pixels outside**. Visual inspection fails fidelity: shirt/body geometry shifts inside the box and its borders visibly cut across the subject. Pixel protection outside a box does not guarantee preservation of other features inside it.
- **Wan video:** two separately inferred segments with seeds 4271/4272; the second uses the first segment's final frame. Each decodes to 17 frames at 8 fps (2.125 seconds). Replaying these actual generated segments through the final service assembly produces **640×384, 30 frames, 3.75 seconds**, with decoded duplicate-sequence checks passing and no looping. Visual inspection fails semantics: there are two balls rather than one and background artifacts; the segments are not an exact repeated sequence, but the requested action is not faithfully achieved.

These checks used bounded settings (20 image steps, 12 video steps), not exhaustive model-quality tuning. Grounding, identity, precise counts, local anatomy, composition and seamless temporal progression remain model-dependent. Final-dimension resampling cannot create native detail. Video visual verification samples frames and cannot prove every intervening frame is correct. The current video models lack tracked edit masks, so localized video edits return an explicit unsupported-method failure. Textless SVD cannot apply textual corrections; it fails explicitly rather than changing workflows.

The strict visual gate provides failure handling and evidence requirements, not a mathematical guarantee against a vision model's inaccurate judgment. Failed live examples must not be presented as successful user deliverables.
