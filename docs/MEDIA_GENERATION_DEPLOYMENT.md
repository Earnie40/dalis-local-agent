# Image and video generation deployment

The DacaiLocalAgent UI and agent tools use the DACAIS-owned media API from the
separate local repository at `C:\Users\Kyleh\deepbrain-avatar-poc`. The repository
name is historical; this integration does not call any DeepBrain AI company API,
SDK, model, or hosted service.

## Local development

Configure `.env` with the selected Runpod ID and API/SSH credentials, then use:

```env
DACAI_IMAGE_BACKEND=dacais-media
DACAI_VIDEO_BACKEND=dacais-media
DACAI_MEDIA_TRANSPORT=ssh-tunnel
DACAI_MEDIA_BASE_URL=http://127.0.0.1:18090
DACAI_MEDIA_REMOTE_PORT=8090
DACAI_MEDIA_AUTOSTART=true
DACAI_MEDIA_AUTOPROVISION_MODELS=true
```

`pnpm dev` is the only startup command. The server supervises the full media
connection: it starts the configured billable pod when necessary, waits for its
new SSH endpoint, restores `/workspace/dacais-media/run-media.sh`, establishes a
loopback-only tunnel, and reconnects if the tunnel drops. The sidebar reports
`starting pod`, `waiting for ssh`, `starting service`, or `Ready · image + video`.

`DACAI_MEDIA_AUTOSTART=true` is an explicit cost opt-in. Set it to `false` when a
developer should start the pod manually. The legacy `pnpm run runpod:media`
command remains available for diagnostics but is not needed during normal dev.
When `DACAI_MEDIA_AUTOPROVISION_MODELS` is omitted it follows that same opt-in:
the authenticated SSH supervisor restores missing image/video weights with the
pod's checked provisioners and selects an installed diffusion-capable Python
runtime. Set it explicitly to `false` to require manual model acquisition.

After changing the media service or one of its model runners, explicitly
refresh the persistent GPU-volume service before testing a feature that depends
on the new endpoints:

```powershell
pnpm run runpod:media -- --sync-service
```

This copies only the checked service/runner/provisioning source files (never
`.env` or credentials),
restarts it on the already-selected pod, verifies `/v1/health`, and opens the
loopback diagnostic tunnel. It does not create, start, or resize a pod.

## Complete adult-human anatomy lane

Anatomy-sensitive prompts do not use the SDXL edit or SVD animation fallbacks:

- prompt-only images use `Qwen/Qwen-Image-2512`;
- edits use `Qwen/Qwen-Image-Edit-2511`;
- localized pelvis/genital, limb, hand, or foot edits use a MediaPipe-derived
  feathered region lock so unrelated source pixels are restored exactly;
- anatomy-sensitive video uses `Wan-AI/Wan2.2-TI2V-5B-Diffusers` and rejects
  full-body output when sampled pose landmarks disappear or limb proportions
  drift beyond the configured tolerance.

All three checkpoints are Apache-2.0 and pinned by immutable revision. They are
large (roughly 140 GiB total), so model acquisition is deliberately opt-in:

```bash
cd /workspace/dacais-media/service
DACAIS_ALLOW_LARGE_MODEL_DOWNLOAD=1 ./provision-anatomy-edit.sh
```

The provisioner checks CUDA, VRAM, available RAM, and persistent disk before it
downloads anything. Set `DACAIS_ANATOMY_COMPONENTS=generate,edit` (or another
comma-separated subset) to provision only selected lanes. A sub-60 GiB GPU uses
CPU/model offload; 60 GiB or larger keeps the active Qwen/Wan pipeline on CUDA.
Only one anatomy image model is resident at a time, and idle workers release
their pipeline after three minutes.

Readiness is available without exposing credentials:

```text
GET  /api/infrastructure/media/status
POST /api/infrastructure/media/reconnect
```

## Face swap lane

`video.faceSwap` replaces one character's face in an existing clip with the face
from an image. It synthesizes no new scene: every frame keeps its original
motion, framing, timing and audio, and only the tracked identity is repainted.
The lane runs on the same `dacais-media` service as `DACAI_VIDEO_BACKEND`, in its
own venv, so a swap can run while the large diffusion pipelines are unloaded:

- detection and recognition use an InsightFace pack (`buffalo_l` by default);
- the swap itself uses `inswapper_128.onnx`;
- `GFPGANv1.4` optionally restores the swapped region and is not required.

Those weights are licensed for **non-commercial research use**, so acquisition is
deliberately opt-in:

```bash
cd /workspace/dacais-media/service
DACAIS_ACCEPT_FACE_SWAP_MODEL_LICENSE=1 ./provision-face-swap.sh
```

`/v1/health` reports `faceSwapModel` once the lane is installed; until then
`/v1/face-swap` answers 501 rather than degrading to a different renderer. The
swapper is pinned by sha256, so a substituted mirror build is deleted instead of
installed.

Two GPU details are load-bearing on a Blackwell (sm_120) pod, and both were
found by running the lane rather than by loading it:

- onnxruntime-gpu must carry cubins for the card. 1.23.0 builds its sessions
  happily and then fails the first node with `cudaErrorNoKernelImageForDevice`.
- 1.29.0 has the kernels but is a CUDA 13 build, while the pod ships CUDA 12.8.
  The `[cuda,cudnn]` extras bring the matching runtime, and the runner calls
  `onnxruntime.preload_dlls()` because the media service is started from a
  non-login shell with no `LD_LIBRARY_PATH` to find it by.

Neither failure is visible at load time — the second one degrades to
`CPUExecutionProvider` silently, which is the same job at roughly fifty times
the cost. So the provisioner's smoke test launches a real kernel and asserts the
bound provider, the runner refuses to start on CPU unless
`DACAIS_FACE_SWAP_ALLOW_CPU=1`, and every result reports the `provider` that
actually rendered it.

`pnpm media:faceswap:verify` proves the whole path end to end against the live
service: it generates a synthetic face and an SVD-animated target clip on the
pod, runs the real `video.faceSwap` tool over them, and fails unless a frame was
genuinely swapped. Add `--reuse` to keep the previous fixtures.

Every frame of the target clip is re-rendered, so `DACAI_FACE_SWAP_MAX_SECONDS`
(default 120) bounds one job. The tool probes the clip locally and rejects a
longer one before uploading anything. The runner writes a synthetic-media tag
into the result's MP4 metadata and returns it as `syntheticMediaTag`, and the
tool deletes the artifact unless the service reports at least one swapped frame.
The `face-swap-video` skill carries the operating procedure and the authorization
guardrails for the agent.

## Production

Production does not use SSH. Put the media container behind a TLS endpoint and
configure the Dacai server with:

```env
NODE_ENV=production
DACAI_IMAGE_BACKEND=dacais-media
DACAI_VIDEO_BACKEND=dacais-media
DACAI_MEDIA_TRANSPORT=https
DACAI_MEDIA_BASE_URL=https://media.example.com
DACAI_MEDIA_TOKEN=<runtime secret>
DACAI_MEDIA_AUTOSTART=false
DACAI_MEDIA_AUTOPROVISION_MODELS=false
```

The tools reject plain HTTP, URL-embedded credentials, and an HTTPS production
configuration without a bearer token. Keep `DACAI_MEDIA_TOKEN`, `RUNPOD_API_KEY`,
database credentials, and registry credentials in the deployment platform's
secret store; never bake them into either image.

The media image is built from the avatar repository:

```powershell
docker build --platform linux/amd64 `
  -f runpod/Dockerfile.media `
  -t <registry>/dacais-media:<version> .
docker push <registry>/dacais-media:<version>
```

Deploy it on a Runpod GPU pod with a persistent volume mounted at `/workspace`,
ports `22/tcp,8090/http`, and runtime secret `DACAIS_MEDIA_TOKEN`. Existing
weights belong at `/workspace/dacais-media/models/sdxl-base` and
`/workspace/dacais-media/models/svd-xt`. On an empty volume, set
`DACAIS_MEDIA_DOWNLOAD_MODELS=true` for the first boot, then remove it. The image
requires the configured models before serving and preserves the official
Runpod `/start.sh`, so SSH remains available.

The Dacai application itself has two production image targets and a same-origin
reverse proxy:

```powershell
Copy-Item deploy/production.env.example .env.production
# Replace every placeholder through the deployment secret store.
docker compose -f deploy/compose.production.yml build
docker compose -f deploy/compose.production.yml up -d
```

The web target listens on port 8080 in the example. The server target is only
exposed to the compose network, runs database migrations at startup, and uses
authenticated HTTPS for media calls.

## Release gate

Before a real production push:

1. Pin an immutable media image tag or digest and confirm model licenses.
2. Put TLS and access control in front of port 8090; do not publish raw HTTP.
3. Inject secrets at runtime and rotate any credential used during staging.
4. Verify `/ping`, authenticated `/v1/health`, image generation, image editing,
   anatomy image generation, region-locked anatomy editing, anatomy video with
   its validation report, text-to-video, image animation, and a short multi-scene `video.story.generate`
   run (including `/v1/concat-video` and the streamed final artifact) from the
   deployed Dacai server.
5. Configure monitoring, request limits, GPU cost alerts, backups for persistent
   media, and a stop/rollback procedure.
