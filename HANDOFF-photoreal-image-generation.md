# Handoff: photoreal raster generation

Date: 2026-09-03

## Completion update

The local image/video path is now implemented and live-validated against the
DACAIS-owned media service on Runpod pod `2d2zi6xdotory8` (L40S, US-MO-1).
The repository named `deepbrain-avatar-poc` is only the source location of that
service; no DeepBrain company API, SDK, model, or hosted service is used.

- `DACAI_IMAGE_BACKEND=dacais-media` supports text-to-image and workspace-image
  editing over a loopback-only SSH tunnel.
- `DACAI_VIDEO_BACKEND=dacais-media` supports text-to-video and animation of a
  workspace PNG/JPEG/WebP.
- `video.generate` has the same mutation approval, workspace containment,
  no-overwrite, signature validation, hashing, and activity tracking as image
  generation. MP4 results render inline in agent chat.
- The GPU service remains in the avatar repository and is connected by its own
  `/v1/generate-backdrop`, `/v1/edit-image`, and `/v1/animate-image` API; model
  code and weights are not copied into DacaiLocalAgent.
- SDXL and Stable Video Diffusion weights live under
  `/workspace/dacais-media/models` on the pod's 75 GB persistent volume.
- `pnpm dev` now starts/restores the configured pod-side service, owns and
  monitors the private `127.0.0.1:18090` SSH tunnel, and exposes media readiness
  in the frontend. `pnpm run runpod:media` remains a diagnostic command only.
- Production uses explicit `DACAI_MEDIA_TRANSPORT=https`, requires bearer
  authentication, and has container/deployment artifacts documented in
  `docs/MEDIA_GENERATION_DEPLOYMENT.md`.

Live evidence: a generated PNG, an edited PNG, and a 1024x576 H.264 MP4 at 25
FPS were returned through the actual Dacai tools and independently validated.

## Goal

Add ChatGPT-style raster image generation to the coding agent while keeping generated files inside the selected workspace, displaying them inline in agent chat, and preserving the existing permission engine.

## Current state

The original image-only implementation below is retained as historical context.

- Added `packages/tools/src/image-generation-tools.ts` with an `image.generate` mutation tool.
- Supported backends:
  - `automatic1111`: local Automatic1111/Forge-compatible `POST /sdapi/v1/txt2img` API.
  - `openai`: explicitly enabled OpenAI Images API. It is never selected merely because `OPENAI_API_KEY` exists.
- Output is restricted to a workspace-relative `.png`, capped at 25 MB, checked for a valid PNG signature, written without overwriting an existing file, and returned with a SHA-256 hash.
- Added the tool export in `packages/tools/src/index.ts`.
- Added `image.generate` to agent mutation/path tracking in `packages/agent-core/src/runtime-state.ts`.
- Wired prompt-based tool selection and instructions in `apps/server/src/routes/agent.ts`.
- Added activity labeling in `apps/server/src/agent-activity.ts`.
- Added inline artifact discovery in `apps/web/src/agent-artifacts.ts` and the tool label/selector in `apps/web/src/AgentPanel.tsx`.
- Documented environment variables in `.env.example`.

The earlier inline artifact endpoint and preview UI are already present in:

- `apps/server/src/agent-artifacts.ts`
- `apps/web/src/agent-artifacts.ts`
- `apps/web/src/AgentPanel.tsx`

## Important environment evidence

- No Automatic1111/Forge or ComfyUI server was listening on ports 7860/7861/8188.
- This host reports Intel integrated graphics and no `nvidia-smi`; a local diffusion runtime is not currently installed.
- `OPENAI_API_KEY` is configured, but paid image generation must remain opt-in.
- Ollama/Qwen cannot generate raster images itself.

## Configuration

Local backend:

```env
DACAI_IMAGE_BACKEND=automatic1111
DACAI_IMAGE_BASE_URL=http://127.0.0.1:7860
DACAI_IMAGE_MODEL=
```

Explicit paid backend:

```env
DACAI_IMAGE_BACKEND=openai
DACAI_IMAGE_BASE_URL=https://api.openai.com/v1
DACAI_IMAGE_MODEL=gpt-image-1
```

Do not enable the paid backend without the user's explicit choice.

## Validation completed

The image/edit/video paths were exercised through the actual Dacai tools. Unit
tests, package typechecks, lint, the full monorepo build, and the full test suite
passed after the original integration. The server-managed startup and production
transport have additional focused tests and are revalidated as part of this
handoff continuation.

## Likely first checks

```powershell
pnpm --filter @dacai-local-agent/tools exec tsc --noEmit
pnpm --filter @dacai-local-agent/server exec tsc --noEmit
pnpm --filter @dacai-local-agent/web exec tsc --noEmit
pnpm exec vitest run tests/image-generation-tools.test.ts packages/agent-core/src/runtime-state.test.ts tests/agent-artifacts.test.ts
```

## Safety/design constraints

- Do not use Computer Use or browser automation.
- Do not expose API keys in tool output, logs, tests, or committed files.
- Do not silently route local Qwen requests to a cost-incurring provider.
- Keep all generation requests inside `PermissionedToolExecutor`; `image.generate` remains a mutation requiring approval.
- Do not claim photoreal generation is operational until a configured backend actually returns and writes a verified PNG.
