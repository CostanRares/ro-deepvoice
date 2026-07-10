# ============================================================================
# Ro-DeepVoice — gateway local (FastAPI) + interfața web a asistentului.
# Rulează în LOCAL_MODE: fără tunel SSH, vorbește direct cu microserviciile
# de inferență din rețeaua docker-compose (URL-urile vin din variabile de mediu).
# ============================================================================
FROM python:3.11-slim

WORKDIR /app

COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./server/

# Serviciile rulează local (containere), nu pe cluster
ENV LOCAL_MODE=1
EXPOSE 5000

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "5000"]
