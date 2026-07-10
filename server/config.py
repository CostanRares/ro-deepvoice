"""
Configuration settings for the TTS Server
==========================================
Configurare pentru Gateway-ul local și tunelul SSH către cluster.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Încarcă variabilele din server/.env (indiferent de directorul de lucru)
load_dotenv(Path(__file__).resolve().parent / ".env")


class Settings:
    """
    Setări pentru serverul gateway local.
    Valorile pot fi suprascrise prin variabile de mediu sau fișierul .env
    """
    
    # =========================================================================
    # SSH CONFIGURATION - Pentru conectarea la cluster
    # =========================================================================
    SSH_HOST: str = os.getenv("SSH_HOST", "10.13.0.105")
    SSH_PORT: int = int(os.getenv("SSH_PORT", "22"))
    SSH_USERNAME: str = os.getenv("SSH_USERNAME", "costan.rares")
    SSH_KEY_PATH: str = os.getenv("SSH_KEY_PATH", "")
    
    SSH_PASSWORD: str = os.getenv("SSH_PASSWORD", "")
    
    # =========================================================================
    # SSH TUNNEL CONFIGURATION - Pentru comunicarea cu cluster service
    # =========================================================================
    # Portul pe care rulează cluster_service pe mașina remote
    SSH_TUNNEL_REMOTE_PORT: int = int(os.getenv("SSH_TUNNEL_REMOTE_PORT", "8000"))
    
    # Portul local pe care va fi mapat tunelul (gateway-ul trimite cereri aici)
    SSH_TUNNEL_LOCAL_PORT: int = int(os.getenv("SSH_TUNNEL_LOCAL_PORT", "8001"))
    
    # Timeout pentru reconectare automată (secunde)
    SSH_TUNNEL_RECONNECT_TIMEOUT: int = int(os.getenv("SSH_TUNNEL_RECONNECT_TIMEOUT", "30"))
    
    # =========================================================================
    # LOCAL GATEWAY SERVER CONFIGURATION
    # =========================================================================
    SERVER_HOST: str = os.getenv("SERVER_HOST", "0.0.0.0")
    SERVER_PORT: int = int(os.getenv("SERVER_PORT", "8000"))
    DEBUG: bool = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")
    
    # =========================================================================
    # CLUSTER PATHS - Pentru referință (folosite de cluster_service)
    # =========================================================================
    CLUSTER_PROJECT_PATH: str = os.getenv(
        "CLUSTER_PROJECT_PATH", 
        "/home/costan.rares/ro-deepvoice"
    )
    CLUSTER_PYTHON_PATH: str = os.getenv(
        "CLUSTER_PYTHON_PATH",
        "/home/costan.rares/miniconda3/envs/ro_deepvoice/bin/python"
    )
    CLUSTER_MODEL_PATH: str = os.getenv(
        "CLUSTER_MODEL_PATH",
        "/home/costan.rares/ro-deepvoice/logs/voxpopuli_ro/G_680000.pth"
    )
    CLUSTER_CONFIG_PATH: str = os.getenv(
        "CLUSTER_CONFIG_PATH",
        "/home/costan.rares/ro-deepvoice/configs/voxpopuli_ro.json"
    )
    
    # =========================================================================
    # LOCAL PATHS
    # =========================================================================
    TEMP_AUDIO_DIR: Path = Path(os.getenv("TEMP_AUDIO_DIR", "temp_audio"))
    
    def __init__(self):
        """Inițializare și creare directoare necesare"""
        self.TEMP_AUDIO_DIR.mkdir(exist_ok=True)
    
    def __repr__(self):
        return f"""Settings(
    SSH: {self.SSH_USERNAME}@{self.SSH_HOST}:{self.SSH_PORT}
    Tunnel: localhost:{self.SSH_TUNNEL_LOCAL_PORT} → cluster:{self.SSH_TUNNEL_REMOTE_PORT}
    Gateway: {self.SERVER_HOST}:{self.SERVER_PORT}
    Debug: {self.DEBUG}
)"""


settings = Settings()
