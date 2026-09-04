#!/usr/bin/env bash
set -Eeuo pipefail

export OLLAMA_MODELS=/workspace/dacais-media/ollama-models
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_KEEP_ALIVE=5m
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_NUM_PARALLEL=1
export LD_LIBRARY_PATH=/workspace/ollama/lib/ollama:${LD_LIBRARY_PATH:-}

exec /workspace/ollama/bin/ollama serve
