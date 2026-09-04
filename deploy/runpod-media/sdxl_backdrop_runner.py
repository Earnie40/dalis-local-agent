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
    dtype = torch.float16 if device == "cuda" else torch.float32
    with contextlib.redirect_stdout(sys.stderr):
        pipeline = StableDiffusionXLPipeline.from_pretrained(
            str(MODEL_ROOT), torch_dtype=dtype, variant="fp16", use_safetensors=True,
        ).to(device)
        edit_pipeline = StableDiffusionXLImg2ImgPipeline(**pipeline.components)
        pipeline.set_progress_bar_config(disable=True)
        edit_pipeline.set_progress_bar_config(disable=True)
        enable_vae_slicing(pipeline)
    emit({
        "type": "worker_ready",
        "model": "stabilityai/stable-diffusion-xl-base-1.0",
        "width": WIDTH,
        "height": HEIGHT,
        "device": device,
    })

    for line in sys.stdin:
        try:
            command = json.loads(line)
            command_type = command.get("type")
            if command_type not in ("backdrop", "edit"):
                raise ValueError("Unsupported SDXL worker command")
            prompt = str(command.get("prompt", "")).strip()
            if not prompt:
                raise ValueError("prompt is required")
            output = Path(str(command["output"]))
            output.parent.mkdir(parents=True, exist_ok=True)
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            seed = int(command["seed"]) if command.get("seed") is not None else int(torch.seed() % 2147483648)
            generator = torch.Generator(device=device).manual_seed(seed)
            with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
                width = int(command.get("width", WIDTH))
                height = int(command.get("height", HEIGHT))
                common = {
                    "prompt": prompt,
                    "negative_prompt": str(command.get("negativePrompt") or NEGATIVE),
                    "num_inference_steps": int(command.get("steps", STEPS)),
                    "guidance_scale": float(command.get("guidanceScale", 6.5)),
                    "generator": generator,
                }
                if command_type == "edit":
                    source = Path(str(command.get("input", "")))
                    if not source.is_file():
                        raise FileNotFoundError(f"source image does not exist: {source}")
                    initial = Image.open(source).convert("RGB").resize((width, height), Image.LANCZOS)
                    image = edit_pipeline(
                        **common, image=initial, strength=float(command.get("strength", 0.65)),
                    ).images[0]
                else:
                    image = pipeline(**common, width=width, height=height).images[0]
            image.save(output, format="PNG")
            emit({
                "type": "complete",
                "output": str(output),
                "width": image.width,
                "height": image.height,
                "seed": seed,
                "peakVramMb": gpu_peak_mb(),
            })
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "error": str(error)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
