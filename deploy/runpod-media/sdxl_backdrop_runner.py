#!/usr/bin/env python3
"""Persistent SDXL JSONL worker for image generation and editing."""
from __future__ import annotations

import contextlib
import json
import os
import sys
import traceback
from pathlib import Path

import torch
from diffusers import StableDiffusionXLImg2ImgPipeline, StableDiffusionXLPipeline
from PIL import Image

import gpu_runtime
from media_intent import aligned_size, inference_instruction, finalize_image, output_size

ORIGINAL_STDOUT = sys.stdout
MODEL_ROOT = Path(os.environ.get("DACAIS_SDXL_MODEL_ROOT", "/opt/dacais-sdxl/stable-diffusion-xl-base-1.0"))
WIDTH = int(os.environ.get("DACAIS_SDXL_WIDTH", "1344"))
HEIGHT = int(os.environ.get("DACAIS_SDXL_HEIGHT", "768"))
STEPS = int(os.environ.get("DACAIS_SDXL_STEPS", "28"))
NEGATIVE = os.environ.get(
    "DACAIS_SDXL_NEGATIVE",
    "text, watermark, logo, signature, low quality, lowres, blurry, "
    "distorted, deformed, disfigured, extra limbs, bad anatomy",
)
# Free VRAM needed to decode the latent in one pass instead of slicing the VAE.
UNSLICED_DECODE_GIB = float(os.environ.get("DACAIS_SDXL_UNSLICED_DECODE_GIB", "12"))


def emit(value: dict) -> None:
    ORIGINAL_STDOUT.write(json.dumps(value, separators=(",", ":")) + "\n")
    ORIGINAL_STDOUT.flush()


def gpu_peak_mb() -> int:
    return round(torch.cuda.max_memory_allocated() / 1024 / 1024) if torch.cuda.is_available() else 0


def enable_vae_slicing(pipeline: StableDiffusionXLPipeline) -> None:
    """Support both stable and pre-1.0 diffusers VAE-slicing APIs."""
    enable_pipeline_slicing = getattr(pipeline, "enable_vae_slicing", None)
    if callable(enable_pipeline_slicing):
        enable_pipeline_slicing()
        return
    enable_vae_slicing_method = getattr(pipeline.vae, "enable_slicing", None)
    if callable(enable_vae_slicing_method):
        enable_vae_slicing_method()


def main() -> int:
    if not MODEL_ROOT.is_dir():
        emit({"type": "error", "error": f"SDXL weights are not installed at {MODEL_ROOT}"})
        return 1
    device = "cuda" if torch.cuda.is_available() else "cpu"
    # SDXL ships fp16 weights and is numerically tuned for them; the Blackwell
    # gain comes from the tensor-core paths below, not from changing precision.
    dtype = torch.float16 if device == "cuda" else torch.float32
    profile = None
    sliced = True
    if device == "cuda":
        try:
            profile = gpu_runtime.verify_kernels()
        except RuntimeError as error:
            emit({"type": "error", "error": str(error)})
            return 1
        gpu_runtime.configure_backends(profile)
    with contextlib.redirect_stdout(sys.stderr):
        pipeline = StableDiffusionXLPipeline.from_pretrained(
            str(MODEL_ROOT), torch_dtype=dtype, variant="fp16", use_safetensors=True,
        ).to(device)
        edit_pipeline = StableDiffusionXLImg2ImgPipeline(**pipeline.components)
        pipeline.set_progress_bar_config(disable=True)
        edit_pipeline.set_progress_bar_config(disable=True)
        # Slicing kept peak VRAM low enough for the backdrop worker to coexist
        # with the realtime renderer. With the headroom genuinely free, one-pass
        # decoding is faster for the same pixels.
        sliced = not (device == "cuda" and gpu_runtime.has_headroom(UNSLICED_DECODE_GIB))
        if sliced:
            enable_vae_slicing(pipeline)
    emit({
        "type": "worker_ready",
        "model": "stabilityai/stable-diffusion-xl-base-1.0",
        "width": WIDTH,
        "height": HEIGHT,
        "device": device,
        "gpu": profile.name if profile else None,
        "computeCapability": profile.sm if profile else None,
        "vaeSlicing": sliced,
    })

    for line in sys.stdin:
        try:
            command = json.loads(line)
            command_type = command.get("type")
            if command_type not in ("backdrop", "edit"):
                raise ValueError("Unsupported SDXL worker command")
            prompt = inference_instruction(command)
            if not prompt:
                raise ValueError("prompt is required")
            output = Path(str(command["output"]))
            output.parent.mkdir(parents=True, exist_ok=True)
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            seed = int(command["seed"]) if command.get("seed") is not None else int(torch.seed() % 2147483648)
            generator = torch.Generator(device=device).manual_seed(seed)
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                original_source = None
                width, height = aligned_size(output_size(command, (WIDTH, HEIGHT)))
                common = {
                    "prompt": prompt,
                    "negative_prompt": str(command.get("negativePrompt", "" if command.get("intent") else NEGATIVE)),
                    "num_inference_steps": int(command.get("steps", STEPS)),
                    "guidance_scale": float(command.get("guidanceScale", 6.5)),
                    "generator": generator,
                }
                if command_type == "edit":
                    source = Path(str(command.get("input", "")))
                    if not source.is_file():
                        raise FileNotFoundError(f"source image does not exist: {source}")
                    original_source = Image.open(source).convert("RGB")
                    width, height = aligned_size(output_size(command, original_source.size))
                    initial = original_source.resize((width, height), Image.LANCZOS)
                    image = original_source.copy() if command.get("strength") == 0 else edit_pipeline(
                        **common, image=initial, strength=float(command.get("strength", 0.65)),
                    ).images[0]
                else:
                    image = pipeline(**common, width=width, height=height).images[0]
            image, precision = finalize_image(image, command, original_source)
            image.save(output, format="PNG")
            emit({
                "type": "complete",
                "output": str(output),
                "width": image.width,
                "height": image.height,
                "seed": seed,
                "peakVramMb": gpu_peak_mb(),
                **precision,
            })
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
