"""
Ro-DeepVoice Gateway Server - Local Proxy with SSH Tunnel
==========================================================
Acest server rulează LOCAL și acționează ca un gateway/proxy
către serviciul de pe cluster prin tunel SSH.

Arhitectura:
    Chrome Extension → Gateway Local (:8000) → SSH Tunnel → Cluster Service (:8000)
"""

import os
import io
import json
import uuid
import base64
import time
import asyncio
import logging
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sshtunnel import SSHTunnelForwarder

from server.config import settings

# Configurare logging
logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Reduce paramiko logging (prea verbose pentru producție)
logging.getLogger("paramiko").setLevel(logging.WARNING)


# ============================================================================
# StyleTTS2 — referință vocală implicită
# ============================================================================
# La checkpoint-ul curent (epoch_2nd_00002), calea "fără reference_wav" trimite
# direct în sinteză ieșirea sampler-ului de difuziune, care încă nu a convers
# (conform notei din styletts2_service/main.py: funcționează abia de la
# epoch_2nd_00020+) — rezultă doar zgomot de înaltă frecvență. Calea de voice
# cloning amestecă acea ieșire cu un embedding de referință real (alpha/beta
# blend), ocolind problema. Atașăm deci o referință implicită ori de câte ori
# clientul nu trimite una, ca StyleTTS2 să producă voce reală indiferent de
# checkpoint.
_STYLETTS2_DEFAULT_REF_PATH = Path(__file__).resolve().parent.parent / "RSC" / "wav" / "002" / "002_00_0015.wav"
_styletts2_default_ref_b64: Optional[str] = None


def get_styletts2_default_reference() -> Optional[str]:
    global _styletts2_default_ref_b64
    if _styletts2_default_ref_b64 is None:
        try:
            with open(_STYLETTS2_DEFAULT_REF_PATH, "rb") as f:
                _styletts2_default_ref_b64 = base64.b64encode(f.read()).decode()
        except OSError as e:
            logger.warning(f"Nu pot încărca referința StyleTTS2 implicită: {e}")
            _styletts2_default_ref_b64 = ""
    return _styletts2_default_ref_b64 or None


# ============================================================================
# SSH TUNNEL MANAGER
# ============================================================================

class SSHTunnelManager:
    """
    Manager pentru tunelul SSH către cluster.
    Menține o conexiune persistentă și o recreează dacă cade.
    """
    
    def __init__(self):
        self.tunnel: Optional[SSHTunnelForwarder] = None
        self.local_port_vits1_biblie: int = settings.SSH_TUNNEL_LOCAL_PORT
        self.local_port_vits2_biblie: int = settings.SSH_TUNNEL_LOCAL_PORT + 1
        self.local_port_vits2_rss: int = settings.SSH_TUNNEL_LOCAL_PORT + 2
        self.local_port_vits1_mass: int = settings.SSH_TUNNEL_LOCAL_PORT + 3
        self.local_port_styletts2: int = settings.SSH_TUNNEL_LOCAL_PORT + 4
        self.local_port_llm: int = settings.SSH_TUNNEL_LOCAL_PORT + 5
        self._lock = asyncio.Lock()

        # ------------------------------------------------------------------
        # LOCAL_MODE (opt-in): microserviciile ruleaza LOCAL (ex. containere
        # Docker), nu pe cluster — nu se deschide niciun tunel SSH, iar
        # cererile merg direct la URL-urile de mai jos (suprascriibile prin
        # variabile de mediu, pentru docker-compose: URL_VITS1_BIBLIE=http://vits1-biblie:8011 etc.).
        # FARA variabila LOCAL_MODE setata, comportamentul ramane neschimbat.
        # ------------------------------------------------------------------
        self.local_mode: bool = os.getenv("LOCAL_MODE", "").lower() in ("1", "true", "yes")
        self.local_urls = {
            "vits1_biblie": os.getenv("URL_VITS1_BIBLIE", "http://127.0.0.1:8011"),
            "vits2_biblie": os.getenv("URL_VITS2_BIBLIE", "http://127.0.0.1:8012"),
            "vits2_rss":    os.getenv("URL_VITS2_RSS",    "http://127.0.0.1:8013"),
            "vits1_mass":   os.getenv("URL_VITS1_RSS",    "http://127.0.0.1:8014"),
            "styletts2":    os.getenv("URL_STYLETTS2",    "http://127.0.0.1:8015"),
            "llm":          os.getenv("URL_LLM",          "http://127.0.0.1:8016"),
        }
        if self.local_mode:
            logger.info("LOCAL_MODE activ: fara tunel SSH, servicii locale: %s", self.local_urls)
    
    def _create_tunnel(self) -> SSHTunnelForwarder:
        """Creează un nou tunel SSH"""
        logger.info(f"Creare tunel SSH către cluster")
        
        # Configurare autentificare
        ssh_kwargs = {
            "ssh_address_or_host": (settings.SSH_HOST, settings.SSH_PORT),
            "ssh_username": settings.SSH_USERNAME,
            "remote_bind_addresses": [("127.0.0.1", 8011), ("127.0.0.1", 8012), ("127.0.0.1", 8013), ("127.0.0.1", 8014), ("127.0.0.1", 8015), ("127.0.0.1", 8016)],
            "local_bind_addresses": [("127.0.0.1", self.local_port_vits1_biblie), ("127.0.0.1", self.local_port_vits2_biblie), ("127.0.0.1", self.local_port_vits2_rss), ("127.0.0.1", self.local_port_vits1_mass), ("127.0.0.1", self.local_port_styletts2), ("127.0.0.1", self.local_port_llm)],
            "set_keepalive": 30,
        }
        
        # Autentificare cu cheie sau parolă
        if settings.SSH_KEY_PATH and os.path.exists(os.path.expanduser(settings.SSH_KEY_PATH)):
            ssh_kwargs["ssh_pkey"] = os.path.expanduser(settings.SSH_KEY_PATH)
            logger.info(f"Folosesc cheie SSH: {settings.SSH_KEY_PATH}")
        elif settings.SSH_PASSWORD:
            ssh_kwargs["ssh_password"] = settings.SSH_PASSWORD
            logger.info("Folosesc autentificare cu parolă")
        else:
            raise ValueError("Nu există metodă de autentificare SSH configurată")
        
        return SSHTunnelForwarder(**ssh_kwargs)
    
    async def ensure_connected(self) -> bool:
        """Asigură că tunelul este activ, îl recreează dacă e necesar"""
        if self.local_mode:
            return True   # serviciile sunt locale, nu e nevoie de tunel
        async with self._lock:
            # Verifică dacă tunelul există și e activ
            if self.tunnel and self.tunnel.is_active:
                return True
            
            # Închide tunelul vechi dacă există
            if self.tunnel:
                try:
                    self.tunnel.stop()
                except:
                    pass
            
            # Creează tunel nou
            try:
                self.tunnel = self._create_tunnel()
                self.tunnel.start()
                
                # Actualizează porturile locale (pot fi diferite dacă erau ocupate)
                self.local_port_vits1_biblie = self.tunnel.local_bind_ports[0]
                self.local_port_vits2_biblie = self.tunnel.local_bind_ports[1]
                self.local_port_vits2_rss = self.tunnel.local_bind_ports[2]
                self.local_port_vits1_mass = self.tunnel.local_bind_ports[3]
                self.local_port_styletts2 = self.tunnel.local_bind_ports[4]
                self.local_port_llm = self.tunnel.local_bind_ports[5]

                logger.info(
                    f"Tunel SSH activ: vits1_biblie={self.local_port_vits1_biblie}, "
                    f"vits2_biblie={self.local_port_vits2_biblie}, "
                    f"vits2_rss={self.local_port_vits2_rss}, "
                    f"vits1_mass={self.local_port_vits1_mass}, "
                    f"styletts2={self.local_port_styletts2}, "
                    f"llm={self.local_port_llm}"
                )
                return True
                
            except Exception as e:
                logger.error(f"Eroare la crearea tunelului SSH: {e}")
                self.tunnel = None
                return False
    
    def get_cluster_url(self, model: str = "vits1_biblie", speaker: int = 0) -> str:
        """Returnează URL-ul pentru serviciul de pe cluster (prin tunel)"""
        if self.local_mode:
            if model in ("vits2_biblie", "vits2"):
                return self.local_urls["vits2_biblie"]
            elif model == "vits2_rss":
                return self.local_urls["vits2_rss"]
            elif model in ("vits1_mass", "vits1_rss"):
                return self.local_urls["vits1_mass"]
            elif model == "styletts2":
                return self.local_urls["styletts2"]
            else:
                return self.local_urls["vits1_biblie"]
        if model in ("vits2_biblie", "vits2"):
            return f"http://127.0.0.1:{self.local_port_vits2_biblie}"
        elif model == "vits2_rss":
            return f"http://127.0.0.1:{self.local_port_vits2_rss}"
        elif model in ("vits1_mass", "vits1_rss"):
            # vits1_rss = numele public (teză) al modelului VITS1 ajustat pe RSS;
            # serviciul de pe cluster îl expune sub numele intern vits1_mass (port 8014).
            return f"http://127.0.0.1:{self.local_port_vits1_mass}"
        elif model == "styletts2":
            return f"http://127.0.0.1:{self.local_port_styletts2}"
        else:
            # vits1_biblie, vits1, sau orice altceva
            return f"http://127.0.0.1:{self.local_port_vits1_biblie}"

    def get_llm_url(self) -> str:
        """Returnează URL-ul serviciului LLM (prin tunel)"""
        if self.local_mode:
            return self.local_urls["llm"]
        return f"http://127.0.0.1:{self.local_port_llm}"

    def is_connected(self) -> bool:
        """Verifică dacă tunelul e activ"""
        if self.local_mode:
            return True
        return self.tunnel is not None and self.tunnel.is_active
    
    def stop(self):
        """Oprește tunelul"""
        if self.tunnel:
            try:
                self.tunnel.stop()
                logger.info("Tunel SSH oprit")
            except Exception as e:
                logger.error(f"Eroare la oprirea tunelului: {e}")
            finally:
                self.tunnel = None


# Global tunnel manager
tunnel_manager = SSHTunnelManager()


# ============================================================================
# FASTAPI APPLICATION
# ============================================================================

async def tunnel_keepalive():
    """Reconectează automat tunelul SSH dacă cade"""
    while True:
        await asyncio.sleep(30)
        if not tunnel_manager.is_connected():
            logger.info("Tunel SSH inactiv, reîncerc conexiunea...")
            await tunnel_manager.ensure_connected()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager"""
    logger.info("Pornire Gateway Server...")

    # Încearcă să creeze tunelul la startup
    if await tunnel_manager.ensure_connected():
        logger.info("Tunel SSH stabilit cu succes")
    else:
        logger.warning("Nu s-a putut stabili tunelul SSH la startup — se va reîncerca automat")

    # Pornește keepalive în background
    keepalive_task = asyncio.create_task(tunnel_keepalive())

    yield

    # Cleanup
    keepalive_task.cancel()
    logger.info("Oprire Gateway Server...")
    tunnel_manager.stop()


app = FastAPI(
    title="Ro-DeepVoice Gateway",
    description="Gateway local pentru serviciul TTS de pe cluster GPU",
    version="1.0.0",
    lifespan=lifespan
)

# CORS pentru extensia Chrome
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# MODELE PYDANTIC
# ============================================================================

class TTSRequest(BaseModel):
    """Request pentru sinteză vocală"""
    text: str
    model: str = "vits1_biblie"
    streaming: bool = False
    speed: float = 1.05
    noise_scale: float = 0.667
    noise_scale_w: float = 0.4
    speaker: int = 0
    reference_audio_base64: Optional[str] = None

class TTSResponse(BaseModel):
    """Response pentru sinteză vocală"""
    success: bool
    audio_url: Optional[str] = None
    audio_base64: Optional[str] = None
    duration: Optional[float] = None
    error: Optional[str] = None


class ChatRequest(BaseModel):
    """Request pentru asistentul conversațional (LLM + voce)"""
    text: str
    tts_model: str = "vits2_rss"
    reference_audio_base64: Optional[str] = None
    reference_id: Optional[str] = None   # referință de clonare salvată (server-side)
    history: Optional[list] = None
    max_tokens: int = 400


# ============================================================================
# REFERINȚE DE CLONARE VOCALĂ (stocate permanent pe server)
# ============================================================================
REFERENCES_DIR = Path(__file__).resolve().parent / "references"
REFERENCES_DIR.mkdir(exist_ok=True)
REGISTRY_PATH = REFERENCES_DIR / "registry.json"


def _load_registry() -> list:
    if REGISTRY_PATH.exists():
        try:
            return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []


def _save_registry(items: list):
    REGISTRY_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def get_reference_audio_b64(ref_id: str) -> Optional[str]:
    p = REFERENCES_DIR / f"{ref_id}.wav"
    if p.exists():
        return base64.b64encode(p.read_bytes()).decode()
    return None


class ReferenceCreate(BaseModel):
    name: str
    audio_base64: str   # WAV base64


class STTRequest(BaseModel):
    """Request pentru transcriere vocală (Whisper)"""
    audio_base64: str


# Parametri optimi de inferență per model, determinați prin sweep UTMOS (n=8, 17 Iun 2026).
# Mapare: noise_scale, noise_scale_w, speed (=length_scale). Gateway-ul îi aplică automat,
# astfel încât extensia beneficiază de cele mai bune scoruri fără configurare din client.
OPTIMAL_VITS_PARAMS = {
    "vits1_mass":   {"noise_scale": 0.55,  "noise_scale_w": 0.8, "speed": 1.1},   # 3.77 -> 3.87
    "vits1_rss":    {"noise_scale": 0.55,  "noise_scale_w": 0.8, "speed": 1.1},   # alias public pentru vits1_mass
    "vits2_rss":    {"noise_scale": 0.55,  "noise_scale_w": 0.5, "speed": 1.1},   # 3.71 -> 3.78
    "vits1_biblie": {"noise_scale": 0.667, "noise_scale_w": 0.2, "speed": 0.75},  # ales manual: mai rapid + fluent
    "vits2_biblie": {"noise_scale": 0.4,   "noise_scale_w": 0.2, "speed": 0.85},  # ales manual: mai rapid + mai putin sacadat
}


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def forward_to_cluster(endpoint: str, json_data: dict, model: str = "vits1_biblie", speaker: int = 0, timeout: float = 60.0) -> httpx.Response:
    """
    Trimite o cerere către serviciul de pe cluster prin tunel SSH.
    """
    # Asigură conexiunea
    if not await tunnel_manager.ensure_connected():
        raise HTTPException(status_code=503, detail="Nu se poate conecta la cluster")
    
    cluster_url = f"{tunnel_manager.get_cluster_url(model, speaker)}{endpoint}"
    
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.post(cluster_url, json=json_data)
            return response
        except httpx.ConnectError:
            # Tunelul poate fi mort, încearcă să-l recreeze
            logger.warning("Conexiune pierdută, recreez tunelul...")
            tunnel_manager.tunnel = None
            if await tunnel_manager.ensure_connected():
                # Reîncearcă cererea
                response = await client.post(cluster_url, json=json_data)
                return response
            raise HTTPException(status_code=503, detail="Conexiunea la cluster a eșuat")


# ============================================================================
# ENDPOINTS
# ============================================================================

@app.get("/")
async def root():
    """Informații despre API"""
    return {
        "name": "Ro-DeepVoice Gateway",
        "version": "1.0.0",
        "description": "Gateway local pentru TTS pe cluster GPU",
        "endpoints": {
            "health": "GET /health",
            "tts": "POST /tts",
            "tts_stream": "POST /tts/stream",
            "audio": "GET /audio/{filename}"
        }
    }


@app.get("/health")
async def health_check():
    """
    Verifică starea gateway-ului și conexiunea la cluster.
    """
    tunnel_status = tunnel_manager.is_connected()
    cluster_status = None
    cluster_health = {}
    
    if tunnel_status:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{tunnel_manager.get_cluster_url()}/health")
                if response.status_code == 200:
                    cluster_health = response.json()
                    cluster_status = cluster_health.get("status", "unknown")
        except Exception as e:
            cluster_status = f"error: {e}"
    
    return {
        "status": "healthy" if tunnel_status and cluster_status == "healthy" else "degraded",
        "tunnel_active": tunnel_status,
        "tunnel_port": tunnel_manager.local_port_vits1_biblie if tunnel_status else None,
        "cluster_status": cluster_status,
        "cluster_details": cluster_health
    }


@app.post("/tts", response_model=TTSResponse)
async def text_to_speech(request: TTSRequest):
    """
    Endpoint principal pentru Text-to-Speech.
    Primește text și returnează audio (URL sau base64).
    """
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Textul nu poate fi gol")
    
    logger.info(f"TTS request: '{request.text[:50]}...'")
    
    try:
        # Măsurare timp total (include network + procesare GPU)
        total_start = time.time()

        # Determină speaker_id corect pe baza modelului
        # (ignoră ce trimite extensia — evită bug-uri de configurare)
        if request.model == "vits2_biblie":
            effective_speaker = 1  # Biblie = speaker_id 1 în modelul multi-speaker VITS2
        elif request.model in ("vits2_rss", "vits1_biblie", "vits1_mass", "vits1"):
            effective_speaker = 0
        else:
            effective_speaker = request.speaker  # Fallback pentru modele custom

        # StyleTTS2 are API diferit față de VITS (fără noise_scale/speaker, cu reference_wav)
        if request.model == "styletts2":
            payload = {
                "text": request.text,
                "speed": request.speed,
                "diffusion_steps": 10,
            }
            # Doar dacă utilizatorul trimite o referință folosim calea de clonare;
            # altfel serviciul folosește vocea implicită (default_ref_s) — calitate
            # mai bună la checkpoint-urile actuale (epoca > 20).
            if request.reference_audio_base64:
                payload["reference_wav"] = request.reference_audio_base64
            response = await forward_to_cluster(
                "/generate", payload, model="styletts2", timeout=120.0
            )
            total_elapsed = time.time() - total_start
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code,
                                    detail=response.json().get("detail", "Eroare StyleTTS2"))
            data = response.json()
            return TTSResponse(
                success=True,
                audio_base64=data.get("audio_base64"),
                duration=None
            )

        # Aplică parametrii optimi per-model (sweep UTMOS); fallback la ce trimite clientul
        opt = OPTIMAL_VITS_PARAMS.get(request.model)
        eff_speed = opt["speed"] if opt else request.speed
        eff_noise_scale = opt["noise_scale"] if opt else request.noise_scale
        eff_noise_scale_w = opt["noise_scale_w"] if opt else request.noise_scale_w
        logger.info(f"[PARAMS] {request.model}: speed={eff_speed} ns={eff_noise_scale} nsw={eff_noise_scale_w}")

        # Forward către cluster - endpoint care returnează base64 (modele VITS)
        response = await forward_to_cluster(
            "/generate",
            {
                "text": request.text,
                "format": "base64",
                "speed": eff_speed,
                "noise_scale": eff_noise_scale,
                "noise_scale_w": eff_noise_scale_w,
                "speaker": effective_speaker
            },
            model=request.model,
            speaker=effective_speaker
        )

        total_elapsed = time.time() - total_start

        if response.status_code != 200:
            error_detail = response.json().get("detail", "Eroare necunoscută")
            raise HTTPException(status_code=response.status_code, detail=error_detail)

        data = response.json()

        if not data.get("success"):
            raise HTTPException(status_code=500, detail=data.get("error", "Eroare la generare"))
        
        # Calculează metrici (estimare GPU ~30% din total, network ~70%)
        gpu_time = total_elapsed * 0.3
        network_overhead = total_elapsed * 0.7
        
        logger.info(f"[METRICS] Processing time (GPU): {gpu_time:.2f}s")
        logger.info(f"[METRICS] Network overhead (SSH): {network_overhead:.2f}s")
        logger.info(f"[METRICS] Total latency: {total_elapsed:.2f}s (Round-Trip Time)")
        
        return TTSResponse(
            success=True,
            audio_base64=data.get("audio_base64"),
            duration=data.get("duration")
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Eroare TTS: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================================
# ASISTENT CONVERSAȚIONAL (LLM românesc + voce)
# ============================================================================

def split_sentences(text: str):
    """Împarte textul în propoziții pentru sinteză incrementală (audio mai rapid)."""
    import re
    text = (text or "").strip()
    if not text:
        return []
    parts = re.split(r'(?<=[.!?…])\s+', text)
    out, buf = [], ""
    for p in parts:
        buf = (buf + " " + p).strip() if buf else p
        if len(buf) >= 12 or p.endswith(('.', '!', '?', '…')):
            out.append(buf); buf = ""
    if buf:
        out.append(buf)
    return [s for s in out if s.strip()]


XTTS_LOCAL_URL = "http://127.0.0.1:8020"   # XTTS-v2 rulează local pe laptop (CPU), nu pe cluster


async def synth_segment(text: str, model: str, reference_b64: Optional[str]) -> Optional[str]:
    """Sintetizează un segment de text cu modelul ales; întoarce audio base64."""
    effective_speaker = 1 if model == "vits2_biblie" else 0

    # XTTS-v2 (baseline zero-shot) — rulează LOCAL, necesită mereu o referință
    if model == "xtts_v2":
        if not reference_b64:
            return None
        async with httpx.AsyncClient(timeout=300.0) as client:
            try:
                r = await client.post(f"{XTTS_LOCAL_URL}/generate",
                    json={"text": text, "reference_wav": reference_b64, "language": "ro"})
                return r.json().get("audio_base64") if r.status_code == 200 else None
            except Exception as e:
                logger.warning(f"XTTS eșuat: {e}")
                return None

    if model == "styletts2":
        payload = {"text": text, "speed": 1.0, "diffusion_steps": 10}
        # referință doar dacă e furnizată explicit (clonare); altfel vocea implicită
        if reference_b64:
            payload["reference_wav"] = reference_b64
        resp = await forward_to_cluster("/generate", payload, model="styletts2", timeout=120.0)
        return resp.json().get("audio_base64") if resp.status_code == 200 else None

    opt = OPTIMAL_VITS_PARAMS.get(model, {})
    payload = {
        "text": text, "format": "base64",
        "speed": opt.get("speed", 1.05),
        "noise_scale": opt.get("noise_scale", 0.667),
        "noise_scale_w": opt.get("noise_scale_w", 0.4),
        "speaker": effective_speaker,
    }
    resp = await forward_to_cluster("/generate", payload, model=model, speaker=effective_speaker)
    return resp.json().get("audio_base64") if resp.status_code == 200 else None


@app.post("/chat")
async def chat(request: ChatRequest):
    """Asistent: prompt -> LLM românesc -> propoziții -> sinteză vocală (model ales)."""
    if not request.text.strip():
        raise HTTPException(400, "Mesaj gol")
    if not await tunnel_manager.ensure_connected():
        raise HTTPException(503, "Nu se poate conecta la cluster")

    llm_payload = {"prompt": request.text, "max_tokens": request.max_tokens}
    if request.history:
        llm_payload["history"] = request.history

    async with httpx.AsyncClient(timeout=180.0) as client:
        try:
            r = await client.post(f"{tunnel_manager.get_llm_url()}/generate", json=llm_payload)
        except httpx.ConnectError:
            tunnel_manager.tunnel = None
            await tunnel_manager.ensure_connected()
            r = await client.post(f"{tunnel_manager.get_llm_url()}/generate", json=llm_payload)
    if r.status_code != 200:
        raise HTTPException(502, f"Eroare LLM: {r.text[:200]}")
    reply = r.json().get("reply", "").strip()

    # rezolvă referința de clonare: id salvat (server) sau audio trimis direct
    ref_b64 = request.reference_audio_base64
    if request.reference_id:
        ref_b64 = get_reference_audio_b64(request.reference_id) or ref_b64

    segments = []
    for sent in split_sentences(reply):
        try:
            audio = await synth_segment(sent, request.tts_model, ref_b64)
        except Exception as e:
            logger.warning(f"Sinteză eșuată pentru segment: {e}")
            audio = None
        segments.append({"text": sent, "audio_base64": audio})

    logger.info(f"[CHAT] reply={len(reply)} chars, {len(segments)} segmente audio")
    return {"reply": reply, "segments": segments}


@app.post("/stt")
async def stt(request: STTRequest):
    """Transcriere vocală cu Whisper (rulează pe cluster, prin serviciul LLM)."""
    if not await tunnel_manager.ensure_connected():
        raise HTTPException(503, "Nu se poate conecta la cluster")
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(f"{tunnel_manager.get_llm_url()}/stt",
                              json={"audio_base64": request.audio_base64})
    if r.status_code != 200:
        raise HTTPException(502, f"Eroare STT: {r.text[:200]}")
    return r.json()


@app.get("/ui")
async def chat_ui():
    """Servește interfața web de chat (fără cache, să se ia mereu ultima versiune)."""
    html = Path(__file__).resolve().parent / "webchat" / "index.html"
    return FileResponse(str(html), headers={"Cache-Control": "no-store, must-revalidate"})


@app.get("/references")
async def list_references():
    """Listează referințele de clonare salvate (id + nume)."""
    return _load_registry()


@app.post("/references")
async def create_reference(req: ReferenceCreate):
    """Salvează o referință vocală nouă (WAV) permanent pe server."""
    name = req.name.strip() or "fără nume"
    try:
        data = base64.b64decode(req.audio_base64)
    except Exception:
        raise HTTPException(400, "audio_base64 invalid")
    if len(data) < 2000:
        raise HTTPException(400, "Audio prea scurt pentru o referință utilă")
    ref_id = uuid.uuid4().hex[:12]
    (REFERENCES_DIR / f"{ref_id}.wav").write_bytes(data)
    items = _load_registry()
    items.append({"id": ref_id, "name": name})
    _save_registry(items)
    logger.info(f"[REF] salvat '{name}' ({ref_id}, {len(data)} bytes)")
    return {"id": ref_id, "name": name}


@app.delete("/references/{ref_id}")
async def delete_reference(ref_id: str):
    """Șterge o referință salvată."""
    items = [x for x in _load_registry() if x.get("id") != ref_id]
    _save_registry(items)
    try:
        (REFERENCES_DIR / f"{ref_id}.wav").unlink()
    except OSError:
        pass
    return {"ok": True}


@app.post("/tts/stream")
async def text_to_speech_stream(request: TTSRequest):
    """
    Endpoint pentru TTS cu streaming.
    Returnează audio direct ca stream WAV.
    """
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Textul nu poate fi gol")
    
    logger.info(f"TTS stream request: '{request.text[:50]}...'")
    
    # Asigură conexiunea
    if not await tunnel_manager.ensure_connected():
        raise HTTPException(status_code=503, detail="Nu se poate conecta la cluster")
    
    async def stream_from_cluster():
        """Stream audio de la cluster"""
        cluster_base_url = tunnel_manager.get_cluster_url(request.model, request.speaker)
        cluster_url = f"{cluster_base_url}/generate_stream"
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            payload = {
                "text": request.text,
                "speed": request.speed,
                "noise_scale": request.noise_scale,
                "noise_scale_w": request.noise_scale_w,
                "speaker": request.speaker
            }
            async with client.stream("POST", cluster_url, json=payload) as response:
                if response.status_code != 200:
                    raise HTTPException(status_code=response.status_code, detail="Eroare cluster")
                
                async for chunk in response.aiter_bytes(chunk_size=8192):
                    yield chunk
    
    return StreamingResponse(
        stream_from_cluster(),
        media_type="audio/wav",
        headers={
            "Content-Disposition": "inline; filename=tts_output.wav",
            "Cache-Control": "no-cache"
        }
    )


@app.websocket("/ws/tts")
async def websocket_tts(websocket: WebSocket):
    """
    WebSocket endpoint pentru TTS interactiv.
    Permite cereri multiple pe aceeași conexiune.
    """
    await websocket.accept()
    logger.info("WebSocket conexiune acceptată")
    
    try:
        while True:
            # Primește cererea
            data = await websocket.receive_json()
            text = data.get("text", "")
            speed = data.get("speed", 1.05)
            noise_scale = data.get("noise_scale", 0.667)
            noise_scale_w = data.get("noise_scale_w", 0.4)
            speaker = data.get("speaker", 0)
            model = data.get("model", "vits1")
            reference_audio_base64 = data.get("reference_audio_base64", None)
            
            if not text.strip():
                await websocket.send_json({
                    "type": "error",
                    "message": "Textul nu poate fi gol"
                })
                continue
            
            await websocket.send_json({
                "type": "processing",
                "message": "Se procesează..."
            })
            
            try:
                # Forward către cluster
                response = await forward_to_cluster(
                    "/generate",
                    {
                        "text": text,
                        "speed": speed,
                        "noise_scale": noise_scale,
                        "noise_scale_w": noise_scale_w,
                        "speaker": speaker
                    },
                    model=model,
                    speaker=speaker
                )
                
                if response.status_code == 200:
                    data = response.json()
                    if data.get("success"):
                        await websocket.send_json({
                            "type": "audio",
                            "audio_base64": data.get("audio_base64"),
                            "duration": data.get("duration"),
                            "sample_rate": data.get("sample_rate", 22050)
                        })
                    else:
                        await websocket.send_json({
                            "type": "error",
                            "message": data.get("error", "Eroare necunoscută")
                        })
                else:
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Eroare cluster: {response.status_code}"
                    })
                    
            except Exception as e:
                await websocket.send_json({
                    "type": "error",
                    "message": str(e)
                })
            
            await websocket.send_json({"type": "complete"})
            
    except WebSocketDisconnect:
        logger.info("WebSocket deconectat")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")


@app.post("/reconnect")
async def reconnect_tunnel():
    """
    Forțează reconectarea tunelului SSH.
    Util când conexiunea se pierde.
    """
    # Oprește tunelul vechi
    tunnel_manager.stop()
    
    # Așteaptă puțin
    await asyncio.sleep(1)
    
    # Recreează tunelul
    success = await tunnel_manager.ensure_connected()
    
    return {
        "success": success,
        "tunnel_active": tunnel_manager.is_connected(),
        "local_port": tunnel_manager.local_port_vits1_biblie if success else None
    }


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    print("""
╔══════════════════════════════════════════════════════════════╗
║              Ro-DeepVoice Gateway Server                     ║
╠══════════════════════════════════════════════════════════════╣
║  Gateway local cu tunel SSH către cluster GPU.               ║
║  Endpoint: http://localhost:8000                             ║
╚══════════════════════════════════════════════════════════════╝
    """)
    
    uvicorn.run(
        "main:app",
        host=settings.SERVER_HOST,
        port=settings.SERVER_PORT,
        reload=settings.DEBUG
    )
