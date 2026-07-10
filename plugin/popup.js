// Ro-DeepVoice Plugin - Studio JavaScript

class RoDeepVoiceStudio {
    constructor() {
        this.serverUrl = 'http://127.0.0.1:5000';
        this.audioQueue = [];
        this.isPlaying = false;
        this.isConnected = false;
        this.currentChunkIndex = 0;
        this.isAborted = false;
        this.totalChunks = 0;
        
        // Studio Parameters
        this.model = 'vits1_biblie';
        this.speed = 1.0;            // viteza de REDARE a audio-ului (client-side playbackRate)
        this.speaker = 0;
        this.savedVoices = {};
        this.referenceAudio = '';
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.recordingTimerInterval = null;
        
        this.elements = {};
        this.init();
    }

    async init() {
        this.cacheElements();
        await this.loadSettings();
        this.attachEventListeners();
        this.checkConnection();
        await this.autoExtractSelection();
    }

    async autoExtractSelection() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            let text = '';

            // 1) Încearcă selecția live din pagină (merge pe pagini web normale).
            if (tab) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => window.getSelection().toString().trim()
                    });
                    if (results && results[0] && results[0].result) {
                        text = results[0].result;
                    }
                } catch (e) {
                    // executeScript poate eșua pe vizualizatorul PDF intern (izolat).
                }
            }

            // 2) Rezervă pentru PDF-uri/documente: folosește ultima selecție capturată
            //    prin meniul de click-dreapta (salvată de background.js). Așa, pentru un
            //    PDF: selectezi text -> click dreapta -> Deschide Ro-DeepVoice -> textul apare.
            if (!text) {
                const st = await chrome.storage.local.get(['lastSelection', 'lastSelectionTime']);
                if (st.lastSelection && st.lastSelectionTime &&
                    (Date.now() - st.lastSelectionTime < 120000)) {
                    text = st.lastSelection;
                }
            }

            if (text) {
                this.elements.textInput.value = text;
                this.updateCharCount();
            }
        } catch (error) {
            console.error('Auto-extract error:', error);
        }
    }

    updateCharCount() {
        this.elements.charCount.textContent = `${this.elements.textInput.value.length}`;
    }

    cacheElements() {
        this.elements = {
            serverUrl: document.getElementById('server-url'),
            connectBtn: document.getElementById('connect-btn'),
            statusContainer: document.getElementById('connection-status'),
            statusText: document.querySelector('#connection-status .status-text'),
            textInput: document.getElementById('text-input'),
            charCount: document.getElementById('char-counter'),
            
            // Studio Parameters
            modelSelect: document.getElementById('model-select'),
            styletts2Note: document.getElementById('styletts2-note'),
            speakerGroup: document.getElementById('speaker-group'),
            voiceCloningGroup: document.getElementById('voice-cloning-group'),
            voiceCloneSelect: document.getElementById('voice-clone-select'),
            deleteVoiceBtn: document.getElementById('delete-voice-btn'),
            recordVoiceBtn: document.getElementById('record-voice-btn'),
            recordStatus: document.getElementById('record-status'),
            recordTimer: document.getElementById('record-timer'),
            
            speedSlider: document.getElementById('speed-slider'),
            speedVal: document.getElementById('speed-val'),
            speakerSelect: document.getElementById('speaker-select'),
            
            // Actions
            playBtn: document.getElementById('play-btn'),
            downloadBtn: document.getElementById('download-btn'),
            stopBtn: document.getElementById('stop-btn'),
            
            // Audio/Progress
            progressSection: document.getElementById('progress-section'),
            progressFill: document.getElementById('progress-fill'),
            progressText: document.getElementById('progress-text'),
            audioPlayer: document.getElementById('audio-player')
        };
    }

    loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['serverUrl', 'model', 'speed', 'speaker', 'savedVoices'], (result) => {
                if (result.serverUrl) {
                    this.serverUrl = result.serverUrl;
                    this.elements.serverUrl.value = result.serverUrl;
                }
                if (result.model) {
                    this.model = result.model;
                    this.elements.modelSelect.value = result.model;
                }
                if (result.speed) {
                    this.speed = result.speed;
                    this.elements.speedSlider.value = result.speed;
                    this.elements.speedVal.textContent = parseFloat(result.speed).toFixed(1);
                }
                if (result.speaker !== undefined) {
                    this.speaker = result.speaker;
                    this.elements.speakerSelect.value = result.speaker;
                }
                if (result.savedVoices) {
                    this.savedVoices = result.savedVoices;
                    this.populateSavedVoices();
                }
                this.updateUIVisibility();
                resolve();
            });
        });
    }

    populateSavedVoices() {
        while (this.elements.voiceCloneSelect.options.length > 1) {
            this.elements.voiceCloneSelect.remove(1);
        }
        for (const [name, b64] of Object.entries(this.savedVoices)) {
            const opt = document.createElement('option');
            opt.value = b64;
            opt.textContent = name;
            this.elements.voiceCloneSelect.appendChild(opt);
        }
        this.updateDeleteVoiceBtnState();
    }

    updateDeleteVoiceBtnState() {
        this.elements.deleteVoiceBtn.disabled = !this.elements.voiceCloneSelect.value;
    }

    deleteSelectedVoice() {
        const selectedB64 = this.elements.voiceCloneSelect.value;
        if (!selectedB64) return;

        const selectedName = this.elements.voiceCloneSelect.options[this.elements.voiceCloneSelect.selectedIndex].textContent;
        if (!confirm(`Ștergi vocea salvată "${selectedName}"?`)) return;

        for (const [name, b64] of Object.entries(this.savedVoices)) {
            if (b64 === selectedB64) {
                delete this.savedVoices[name];
            }
        }
        this.saveSettings();
        this.populateSavedVoices();
        this.elements.voiceCloneSelect.value = '';
        this.referenceAudio = '';
        this.updateDeleteVoiceBtnState();
    }

    updateUIVisibility() {
        if (this.model === 'styletts2') {
            this.elements.speakerGroup.classList.add('hidden');
            this.elements.voiceCloningGroup.classList.remove('hidden');
            this.elements.styletts2Note.classList.remove('hidden');
        } else {
            // Model name acum encodează vocea — speakerGroup ascuns
            this.elements.speakerGroup.classList.add('hidden');
            this.elements.voiceCloningGroup.classList.add('hidden');
            this.elements.styletts2Note.classList.add('hidden');
        }
    }

    saveSettings() {
        const settings = {
            serverUrl: this.elements.serverUrl.value,
            model: this.elements.modelSelect.value,
            speed: parseFloat(this.elements.speedSlider.value),
            speaker: parseInt(this.elements.speakerSelect.value),
            savedVoices: this.savedVoices
        };

        this.serverUrl = settings.serverUrl;
        this.model = settings.model;
        this.speed = settings.speed;
        this.speaker = settings.speaker;
        
        chrome.storage.local.set(settings);
        
        // Notify background script (if it needs to know serverUrl)
        chrome.runtime.sendMessage({ action: 'saveSettings', settings: settings });
    }

    attachEventListeners() {
        // Connect
        this.elements.connectBtn.addEventListener('click', () => {
            this.saveSettings();
            this.checkConnection();
        });

        // Server URL input
        this.elements.serverUrl.addEventListener('change', () => this.saveSettings());

        // Viteza de REDARE (client-side): aplicată direct pe player, are efect imediat
        this.elements.speedSlider.addEventListener('input', (e) => {
            this.speed = parseFloat(e.target.value);
            this.elements.speedVal.textContent = this.speed.toFixed(1);
            this.elements.audioPlayer.playbackRate = this.speed;  // efect imediat, chiar în timpul redării
            this.saveSettings();
        });

        this.elements.modelSelect.addEventListener('change', () => {
            this.saveSettings();
            this.updateUIVisibility();
        });
        this.elements.speakerSelect.addEventListener('change', () => this.saveSettings());
        this.elements.voiceCloneSelect.addEventListener('change', (e) => {
            this.referenceAudio = e.target.value;
            this.updateDeleteVoiceBtnState();
        });
        this.elements.deleteVoiceBtn.addEventListener('click', () => this.deleteSelectedVoice());
        this.elements.recordVoiceBtn.addEventListener('click', () => this.toggleRecording());

        // Actions
        this.elements.playBtn.addEventListener('click', () => this.synthesize(false));
        this.elements.downloadBtn.addEventListener('click', () => this.downloadAudio());
        this.elements.stopBtn.addEventListener('click', () => this.stop());

        // Text input update char count
        this.elements.textInput.addEventListener('input', () => this.updateCharCount());

        // Audio player events
        this.elements.audioPlayer.addEventListener('ended', () => this.playNextInQueue());
    }


    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Browserul alege implicit un format comprimat (de regulă audio/webm;codecs=opus) —
            // serverul acceptă doar WAV, deci convertim înainte de a salva/trimite (vezi blobToWavBase64).
            this.mediaRecorder = new MediaRecorder(stream);
            this.audioChunks = [];

            this.mediaRecorder.addEventListener("dataavailable", event => {
                this.audioChunks.push(event.data);
            });

            this.mediaRecorder.addEventListener("stop", async () => {
                this.elements.recordStatus.textContent = "Se procesează...";
                try {
                    const recordedBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
                    const base64data = await this.blobToWavBase64(recordedBlob);
                    const name = prompt("Cum doriți să denumiți această voce copiată?");
                    if (name && name.trim().length > 0) {
                        this.savedVoices[name] = base64data;
                        this.saveSettings();
                        this.populateSavedVoices();
                        this.elements.voiceCloneSelect.value = base64data;
                        this.referenceAudio = base64data;
                        this.updateDeleteVoiceBtnState();
                    }
                } catch (e) {
                    console.error("Recording conversion error:", e);
                    alert("Eroare la procesarea înregistrării: " + e.message);
                } finally {
                    this.elements.recordStatus.textContent = "";
                    // Stop all tracks to release mic
                    stream.getTracks().forEach(track => track.stop());
                }
            });

            this.mediaRecorder.start();
            this.isRecording = true;
            this.elements.recordVoiceBtn.classList.add('recording');
            this.elements.recordStatus.textContent = "Se înregistrează...";
            this.startRecordingTimer();
        } catch (e) {
            console.error("Mic error:", e);
            alert("Nu am putut accesa microfonul. Verificați permisiunile.");
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            this.mediaRecorder.stop();
        }
        this.isRecording = false;
        this.elements.recordVoiceBtn.classList.remove('recording');
        this.elements.recordStatus.textContent = "";
        this.stopRecordingTimer();
    }

    startRecordingTimer() {
        this.recordingStartTime = Date.now();
        this.elements.recordTimer.classList.remove('hidden');
        this.elements.recordTimer.textContent = "00:00";
        this.recordingTimerInterval = setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - this.recordingStartTime) / 1000);
            const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
            const ss = String(elapsedSec % 60).padStart(2, '0');
            this.elements.recordTimer.textContent = `${mm}:${ss}`;
        }, 250);
    }

    stopRecordingTimer() {
        if (this.recordingTimerInterval) {
            clearInterval(this.recordingTimerInterval);
            this.recordingTimerInterval = null;
        }
        this.elements.recordTimer.classList.add('hidden');
        this.elements.recordTimer.textContent = "00:00";
    }

    /**
     * Decodează blob-ul înregistrat (de regulă WebM/Opus) prin Web Audio API
     * și îl reîncodează ca WAV PCM mono 16-bit — singurul format acceptat
     * de serviciul StyleTTS2 (torchaudio/libsndfile respinge WebM cu
     * "Format not recognised").
     */
    async blobToWavBase64(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioContextClass();
        let audioBuffer;
        try {
            audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        } finally {
            audioCtx.close();
        }

        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;

        // Mixaj mono (serverul face oricum wav.mean(dim=0) la încărcare)
        const mono = new Float32Array(length);
        for (let ch = 0; ch < numChannels; ch++) {
            const data = audioBuffer.getChannelData(ch);
            for (let i = 0; i < length; i++) mono[i] += data[i] / numChannels;
        }

        const bytesPerSample = 2; // 16-bit PCM
        const dataSize = length * bytesPerSample;
        const wavBuffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(wavBuffer);

        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);          // chunk size (PCM)
        view.setUint16(20, 1, true);           // format = PCM
        view.setUint16(22, 1, true);           // canale = 1 (mono)
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
        view.setUint16(32, bytesPerSample, true);              // block align
        view.setUint16(34, 16, true);          // bits per sample
        writeString(36, 'data');
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let i = 0; i < length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, mono[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }

        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(wavBlob);
        });
    }

    async checkConnection() {
        this.setStatus('connecting', 'Se conectează...');
        try {
            const response = await fetch(`${this.serverUrl}/health`);
            if (response.ok) {
                this.isConnected = true;
                this.setStatus('connected', `Conectat - Model Gata`);
                this.elements.playBtn.disabled = false;
                this.elements.downloadBtn.disabled = false;
            } else {
                throw new Error('Response not OK');
            }
        } catch (error) {
            this.isConnected = false;
            this.setStatus('disconnected', 'Deconectat');
            this.elements.playBtn.disabled = true;
            this.elements.downloadBtn.disabled = true;
        }
    }

    setStatus(state, text) {
        this.elements.statusContainer.className = `status ${state}`;
        this.elements.statusText.textContent = text;
    }

    // --- STREAMING PLAYBACK LOGIC ---

    async synthesize() {
        const text = this.elements.textInput.value.trim();
        if (!text) { alert('Introduceți textul de sintetizat.'); return; }
        if (!this.isConnected) { alert('Nu sunteți conectat la server.'); return; }

        this.showProgress();
        this.setProgress(5, 'Se pregătește...');
        this.elements.playBtn.disabled = true;
        this.elements.downloadBtn.disabled = true;

        const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
        const chunks = sentences.map(s => s.trim()).filter(s => s.length > 0);
        if (chunks.length === 0) chunks.push(text);

        this.audioQueue = [];
        this.isPlaying = false;
        this.currentChunkIndex = 0;
        this.totalChunks = chunks.length;
        this.isAborted = false;

        this.elements.audioPlayer.pause();
        this.elements.audioPlayer.src = '';
        this.updatePlaybackButtons();

        this.fetchChunks(chunks);
    }

    async fetchChunks(chunks) {
        for (let i = 0; i < chunks.length; i++) {
            if (this.isAborted) break;
            
            try {
                if (!this.isPlaying) {
                    this.setProgress(10, `Generare fragment ${i+1}/${chunks.length}...`);
                }
                
                const response = await fetch(`${this.serverUrl}/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: chunks[i],
                        model: this.model,
                        speaker: this.speaker,
                        reference_audio_base64: this.model === 'styletts2' ? this.referenceAudio : null
                    })
                });

                if (!response.ok) throw new Error('Eroare server');
                const data = await response.json();
                
                if (data.audio_base64) {
                    const audioBlob = this.base64ToBlob(data.audio_base64, 'audio/wav');
                    const audioUrl = URL.createObjectURL(audioBlob);
                    
                    this.audioQueue.push(audioUrl);
                    this.currentChunkIndex++;
                    
                    if (!this.isPlaying) {
                        this.playNextInQueue();
                    } else {
                        const played = this.currentChunkIndex - this.audioQueue.length;
                        const pct = Math.floor((played / this.totalChunks) * 100);
                        this.setProgress(pct, `Se descarcă fragmentul ${this.currentChunkIndex}/${this.totalChunks}...`);
                    }
                }
            } catch (error) {
                console.error('Fetch error:', error);
                if (!this.isPlaying && this.audioQueue.length === 0) {
                    this.setProgress(0, `Eroare: ${error.message}`);
                }
            }
        }
    }

    playNextInQueue() {
        if (this.isAborted) return;
        
        if (this.audioQueue.length > 0) {
            this.isPlaying = true;
            this.updatePlaybackButtons();
            
            const playedChunks = this.currentChunkIndex - this.audioQueue.length;
            const pct = Math.floor((playedChunks / this.totalChunks) * 100);
            this.setProgress(pct, `Se redă... (${playedChunks}/${this.totalChunks})`);
            
            const nextAudioUrl = this.audioQueue.shift();
            this.elements.audioPlayer.src = nextAudioUrl;
            this.elements.audioPlayer.playbackRate = this.speed;  // viteza de redare aleasă
            this.elements.audioPlayer.play().catch(e => console.error("Play error:", e));
        } else {
            this.isPlaying = false;
            if (this.currentChunkIndex >= this.totalChunks) {
                this.setProgress(100, 'Finalizat!');
                setTimeout(() => this.hideProgress(), 2000);
                this.elements.playBtn.disabled = false;
                this.elements.downloadBtn.disabled = false;
            }
            this.updatePlaybackButtons();
        }
    }

    // --- DOWNLOAD LOGIC ---

    async downloadAudio() {
        const text = this.elements.textInput.value.trim();
        if (!text) { alert('Introduceți textul pentru a-l descărca.'); return; }
        if (!this.isConnected) { alert('Nu sunteți conectat la server.'); return; }

        this.showProgress();
        this.setProgress(10, 'Se generează fișierul audio complet...');
        this.elements.playBtn.disabled = true;
        this.elements.downloadBtn.disabled = true;

        try {
            // For download, we request the full audio at once
            const response = await fetch(`${this.serverUrl}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    model: this.model,
                    speaker: this.speaker,
                    reference_audio_base64: this.model === 'styletts2' ? this.referenceAudio : null
                })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || 'Eroare la generare');
            }

            const data = await response.json();
            
            if (data.audio_base64) {
                this.setProgress(80, 'Se descarcă...');
                const audioBlob = this.base64ToBlob(data.audio_base64, 'audio/wav');
                const audioUrl = URL.createObjectURL(audioBlob);
                
                // Create dummy anchor to trigger download
                const a = document.createElement('a');
                a.href = audioUrl;
                a.download = `Ro-DeepVoice_${Date.now()}.wav`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                
                this.setProgress(100, 'Descărcare completă!');
                setTimeout(() => this.hideProgress(), 2000);
            }
        } catch (error) {
            console.error('Download error:', error);
            this.setProgress(0, `Eroare: ${error.message}`);
            setTimeout(() => this.hideProgress(), 3000);
        } finally {
            this.elements.playBtn.disabled = false;
            this.elements.downloadBtn.disabled = false;
        }
    }

    base64ToBlob(base64, mimeType) {
        const byteCharacters = atob(base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        return new Blob([byteArray], { type: mimeType });
    }

    stop() {
        this.isAborted = true;
        this.audioQueue = [];
        this.isPlaying = false;
        
        this.elements.audioPlayer.pause();
        this.elements.audioPlayer.currentTime = 0;
        this.elements.audioPlayer.src = '';
        
        this.hideProgress();
        this.updatePlaybackButtons();
        this.elements.playBtn.disabled = false;
        this.elements.downloadBtn.disabled = false;
    }

    updatePlaybackButtons() {
        this.elements.playBtn.disabled = this.isPlaying;
        this.elements.downloadBtn.disabled = this.isPlaying;
        this.elements.stopBtn.disabled = !this.isPlaying;
    }

    showProgress() {
        this.elements.progressSection.classList.remove('hidden');
    }

    hideProgress() {
        this.elements.progressSection.classList.add('hidden');
    }

    setProgress(percent, text) {
        this.elements.progressFill.style.width = `${percent}%`;
        this.elements.progressText.textContent = text;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.roDeepVoiceStudio = new RoDeepVoiceStudio();
});
