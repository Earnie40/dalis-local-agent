#!/usr/bin/env bash
# Provision the isolated InsightFace face-swap lane on persistent storage.
#
# The swap runner is deliberately kept out of the diffusers venvs: it needs
# onnxruntime-gpu and opencv, and it must be startable while the large image and
# video pipelines are unloaded.
set -euo pipefail

ROOT="${DACAIS_MEDIA_ROOT:-/workspace/dacais-media}"
SERVICE_DIR="${DACAIS_SERVICE_DIR:-$ROOT/service}"
VENV="$ROOT/venvs/face-swap"
PYTHON="$VENV/bin/python"

if [ "${DACAIS_ACCEPT_FACE_SWAP_MODEL_LICENSE:-0}" != "1" ]; then
  echo "The InsightFace detector and inswapper weights are licensed for non-commercial research use. Re-run with DACAIS_ACCEPT_FACE_SWAP_MODEL_LICENSE=1 once that fits this deployment." >&2
  exit 2
fi

mkdir -p "$ROOT"/{models,venvs,cache,logs,jobs,service}

if [ ! -x "$PYTHON" ]; then
  # The optional restorer needs torch. Inheriting the pod's build keeps a ~2.5 GiB
  # duplicate off the volume and keeps the CUDA architecture already proven here.
  python3 -m venv --system-site-packages "$VENV"
fi
"$PYTHON" -m pip install --upgrade pip wheel 'setuptools>=70,<81'
"$PYTHON" -m pip install Cython==3.0.11
# onnxruntime-gpu must ship cubins for the card's architecture: 1.23.0 loads on
# this pod's Blackwell (sm_120) part and then dies on the first node with
# cudaErrorNoKernelImageForDevice. 1.29.0 has the kernels, but it is a CUDA 13
# build and the pod only carries CUDA 12.8, so the [cuda,cudnn] extras are what
# bring the matching runtime along; without them the provider fails to register
# and every frame quietly renders on the CPU instead.
ONNXRUNTIME="${DACAIS_FACE_SWAP_ONNXRUNTIME:-1.29.0}"
# insightface builds its extensions under pip's isolated build environment, so
# numpy is left to the resolver here rather than pinned and then overridden by
# insightface's own dependency set. Verified set on this pod: insightface 0.7.3,
# onnxruntime-gpu 1.29.0 on CUDA 13 wheels, numpy 2.5.3.
"$PYTHON" -m pip install \
  insightface==0.7.3 onnx==1.17.0 "onnxruntime-gpu[cuda,cudnn]==$ONNXRUNTIME" \
  opencv-python-headless==4.11.0.86 Pillow==11.1.0 huggingface-hub==0.30.2

if [ "${DACAIS_FACE_SWAP_INSTALL_RESTORER:-1}" = "1" ]; then
  # GFPGAN sharpens the swapped region. It is optional: the runner reports
  # restoredFaces=false and still returns a swapped video without it.
  "$PYTHON" -m pip install gfpgan==1.3.8 basicsr==1.4.2 facexlib==0.3.0 realesrgan==0.3.0
fi

HF_HOME="$ROOT/cache/huggingface" "$PYTHON" "$SERVICE_DIR/download_face_swap_models.py"

"$PYTHON" - <<'PY'
import os
from pathlib import Path

import numpy as np

try:
    import torch  # noqa: F401 - see the runner: keeps cuDNN/cuBLAS resident
except ImportError:
    pass

import onnxruntime

# Same bootstrap the runner performs: load the CUDA runtime from onnxruntime's
# nvidia wheels rather than relying on an LD_LIBRARY_PATH the service will not
# have. Verifying under different conditions than production would prove nothing.
preload = getattr(onnxruntime, "preload_dlls", None)
if callable(preload):
    preload()

from insightface.app import FaceAnalysis
from insightface.model_zoo import get_model

root = Path(os.environ.get("DACAIS_FACE_SWAP_MODEL_ROOT",
                           os.environ.get("DACAIS_MEDIA_ROOT", "/workspace/dacais-media") + "/models/face-swap"))
providers = [name for name in ("CUDAExecutionProvider", "CPUExecutionProvider")
             if name in onnxruntime.get_available_providers()]
assert "CUDAExecutionProvider" in providers, (
    f"onnxruntime has no CUDA provider on this pod; available: {onnxruntime.get_available_providers()}")
analyzer = FaceAnalysis(name=os.environ.get("DACAIS_FACE_SWAP_DETECTOR", "buffalo_l"),
                        root=str(root), providers=providers)
analyzer.prepare(ctx_id=0, det_size=(640, 640))
swapper = get_model(str(root / "inswapper_128.onnx"), providers=providers)

# Building a session succeeds even on a wheel with no cubin for this card's
# architecture: the failure surfaces only when a node runs, as
# cudaErrorNoKernelImageForDevice. Launch one kernel here rather than shipping a
# lane that loads cleanly and then fails on the first frame of every job.
analyzer.get(np.random.randint(0, 255, (640, 640, 3), dtype=np.uint8))
active = swapper.session.get_providers()[0]
assert active == "CUDAExecutionProvider", f"the swapper bound to {active} instead of CUDA"
print(f"Face swap lane ready on {active} (onnxruntime {onnxruntime.__version__}) with weights under {root}")
PY

echo "Set DACAIS_FACE_SWAP_PYTHON=$PYTHON when starting media_service.py"
