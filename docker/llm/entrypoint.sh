#!/bin/sh
# Ro-DeepVoice — pornirea serviciului LLM.
# Descarca modelul GGUF la PRIMA pornire (in volumul /models), apoi porneste serviciul.
set -e

MODEL_PATH="${LLM_MODEL_PATH:-/models/RoLlama3-8b-Instruct.Q4_K_M.gguf}"
MODEL_URL="${LLM_MODEL_URL:-https://huggingface.co/legraphista/RoLlama3-8b-Instruct-IMat-GGUF/resolve/main/RoLlama3-8b-Instruct.Q4_K.gguf}"

if [ ! -f "$MODEL_PATH" ]; then
    echo "[llm] Modelul nu exista local. Descarc (~4,9 GB, o singura data)..."
    echo "[llm]   $MODEL_URL"
    mkdir -p "$(dirname "$MODEL_PATH")"
    curl -L --fail --retry 3 -o "$MODEL_PATH.part" "$MODEL_URL"
    mv "$MODEL_PATH.part" "$MODEL_PATH"
    echo "[llm] Model descarcat: $(du -h "$MODEL_PATH" | cut -f1)"
else
    echo "[llm] Model gasit: $MODEL_PATH"
fi

export LLM_MODEL_PATH="$MODEL_PATH"
exec uvicorn llm_service:app --host 0.0.0.0 --port "${PORT:-8016}"
