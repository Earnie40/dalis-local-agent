#!/usr/bin/env python3
"""DACAIS-owned Kokoro + SadTalker + FFmpeg HTTP inference service."""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

ROOT = Path(os.environ.get("DACAIS_MEDIA_ROOT", "/workspace/dacais-media")).resolve()
TTS_PYTHON = ROOT / "venvs" / "kokoro" / "bin" / "python"
CLONE_TTS_PYTHON = ROOT / "venvs" / "chatterbox" / "bin" / "python"
SADTALKER_PYTHON = ROOT / "venvs" / "sadtalker" / "bin" / "python"
SADTALKER = ROOT / "models" / "SadTalker"
SERVICE_DIR = ROOT / "service"
TOKEN = os.environ.get("DACAIS_MEDIA_TOKEN", "")
MAX_BODY = int(os.environ.get("DACAIS_MAX_MEDIA_BYTES", str(250 * 1024 * 1024)))
REALTIME_SOURCE_FPS = max(1, min(60, int(os.environ.get("DACAIS_REALTIME_FPS", "25"))))
MAX_REALTIME_REFERENCE_SECONDS = max(1, min(120, int(os.environ.get("DACAIS_MAX_REALTIME_REFERENCE_SECONDS", "60"))))
MAX_CLONE_REFERENCE_SECONDS = max(3, min(30, int(os.environ.get("DACAIS_MAX_CLONE_REFERENCE_SECONDS", "12"))))
# `ffmpeg -t` is not sample-exact: resampling to 24 kHz emits a few samples of
# codec padding past the cut, so a 12s trim lands at 288012 frames against a
# 288000 limit. Without tolerance every reference at the cap is rejected.
CLONE_REFERENCE_FRAME_TOLERANCE = int(os.environ.get("DACAIS_CLONE_REFERENCE_FRAME_TOLERANCE", "2400"))
REALTIME_AVATAR_PREP_VERSION = "guided-liveness-montage-v6"
CLONE_REFERENCE_CACHE_VERSION = "mono-24k-pcm16-v1"
JOB_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MUSE_TALK = ROOT / "models" / "MuseTalk"
MUSE_TALK_PYTHON = Path(os.environ.get("DACAIS_MUSETALK_PYTHON", str(ROOT / "venvs" / "musetalk" / "bin" / "python")))
MUSE_TALK_OVERLAY = Path(os.environ["DACAIS_MUSETALK_OVERLAY"]) if os.environ.get("DACAIS_MUSETALK_OVERLAY") else None
MUSE_TALK_UNET = MUSE_TALK / "models" / "musetalkV15" / "unet.pth"
REALTIME_RUNNER = SERVICE_DIR / "musetalk_stream_runner.py"
CLONE_TTS_RUNNER = SERVICE_DIR / "chatterbox_stream_runner.py"
CAPTURE_INDEX_RUNNER = SERVICE_DIR / "capture_index_runner.py"
CAPTURE_INDEX_PYTHON = Path(os.environ.get("DACAIS_CAPTURE_INDEX_PYTHON", sys.executable))
FACE_LANDMARKER_MODEL = Path(os.environ.get(
    "DACAIS_FACE_LANDMARKER_MODEL", str(ROOT / "models" / "mediapipe" / "face_landmarker.task")))
SDXL_RUNNER = SERVICE_DIR / "sdxl_backdrop_runner.py"
MATTING_RUNNER = SERVICE_DIR / "matting_runner.py"
SVD_RUNNER = SERVICE_DIR / "svd_backdrop_runner.py"
SVD_PYTHON = Path(os.environ.get("DACAIS_SVD_PYTHON", str(SADTALKER_PYTHON)))
SVD_MODEL_ROOT = Path(os.environ.get("DACAIS_SVD_MODEL_ROOT", "/opt/dacais-svd/stable-video-diffusion-img2vid-xt"))
MATTING_PYTHON = Path(os.environ.get("DACAIS_MATTING_PYTHON", str(SADTALKER_PYTHON)))
SDXL_PYTHON = Path(os.environ.get("DACAIS_SDXL_PYTHON", str(SADTALKER_PYTHON)))
SDXL_MODEL_ROOT = Path(os.environ.get("DACAIS_SDXL_MODEL_ROOT", "/opt/dacais-sdxl/stable-diffusion-xl-base-1.0"))
# Upscale small uploads and cap large ones. MuseTalk renders the face at
# 256x256, so a 400px portrait yields a ~150px crop and most of that
# generated detail is discarded when it is blended back in.
REALTIME_SOURCE_SCALE = os.environ.get(
    "DACAIS_REALTIME_SOURCE_SCALE", "scale='min(1280,max(768,iw))':-2:flags=lanczos")
# A full one-minute identity capture is retained as the source of truth, but
# MuseTalk should not cache every nearly-identical frame. These intervals sample
# every guided-motion-v2 cue and form a compact, varied loop for live replies.
GUIDED_V2_MOTION_INTERVALS = (
    (0.0, 1.5), (7.0, 9.0), (14.0, 16.0), (21.0, 23.0), (29.0, 30.5),
    (41.0, 43.0), (47.0, 49.0), (53.0, 55.0), (58.0, 59.0),
)


def guided_liveness_intervals(evidence: Any, duration: float) -> tuple[tuple[float, float], ...]:
    """Select the exact moments where the browser detected randomized actions."""
    if not isinstance(evidence, dict) or not isinstance(evidence.get("completions"), list):
        return ()
    intervals: list[tuple[float, float]] = []
    for completion in evidence["completions"]:
        if not isinstance(completion, dict):
            continue
        try:
            completed_at = float(completion.get("completedAtSeconds"))
        except (TypeError, ValueError):
            continue
        start = max(0.0, completed_at - 0.85)
        end = min(duration, completed_at + 0.85)
        if end - start >= 0.25:
            intervals.append((start, end))
    return tuple(intervals)
# One MuseTalk worker owns the GPU, so realtime sessions serialize on it. Admit
# only as many as the GPU can interleave without visible stalling, and tell the
# caller plainly rather than letting the (N+1)th conversation hang.
MAX_REALTIME_SESSIONS = max(1, int(os.environ.get("DACAIS_MAX_REALTIME_SESSIONS", "2")))


class CapacityError(RuntimeError):
    """The renderer is fully committed; the caller may retry later."""


REALTIME_AVATARS: dict[str, dict[str, Any]] = {}
REALTIME_SESSIONS: dict[str, dict[str, Any]] = {}
REALTIME_LOCK = threading.Lock()
CLONE_REFERENCE_CACHE_LOCK = threading.Lock()
# A warmed voice keeps its normalized reference on disk so a live
# conversation can synthesize each clause without re-uploading the whole
# source recording. That upload, not the model, dominated reply latency.
WARM_CLONE_REFERENCES: dict[str, str] = {}
CLONE_REFERENCE_NOT_WARM = "voice reference is not warm for this voiceId"


class MuseTalkWorker:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None
        self.lock = threading.Lock()
        self.log_handle: Any = None
        # A configured session cap is not proof of capacity. These are the
        # measured costs the cap should actually be derived from.
        self.baseline_vram_mb = 0
        self.loaded_vram_mb = 0
        self.started_at = 0.0

    def ensure(self) -> None:
        if self.process and self.process.poll() is None:
            return
        for description, path in (("interpreter", MUSE_TALK_PYTHON),
                                  ("stream runner", REALTIME_RUNNER), ("UNet weights", MUSE_TALK_UNET)):
            if not path.exists():
                raise RuntimeError(f"MuseTalk realtime renderer is missing its {description}: {path}")
        logs = ROOT / "logs"; logs.mkdir(exist_ok=True)
        self.baseline_vram_mb = gpu_used_mb()
        self.log_handle = (logs / "musetalk-worker.log").open("a", encoding="utf-8")
        python_path = f"{MUSE_TALK}:{os.environ.get('PYTHONPATH', '')}"
        if MUSE_TALK_OVERLAY and MUSE_TALK_OVERLAY.is_dir():
            python_path = f"{MUSE_TALK_OVERLAY}:{python_path}"
        self.process = subprocess.Popen(
            [str(MUSE_TALK_PYTHON), "-u", str(REALTIME_RUNNER)], cwd=MUSE_TALK,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log_handle,
            text=True, bufsize=1,
            env={**os.environ, "PYTHONPATH": python_path,
                 "HF_HOME": os.environ.get("HF_HOME", str(ROOT / "cache" / "huggingface")),
                 "TORCH_HOME": os.environ.get("TORCH_HOME", str(ROOT / "cache" / "torch")),
                 "DACAIS_TORCH_HOME": os.environ.get("DACAIS_TORCH_HOME", str(ROOT / "cache" / "torch"))},
        )
        event = self.read_event()
        if event.get("type") != "worker_ready":
            raise RuntimeError(event.get("error", "MuseTalk worker did not become ready"))
        self.loaded_vram_mb = int(event.get("vramMb", 0) or 0)
        self.started_at = time.time()

    def read_event(self) -> dict[str, Any]:
        if not self.process or not self.process.stdout:
            raise RuntimeError("MuseTalk worker is unavailable")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("MuseTalk worker exited unexpectedly")
        return json.loads(line)

    def stream(self, command: dict[str, Any]):
        with self.lock:
            self.ensure()
            assert self.process and self.process.stdin
            self.process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n"); self.process.stdin.flush()
            while True:
                event = self.read_event(); yield event
                if event.get("type") in {"prepared", "complete", "stopped", "error"}:
                    break


MUSE_TALK_WORKER = MuseTalkWorker()


class ChatterboxWorker:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None; self.lock = threading.Lock(); self.log_handle: Any = None
    def ensure(self) -> None:
        if self.process and self.process.poll() is None: return
        if not CLONE_TTS_PYTHON.exists() or not CLONE_TTS_RUNNER.exists(): raise RuntimeError("Persistent cloned-voice worker is not installed")
        self.log_handle = (ROOT / "logs" / "chatterbox-worker.log").open("a", encoding="utf-8")
        self.process = subprocess.Popen([str(CLONE_TTS_PYTHON), "-u", str(CLONE_TTS_RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log_handle, text=True, bufsize=1)
        event = self.read_event()
        if event.get("type") != "worker_ready": raise RuntimeError(event.get("error", "Cloned-voice worker did not become ready"))
    def read_event(self) -> dict[str, Any]:
        if not self.process or not self.process.stdout: raise RuntimeError("Cloned-voice worker is unavailable")
        line = self.process.stdout.readline()
        if not line: raise RuntimeError("Cloned-voice worker exited unexpectedly")
        return json.loads(line)
    def request(self, command: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.ensure(); assert self.process and self.process.stdin
            self.process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n"); self.process.stdin.flush(); event = self.read_event()
            if event.get("type") == "error": raise RuntimeError(str(event.get("error")))
            return event


CLONE_TTS_WORKER = ChatterboxWorker()


class SdxlWorker:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None; self.lock = threading.Lock(); self.log_handle: Any = None
    def ensure(self) -> None:
        if self.process and self.process.poll() is None: return
        for description, path in (("interpreter", SDXL_PYTHON), ("runner", SDXL_RUNNER), ("weights", SDXL_MODEL_ROOT)):
            if not path.exists(): raise RuntimeError(f"Generative backdrop renderer is missing its {description}: {path}")
        (ROOT / "logs").mkdir(exist_ok=True)
        self.log_handle = (ROOT / "logs" / "sdxl-worker.log").open("a", encoding="utf-8")
        self.process = subprocess.Popen([str(SDXL_PYTHON), "-u", str(SDXL_RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log_handle, text=True, bufsize=1)
        event = self.read_event()
        if event.get("type") != "worker_ready": raise RuntimeError(event.get("error", "Generative backdrop worker did not become ready"))
    def read_event(self) -> dict[str, Any]:
        if not self.process or not self.process.stdout: raise RuntimeError("Generative backdrop worker is unavailable")
        line = self.process.stdout.readline()
        if not line: raise RuntimeError("Generative backdrop worker exited unexpectedly")
        return json.loads(line)
    def request(self, command: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.ensure(); assert self.process and self.process.stdin
            self.process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n"); self.process.stdin.flush(); event = self.read_event()
            if event.get("type") == "error": raise RuntimeError(str(event.get("error")))
            return event


SDXL_WORKER = SdxlWorker()


class MattingWorker:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None; self.lock = threading.Lock(); self.log_handle: Any = None
    def ensure(self) -> None:
        if self.process and self.process.poll() is None: return
        for description, path in (("interpreter", MATTING_PYTHON), ("runner", MATTING_RUNNER)):
            if not path.exists(): raise RuntimeError(f"Presenter matting is missing its {description}: {path}")
        (ROOT / "logs").mkdir(exist_ok=True)
        self.log_handle = (ROOT / "logs" / "matting-worker.log").open("a", encoding="utf-8")
        self.process = subprocess.Popen([str(MATTING_PYTHON), "-u", str(MATTING_RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log_handle, text=True, bufsize=1)
        event = self.read_event()
        if event.get("type") != "worker_ready": raise RuntimeError(event.get("error", "Matting worker did not become ready"))
    def read_event(self) -> dict[str, Any]:
        if not self.process or not self.process.stdout: raise RuntimeError("Matting worker is unavailable")
        line = self.process.stdout.readline()
        if not line: raise RuntimeError("Matting worker exited unexpectedly")
        return json.loads(line)
    def request(self, command: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.ensure(); assert self.process and self.process.stdin
            self.process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n"); self.process.stdin.flush(); event = self.read_event()
            if event.get("type") == "error": raise RuntimeError(str(event.get("error")))
            return event


MATTING_WORKER = MattingWorker()


class SvdWorker:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None; self.lock = threading.Lock(); self.log_handle: Any = None
    def ensure(self) -> None:
        if self.process and self.process.poll() is None: return
        for description, path in (("interpreter", SVD_PYTHON), ("runner", SVD_RUNNER), ("weights", SVD_MODEL_ROOT)):
            if not path.exists(): raise RuntimeError(f"Animated backdrop renderer is missing its {description}: {path}")
        (ROOT / "logs").mkdir(exist_ok=True)
        self.log_handle = (ROOT / "logs" / "svd-worker.log").open("a", encoding="utf-8")
        self.process = subprocess.Popen([str(SVD_PYTHON), "-u", str(SVD_RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log_handle, text=True, bufsize=1)
        event = self.read_event()
        if event.get("type") != "worker_ready": raise RuntimeError(event.get("error", "Animated backdrop worker did not become ready"))
    def read_event(self) -> dict[str, Any]:
        if not self.process or not self.process.stdout: raise RuntimeError("Animated backdrop worker is unavailable")
        line = self.process.stdout.readline()
        if not line: raise RuntimeError("Animated backdrop worker exited unexpectedly")
        return json.loads(line)
    def request(self, command: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            self.ensure(); assert self.process and self.process.stdin
            self.process.stdin.write(json.dumps(command, separators=(",", ":")) + "\n"); self.process.stdin.flush(); event = self.read_event()
            if event.get("type") == "error": raise RuntimeError(str(event.get("error")))
            return event


SVD_WORKER = SvdWorker()


def run(command: list[str], *, cwd: Path | None = None, monitor: bool = False) -> tuple[str, int]:
    peak = gpu_used_mb()
    stop = threading.Event()
    def sample() -> None:
        nonlocal peak
        while not stop.wait(0.25):
            peak = max(peak, gpu_used_mb())
    thread = threading.Thread(target=sample, daemon=True)
    if monitor:
        thread.start()
    try:
        process = subprocess.run(command, cwd=cwd, text=True, capture_output=True, timeout=1_800, check=False)
    finally:
        stop.set()
        if monitor: thread.join(timeout=1)
    if process.returncode:
        detail = (process.stderr or process.stdout)[-2_000:]
        raise RuntimeError(f"media command failed ({process.returncode}): {detail}")
    return process.stdout, peak


def gpu_used_mb() -> int:
    try:
        output = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], text=True, timeout=5)
        return int(output.strip().splitlines()[0])
    except Exception:
        return 0


def health() -> dict[str, Any]:
    output = subprocess.check_output([
        "nvidia-smi", "--query-gpu=memory.total,memory.used,memory.free,utilization.gpu",
        "--format=csv,noheader,nounits",
    ], text=True, timeout=10).strip()
    values = [int(value.strip()) for value in output.splitlines()[0].split(",")]
    processes = subprocess.run(["nvidia-smi", "--query-compute-apps=process_name", "--format=csv,noheader"], text=True, capture_output=True, timeout=10).stdout
    return {"totalMemoryMb": values[0], "usedMemoryMb": values[1], "freeMemoryMb": values[2], "utilizationPercent": values[3], "activeProcesses": [line for line in processes.splitlines() if line.strip()]}


def job_dir(job_id: str) -> Path:
    if not JOB_RE.fullmatch(job_id):
        raise ValueError("jobId contains unsupported characters")
    directory = (ROOT / "jobs" / job_id).resolve()
    if ROOT not in directory.parents:
        raise ValueError("job path escapes media root")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def decode(value: str, output: Path) -> None:
    raw = base64.b64decode(value, validate=True)
    if not raw or len(raw) > MAX_BODY:
        raise ValueError("media payload is empty or too large")
    output.write_bytes(raw)


def encode(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def probe(path: Path) -> dict[str, Any]:
    output, _ = run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", str(path)])
    data = json.loads(output); video = next(item for item in data["streams"] if "width" in item)
    raw_duration = data.get("format", {}).get("duration")
    try:
        duration = float(raw_duration)
    except (TypeError, ValueError):
        duration = 0.0
    # Chrome MediaRecorder commonly writes a WebM with no container duration.
    # The packets still carry presentation timestamps, so use their final video
    # timestamp instead of rejecting a valid camera recording.
    if duration <= 0:
        packet_output, _ = run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "packet=pts_time,dts_time", "-of", "json", str(path),
        ])
        packet_data = json.loads(packet_output)
        timestamps: list[float] = []
        for packet in packet_data.get("packets", []):
            for key in ("pts_time", "dts_time"):
                try:
                    timestamps.append(float(packet.get(key)))
                except (TypeError, ValueError):
                    pass
        if timestamps:
            duration = max(timestamps)
    if duration <= 0:
        raise ValueError("video duration could not be determined")
    return {"codec": video["codec_name"], "width": video["width"], "height": video["height"], "duration": duration}


def duration_of(path: Path) -> float:
    """Container duration, for inputs like WAV that carry no video stream."""
    output, _ = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)])
    return float(json.loads(output)["format"]["duration"])


def tts(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", ""))); audio = directory / "tts.wav"
    text = str(body.get("text", "")).strip()
    if not 1 <= len(text) <= 10_000: raise ValueError("text length must be between 1 and 10000")
    command = [str(TTS_PYTHON), str(SERVICE_DIR / "kokoro_runner.py"), "--text", text, "--voice", str(body.get("voice", "af_heart")), "--speed", str(body.get("speed", 1)), "--output", str(audio)]
    _, peak = run(command, monitor=True)
    with wave.open(str(audio), "rb") as source: duration = source.getnframes() / source.getframerate(); sample_rate = source.getframerate()
    return {"audioBase64": encode(audio), "duration": duration, "sampleRate": sample_rate, "model": "hexgrad/Kokoro-82M", "peakVramMb": peak, "remotePath": str(audio)}


def media_suffix(mime_type: str) -> str:
    value = mime_type.lower()
    if "webm" in value: return ".webm"
    if "mpeg" in value or "mp3" in value: return ".mp3"
    if "wav" in value: return ".wav"
    if "ogg" in value: return ".ogg"
    if "quicktime" in value: return ".mov"
    if "mp4" in value: return ".mp4"
    if "png" in value: return ".png"
    if "jpeg" in value or "jpg" in value: return ".jpg"
    return ".bin"


def valid_clone_reference(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as reference:
            return (
                reference.getnchannels() == 1
                and reference.getsampwidth() == 2
                and reference.getframerate() == 24_000
                and 0 < reference.getnframes() <= 24_000 * MAX_CLONE_REFERENCE_SECONDS + CLONE_REFERENCE_FRAME_TOLERANCE
            )
    except (OSError, EOFError, wave.Error):
        return False


def warm_reference_for(voice_id: str) -> Path | None:
    with CLONE_REFERENCE_CACHE_LOCK:
        cached = WARM_CLONE_REFERENCES.get(voice_id)
    if not cached:
        return None
    reference = Path(cached)
    return reference if valid_clone_reference(reference) else None


def cached_clone_reference(voice_id: str, mime_type: str, reference_value: str) -> Path:
    if not reference_value:
        warmed = warm_reference_for(voice_id)
        if warmed is not None:
            return warmed
        raise ValueError(CLONE_REFERENCE_NOT_WARM)
    try:
        encoded_reference = reference_value.encode("ascii")
    except UnicodeEncodeError as error:
        raise ValueError("voice reference must be base64-encoded ASCII") from error

    content_hash = hashlib.sha256(encoded_reference).hexdigest()
    cache_identity = hashlib.sha256()
    cache_identity.update(CLONE_REFERENCE_CACHE_VERSION.encode("ascii")); cache_identity.update(b"\0")
    cache_identity.update(str(MAX_CLONE_REFERENCE_SECONDS).encode("ascii")); cache_identity.update(b"\0")
    cache_identity.update(voice_id.encode("utf-8")); cache_identity.update(b"\0")
    cache_identity.update(content_hash.encode("ascii"))
    cache_key = cache_identity.hexdigest()
    cache_directory = ROOT / "cache" / "voice-references"
    reference = cache_directory / f"{cache_key}.wav"

    with CLONE_REFERENCE_CACHE_LOCK:
        if valid_clone_reference(reference):
            WARM_CLONE_REFERENCES[voice_id] = str(reference)
            return reference
        reference.unlink(missing_ok=True)
        try:
            raw_reference = base64.b64decode(encoded_reference, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("voice reference is not valid base64") from error
        if not raw_reference or len(raw_reference) > MAX_BODY:
            raise ValueError("voice reference is empty or too large")

        cache_directory.mkdir(parents=True, exist_ok=True)
        temporary_id = f"{os.getpid()}-{threading.get_ident()}-{time.time_ns()}"
        source = cache_directory / f".{cache_key}-{temporary_id}{media_suffix(mime_type)}"
        # Keep the normalized target distinct even when the uploaded reference
        # is already WAV; FFmpeg cannot safely read and rewrite the same path.
        normalized = cache_directory / f".{cache_key}-{temporary_id}-normalized.wav"
        try:
            source.write_bytes(raw_reference)
            run([
                "ffmpeg", "-y", "-i", str(source), "-map", "0:a:0", "-vn",
                "-t", str(MAX_CLONE_REFERENCE_SECONDS), "-ac", "1", "-ar", "24000",
                "-c:a", "pcm_s16le", str(normalized),
            ])
            if not valid_clone_reference(normalized):
                raise RuntimeError("FFmpeg produced an invalid cloned-voice reference")
            os.replace(normalized, reference)
            WARM_CLONE_REFERENCES[voice_id] = str(reference)
        finally:
            source.unlink(missing_ok=True)
            normalized.unlink(missing_ok=True)
        return reference


def clone_tts(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", "")))
    text = str(body.get("text", "")).strip()
    if not 1 <= len(text) <= 10_000: raise ValueError("text length must be between 1 and 10000")
    voice_id = str(body.get("voiceId", "")).strip()
    if not voice_id: raise ValueError("voiceId is required")
    mime_type = str(body.get("referenceMimeType", "application/octet-stream"))
    raw_audio = directory / "clone-raw.wav"
    output = directory / "clone.wav"
    reference = cached_clone_reference(voice_id, mime_type, str(body.get("referenceMediaBase64", "")))
    worker_result = CLONE_TTS_WORKER.request({"text": text, "reference": str(reference), "language": str(body.get("language", "en")), "output": str(raw_audio)})
    peak = int(worker_result.get("peakVramMb", 0))
    speed = float(body.get("speed", 1))
    if not 0.5 <= speed <= 1.5: raise ValueError("speed must be between 0.5 and 1.5")
    if speed == 1:
        shutil.copy2(raw_audio, output)
    else:
        run(["ffmpeg", "-y", "-i", str(raw_audio), "-filter:a", f"atempo={speed}", str(output)])
    with wave.open(str(output), "rb") as generated_audio:
        duration = generated_audio.getnframes() / generated_audio.getframerate()
        sample_rate = generated_audio.getframerate()
    return {
        "audioBase64": encode(output), "duration": duration, "sampleRate": sample_rate,
        "model": str(worker_result.get("model", "ResembleAI/chatterbox-multilingual")), "voiceId": voice_id,
        "voiceConditioningCached": bool(worker_result.get("voiceConditioningCached")),
        "peakVramMb": peak, "remotePath": str(output),
    }


def warm_clone_tts(body: dict[str, Any]) -> dict[str, Any]:
    voice_id = str(body.get("voiceId", "")).strip()
    if not voice_id: raise ValueError("voiceId is required to warm a cloned voice")
    reference = cached_clone_reference(
        voice_id,
        str(body.get("referenceMimeType", "application/octet-stream")),
        str(body.get("referenceMediaBase64", "")),
    )
    prepared = CLONE_TTS_WORKER.request({
        "type": "prepare", "reference": str(reference),
        "language": str(body.get("language", "en")),
    })
    return {
        "ok": True, "model": str(prepared.get("model", "ResembleAI/chatterbox-multilingual")),
        "warm": True, "voiceConditioningCached": True,
    }


def avatar(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", ""))); image = directory / "presenter.png"; audio = directory / "tts.wav"; results = directory / "sadtalker"
    source_value = str(body.get("sourceMediaBase64") or body.get("imageBase64") or "")
    source_mime = str(body.get("sourceMimeType", "image/png"))
    source = directory / f"presenter-source{media_suffix(source_mime)}"
    decode(source_value, source); decode(str(body.get("audioBase64", "")), audio); results.mkdir(exist_ok=True)
    if source_mime.startswith("video/"):
        run(["ffmpeg", "-y", "-i", str(source), "-vf", "thumbnail,scale='min(1024,iw)':-2", "-frames:v", "1", str(image)])
    else:
        run(["ffmpeg", "-y", "-i", str(source), "-frames:v", "1", str(image)])
    before = set(results.rglob("*.mp4"))
    command = [str(SADTALKER_PYTHON), "inference.py", "--driven_audio", str(audio), "--source_image", str(image), "--result_dir", str(results), "--still", "--preprocess", "full"]
    _, peak = run(command, cwd=SADTALKER, monitor=True)
    candidates = list(set(results.rglob("*.mp4")) - before) or list(results.rglob("*.mp4"))
    if not candidates: raise RuntimeError("SadTalker produced no MP4")
    generated = max(candidates, key=lambda item: item.stat().st_mtime); output = directory / "avatar.mp4"; shutil.copy2(generated, output)
    return {"videoBase64": encode(output), "model": "OpenTalker/SadTalker", "peakVramMb": peak, "duration": probe(output)["duration"], "remotePath": str(output)}


def generate_backdrop(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", "")))
    prompt = str(body.get("prompt", "")).strip()
    if not 1 <= len(prompt) <= 2_000: raise ValueError("prompt length must be between 1 and 2000")
    output = directory / "backdrop.png"
    command: dict[str, Any] = {"type": "backdrop", "prompt": prompt, "output": str(output)}
    for key in ("negativePrompt", "seed", "steps", "guidanceScale", "width", "height"):
        if body.get(key) is not None: command[key] = body[key]
    event = SDXL_WORKER.request(command)
    result: dict[str, Any] = {"imageBase64": encode(output), "model": "stabilityai/stable-diffusion-xl-base-1.0",
                              "width": event.get("width"), "height": event.get("height"),
                              "seed": event.get("seed"), "peakVramMb": event.get("peakVramMb"), "remotePath": str(output)}
    if body.get("animate"):
        # Animation is additive: on failure the caller still has a usable still.
        try:
            animate_command: dict[str, Any] = {"type": "animate", "input": str(output), "directory": str(directory)}
            for key in ("seed", "motionBucket", "frames", "noiseAug", "sourceFps"):
                if body.get(key) is not None: animate_command[key] = body[key]
            animated = SVD_WORKER.request(animate_command)
            result["videoBase64"] = encode(Path(str(animated["output"])))
            result["videoModel"] = "stabilityai/stable-video-diffusion-img2vid-xt"
            result["videoFrames"] = animated.get("frames")
            result["peakVramMb"] = max(int(result.get("peakVramMb") or 0), int(animated.get("peakVramMb") or 0))
        except Exception as error:
            result["videoError"] = str(error)
    return result


def edit_image(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", "")))
    prompt = str(body.get("prompt", "")).strip()
    if not 1 <= len(prompt) <= 2_000: raise ValueError("prompt length must be between 1 and 2000")
    mime_type = str(body.get("sourceMimeType", "image/png"))
    if mime_type not in ("image/png", "image/jpeg", "image/webp"):
        raise ValueError("sourceMimeType must be image/png, image/jpeg, or image/webp")
    source_value = str(body.get("sourceMediaBase64", ""))
    if not source_value: raise ValueError("sourceMediaBase64 is required")
    source = directory / f"source{media_suffix(mime_type)}"; decode(source_value, source)
    output = directory / "edited.png"
    strength = float(body.get("strength", 0.65))
    if not 0.05 <= strength <= 1.0: raise ValueError("strength must be between 0.05 and 1")
    command: dict[str, Any] = {
        "type": "edit", "input": str(source), "output": str(output), "prompt": prompt,
        "strength": strength,
    }
    for key in ("negativePrompt", "seed", "steps", "guidanceScale", "width", "height"):
        if body.get(key) is not None: command[key] = body[key]
    event = SDXL_WORKER.request(command)
    return {"imageBase64": encode(output), "model": "stabilityai/stable-diffusion-xl-base-1.0",
            "width": event.get("width"), "height": event.get("height"), "seed": event.get("seed"),
            "peakVramMb": event.get("peakVramMb"), "remotePath": str(output)}


def animate_image(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", "")))
    mime_type = str(body.get("sourceMimeType", "image/png"))
    if mime_type not in ("image/png", "image/jpeg", "image/webp"):
        raise ValueError("sourceMimeType must be image/png, image/jpeg, or image/webp")
    source_value = str(body.get("sourceMediaBase64", ""))
    if not source_value: raise ValueError("sourceMediaBase64 is required")
    source = directory / f"source{media_suffix(mime_type)}"; decode(source_value, source)
    command: dict[str, Any] = {"type": "animate", "input": str(source), "directory": str(directory)}
    for key in ("seed", "motionBucket", "frames", "noiseAug", "sourceFps"):
        if body.get(key) is not None: command[key] = body[key]
    event = SVD_WORKER.request(command)
    output = Path(str(event["output"]))
    return {"videoBase64": encode(output), "videoModel": "stabilityai/stable-video-diffusion-img2vid-xt",
            "videoFrames": event.get("frames"), "width": event.get("width"), "height": event.get("height"),
            "peakVramMb": event.get("peakVramMb"), "remotePath": str(output)}


# Photorealistic, but deliberately generic: the prompt never names or describes a
# real individual, so the result is a synthetic presenter rather than a likeness.
PRESENTER_PROMPT = (
    "photorealistic studio portrait photograph of a professional {descriptor} presenter, "
    "head and shoulders, facing the camera directly, neutral closed-mouth expression, "
    "soft even key lighting, sharp focus on the eyes, natural detailed skin texture, "
    "business attire, plain uncluttered neutral background, 85mm lens, shallow depth of field"
)
PRESENTER_NEGATIVE = (
    "cartoon, 3d render, cgi, illustration, anime, stylized, plastic skin, doll, "
    "open mouth, visible teeth, talking, sunglasses, hat, hands, multiple people, crowd, "
    "celebrity, text, watermark, logo, blurry, lowres, deformed, disfigured, extra limbs"
)


def generate_presenter(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", "")))
    descriptor = str(body.get("descriptor", "")).strip()
    if len(descriptor) > 200: raise ValueError("descriptor must be 200 characters or fewer")
    prompt = str(body.get("prompt", "")).strip() or PRESENTER_PROMPT.format(descriptor=descriptor or "adult")
    output = directory / "presenter-generated.png"
    command: dict[str, Any] = {
        "type": "backdrop", "prompt": prompt, "output": str(output),
        "negativePrompt": str(body.get("negativePrompt") or PRESENTER_NEGATIVE),
        # Square keeps the face centred for the downstream face detector.
        "width": int(body.get("width", 1024)), "height": int(body.get("height", 1024)),
        "steps": int(body.get("steps", 34)), "guidanceScale": float(body.get("guidanceScale", 5.0)),
    }
    if body.get("seed") is not None: command["seed"] = body["seed"]
    event = SDXL_WORKER.request(command)
    return {"imageBase64": encode(output), "model": "stabilityai/stable-diffusion-xl-base-1.0",
            "width": event.get("width"), "height": event.get("height"),
            "peakVramMb": event.get("peakVramMb"), "prompt": prompt, "remotePath": str(output)}


SCENE_FILTER = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p"


def scene_inputs(directory: Path, scenes: list[dict[str, Any]], seconds: float) -> tuple[list[str], str, str]:
    """Build ffmpeg inputs and a filter chain that cycles uploaded media behind the presenter.

    Each upload holds the frame for an equal share of the narration. Videos play
    from their own first seconds; stills are looped for their slot.
    """
    share = max(seconds / max(len(scenes), 1), 0.5)
    inputs: list[str] = []; chains: list[str] = []; labels = ""
    for index, scene in enumerate(scenes):
        mime = str(scene.get("mimeType", "image/png"))
        path = directory / f"scene-{index}{media_suffix(mime)}"
        decode(str(scene.get("media", "")), path)
        if mime.startswith("video/"):
            inputs += ["-t", f"{share:.3f}", "-i", str(path)]
        else:
            inputs += ["-loop", "1", "-t", f"{share:.3f}", "-i", str(path)]
        chains.append(f"[{index}:v]{SCENE_FILTER}[s{index}]")
        labels += f"[s{index}]"
    chains.append(f"{labels}concat=n={len(scenes)}:v=1:a=0[bg]")
    return inputs, ";".join(chains), "[bg]"


def compose(body: dict[str, Any]) -> dict[str, Any]:
    directory = job_dir(str(body.get("jobId", ""))); source = directory / "avatar.mp4"; audio = directory / "tts.wav"; output = directory / "final.mp4"
    decode(str(body.get("videoBase64", "")), source); decode(str(body.get("audioBase64", "")), audio)
    scenes = body.get("scenes") or []
    if not isinstance(scenes, list) or len(scenes) > 40: raise ValueError("scenes must be a list of at most 40 items")
    backdrop_raw = str(body.get("backdropBase64", ""))
    backdrop_video_raw = str(body.get("backdropVideoBase64", ""))
    # Matting is best-effort: a failure must degrade to the opaque presenter
    # rather than lose an otherwise finished render.
    cutout = bool(body.get("cutout", True)) and (bool(scenes) or bool(backdrop_raw) or bool(backdrop_video_raw))
    presenter_input = source; matting_error = ""
    if cutout:
        try:
            matted = directory / "avatar-matte.mov"
            MATTING_WORKER.request({"type": "matte", "input": str(source), "output": str(matted)})
            presenter_input = matted
        except Exception as error:
            matting_error = str(error)
    # Uploaded media takes the frame when supplied; a generated backdrop is the
    # fallback, and the flat brand colour is the last resort.
    if scenes:
        seconds = duration_of(audio) if audio.exists() else 0.0
        extra, scene_chain, background = scene_inputs(directory, scenes, seconds)
        inputs = [*extra, "-i", str(presenter_input), "-i", str(audio)]
        person = f"[{len(scenes)}:v]"; audio_map = f"{len(scenes) + 1}:a:0"
        filter_graph = (f"{scene_chain};{person}scale=460:-2[person];"
                        f"{background}[person]overlay=W-w-72:H-h-40,"
                        "drawtext=text='DACAIS':x=64:y=54:fontsize=46:fontcolor=white[v]")
    elif backdrop_video_raw:
        # An animated backdrop is looped to cover the narration; -shortest ends
        # the render on the audio rather than on the loop boundary.
        backdrop = directory / "backdrop-loop.mp4"; decode(backdrop_video_raw, backdrop)
        inputs = ["-i", str(presenter_input), "-i", str(audio), "-stream_loop", "-1", "-i", str(backdrop)]; audio_map = "1:a:0"
        filter_graph = ("[2:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1[bg];"
                        "[0:v]scale=614:-2[person];[bg][person]overlay=W-w-72:H-h-40:shortest=1,"
                        "drawtext=text='DACAIS':x=64:y=54:fontsize=46:fontcolor=white[v]")
    elif backdrop_raw:
        backdrop = directory / "backdrop.png"; decode(backdrop_raw, backdrop)
        inputs = ["-i", str(presenter_input), "-i", str(audio), "-i", str(backdrop)]; audio_map = "1:a:0"
        filter_graph = ("[2:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720[bg];"
                        "[0:v]scale=614:-2[person];[bg][person]overlay=W-w-72:H-h-40,"
                        "drawtext=text='DACAIS':x=64:y=54:fontsize=46:fontcolor=white[v]")
    else:
        inputs = ["-i", str(presenter_input), "-i", str(audio)]; audio_map = "1:a:0"
        filter_graph = "[0:v]scale=614:-2[person];color=c=0x101827:s=1280x720[bg];[bg][person]overlay=W-w-72:H-h-40,drawtext=text='DACAIS':x=64:y=54:fontsize=46:fontcolor=white[v]"
    run(["ffmpeg", "-y", *inputs, "-filter_complex", filter_graph, "-map", "[v]", "-map", audio_map, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(output)])
    metadata = probe(output); version = subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0]
    return {"videoBase64": encode(output), "ffmpegVersion": version, **metadata, "remotePath": str(output),
            "cutout": cutout and not matting_error, "mattingError": matting_error}


def realtime_prepare(body: dict[str, Any]) -> dict[str, Any]:
    session_id = str(body.get("sessionId", ""))
    if not JOB_RE.fullmatch(session_id): raise ValueError("sessionId contains unsupported characters")
    mime_type = str(body.get("sourceMimeType", "image/png"))
    movement_guide_version = str(body.get("movementGuideVersion", "")).strip()
    movement_guide_evidence = body.get("movementGuideEvidence")
    source_raw = base64.b64decode(str(body.get("sourceMedia", "")), validate=True)
    if not source_raw or len(source_raw) > MAX_BODY: raise ValueError("avatar source is empty or too large")
    source_hash = hashlib.sha256()
    source_hash.update(REALTIME_AVATAR_PREP_VERSION.encode("utf-8")); source_hash.update(b"\0")
    source_hash.update(mime_type.encode("utf-8")); source_hash.update(b"\0")
    source_hash.update(movement_guide_version.encode("utf-8")); source_hash.update(b"\0")
    source_hash.update(json.dumps(movement_guide_evidence, sort_keys=True, separators=(",", ":")).encode("utf-8")); source_hash.update(b"\0")
    source_hash.update(source_raw)
    avatar_id = "avatar-" + source_hash.hexdigest()[:24]
    directory = job_dir("rtprep-" + avatar_id[-24:]); source = directory / f"source{media_suffix(mime_type)}"; video = directory / "source.mp4"
    source.write_bytes(source_raw)
    original_metadata = probe(source)
    cold_start = avatar_id not in REALTIME_AVATARS
    if not video.exists():
        if mime_type.startswith("video/"):
            # Preserve the recorded head, expression, and upper-body motion. MuseTalk
            # cycles these source frames while replacing the mouth for each reply.
            motion_intervals: tuple[tuple[float, float], ...] = ()
            if movement_guide_version == "guided-motion-v2":
                motion_intervals = GUIDED_V2_MOTION_INTERVALS
            elif movement_guide_version == "guided-liveness-v3":
                motion_intervals = guided_liveness_intervals(movement_guide_evidence, float(original_metadata["duration"]))
            if motion_intervals:
                chains = [
                    f"[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[v{index}]"
                    for index, (start, end) in enumerate(motion_intervals)
                ]
                inputs = "".join(f"[v{index}]" for index in range(len(motion_intervals)))
                filter_graph = (
                    ";".join(chains)
                    + f";{inputs}concat=n={len(motion_intervals)}:v=1:a=0,"
                    + f"fps={REALTIME_SOURCE_FPS},{REALTIME_SOURCE_SCALE},setsar=1[v]"
                )
                run([
                    "ffmpeg", "-y", "-i", str(source), "-filter_complex", filter_graph,
                    "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video),
                ])
            else:
                run([
                    "ffmpeg", "-y", "-i", str(source), "-map", "0:v:0", "-an",
                    "-t", str(MAX_REALTIME_REFERENCE_SECONDS),
                    "-vf", f"fps={REALTIME_SOURCE_FPS},{REALTIME_SOURCE_SCALE},setsar=1",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video),
                ])
        else:
            run(["ffmpeg", "-y", "-i", str(source), "-frames:v", "1", "-vf", REALTIME_SOURCE_SCALE, "-pix_fmt", "yuv420p", str(video)])
    source_metadata = probe(video)
    verified_single_face = (
        movement_guide_version == "guided-liveness-v3"
        and isinstance(movement_guide_evidence, dict)
        and float(movement_guide_evidence.get("singleFaceRatio", 0)) >= .9
        and float(movement_guide_evidence.get("multipleFaceRatio", 1)) <= .02
    )
    vram_before_prepare = gpu_used_mb()
    event = list(MUSE_TALK_WORKER.stream({
        "type": "prepare", "avatarId": avatar_id, "videoPath": str(video),
        "verifiedSingleFace": verified_single_face,
    }))[-1]
    if event.get("type") == "error": raise RuntimeError(str(event.get("error")))
    avatar_vram_mb = max(0, int(event.get("vramMb", 0) or 0) - vram_before_prepare)
    index_state = build_capture_index(avatar_id, video)
    with REALTIME_LOCK:
        REALTIME_AVATARS[avatar_id] = {"videoPath": str(video), "preparedAt": time.time(),
                                       "sourceDuration": original_metadata["duration"],
                                       "vramMb": avatar_vram_mb,
                                       "cycleFrames": int(event.get("cycleFrames", 0) or 0)}
    return {
        "avatarId": avatar_id, "model": event.get("model", "TMElyralab/MuseTalk-1.5"),
        "coldStart": cold_start and not bool(event.get("cached")),
        "motionReference": mime_type.startswith("video/") and source_metadata["duration"] > 0.1,
        "sourceDuration": original_metadata["duration"],
        "preparedReferenceDuration": source_metadata["duration"],
        # The renderer cycles this reference at exactly this rate, so the client
        # can present the same frames continuously between replies.
        "referenceFps": REALTIME_SOURCE_FPS,
        "avatarVramMb": avatar_vram_mb,
        "referenceFrames": event.get("referenceFrames"),
        "cycleFrames": event.get("cycleFrames"),
        "captureIndex": index_state,
        "movementGuideVersion": movement_guide_version or None,
        "captureQuality": event.get("captureQuality"),
    }


_ENCODER_CACHE: dict[str, Any] | None = None
# Candidates for a future realtime video track. Reported, not used yet: frames
# currently reach the browser as JPEG over a WebSocket, and moving to an encoded
# WebRTC track needs a server-side peer connection that does not exist.
ENCODER_CANDIDATES = ("h264_nvenc", "hevc_nvenc", "av1_nvenc", "libx264", "libvpx-vp9", "libaom-av1")


def encoder_report() -> dict[str, Any]:
    """Which realtime video encoders this pod actually has, hardware first."""
    global _ENCODER_CACHE
    if _ENCODER_CACHE is not None:
        return _ENCODER_CACHE
    try:
        listing = subprocess.check_output(["ffmpeg", "-hide_banner", "-encoders"], text=True, timeout=20, stderr=subprocess.STDOUT)
    except Exception as error:
        _ENCODER_CACHE = {"available": [], "hardware": [], "error": str(error)}
        return _ENCODER_CACHE
    available = [name for name in ENCODER_CANDIDATES if f" {name} " in listing]
    _ENCODER_CACHE = {
        "available": available,
        "hardware": [name for name in available if name.endswith("_nvenc")],
        "preferred": next((name for name in ("h264_nvenc", "libx264") if name in available), None),
    }
    return _ENCODER_CACHE


def capture_index_available() -> bool:
    return CAPTURE_INDEX_RUNNER.is_file() and FACE_LANDMARKER_MODEL.is_file()


def capture_index_path(avatar_id: str) -> Path:
    return job_dir("rtprep-" + avatar_id[-24:]) / "capture-index.json"


def build_capture_index(avatar_id: str, video: Path) -> dict[str, Any]:
    """Measure the prepared reference once, so poses can be retrieved from it.

    Absence is a supported outcome: without the indexer the renderer keeps its
    existing behavior and reports pose and expression as uncontrollable.
    """
    output = capture_index_path(avatar_id)
    if output.is_file():
        return {"built": False, "cached": True, "path": str(output)}
    if not capture_index_available():
        return {"built": False, "cached": False, "reason": "capture indexer or face landmarker model is not installed"}
    completed = subprocess.run(
        [str(CAPTURE_INDEX_PYTHON), str(CAPTURE_INDEX_RUNNER), "--video", str(video),
         "--output", str(output), "--model", str(FACE_LANDMARKER_MODEL)],
        capture_output=True, text=True, timeout=1_800,
    )
    if completed.returncode != 0:
        print(f"capture index unavailable for {avatar_id}: {completed.stderr.strip()[:400]}", flush=True)
        return {"built": False, "cached": False, "reason": "capture indexing did not complete"}
    return {"built": True, "cached": False, "path": str(output)}


def realtime_vram_report() -> dict[str, Any]:
    """Measured GPU cost of the realtime path, split by what is holding it."""
    with REALTIME_LOCK:
        resident = [{"avatarId": key, "vramMb": int(value.get("vramMb", 0) or 0),
                     "cycleFrames": int(value.get("cycleFrames", 0) or 0),
                     "sessions": sum(1 for other in REALTIME_SESSIONS.values() if other["avatarId"] == key)}
                    for key, value in REALTIME_AVATARS.items()]
    return {
        "baselineMb": MUSE_TALK_WORKER.baseline_vram_mb,
        "modelsLoadedMb": MUSE_TALK_WORKER.loaded_vram_mb,
        "modelsMb": max(0, MUSE_TALK_WORKER.loaded_vram_mb - MUSE_TALK_WORKER.baseline_vram_mb),
        "currentMb": gpu_used_mb(),
        "identities": resident,
        "identityMb": sum(entry["vramMb"] for entry in resident),
    }


def realtime_motion_reference(avatar_id: str) -> tuple[bytes, str]:
    """The prepared reference cycle itself, for the continuous idle/listening layer."""
    if not JOB_RE.fullmatch(avatar_id):
        raise ValueError("avatarId contains unsupported characters")
    with REALTIME_LOCK:
        entry = REALTIME_AVATARS.get(avatar_id)
    if not entry:
        raise ValueError("avatarId has not been prepared")
    video = Path(str(entry["videoPath"]))
    if not video.is_file():
        raise ValueError("the prepared motion reference is no longer on disk")
    return video.read_bytes(), "video/mp4"


def realtime_start(body: dict[str, Any]) -> dict[str, Any]:
    session_id = str(body.get("sessionId", "")); avatar_id = str(body.get("avatarId", ""))
    if not JOB_RE.fullmatch(session_id): raise ValueError("sessionId contains unsupported characters")
    with REALTIME_LOCK:
        if avatar_id not in REALTIME_AVATARS: raise ValueError("avatarId has not been prepared")
        if session_id not in REALTIME_SESSIONS and len(REALTIME_SESSIONS) >= MAX_REALTIME_SESSIONS:
            raise CapacityError(f"realtime renderer is at capacity ({MAX_REALTIME_SESSIONS} concurrent sessions)")
        REALTIME_SESSIONS[session_id] = {"avatarId": avatar_id, "state": "IDLE", "startedAt": time.time()}
        active = len(REALTIME_SESSIONS)
    return {"ok": True, "sessionId": session_id, "state": "IDLE", "activeSessions": active,
            "sessionCapacity": MAX_REALTIME_SESSIONS}


def realtime_state(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    state = str(body.get("state", ""))
    allowed = {"INITIALIZING", "CONNECTING", "IDLE", "LISTENING", "USER_SPEAKING", "THINKING",
               "SPEAKING", "INTERRUPTED", "RECONNECTING", "ENDING"}
    if state not in allowed: raise ValueError("unsupported realtime state")
    with REALTIME_LOCK:
        if session_id not in REALTIME_SESSIONS: raise ValueError("realtime session not found")
        REALTIME_SESSIONS[session_id]["state"] = state
    return {"ok": True, "state": state}


def realtime_interrupt(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
    utterance_id = str(body.get("utteranceId", ""))
    if not JOB_RE.fullmatch(utterance_id): raise ValueError("utteranceId contains unsupported characters")
    directory = job_dir("rt-" + session_id); (directory / f"interrupt-{utterance_id}").touch()
    return {"ok": True, "utteranceId": utterance_id}


def realtime_stop(session_id: str) -> dict[str, Any]:
    with REALTIME_LOCK:
        session = REALTIME_SESSIONS.pop(session_id, None)
        if not session: raise ValueError("realtime session not found")
        avatar_id = str(session["avatarId"])
        # Only the last session using this face may release it. The on-disk
        # latent cache survives, so the next session re-prepares in milliseconds.
        still_in_use = any(str(other["avatarId"]) == avatar_id for other in REALTIME_SESSIONS.values())
        if not still_in_use: REALTIME_AVATARS.pop(avatar_id, None)
    released = False
    worker_running = bool(MUSE_TALK_WORKER.process and MUSE_TALK_WORKER.process.poll() is None)
    # A worker that is not running has already released the memory; starting one
    # just to stop an avatar would load every model for nothing.
    if not still_in_use and worker_running:
        try:
            list(MUSE_TALK_WORKER.stream({"type": "stop", "avatarId": avatar_id}))
            released = True
        except Exception as error:
            # A worker that has already exited has released the memory anyway;
            # never fail session teardown on it.
            print(f"realtime stop could not release avatar {avatar_id}: {error}", flush=True)
    directory = ROOT / "jobs" / ("rt-" + session_id)
    if directory.is_dir(): shutil.rmtree(directory, ignore_errors=True)
    return {"ok": True, "sessionId": session_id, "avatarReleased": released or not worker_running}


ROUTES: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "/v1/tts": tts,
    "/v1/voice/clone-synthesize": clone_tts,
    "/v1/voice/warm": warm_clone_tts,
    "/v1/avatar": avatar,
    "/v1/compose": compose,
    "/v1/generate-backdrop": generate_backdrop,
    "/v1/edit-image": edit_image,
    "/v1/animate-image": animate_image,
    "/v1/generate-presenter": generate_presenter,
}


class Handler(BaseHTTPRequestHandler):
    def authorized(self) -> bool:
        return not TOKEN or hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}")
    def reply(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode(); self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
    def do_GET(self) -> None:
        if not self.authorized(): self.reply(401, {"error": "unauthorized"}); return
        match = re.fullmatch(r"/v1/realtime/avatars/([A-Za-z0-9_-]+)/capture-index", self.path)
        if match:
            if not capture_index_available():
                self.reply(501, {"error": "capture indexer is not installed on this pod"}); return
            path = capture_index_path(match.group(1))
            if not path.is_file():
                self.reply(404, {"error": "no capture index has been built for this identity"}); return
            payload = path.read_bytes()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload); return
        match = re.fullmatch(r"/v1/realtime/avatars/([A-Za-z0-9_-]+)/motion-reference", self.path)
        if match:
            try: media, mime_type = realtime_motion_reference(match.group(1))
            except ValueError as error: self.reply(404, {"error": str(error)}); return
            except Exception as error: self.reply(500, {"error": str(error)}); return
            self.send_response(200); self.send_header("Content-Type", mime_type); self.send_header("Content-Length", str(len(media)))
            self.send_header("Cache-Control", "private, max-age=300"); self.end_headers(); self.wfile.write(media); return
        if self.path != "/v1/health": self.reply(404, {"error": "not found"}); return
        try: self.reply(200, {**health(), "ttsModel": "hexgrad/Kokoro-82M" if TTS_PYTHON.exists() else None, "voiceCloneModel": "ResembleAI/chatterbox-turbo+multilingual" if CLONE_TTS_PYTHON.exists() else None, "avatarModel": "OpenTalker/SadTalker" if SADTALKER_PYTHON.exists() else None, "backdropModel": "stabilityai/stable-diffusion-xl-base-1.0" if SDXL_MODEL_ROOT.is_dir() and SDXL_RUNNER.exists() else None, "backdropVideoModel": "stabilityai/stable-video-diffusion-img2vid-xt" if SVD_MODEL_ROOT.is_dir() and SVD_RUNNER.exists() else None, "realtimeAvatarModel": "TMElyralab/MuseTalk-1.5" if MUSE_TALK_PYTHON.exists() and REALTIME_RUNNER.exists() and MUSE_TALK_UNET.exists() else None, "realtimeWorkerReady": bool(MUSE_TALK_WORKER.process and MUSE_TALK_WORKER.process.poll() is None), "realtimeSessions": len(REALTIME_SESSIONS), "realtimeSessionCapacity": MAX_REALTIME_SESSIONS, "realtimeAvatarsResident": len(REALTIME_AVATARS), "realtimeVram": realtime_vram_report(), "videoEncoders": encoder_report(), "frameTransport": "jpeg-over-websocket",
                                  "captureIndexer": capture_index_available(), "mediaRoot": str(ROOT)})
        except Exception as error: self.reply(503, {"error": str(error)})
    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY * 2: raise ValueError("request body is empty or too large")
        return json.loads(self.rfile.read(length))
    def stream_realtime_audio(self, session_id: str, body: dict[str, Any]) -> None:
        with REALTIME_LOCK: session = REALTIME_SESSIONS.get(session_id)
        if not session: raise ValueError("realtime session not found")
        if str(body.get("sessionId", "")) != session_id: raise ValueError("audio chunk sessionId does not match the route")
        utterance_id = str(body.get("utteranceId", ""))
        if not JOB_RE.fullmatch(utterance_id): raise ValueError("utteranceId contains unsupported characters")
        directory = job_dir("rt-" + session_id); audio = directory / f"audio-{utterance_id}.wav"; interrupt_path = directory / f"interrupt-{utterance_id}"
        decode(str(body.get("audio", "")), audio); interrupt_path.unlink(missing_ok=True)
        self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.send_header("Cache-Control", "no-store"); self.end_headers()
        for event in MUSE_TALK_WORKER.stream({"type": "audio", "sessionId": session_id, "utteranceId": utterance_id, "avatarId": session["avatarId"], "audioPath": str(audio), "interruptPath": str(interrupt_path)}):
            self.wfile.write((json.dumps(event, separators=(",", ":")) + "\n").encode()); self.wfile.flush()
    def do_POST(self) -> None:
        if not self.authorized(): self.reply(401, {"error": "unauthorized"}); return
        try:
            body = self.read_body()
            if self.path in ROUTES: self.reply(200, ROUTES[self.path](body)); return
            if self.path == "/v1/realtime/avatars": self.reply(200, realtime_prepare(body)); return
            if self.path == "/v1/realtime/sessions": self.reply(200, realtime_start(body)); return
            match = re.fullmatch(r"/v1/realtime/sessions/([A-Za-z0-9_-]+)/audio", self.path)
            if match: self.stream_realtime_audio(match.group(1), body); return
            match = re.fullmatch(r"/v1/realtime/sessions/([A-Za-z0-9_-]+)/(state|interrupt)", self.path)
            if match:
                result = realtime_state(match.group(1), body) if match.group(2) == "state" else realtime_interrupt(match.group(1), body)
                self.reply(200, result); return
            self.reply(404, {"error": "not found"})
        except CapacityError as error: self.reply(429, {"error": str(error)})
        except ValueError as error: self.reply(400, {"error": str(error)})
        except Exception as error: self.reply(500, {"error": str(error)})
    def do_DELETE(self) -> None:
        if not self.authorized(): self.reply(401, {"error": "unauthorized"}); return
        match = re.fullmatch(r"/v1/realtime/sessions/([A-Za-z0-9_-]+)", self.path)
        if not match: self.reply(404, {"error": "not found"}); return
        try: self.reply(200, realtime_stop(match.group(1)))
        except ValueError as error: self.reply(404, {"error": str(error)})
        except Exception as error: self.reply(500, {"error": str(error)})
    def log_message(self, pattern: str, *args: Any) -> None:
        print(f"{self.address_string()} {pattern % args}", flush=True)


if __name__ == "__main__":
    for name in ("models", "cache", "jobs", "avatars", "voices", "outputs", "training", "datasets", "ingestion", "knowledge", "adapters", "evaluations", "service", "venvs"):
        (ROOT / name).mkdir(parents=True, exist_ok=True)
    host = os.environ.get("DACAIS_MEDIA_HOST", "127.0.0.1")
    ThreadingHTTPServer((host, int(os.environ.get("DACAIS_MEDIA_PORT", "8090"))), Handler).serve_forever()
