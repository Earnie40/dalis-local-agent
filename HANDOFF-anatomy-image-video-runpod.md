# DACAIS anatomy image/video implementation handoff

For Claude or Codex continuing this task. Resume from this state; do not restart
the design or revisit the completed anatomy prompt-guard refactor unless a test
exposes a defect.

## Current verified state

- Main repository: `C:\Users\Kyleh\DacaiLocalAgent`
- GPU media repository: `C:\Users\Kyleh\deepbrain-avatar-poc`
- `pnpm typecheck` passes.
- Full main-repository test suite passes: 82 files, 880 tests.
- GPU media unit tests passed previously: 6 tests.
- The media service and anatomy runners are synced to RunPod.
- The loopback SSH tunnel is currently serving the new pod at
  `http://127.0.0.1:18090`; `/v1/health` is healthy and intentionally reports
  null anatomy models until checkpoint provisioning completes.

## Active RunPod deployment

- Active pod: `xd621ikwpgvkmb` (`dacais-anatomy-image-video`)
- Secure Cloud, `US-KS-2`
- GPU: NVIDIA A100 SXM4 80 GB, billed at the reported $1.59/hour
- System RAM observed: 2 TiB total, about 1.9 TiB available before model loading
- Persistent network volume: `dcfkb7hdoo` (`dacais-anatomy-models`), 275 GB,
  STANDARD, mounted at `/workspace`
- Current direct SSH endpoint: `root@216.81.248.127:12101`
- Use the workstation's existing `~/.ssh/id_ed25519`; do not copy credentials
  into source or the handoff.

The original pod `2d2zi6xdotory8` is stopped and intact. Its host-local
`/workspace` allocation was successfully resized from 75 GB to 275 GB through
the live REST v2 `mounts.persistent` PATCH shape, but the pod could not restart
because its pinned host had no free GPU after three attempts. Do not delete it
without explicit user direction.

## Provisioning in progress

The active pod is running the detached provisioner:

- Parent PID at handoff time: `1599`
- Log: `/workspace/dacais-media/logs/anatomy-provision.log`
- Script: `/workspace/dacais-media/service/provision-anatomy-edit.sh`
- Current stage: downloading the first checkpoint, Qwen Image 2512

Monitor without restarting it:

```bash
ps -p 1599 -o pid,etimes,%cpu,%mem,rss,cmd
pgrep -P 1599 -af . || true
tail -c 3000 /workspace/dacais-media/logs/anatomy-provision.log | tr '\r' '\n' | tail -n 30
```

Pinned checkpoints:

- `Qwen/Qwen-Image-2512` at `25468b98e3276ca6700de15c6628e51b7de54a26`
- `Qwen/Qwen-Image-Edit-2511` at `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9`
- `Wan-AI/Wan2.2-TI2V-5B-Diffusers` at
  `b8fff7315c768468a5333511427288870b2e9635`

Provisioning fixes already made:

- Diffusers commit
  `7643c4826609c47755e3da0e5b768e8070468f49` now uses
  `transformers==5.16.1`; the former 4.57.6 pin conflicted with Diffusers'
  required Hugging Face Hub 1.x dependency.
- MediaPipe transitive JAX/OpenCV/SciPy versions are explicitly pinned to stop
  slow, nondeterministic resolver backtracking.
- `scripts/runpod-media-up.mjs` now creates `$ROOT/logs` on a clean volume before
  redirecting `media-service.log`.

## Remaining verification sequence

1. Let the current provisioner finish. Confirm all three model directories are
   complete and its final Diffusers import check succeeds.
2. Restart the synced media service so `/v1/health` reports all three anatomy
   models.
3. Verify `/v1/anatomy-generate` with a real full-body adult medical/anatomical
   reference prompt and save the returned PNG without logging its base64.
4. Verify `/v1/anatomy-edit` through the real `image.generate` DacaiLocalAgent
   tool path, using workspace-relative source
   `output/e2e_real_upload_emerald_top.png`. Use a localized visible-hand/wrist
   correction so `regionLocked: true` can prove unrelated face/background
   pixels remain exact.
5. Verify `/v1/anatomy-video`, preferably through `video.generate`, using the
   generated full-body image as source, 512x512, the minimum accepted frame
   count, and 20 steps. Require the returned `anatomyValidation.passed` report.
6. Inspect the output image and video contact sheet. Independently compare the
   edit source/output pixels outside the localized region and inspect sampled
   video pose/face geometry for identity, body proportions, missing/duplicated
   parts, and cross-frame drift.
7. Record response `peakVramMb`, `nvidia-smi`, `free -h`, and runner logs. The
   A100 should select CUDA mode because it has more than 60 GiB VRAM.
8. After the final request, verify the corresponding anatomy worker exits and
   VRAM returns to baseline after the configured 180-second idle timeout.
9. Update the local non-secret RunPod target to `xd621ikwpgvkmb` only after live
   verification succeeds. Preserve every other `.env` value and never display
   credentials.
10. Rerun relevant syntax/tests after any defect fix, inspect diffs, and report
    the stopped original pod plus the active pod/volume cost posture.

## Tooling/auth notes

- RunPod MCP authentication works for structured control-plane actions.
- Local `runpodctl 2.10.0` is installed but has no CLI API-key configuration.
- Direct system SSH works with the existing local key.
- If a REST v2 action is missing from the MCP projection, the repository's
  configured API key may be read into process memory for the single request;
  never print it or persist it elsewhere.
