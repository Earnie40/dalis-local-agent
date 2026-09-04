# Handoff — GPU routing, local RAM pressure, anatomy media provisioning

Written 2026-09-04 ~08:20 UTC. Audience: Claude and Codex, both working this stack.

## TL;DR

Codex replaced the L40S pod with a new A100 pod. The replacement carried over the
media service but **not pod-side Ollama**, which was never reinstalled. That single
gap is why `ROUTING_POLICY=gpu-preferred` silently degrades to local CPU inference
and pins ~10 GB of a 15.5 GB workstation. The 80 GB A100 is at **0 MiB VRAM used**
for LLM work while the laptop swaps.

Do not "fix" this by editing routing code. The routing code is behaving correctly.

## Current infrastructure state

| Pod | Id | GPU | Status | Notes |
|---|---|---|---|---|
| dacais-anatomy-image-video | `xd621ikwpgvkmb` | A100 SXM 80 GB | **RUNNING** $1.59/hr | live target, 275 GB network volume |
| dacais-l40s-image-video | `2d2zi6xdotory8` | L40S | EXITED | old host was capacity-starved, storage host-local |

Live pod reachable at `root@216.81.248.127 -p 12101` with `~/.ssh/id_ed25519`.

Account balance was **$8.44** at time of writing — roughly 5 hours of runway at
$1.59/hr. Budget accordingly before starting anything long.

### Active tunnel

Only one, and it is media-only:

```
ssh ... -N -L 127.0.0.1:18090:127.0.0.1:8090 root@216.81.248.127
```

That serves `DACAI_MEDIA_BASE_URL`. There is **no** `11435 -> 11434` inference
tunnel; nothing listens on 11435.

## Why local RAM is full

Verified, not inferred:

- `pgrep -a ollama` on the pod returns NONE. No ollama binary at
  `/workspace/ollama/bin/ollama`, `/workspace/bin/ollama`, or `/usr/local/bin/ollama`.
  `/workspace` contains only `dacais-media`.
- `GET /api/infrastructure/gpu-routing?refresh=true` returns
  `usable: false, reason: "endpoint-unreachable", models: []`.
- Every entry in `/api/models` resolves to `providerInstanceId: local_ollama`.
- `remote_gpu_ollama` therefore falls back via `fallbackInstanceId: 'local_ollama'`
  (packages/shared/src/config.ts:256-270) — working as designed, and it does report
  the reason rather than hiding it.
- Result locally: `llama-server.exe` holds **10.35 GB private / 5.15 GB working set**
  serving `qwen3:8b` at 100% CPU, 32K context. Machine at 89.8% RAM, 43 GB committed
  against a 58.8 GB limit.

This machine has no CUDA GPU — Intel integrated only, 2 GB shared. Local inference
is always CPU and always expensive here.

### Staged change that makes it worse

`config/models/default.yaml` (staged, uncommitted) adds a `vision` alias pinned to
`provider: local_ollama, model: qwen2.5vl:7b`. A `gpu_vision` twin is added too, but
with the pod unreachable the plain alias wins and the first image-attachment run
pulls a *second* multimodal model into system RAM on top of qwen3:8b. Land it, but
know that it is not safe to exercise until pod-side Ollama exists.

## What Codex has done (verified against the live pod)

Completed:

- Guard/prompt-constraint refactor. **Done — do not revisit** unless a test fails.
- Local typecheck clean. Full suite green: 82 files, 880 tests.
- Diagnosed and fixed a real dependency conflict: the pinned 2026 Diffusers commit
  needs huggingface-hub >= 1.26 while the old Transformers 4.57.6 pin capped it at
  < 1.0. Resolved to transformers 5.16.1 / huggingface-hub 1.30.0 / diffusers
  0.41.0.dev0. Confirmed installed on the pod.
- Pinned transitive JAX/OpenCV/NumPy versions so each deploy stops re-resolving.
- Fixed a bootstrap bug: launcher redirected into `logs/` before creating it.
  Idempotent mkdir added.
- Storage resize required the RunPod **v2** `mounts.persistent` shape; the MCP
  projection still sends legacy `volumeInGb`, which silently no-ops. Volume is now
  confirmed at 275 GB. Worth remembering — it will bite again.
- Pod SSH key corrected: RunPod injected a different account key, replaced with this
  workstation's public key.

In flight right now (PID 1599, detached under setsid, survives SSH drop):

- `provision-anatomy-edit.sh` with `DACAIS_ANATOMY_COMPONENTS=generate,edit,video`
- venv `anatomy-edit`: 3.9 GB, built
- `models/qwen-image-2512`: **38 GB down**, mid-fetch (30-file batch ~50%)
- `models/qwen-image-edit-2511`: not started
- `models/wan2.2-ti2v-5b`: not started
- Target total ~140 GiB. Log: `/workspace/dacais-media/logs/anatomy-provision.log`

Not yet reached from the original task list: `/v1/anatomy-generate`,
`/v1/anatomy-edit` through the real tool path, `/v1/anatomy-video`,
identity/anatomy preservation checks, cross-frame geometry, and the 180-second
idle-release VRAM/RAM verification.

### Speed-up available now

The provision log carries:

```
Warning: You are sending unauthenticated requests to the HF Hub.
Please set a HF_TOKEN to enable higher rate limits and faster downloads.
```

`HUGGINGFACE_API_KEY` already exists in `.env`. Exporting it as `HF_TOKEN` for the
provision job would materially speed the remaining ~100 GiB. Worth doing on the next
component boundary rather than killing the current fetch.

## Stale config — fix regardless of anything else

`.env` still points at the dead pod:

- `RUNPOD_ID=2d2zi6xdotory8` — that is the **EXITED** L40S
- `RUNPOD_CONNECTION=ssh root@64.247.206.212 -p 15646` — wrong host and port

The media tunnel found the right endpoint via the API rather than these values, which
is the only reason media still works. Also note a comment reading "Remote GPU
inference disabled — local Ollama only" sitting directly above
`OLLAMA_REMOTE_ENABLED=true`. The URL still resolves through the `runpodConfigured`
branch so the comment is not the blocker, but it is actively misleading.

Prior known trap, still current: the RunPod **REST** `portMappings` can hand you the
UDP port for 22 and the connection is refused. Take the SSH port from **GraphQL**.

## Recommended order of work

1. **Let the current provision finish.** It is 38 GB into a 140 GiB pull on a network
   filesystem. Do not restart it, do not compete with it for bandwidth or volume IO.
2. Local relief, costs nothing, safe now: `ollama stop qwen3:8b` frees ~10 GB;
   set `OLLAMA_KEEP_ALIVE=30s` so models stop lingering 5 minutes past each run.
3. **After** provisioning completes: install Ollama to `/workspace` on the A100, pull
   `qwen3:8b` and `huihui_ai/qwen3-abliterated:8b`, open the `11435 -> 11434` tunnel.
   `gpu-preferred` then promotes the `gpu_*` twins on its own and local RAM frees up
   permanently. Ollama must live on `/workspace` so it survives the next pod swap —
   that is exactly the step that was missed in this one. The release asset is
   `.tar.zst` now, not `.tgz`.
4. Then resume the unfinished endpoint verification list above.

## Commit note

There is a fully staged changeset on `main` (vision, uploads, media-studio, plus
Codex's `video-generation-tools.ts` and `runpod-media-up.mjs` edits). It is real work
and worth committing — but it does **not** address the RAM issue, and committing it
changes nothing at runtime because the server runs `tsx watch` off the working tree.

It currently also stages 13 `generated/*.png`, `output/*.mp4` and several e2e output
PNGs. `.gitignore` is modified in the same changeset; check whether those artifacts
were meant to be excluded before this lands.

Companion repo `deepbrain-avatar-poc` has its own uncommitted set (media_service.py,
musetalk_stream_runner.py, provision-blackwell-realtime.sh, realtime/avatar routes).
