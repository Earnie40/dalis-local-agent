# Handoff — Prompt Fidelity for Image Editing

**Date:** 2026-09-03 · **Branch:** `main` · **Repo:** https://github.com/Earnie40/dalis-local-agent.git

---

## PASTE THIS INTO A NEW SESSION

> Continue work on DacaiLocalAgent at `c:\Users\Kyleh\DacaiLocalAgent`. Read
> `HANDOFF-prompt-fidelity-image-editing.md` at the repo root first — it has the full
> state, the pod details, and the gotchas.
>
> **Goal:** make image editing do *exactly* what the user's prompt says. Attaching a photo
> and typing "make her hair blonde" must return the same person with blonde hair — not a
> different person, not a square crop, not a from-scratch render.
>
> The upload pipeline, the vision model, and caption-grounded prompting are **already
> built and passing tests**. The remaining piece is **replacing SDXL img2img with an
> instruction-following edit model** (Qwen-Image-Edit or FLUX.1 Kontext) on the RunPod
> L40S, plus a new media-service endpoint and the local tool wiring to reach it.
>
> Start by checking the pod's Python environment (`diffusers`/`torch` versions) and real
> VRAM headroom, then recommend a model given the 46 GB card. Do not start a large
> download until you have confirmed it fits alongside what is already loaded.
>
> Verify with a real photo end to end — that has never been done. Do not report success
> from types and unit tests alone.

---

## Why the current output is wrong

`/v1/edit-image` on the pod is **SDXL img2img**. It re-renders the *entire frame* from
whatever prompt it is handed. "Make her hair blonde" describes almost nothing, so every
unstated part of the scene — face, pose, clothing, background — is free to drift. That is
the root cause of "it didn't do what I asked."

Caption grounding (built, see below) mitigates this by describing the whole intended
result so the unchanged parts are pinned by the prompt. **It does not enforce anything.**
Only an instruction-trained edit model, or mask-based inpainting, actually constrains the
edit to the region the user meant.

---

## What is already done (all tests green)

**82 test files · 872 tests passing.** `agent-core`, `providers`, `server`, `web` all
typecheck clean. Web bundle builds.

### 1. Workspace-scoped uploads
Files land in `<workspaceRoot>/.dacai/uploads/` so the agent's ordinary filesystem tools
read them by relative path.

- `apps/server/src/workspace-uploads.ts` **(new)** — store, sanitizer, `resolveWithinWorkspace`
  containment, `capabilities.write` check, 25 MB cap, extension allowlist, `containsSecret`
  rejection (rejected, not redacted — a secret on disk outlives the request).
  Also holds `readImageDimensions` (PNG/JPEG/WebP header parsing), `fitGenerationSize`,
  `selectEditableImage`, `loadVisionAttachments`.
- `apps/server/src/routes/uploads.ts` **(new)** — `POST`/`GET`/`DELETE /api/workspaces/:id/uploads`.
- `apps/server/src/index.ts` — registers `@fastify/multipart` (newly added dep) + the routes.
- `apps/web/src/AttachmentBar.tsx` **(new)** — shared upload control.
- Wired into Chat (`App.tsx`), Agent (`AgentPanel.tsx`), Studio (`StudioPanel.tsx`),
  plus `api.ts`, `styles.css`.
- `.gitignore` — added `.dacai/uploads/` (`.dacai/` is tracked, so uploads would have
  been committed).

### 2. Image-edit wiring fixes
The image path **bypasses the model entirely** — `agent.ts` hand-builds the
`image.generate` call rather than letting the model choose arguments. It never calls
`runAgentLoop`, so prompt-level attachment text never reached it.

- `sourcePath` + `strength: 0.55` now passed for attached images.
- Dimensions preserved via `readImageDimensions` + `fitGenerationSize` (256–1536, multiple
  of 8). Previously hardcoded 1024×1024, which squashed every non-square source.
- Intent classification is attachment-aware: every regex required the literal words
  *image/photo/picture*, so "make her hair blonde" was classified as an ordinary coding
  prompt and never reached the media path.
- Same blind spot fixed in `AgentPanel.tsx`'s Run-button gate.

### 3. Vision — the agent can now see
Nothing in the system had *ever* seen pixels. `CompletionMessage.content` was a plain
string; no VLM existed in config.

- `packages/agent-core/src/types.ts` — `images?: string[]` on `CompletionMessage` **and**
  `ChatMessage` (raw base64, no `data:` prefix).
- `packages/agent-core/src/agent-loop.ts` — `promptImages` option; carries `images` through
  the request mapping (it was being dropped one layer above the provider).
- `packages/providers/src/ollama-provider.ts:~1800` — sends Ollama's native `images` field.
- `config/models/default.yaml` — new `vision` + `gpu_vision` aliases → `qwen2.5vl:7b`.
- `apps/server/src/vision.ts` **(new)** — `describeImage()` and `buildGroundedEditPrompt()`.

**`qwen2.5vl:7b` is installed on the pod AND locally.** Verified it genuinely sees:
synthesized a red/blue/green test image, model answered "Red: top left quadrant. Blue: top
right quadrant. Green: bottom half." Correct. On a synthetic portrait it produced
"short brown hair … neutral expression … blue and green background" — locating real regions.

Grounded prompts now look like:
```
"A woman in a red coat in front of a brick wall, brown hair, soft daylight.
 The image is modified so that: make her hair blonde.
 Everything else in the scene remains exactly as described."
```
The caption is surfaced in the activity feed as "Read the attached image". If no vision
model resolves, it warns and proceeds ungrounded rather than silently drifting.

### New test files
`tests/workspace-uploads.test.ts` (17) · `tests/upload-image-editing.test.ts` (17) ·
`tests/vision-grounding.test.ts` (7)

---

## What is NOT done

1. **Instruction-following edit model — the actual remaining work.** See below.
2. **Mask-based inpainting** (Grounded-SAM / face-parsing → `/v1/inpaint`). Not started.
   No mask parameter or inpaint endpoint exists anywhere.
3. **No real photo has been round-tripped end to end.** Every stage was verified
   individually; the full path through `/v1/edit-image` to a finished PNG was never run.
4. **Nothing is committed or pushed.** All of the above is uncommitted working tree on top
   of `97d0c23`, which is itself unpushed (`main` is ahead 1 of `origin/main`).
5. **Junk files in `97d0c23`:** a 0-byte file literally named `=` and `Untitled-1.txt`.
   Remove before pushing.

---

## Pod facts (verified, not assumed)

```
ssh root@64.247.206.212 -p 15646 -i C:/Users/Kyleh/.ssh/id_ed25519
Pod id: 2d2zi6xdotory8
```

| Fact | Value |
|---|---|
| GPU | **NVIDIA L40S, 46068 MiB** — was 40793 MiB *used* by a loaded `qwen3-coder:30b` |
| Disk | `/workspace` 122 TB available |
| Ollama binary | **`/workspace/ollama/bin/ollama`** — NOT on `PATH` in a non-interactive SSH shell |
| `OLLAMA_MODELS` | `/workspace/dacais-media/ollama-models` |
| `OLLAMA_HOST` | `127.0.0.1:11434` |
| `OLLAMA_MAX_LOADED_MODELS` | **1** — loading the VLM evicts the coder model |
| `OLLAMA_KEEP_ALIVE` | `5m` |
| Media service | `/workspace/dacais-media/service/media_service.py` (61 KB) |
| Launcher | `/workspace/dacais-media/run-media.sh` → port **8090**, host 127.0.0.1 |
| Models on disk | `models/sdxl-base` 6.5 G · `models/svd-xt` 4.3 G |
| `edit_image` handler | `media_service.py:573` — dispatches `{"type":"edit"}` to `SDXL_WORKER` |
| Endpoints | `/v1/generate-backdrop`, `/v1/edit-image`, `/v1/animate-image`, `/v1/avatar`, `/v1/tts`, `/v1/voice/*`, `/v1/compose`, `/v1/concat-video` — **no inpaint, no mask** |

Any ollama command over SSH must use the full path and env:
```bash
export OLLAMA_MODELS=/workspace/dacais-media/ollama-models OLLAMA_HOST=127.0.0.1:11434
/workspace/ollama/bin/ollama list
```

Local `.env` (relevant): `ROUTING_POLICY=gpu-preferred`, `OLLAMA_REMOTE_ENABLED=true`,
`DACAI_IMAGE_BACKEND=dacais-media`, `DACAI_MEDIA_BASE_URL=http://127.0.0.1:18090`
(SSH tunnel), `DACAI_MEDIA_REMOTE_PORT=8090`, `RUNPOD_OLLAMA_MODEL=qwen3-coder:30b`.

---

## The remaining work: instruction-following edit model

### Model options

| Model | Size | Notes |
|---|---|---|
| **Qwen-Image-Edit** | ~20B (≈41 GB bf16) | Apache-2.0, **not gated**. Matches the existing Qwen stack. Very tight on 46 GB — needs fp8/quantized weights or sequential CPU offload. |
| **FLUX.1 Kontext dev** | 12B (≈24 GB bf16) | Best fit for the card. **Gated on HuggingFace** — needs an accepted licence and an `HF_TOKEN`; `HF_TOKEN` is currently empty in `.env`. Requires `diffusers >= 0.35`. |
| **Step1X-Edit** | 19B | Similar footprint to Qwen-Image-Edit. |
| **InstructPix2Pix** | SD1.5, ~4 GB | Tiny, diffusers-native, well supported — but markedly weaker. Reasonable fallback / proof of wiring. |

**Check first:** `python3 -c "import diffusers, torch; print(diffusers.__version__, torch.__version__)"`
on the pod, and real free VRAM after Ollama idles out (`OLLAMA_KEEP_ALIVE=5m`).

### Implementation sketch

1. **Pod:** download the chosen model to `/workspace/dacais-media/models/<name>/`
   (mirror `service/download_sdxl_model.py`). Write a runner alongside
   `sdxl_backdrop_runner.py` — call it `instruct_edit_runner.py`.
2. **Pod:** add `/v1/instruct-edit` to `media_service.py` (register in the route table at
   `~line 969`). Accept `prompt`, `sourceMediaBase64`, `sourceMimeType`, optional
   `guidanceScale`/`steps`/`seed`. **Keep `/v1/edit-image` working** — fall back to it if
   the new model fails to load.
3. **Local:** in `packages/tools/src/image-generation-tools.ts`, `dacaisMediaImage()`
   currently picks `edit ? '/v1/edit-image' : '/v1/generate-backdrop'`. Add the instruct
   route, selected by a new tool arg or an env switch
   (e.g. `DACAI_IMAGE_EDIT_MODE=instruct|img2img`).
4. **Local:** in `apps/server/src/routes/agent.ts`, when the instruct backend is active,
   pass the user's **raw instruction** — an instruct model wants "make her hair blonde",
   NOT the grounded full caption. Keep grounding for the img2img fallback path.
   `buildGroundedEditPrompt` should become conditional, not unconditional.
5. **Test with a real photograph.** This is the acceptance criterion.

---

## Gotchas that cost time

- **Another agent (Cline?) is editing `apps/server/src/routes/agent.ts` concurrently.**
  It changed under me three times mid-session and independently added `classifyDirectMediaRequest`,
  `isImageEditRequest`, and `sourceImage` wiring on top of my `attachedUploads`.
  **Re-read that file before editing it.** Cline checkpoint commits are visible in `git log --all`.
- **The attachment intent rule flip-flopped.** It is currently *permissive*: with an image
  attached, **any** non-empty prompt counts as an image request — so "what is in this photo?"
  fires a render instead of an answer. A verb-gated version existed briefly. Worth a
  deliberate decision; `tests/upload-image-editing.test.ts` documents current behaviour.
- **Heredocs corrupt files on this Windows setup.** Writing a regex containing a literal
  control-character range through a bash heredoc embedded raw control bytes into the source.
  Use the `Write` tool, or a Python script written to a file and then executed — not inline
  shell quoting.
- **`json()` in `apps/web/src/api.ts` forces `Content-Type: application/json`**, which
  destroys multipart boundaries. `uploadWorkspaceFiles` deliberately uses its own `fetch`.
- **`git fetch --prune` reported `[deleted] origin/master`.** That branch was *already* gone
  from GitHub; prune only removed the stale local ref. `b3572c0` still exists locally, and
  the `backup-before-public-push` branch is intact.

---

## Security posture (keep it)

`.gitignore` and `.dockerignore` both carry `.env` / `.env.*` / `!.env.example`. Verified:
real `.env` and all four backups are ignored; both tracked `.env.example` files have every
value blank; a full-history sweep found no real `.env` or SSH key ever committed on any
branch. The 19 credential-pattern hits in `tests/` are synthetic redaction fixtures.

Uploads reject credential-bearing text rather than redacting it. Attachment text **does**
travel to the pod under `gpu-preferred` (encrypted SSH tunnel, your own pod) — binary
uploads contribute only a path.
