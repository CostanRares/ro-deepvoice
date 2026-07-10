# ============================================================================
# Ro-DeepVoice — serviciul LLM (RoLlama3-8b-Instruct, GGUF) + STT (Whisper).
# Optional (profilul „asistent" din docker-compose): pe CPU, generarea e lenta;
# pentru viteza reala e nevoie de GPU (imaginea ruleaza implicit pe CPU).
# Modelul GGUF (~4,9 GB) NU e inclus in imagine — se descarca automat la prima
# pornire, intr-un volum persistent (/models).
# ============================================================================
FROM python:3.11-slim

WORKDIR /app

# curl = descarcarea modelului; build-essential+cmake = llama-cpp-python (daca nu
# exista wheel precompilat pentru platforma)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential cmake git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu \
    llama-cpp-python \
    fastapi "uvicorn[standard]" pydantic faster-whisper

COPY llm_service.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

# implicit: CPU (fara straturi pe GPU); Whisper STT ruleaza si el pe CPU
ENV LLM_N_GPU_LAYERS=0
ENV LLM_MODEL_PATH=/models/RoLlama3-8b-Instruct.Q4_K_M.gguf

EXPOSE 8016
VOLUME /models

CMD ["./entrypoint.sh"]
