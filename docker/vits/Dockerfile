# ============================================================================
# Ro-DeepVoice — imagine de inferență VITS (CPU), cu modelele incluse.
# O singură imagine servește oricare dintre cele 4 modele VITS; modelul concret
# se alege la pornire prin variabila de mediu MODEL_ID
# (vits1_biblie | vits2_biblie | vits2_rss | vits1_mass), iar portul prin PORT.
#
# Codul arhitecturilor și checkpoint-urile sunt incluse în imagine pe aceleași
# căi ca în mediul de dezvoltare, astfel încât microserviciul (main.py) rulează
# fără nicio modificare.
# ============================================================================
FROM python:3.9-slim

WORKDIR /app

# espeak-ng = fonetizarea (G2P) pentru modelele VITS2; build-essential = compilarea
# nucleului Cython al alinierii monotonice (monotonic_align)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    espeak-ng \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt cython

# Codul modelelor + configurațiile + checkpoint-urile, pe căile așteptate de main.py
COPY tree/ /

# Compilarea nucleului Cython al alinierii monotonice, pentru ambele arhitecturi.
# Convențiile de import diferă (VITS1: `from .core import ...`; VITS2:
# `from .monotonic_align.core import ...`), așa că fișierul compilat e pus în
# ambele locuri, iar importul e VALIDAT la build (eșuează build-ul, nu runtime-ul).
RUN set -e; \
    for d in /mnt/hdd1/costan.rares/Ro-DeepVoice_VITS1/Ro-DeepVoice/src \
             /home/costan.rares/Ro-DeepVoice_VITS2; do \
        cd "$d/monotonic_align"; \
        mkdir -p monotonic_align; \
        python setup.py build_ext --inplace; \
        find . -name "core*.so" -exec cp -f {} ./ \; ; \
        find . -maxdepth 1 -name "core*.so" -exec cp -f {} monotonic_align/ \; ; \
        cd "$d" && python -c "import monotonic_align; print('monotonic_align OK in', '$d')"; \
    done

# Microserviciul FastAPI
COPY main.py __init__.py ./

# Inferență strict pe CPU
ENV CUDA_VISIBLE_DEVICES=""
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
