#!/usr/bin/env python3
"""Persistent InsightFace JSONL worker that swaps one identity through a video.

The worker holds the detector, the recognizer, and the swapper resident between
requests exactly like the other model runners here: the service writes one JSON
command per line on stdin and reads one JSON event per line from stdout.

Only the character selected by the caller is rewritten. Everyone else in the
frame, and every frame the character does not appear in, is passed through
untouched, so the result keeps the original motion, framing, and timing.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path

import cv2
import numpy as np

# onnxruntime's CUDA provider needs libcudnn and libcublas already resident.
# They ship on torch's private wheel path, so importing the pod's torch build
# first is what makes the provider load instead of quietly falling back to CPU.
with contextlib.suppress(ImportError):
    import torch  # noqa: F401

from insightface.app import FaceAnalysis
from insightface.model_zoo import get_model

ORIGINAL_STDOUT = sys.stdout
MODEL_ROOT = Path(os.environ.get("DACAIS_FACE_SWAP_MODEL_ROOT", "/workspace/dacais-media/models/face-swap"))
SWAPPER_MODEL = Path(os.environ.get("DACAIS_FACE_SWAP_SWAPPER", str(MODEL_ROOT / "inswapper_128.onnx")))
RESTORE_MODEL = Path(os.environ.get("DACAIS_FACE_SWAP_RESTORER", str(MODEL_ROOT / "GFPGANv1.4.pth")))
DETECTOR_PACK = os.environ.get("DACAIS_FACE_SWAP_DETECTOR", "buffalo_l")
DETECTOR_SIZE = int(os.environ.get("DACAIS_FACE_SWAP_DETECTOR_SIZE", "640"))
# Every artifact leaves the pod labelled. The tag survives in the container
# metadata, so a swapped clip stays identifiable after it leaves the workspace.
SYNTHETIC_MEDIA_TAG = os.environ.get(
    "DACAIS_FACE_SWAP_TAG", "AI-generated: face replaced by DACAIS media service")
MAX_FRAMES = int(os.environ.get("DACAIS_FACE_SWAP_MAX_FRAMES", "9000"))
# A swap re-renders every frame, so a CPU session is not a graceful degradation:
# it is the same job at roughly fifty times the cost. Refuse it unless the
# operator has deliberately accepted that.
ALLOW_CPU = os.environ.get("DACAIS_FACE_SWAP_ALLOW_CPU", "").strip().lower() in {"1", "true", "yes", "on"}


def emit(value: dict) -> None:
    ORIGINAL_STDOUT.write(json.dumps(value, separators=(",", ":")) + "\n")
    ORIGINAL_STDOUT.flush()


def providers() -> list[str]:
    import onnxruntime

    # The service starts this worker from a non-login shell, so there is no
    # inherited LD_LIBRARY_PATH to find the CUDA runtime with. preload_dlls()
    # loads it from onnxruntime's own nvidia wheels instead; without it the
    # provider silently fails to register and every frame runs on the CPU.
    preload = getattr(onnxruntime, "preload_dlls", None)
    if callable(preload):
        try:
            preload()
        except Exception:  # noqa: BLE001 - absence is reported by the provider check
            traceback.print_exc(file=sys.stderr)

    available = onnxruntime.get_available_providers()
    return [name for name in ("CUDAExecutionProvider", "CPUExecutionProvider") if name in available]


def gpu_peak_mb() -> int:
    """Peak VRAM from the driver; onnxruntime has no torch allocator to query."""
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=10).strip().splitlines()[0]
        return int(output)
    except Exception:  # noqa: BLE001 - a metric must never fail a completed render
        return 0


def normalized(embedding: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(embedding))
    return embedding / norm if norm else embedding


def similarity(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.dot(normalized(left), normalized(right)))


def largest_face(faces: list) -> object:
    return max(faces, key=lambda face: (face.bbox[2] - face.bbox[0]) * (face.bbox[3] - face.bbox[1]))


def single_face(analyzer: FaceAnalysis, path: Path, description: str) -> object:
    image = cv2.imread(str(path))
    if image is None:
        raise ValueError(f"{description} could not be decoded as an image")
    faces = analyzer.get(image)
    if not faces:
        raise ValueError(f"no face was detected in {description}")
    return largest_face(faces)


class Restorer:
    """Optional GFPGAN pass over swapped frames; absent weights are not fatal."""

    def __init__(self) -> None:
        self.model = None
        self.loaded = False

    def ensure(self) -> bool:
        if self.loaded:
            return self.model is not None
        self.loaded = True
        if not RESTORE_MODEL.is_file():
            return False
        try:
            from gfpgan import GFPGANer

            with contextlib.redirect_stdout(sys.stderr):
                self.model = GFPGANer(
                    model_path=str(RESTORE_MODEL), upscale=1, arch="clean",
                    channel_multiplier=2, bg_upsampler=None,
                )
        except Exception:  # noqa: BLE001 - restoration is an enhancement, not the render
            traceback.print_exc(file=sys.stderr)
            self.model = None
        return self.model is not None

    def apply(self, frame: np.ndarray) -> np.ndarray:
        if not self.ensure():
            return frame
        with contextlib.redirect_stdout(sys.stderr):
            _, _, restored = self.model.enhance(frame, has_aligned=False, only_center_face=False, paste_back=True)
        return restored if restored is not None else frame


def encode_args() -> list[str]:
    """Match the service's encoder choice without importing it into this venv."""
    configured = os.environ.get("DACAIS_FACE_SWAP_ENCODER", "").strip()
    encoder = configured or "libx264"
    if encoder.endswith("_nvenc"):
        return ["-c:v", encoder, "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0",
                "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"]


def open_encoder(output: Path, width: int, height: int, fps: float, audio: Path | None) -> subprocess.Popen:
    """Pipe swapped frames straight into ffmpeg, muxing the original audio."""
    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", f"{fps:.6f}", "-i", "pipe:0",
    ]
    if audio is not None:
        command += ["-i", str(audio), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-shortest"]
    command += [*encode_args(), "-metadata", f"comment={SYNTHETIC_MEDIA_TAG}", "-movflags", "+faststart", str(output)]
    return subprocess.Popen(command, stdin=subprocess.PIPE, stdout=sys.stderr, stderr=sys.stderr)


def has_audio(path: Path) -> bool:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type",
         "-of", "csv=p=0", str(path)],
        text=True, capture_output=True, timeout=60)
    return "audio" in result.stdout


def swap_video(analyzer: FaceAnalysis, swapper, restorer: Restorer, command: dict, provider: str | None) -> dict:
    source = Path(str(command["source"]))
    target = Path(str(command["input"]))
    output = Path(str(command["output"]))
    if not source.is_file():
        raise FileNotFoundError(f"face image does not exist: {source}")
    if not target.is_file():
        raise FileNotFoundError(f"target video does not exist: {target}")
    output.parent.mkdir(parents=True, exist_ok=True)

    threshold = float(command.get("similarityThreshold", 0.35))
    face_index = int(command.get("targetFaceIndex", 0))
    restore = bool(command.get("restoreFaces", True))
    keep_audio = bool(command.get("keepAudio", True))

    source_face = single_face(analyzer, source, "the face image")
    reference = command.get("targetReference")
    reference_embedding = None
    if reference:
        reference_embedding = normalized(single_face(analyzer, Path(str(reference)), "the target reference image").embedding)

    capture = cv2.VideoCapture(str(target))
    if not capture.isOpened():
        raise ValueError("the target video could not be opened")
    fps = capture.get(cv2.CAP_PROP_FPS) or 0.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if fps <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise ValueError("the target video has no usable frame rate or dimensions")

    audio = target if keep_audio and has_audio(target) else None
    encoder = open_encoder(output, width, height, fps, audio)
    frames = 0
    swapped = 0
    similarities: list[float] = []
    restored_any = False

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frames += 1
            if frames > MAX_FRAMES:
                raise ValueError(f"the target video exceeds the {MAX_FRAMES} frame limit for one swap")
            faces = analyzer.get(frame)
            chosen = None
            if faces:
                if reference_embedding is None:
                    # Lock onto the requested character once, then follow that
                    # identity by embedding. Position ordering alone drifts as
                    # soon as two people cross in the frame.
                    ordered = sorted(faces, key=lambda face: float(face.bbox[0]))
                    if face_index >= len(ordered):
                        raise ValueError(
                            f"targetFaceIndex {face_index} is out of range; "
                            f"{len(ordered)} face(s) were detected in the first frame that shows one")
                    chosen = ordered[face_index]
                    reference_embedding = normalized(chosen.embedding)
                    similarities.append(1.0)
                else:
                    scored = [(similarity(face.embedding, reference_embedding), face) for face in faces]
                    score, candidate = max(scored, key=lambda item: item[0])
                    if score >= threshold:
                        chosen = candidate
                        similarities.append(score)
                        # Track slow appearance changes without letting the
                        # identity wander onto a different person.
                        reference_embedding = normalized(
                            0.9 * reference_embedding + 0.1 * normalized(candidate.embedding))
            if chosen is not None:
                frame = swapper.get(frame, chosen, source_face, paste_back=True)
                if restore:
                    restored = restorer.apply(frame)
                    restored_any = restored_any or restored is not frame
                    frame = restored
                swapped += 1
            encoder.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
    finally:
        capture.release()
        if encoder.stdin:
            with contextlib.suppress(BrokenPipeError, OSError):
                encoder.stdin.close()
        encoder.wait(timeout=600)

    if encoder.returncode != 0:
        raise RuntimeError(f"ffmpeg failed to encode the swapped video (exit {encoder.returncode})")
    if not frames:
        raise ValueError("the target video contained no decodable frames")

    return {
        "type": "complete",
        "output": str(output),
        "width": width,
        "height": height,
        "fps": fps,
        "framesTotal": frames,
        "framesSwapped": swapped,
        "meanSimilarity": round(sum(similarities) / len(similarities), 4) if similarities else 0.0,
        "restoredFaces": restored_any,
        "provider": provider,
        "syntheticMediaTag": SYNTHETIC_MEDIA_TAG,
        "peakVramMb": gpu_peak_mb(),
    }


def main() -> int:
    if not SWAPPER_MODEL.is_file():
        emit({"type": "error", "error": f"the face swap model is not installed at {SWAPPER_MODEL}"})
        return 1
    execution_providers = providers()
    with contextlib.redirect_stdout(sys.stderr):
        analyzer = FaceAnalysis(name=DETECTOR_PACK, root=str(MODEL_ROOT), providers=execution_providers)
        analyzer.prepare(ctx_id=0 if "CUDAExecutionProvider" in execution_providers else -1,
                         det_size=(DETECTOR_SIZE, DETECTOR_SIZE))
        swapper = get_model(str(SWAPPER_MODEL), providers=execution_providers)
    restorer = Restorer()
    # What the session actually bound to, not what the build merely supports.
    # onnxruntime drops to CPU without raising when it cannot create a CUDA
    # session — exhausted VRAM is the common cause on a shared card — and that
    # is a fifty-fold slowdown the caller would otherwise never be told about.
    active = getattr(getattr(swapper, "session", None), "get_providers", lambda: execution_providers)()
    provider = active[0] if active else None
    if "CUDAExecutionProvider" in execution_providers and provider != "CUDAExecutionProvider" and not ALLOW_CPU:
        emit({"type": "error", "error": (
            f"the swap session bound to {provider} although CUDA is available: the GPU is most likely out of "
            f"free memory ({gpu_peak_mb()} MiB in use). Free the resident media pipelines and retry, or set "
            "DACAIS_FACE_SWAP_ALLOW_CPU=1 to accept a CPU render.")})
        return 1
    emit({
        "type": "worker_ready",
        "model": "insightface/inswapper_128",
        "detector": DETECTOR_PACK,
        "providers": execution_providers,
        "activeProvider": provider,
        "restorer": "TencentARC/GFPGANv1.4" if RESTORE_MODEL.is_file() else None,
    })

    for line in sys.stdin:
        try:
            command = json.loads(line)
            if command.get("type") != "face_swap":
                raise ValueError("Unsupported face swap worker command")
            emit(swap_video(analyzer, swapper, restorer, command, provider))
        except Exception as error:  # noqa: BLE001 - one bad request must not end the worker
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
