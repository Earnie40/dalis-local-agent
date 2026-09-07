---
name: face-swap-video
description: Replace one character's face in an attached video with the face from an attached image, using the video.faceSwap GPU media tool.
tags: [media, video, image, face, swap, faceswap, deepfake, attachment]
---
# Face swap into a video

Use this when the user attaches (or points at) a face image and a video and asks
to put that face onto someone in the clip. The work is done by one tool,
`video.faceSwap`, which runs on the DACAIS-owned GPU media service. Everything
else in the clip — motion, framing, timing, lighting, audio, and every other
person in frame — is preserved.

`video.faceSwap` is not `video.generate`. Nothing is synthesized from a prompt
here, so do not fall back to a generative video route when a swap is what was
asked for.

## Preconditions

- `DACAI_VIDEO_BACKEND=dacais-media` and a reachable media service. Without it
  the tool fails closed with that exact instruction; do not substitute another
  backend or a local imitation.
- The pod must have the swap lane provisioned
  (`service/provision-face-swap.sh`, weights under `models/face-swap`).
  `/v1/health` reports `faceSwapModel` when it is installed; a missing lane
  returns HTTP 501 rather than a degraded result.
- Both inputs must already exist inside the active workspace. Uploads land in
  `.dacai/uploads/<id>` and the attachment block in the prompt states the exact
  path. Pass that path through unchanged — never guess a filename.

## Workflow

1. Identify the two inputs from the attachment block or the conversation:
   - `facePath` — the PNG/JPEG/WebP whose face is applied.
   - `videoPath` — the MP4/WebM/MOV to edit.
   If either is missing, ask for it instead of substituting a generated stand-in.
2. Decide which character in the clip is being replaced.
   - One person on screen: nothing more is needed.
   - Several people: prefer `targetReferencePath`, a still of the character to
     replace, because the identity is then tracked by face embedding. Use
     `targetFaceIndex` (left to right in the first frame that shows a face) only
     when no such still exists, and say which character you selected.
3. Choose an `outputPath` that does not exist yet — `generated/<name>.mp4` keeps
   it beside the other media artifacts. The tool refuses to overwrite.
4. Call `video.faceSwap`. Leave `restoreFaces` and `keepAudio` at their defaults
   unless the user asks otherwise; lower `similarityThreshold` only when the
   tracked character is being lost mid-clip (poor lighting, extreme angles).
5. Read the returned evidence before reporting:
   - `framesSwapped` and `framesTotal` — how much of the clip actually changed.
     A low ratio means the character was off screen or not matched, not that the
     job silently succeeded. The tool refuses to keep a file where nothing was
     swapped.
   - `meanSimilarity` — identity-tracking confidence.
   - `width`, `height`, `durationSeconds` — validated against the source clip.
   - `provider` — `CUDAExecutionProvider` on a healthy pod.
   - `path` and `sha256` — the artifact you report.
6. Report the workspace path from the tool result. Never claim a swap happened
   without a successful tool result.

## Correcting a poor result

- Character drifts onto the wrong person: supply `targetReferencePath`, or raise
  `similarityThreshold`.
- Character is skipped in many frames: lower `similarityThreshold` toward 0.2,
  or supply a reference still that matches the lighting in the clip.
- Soft or plastic-looking face: keep `restoreFaces` true; if it is already true,
  the source face is likely too low-resolution for the frame size. Ask for a
  larger, sharper, front-facing photo rather than upscaling silently.
- `targetFaceIndex is out of range`: the first frame with a face showed fewer
  people than the index you passed. Re-check the clip and pick a valid index.
- `the swap session bound to CPUExecutionProvider`: the lane refused to render on
  the CPU, where a swap costs about fifty times as much per frame. This is an
  environment fault, not a bad request — report it rather than retrying, and
  check the result's `provider` field on any swap that felt slow.

## Guardrails

- Only swap faces in footage the user is authorized to alter. If the request is
  to make a real, identifiable person appear to say or do something they did
  not — a public figure, a colleague, an ex-partner — say plainly that you will
  not produce that, and stop. Consenting subjects, the user's own likeness,
  fictional characters, and synthetic faces are ordinary work.
- The service writes a synthetic-media tag into the MP4 metadata and returns it
  as `syntheticMediaTag`. Do not strip it, and mention in your report that the
  clip is labelled as AI-modified.
- The swap weights (InsightFace detector packs and `inswapper_128.onnx`) are
  licensed for non-commercial research use. Say so if the user describes a
  commercial use for the output.
- Long clips are expensive: every frame is re-rendered. `DACAI_FACE_SWAP_MAX_SECONDS`
  (default 120) bounds a single job, and the tool rejects a longer clip up front
  rather than starting a job that will be killed.
- Do not weaken the workspace path containment, the overwrite refusal, or the
  `framesSwapped` check to make a run report success.

## Completion

The task is complete when a `video.faceSwap` result proves a verified MP4 exists
at the reported workspace path with `framesSwapped >= 1`. A failed or blocked
swap is reported as such, with the tool's own error as the evidence.
