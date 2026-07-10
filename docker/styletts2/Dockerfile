# ============================================================================
# Ro-DeepVoice — imagine de inferență StyleTTS2 (CPU), cu modelul inclus.
# Servește sinteza cu vocea implicită + clonarea vocală zero-shot (port 8015).
#
# Codul și checkpoint-ul sunt așezate pe aceleași căi ca în mediul de
# dezvoltare (/home/costan.rares/StyleTTS2), astfel încât microserviciul
# rulează fără nicio modificare. Serviciul își setează singur căile espeak
# către ~/local_espeak — în imagine, acele căi sunt symlink-uri către
# espeak-ng-ul de sistem instalat prin apt.
# ============================================================================
FROM python:3.9-slim

# espeak-ng = fonetizare (G2P); build-essential = compilarea nucleului Cython
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt cython

# Codul + greutățile auxiliare (ASR/JDC/PLBERT) + checkpoint-ul final
COPY tree/ /

# Căile ~/local_espeak pe care serviciul le setează la pornire → espeak de sistem
RUN mkdir -p /root/local_espeak/usr/lib/x86_64-linux-gnu /root/local_espeak/usr/bin \
    && ln -s /usr/lib/x86_64-linux-gnu/libespeak-ng.so.1 /root/local_espeak/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1 \
    && ln -s /usr/lib/x86_64-linux-gnu/espeak-ng-data   /root/local_espeak/usr/lib/x86_64-linux-gnu/espeak-ng-data \
    && ln -s /usr/bin/espeak-ng /root/local_espeak/usr/bin/espeak-ng

# Compilarea alinierii monotonice (import: `from monotonic_align.core import ...`)
RUN set -e; \
    cd /home/costan.rares/StyleTTS2/monotonic_align; \
    mkdir -p monotonic_align; \
    python setup.py build_ext --inplace; \
    find . -name "core*.so" -exec cp -f {} ./ \; ; \
    find . -maxdepth 1 -name "core*.so" -exec cp -f {} monotonic_align/ \; ; \
    cd /home/costan.rares/StyleTTS2 && python -c "import monotonic_align; print('monotonic_align OK')"

WORKDIR /home/costan.rares/StyleTTS2

ENV CUDA_VISIBLE_DEVICES=""
EXPOSE 8015

CMD ["sh", "-c", "uvicorn styletts2_service.main:app --host 0.0.0.0 --port ${PORT:-8015}"]
