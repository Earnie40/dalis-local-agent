#!/usr/bin/env python3
"""Download the face-swap detector, swapper, and optional restorer.

The swapper (`inswapper_128.onnx`) and the InsightFace model packs are released
for non-commercial research use. Nothing here is fetched unless the operator has
acknowledged that with DACAIS_ACCEPT_FACE_SWAP_MODEL_LICENSE=1.
"""
from __future__ import annotations

import hashlib
import os
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("DACAIS_MEDIA_ROOT", "/workspace/dacais-media")).resolve()
MODEL_ROOT = Path(os.environ.get("DACAIS_FACE_SWAP_MODEL_ROOT", str(ROOT / "models" / "face-swap")))
DETECTOR_PACK = os.environ.get("DACAIS_FACE_SWAP_DETECTOR", "buffalo_l")
SWAPPER_REPO = os.environ.get("DACAIS_FACE_SWAP_SWAPPER_REPO", "ezioruan/inswapper_128.onnx")
SWAPPER_FILE = os.environ.get("DACAIS_FACE_SWAP_SWAPPER_FILE", "inswapper_128.onnx")
SWAPPER_REVISION = os.environ.get(
    "DACAIS_FACE_SWAP_SWAPPER_REVISION", "6ffdf0e83c5996cc425e77b59913fc48d79441be")
# The swapper comes from a community mirror, so the digest is the real pin: a
# mismatched download is deleted rather than installed. Set the variable empty
# to accept a different build deliberately.
SWAPPER_SHA256 = os.environ.get(
    "DACAIS_FACE_SWAP_SWAPPER_SHA256",
    "e4a3f08c753cb72d04e10aa0f7dbe3deebbf39567d4ead6dce08e98aa49e16af").strip().lower()
RESTORER_URL = os.environ.get(
    "DACAIS_FACE_SWAP_RESTORER_URL",
    "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth")
INSTALL_RESTORER = os.environ.get("DACAIS_FACE_SWAP_INSTALL_RESTORER", "1") == "1"


def digest(path: Path) -> str:
    hashed = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hashed.update(block)
    return hashed.hexdigest()


def main() -> int:
    if os.environ.get("DACAIS_ACCEPT_FACE_SWAP_MODEL_LICENSE") != "1":
        raise SystemExit(
            "The InsightFace detector and inswapper weights are licensed for non-commercial research use. "
            "Re-run with DACAIS_ACCEPT_FACE_SWAP_MODEL_LICENSE=1 once that fits this deployment.")

    from huggingface_hub import hf_hub_download
    from insightface.utils import storage

    MODEL_ROOT.mkdir(parents=True, exist_ok=True)

    # FaceAnalysis(root=MODEL_ROOT) resolves packs under MODEL_ROOT/models.
    storage.ensure_available("models", DETECTOR_PACK, root=str(MODEL_ROOT))
    print(f"Detector pack {DETECTOR_PACK} is available under {MODEL_ROOT / 'models'}")

    swapper = MODEL_ROOT / "inswapper_128.onnx"
    if not swapper.is_file():
        downloaded = Path(hf_hub_download(
            repo_id=SWAPPER_REPO, filename=SWAPPER_FILE, revision=SWAPPER_REVISION,
            local_dir=str(MODEL_ROOT)))
        if downloaded != swapper:
            downloaded.replace(swapper)
    checksum = digest(swapper)
    if SWAPPER_SHA256 and checksum != SWAPPER_SHA256:
        swapper.unlink()
        raise SystemExit(f"inswapper checksum {checksum} does not match the pinned {SWAPPER_SHA256}")
    print(f"Swapper {swapper} sha256={checksum}")

    if INSTALL_RESTORER:
        restorer = MODEL_ROOT / "GFPGANv1.4.pth"
        if not restorer.is_file():
            partial = restorer.with_suffix(".pth.downloading")
            with urllib.request.urlopen(RESTORER_URL, timeout=600) as response, partial.open("wb") as handle:
                while block := response.read(1024 * 1024):
                    handle.write(block)
            partial.replace(restorer)
        print(f"Restorer {restorer} sha256={digest(restorer)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
