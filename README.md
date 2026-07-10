# Ro-DeepVoice

**Sistem complet de sinteză vocală (text-to-speech) în limba română**, construit cu
arhitecturi neuronale end-to-end (VITS, VITS2, StyleTTS2), cu clonare vocală zero-shot
și asistent conversațional. Dezvoltat ca proiect de diplomă la Academia Tehnică
Militară „Ferdinand I", Facultatea de Sisteme Informatice și Securitate Cibernetică.

- **4 voci VITS** antrenate pentru română (două feminine — corpus RSS, două masculine —
  corpus biblic propriu), calitate apropiată de sistemele comerciale (UTMOS 3,88 vs.
  ElevenLabs 3,97, măsurate cu protocol identic)
- **StyleTTS2** cu **clonare vocală zero-shot** dintr-un eșantion de câteva secunde
- **Extensie de browser** (Chrome/Edge) care citește cu voce orice text selectat
- **Asistent conversațional vocal** (opțional): vorbești → Whisper → RoLlama3 → răspuns vocal
- Totul rulează **local, pe CPU**, în containere Docker — fără GPU, fără servicii externe

---

## Rulare rapidă (download & run)

Cerințe: [Docker](https://docs.docker.com/get-docker/) (Desktop pe Windows/macOS,
Engine pe Linux). Fără GPU. ~8 GB spațiu pe disc pentru imagini.

```bash
git clone https://github.com/CostanRares/ro-deepvoice.git
cd ro-deepvoice
docker compose up -d
```

La prima rulare se descarcă imaginile de pe GitHub Container Registry (~4 GB).
Când totul e pornit:

- **Interfața web:** http://localhost:5000/ui
- **API-ul de sinteză:** `POST http://localhost:5000/tts` cu
  `{"text": "Salut!", "model": "vits1_rss"}`

Cu tot cu **asistentul conversațional** (LLM RoLlama3-8b — mai greu; modelul de
~4,9 GB se descarcă automat la prima pornire; pe CPU răspunsurile sunt lente):

```bash
docker compose --profile asistent up -d
```

### Extensia de browser

1. `chrome://extensions` → activează **Developer mode**
2. **Load unpacked** → alege folderul `plugin/` din acest repo
3. Selectează text pe orice pagină → butonul 🔊 sau click-dreapta →
   „Citește cu Ro-DeepVoice"

Extensia vorbește cu gateway-ul local pe `http://127.0.0.1:5000` (preconfigurat).

---

## Modelele incluse

| Model | Voce | Antrenare | UTMOS |
|---|---|---|---|
| `vits1_rss` | feminină | VITS pre-antrenat pe VoxPopuli-ro, ajustat pe RSS | **3,88** |
| `vits2_rss` | feminină | VITS2 pre-antrenat pe RSC, ajustat pe RSS | 3,87 |
| `vits1_biblie` | masculină | VITS ajustat pe corpus biblic propriu | 3,27 |
| `vits2_biblie` | masculină | VITS2 ajustat pe corpus biblic propriu | 3,14 |
| `styletts2` | implicită + **clonare** | StyleTTS2 antrenat pe RSC (multi-vorbitor) | 2,93 |

Evaluarea completă (UTMOS, CER, MCD, studiu MOS cu 45 de ascultători, latență/RTF)
este documentată în lucrarea de diplomă asociată proiectului.

## API (gateway, port 5000)

| Metodă | Endpoint | Rol |
|---|---|---|
| `GET` | `/health` | starea gateway-ului și a serviciilor |
| `POST` | `/tts` | sinteză: `{"text", "model", "speed"?, "speaker"?, "reference_audio_base64"?}` |
| `POST` | `/tts/stream` | sinteză cu răspuns în flux |
| `POST` | `/chat` | asistentul: text → răspuns LLM + segmente audio (necesită profilul `asistent`) |
| `POST` | `/stt` | transcriere vocală Whisper (necesită profilul `asistent`) |
| `GET` | `/ui` | interfața web |
| `GET/POST/DELETE` | `/references` | gestiunea referințelor de clonare |

Pentru clonare vocală: `POST /tts` cu `"model": "styletts2"` și
`"reference_audio_base64"` = un WAV scurt (2–20 s) cu vocea de clonat.

---

## Arhitectură

```
Extensie browser ──┐
                   ├──► Gateway FastAPI (:5000) ──► vits1-rss    (:8014)
Interfața web  ────┘         LOCAL_MODE            vits2-rss    (:8013)
                                                   vits1-biblie (:8011)
                                                   vits2-biblie (:8012)
                                                   styletts2    (:8015)
                                                   llm (opțional, :8016)
```

Fiecare model rulează în propriul container (microserviciu FastAPI); gateway-ul
rutează cererile și aplică parametrii optimi de inferență per model. Același cod
rulează și în varianta „client subțire → cluster GPU prin tunel SSH" (modul implicit,
fără `LOCAL_MODE`), folosită în dezvoltarea proiectului.

## Structura repo-ului

```
docker-compose.yml   rularea locală completă (imagini de pe ghcr.io)
plugin/              extensia de browser (Manifest V3)
server/              gateway-ul FastAPI + interfața web (codul din imaginea gateway)
docker/              Dockerfile-urile celor 4 imagini (rețeta de build)
```

Imaginile conțin codul arhitecturilor și greutățile modelelor antrenate în cadrul
proiectului. Corpusurile de antrenare NU sunt distribuite (RSS/RSC aparțin
autorilor lor; corpusul biblic derivă din înregistrări Faith Comes By Hearing,
nedistribuibile); sursele și pipeline-ul de construire sunt documentate în lucrare.

## Note

- Prima sinteză după pornire poate dura câteva secunde în plus (încărcarea modelului).
- StyleTTS2 pe CPU: sinteza durează ~1–3 s per propoziție (RTF ≈ 0,33).
- Asistentul LLM pe CPU este utilizabil, dar lent (model 8B cuantizat la 4 biți);
  pentru viteză reală se recomandă rularea serviciului LLM pe un GPU.
