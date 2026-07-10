// Ro-DeepVoice Plugin - Content Script
// Runs on web pages to extract text and provide TTS functionality

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        maxTextLength: 10000,
        fabShowDelay: 300
    };

    // State
    let state = {
        selectedText: '',
        fabVisible: false,
        miniPlayerVisible: false,
        serverUrl: 'http://127.0.0.1:5000',
        speed: 1.0   // viteza de REDARE (client-side playbackRate), aceeași ca în popup
    };

    // Load settings
    chrome.storage.local.get(['serverUrl', 'speed'], (result) => {
        if (result.serverUrl) {
            state.serverUrl = result.serverUrl;
        }
        if (result.speed) {
            state.speed = parseFloat(result.speed) || 1.0;
        }
    });

    // Reflectă în timp real, în mini-player, viteza schimbată din popup (Studio) și invers,
    // ca cele două căi de redare (pagini web vs. documente/PDF) să fie consecvente.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.speed) {
            state.speed = parseFloat(changes.speed.newValue) || 1.0;
            syncSpeedUI();
        }
    });

    // Create floating action button
    function createFab() {
        const fab = document.createElement('button');
        fab.id = 'ro-deepvoice-fab';
        fab.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 9v6h4l5 5V4L7 9H3z"/>
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
        `;
        fab.title = 'Citește cu Ro-DeepVoice';
        document.body.appendChild(fab);

        fab.addEventListener('click', () => {
            if (state.selectedText) {
                synthesizeAndPlay(state.selectedText);
            }
        });

        return fab;
    }

    // Create mini player
    function createMiniPlayer() {
        const player = document.createElement('div');
        player.id = 'ro-deepvoice-mini-player';
        player.innerHTML = `
            <div class="player-header">
                <span>🔊 Ro-DeepVoice</span>
                <button class="player-close">×</button>
            </div>
            <div class="player-status">Pregătit</div>
            <div class="player-progress">
                <div class="player-progress-fill"></div>
            </div>
            <audio controls></audio>
            <div class="player-speed">
                <span class="player-speed-label">Viteză</span>
                <input type="range" class="player-speed-slider" min="0.5" max="2.0" step="0.1" value="1.0">
                <span class="player-speed-val">1.0x</span>
            </div>
        `;
        document.body.appendChild(player);

        // Close button
        player.querySelector('.player-close').addEventListener('click', () => {
            hideMiniPlayer();
            const audio = player.querySelector('audio');
            audio.pause();
            audio.src = '';
        });

        // Slider de viteză: aplică playbackRate imediat pe redarea în curs (efect în timp
        // real, exact ca în popup) și salvează valoarea ca să persiste între propoziții și sesiuni.
        const speedSlider = player.querySelector('.player-speed-slider');
        const speedVal = player.querySelector('.player-speed-val');
        speedSlider.value = state.speed;
        speedVal.textContent = `${state.speed.toFixed(1)}x`;
        speedSlider.addEventListener('input', (e) => {
            state.speed = parseFloat(e.target.value) || 1.0;
            speedVal.textContent = `${state.speed.toFixed(1)}x`;
            const audio = player.querySelector('audio');
            if (audio) audio.playbackRate = state.speed;
            chrome.storage.local.set({ speed: state.speed });
        });

        // Sincronizare inversă: dacă utilizatorul alege o viteză din meniul „⋮" al player-ului
        // nativ, evenimentul ratechange actualizează slider-ul, state.speed și storage, astfel
        // încât cele două controale rămân consecvente, iar viteza aleasă persistă și la
        // propozițiile următoare (altfel ar fi resetată de reaplicarea per-propoziție).
        const audioEl = player.querySelector('audio');
        audioEl.addEventListener('ratechange', () => {
            const r = audioEl.playbackRate;
            if (!r || Math.abs(r - state.speed) < 0.001) return;  // ignoră reaplicarea propriei valori
            state.speed = r;
            speedSlider.value = r;
            speedVal.textContent = `${r.toFixed(1)}x`;
            chrome.storage.local.set({ speed: state.speed });
        });

        return player;
    }

    // Sincronizează controlul de viteză al mini-playerului cu state.speed (folosit când
    // viteza se schimbă din popup în timp ce mini-playerul e deschis).
    function syncSpeedUI() {
        const player = document.getElementById('ro-deepvoice-mini-player');
        if (!player) return;
        const slider = player.querySelector('.player-speed-slider');
        const val = player.querySelector('.player-speed-val');
        if (slider) slider.value = state.speed;
        if (val) val.textContent = `${state.speed.toFixed(1)}x`;
        const audio = player.querySelector('audio');
        if (audio) audio.playbackRate = state.speed;
    }

    // Show FAB when text is selected
    function showFab(x, y) {
        const fab = document.getElementById('ro-deepvoice-fab') || createFab();
        
        if (x !== undefined && y !== undefined) {
            // Position the FAB near the cursor, with a small offset
            fab.style.left = `${x + 15}px`;
            fab.style.top = `${y + 15}px`;
        }
        
        fab.classList.add('visible');
        state.fabVisible = true;
    }

    // Hide FAB
    function hideFab() {
        const fab = document.getElementById('ro-deepvoice-fab');
        if (fab) {
            fab.classList.remove('visible');
            state.fabVisible = false;
        }
    }

    // Show mini player
    function showMiniPlayer() {
        const player = document.getElementById('ro-deepvoice-mini-player') || createMiniPlayer();
        player.classList.add('visible');
        state.miniPlayerVisible = true;
    }

    // Hide mini player
    function hideMiniPlayer() {
        const player = document.getElementById('ro-deepvoice-mini-player');
        if (player) {
            player.classList.remove('visible');
            state.miniPlayerVisible = false;
        }
    }

    // Update mini player status
    function updateMiniPlayerStatus(status) {
        const player = document.getElementById('ro-deepvoice-mini-player');
        if (player) {
            player.querySelector('.player-status').textContent = status;
        }
    }

    // Update mini player progress
    function updateMiniPlayerProgress(percent) {
        const player = document.getElementById('ro-deepvoice-mini-player');
        if (player) {
            player.querySelector('.player-progress-fill').style.width = `${percent}%`;
        }
    }

    // Synthesize and play text using Sentence-Level Chunking (Streaming)
    async function synthesizeAndPlay(text) {
        if (!text || text.length === 0) return;
        if (text.length > CONFIG.maxTextLength) {
            text = text.substring(0, CONFIG.maxTextLength);
        }

        showMiniPlayer();
        updateMiniPlayerStatus('Se pregătește...');
        updateMiniPlayerProgress(5);

        // Split text into chunks (sentences). Matches sentences with or without trailing punctuation.
        const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
        const chunks = sentences.map(s => s.trim()).filter(s => s.length > 0);
        
        if (chunks.length === 0) {
            chunks.push(text); // Fallback
        }

        const player = document.getElementById('ro-deepvoice-mini-player');
        const audio = player.querySelector('audio');
        
        let audioQueue = [];
        let isPlaying = false;
        let currentChunkIndex = 0;
        let isAborted = false;

        // Reset audio state
        audio.pause();
        audio.src = '';
        
        // Handle stop button or close
        player.querySelector('.player-close').addEventListener('click', () => {
            isAborted = true;
            audioQueue = []; // Clear queue
            hideMiniPlayer();
            audio.pause();
            audio.src = '';
        }, { once: true }); // Ensure we only bind this once per playback session

        const playNextInQueue = () => {
            if (isAborted) return;
            if (audioQueue.length > 0) {
                isPlaying = true;
                const nextAudioUrl = audioQueue.shift();
                audio.src = nextAudioUrl;
                audio.playbackRate = state.speed;  // reaplicat la fiecare propoziție (src nou resetează playbackRate)
                audio.play().catch(e => {
                    console.error("Play error:", e);
                    isPlaying = false;
                    updateMiniPlayerStatus(`Redare blocată (${e.name}). Apasă ▶ pe player pentru a asculta manual.`);
                });

                // Update progress based on chunks processed
                const percent = Math.floor(((currentChunkIndex - audioQueue.length) / chunks.length) * 100);
                updateMiniPlayerProgress(percent);
                updateMiniPlayerStatus(`Se redă (${currentChunkIndex - audioQueue.length}/${chunks.length})...`);
            } else {
                isPlaying = false;
                if (currentChunkIndex >= chunks.length) {
                    updateMiniPlayerStatus('Finalizat');
                    updateMiniPlayerProgress(100);
                }
            }
        };

        audio.onended = playNextInQueue;

        // Fetch loop (Background downloading)
        for (let i = 0; i < chunks.length; i++) {
            if (isAborted) break;
            
            try {
                if (!isPlaying) {
                    updateMiniPlayerStatus(`Generare flux ${i+1}/${chunks.length}...`);
                }
                
                // Context-ul extensiei invalidat: extensia a fost reîncărcată/actualizată
                // după ce pagina era deja deschisă, iar content script-ul vechi și-a pierdut
                // legătura cu ea (chrome.runtime devine undefined / fără id). Singura soluție
                // este reîncărcarea paginii, deci dăm un mesaj explicit în loc de eroarea criptică.
                if (!chrome.runtime || !chrome.runtime.id) {
                    throw new Error('Extensia a fost reîncărcată. Reîncarcă pagina (F5) și încearcă din nou.');
                }

                let response;
                try {
                    response = await chrome.runtime.sendMessage({
                        action: 'ttsRequest',
                        text: chunks[i]
                    });
                } catch (msgError) {
                    // Background service worker didn't respond (e.g. it was suspended
                    // and failed to wake, or the message channel closed before
                    // sendResponse). chrome.runtime.sendMessage rejects in this case
                    // instead of resolving with an error payload.
                    const invalidated = /context invalidated|Extension context|sendMessage/i.test(msgError.message || '');
                    throw new Error(invalidated
                        ? 'Extensia a fost reîncărcată. Reîncarcă pagina (F5) și încearcă din nou.'
                        : `Nu s-a putut contacta extensia (${msgError.message}). Reîncarcă pagina și încearcă din nou.`);
                }

                if (response && response.success && response.data && response.data.success) {
                    const data = response.data;
                    let audioUrl = '';
                    
                    if (data.audio_base64) {
                        const byteCharacters = atob(data.audio_base64);
                        const byteNumbers = new Array(byteCharacters.length);
                        for (let j = 0; j < byteCharacters.length; j++) {
                            byteNumbers[j] = byteCharacters.charCodeAt(j);
                        }
                        const byteArray = new Uint8Array(byteNumbers);
                        const blob = new Blob([byteArray], { type: 'audio/wav' });
                        audioUrl = URL.createObjectURL(blob);
                    } else if (data.audio_url) {
                        audioUrl = data.audio_url.startsWith('http') 
                            ? data.audio_url 
                            : `${state.serverUrl}${data.audio_url}`;
                    }

                    if (audioUrl) {
                        audioQueue.push(audioUrl);
                        currentChunkIndex++;
                        
                        // If not playing and we just got the first chunk, start immediately!
                        if (!isPlaying) {
                            playNextInQueue();
                        }
                    }
                } else {
                    const errMsg = (response && (response.error || (response.data && response.data.error)))
                        || 'Răspuns invalid de la server (fără audio).';
                    console.error('Chunk error:', errMsg, response);
                    if (!isPlaying && audioQueue.length === 0) {
                        updateMiniPlayerStatus(`Eroare: ${errMsg}`);
                        updateMiniPlayerProgress(0);
                    }
                }
            } catch (error) {
                console.error('Fetch error for chunk', i, error);
                if (!isPlaying && audioQueue.length === 0) {
                    updateMiniPlayerStatus(`Eroare: ${error.message}`);
                    updateMiniPlayerProgress(0);
                }
            }
        }
    }

    // Extract main content from page
    function extractPageContent() {
        // First check for selected text
        const selection = window.getSelection().toString().trim();
        if (selection) {
            return selection;
        }

        // Try to find article content
        const selectors = [
            'article',
            '[role="article"]',
            'main',
            '[role="main"]',
            '.post-content',
            '.article-content',
            '.entry-content',
            '.content',
            '#content'
        ];

        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
                return cleanText(element.innerText);
            }
        }

        // Fallback: get body content excluding navigation, etc.
        const body = document.body.cloneNode(true);
        const toRemove = body.querySelectorAll(
            'script, style, nav, header, footer, aside, ' +
            '[role="navigation"], [role="banner"], [role="complementary"], ' +
            '.nav, .navigation, .menu, .sidebar, .footer, .header, ' +
            '.ad, .advertisement, .social-share, ' +
            '#ro-deepvoice-fab, #ro-deepvoice-mini-player'
        );
        toRemove.forEach(el => el.remove());

        return cleanText(body.innerText);
    }

    // Clean extracted text
    function cleanText(text) {
        return text
            .replace(/\s+/g, ' ')  // Multiple spaces to single
            .replace(/\n\s*\n/g, '\n\n')  // Multiple newlines to double
            .trim()
            .substring(0, CONFIG.maxTextLength);
    }

    // Handle text selection
    let selectionTimeout = null;
    document.addEventListener('mouseup', (e) => {
        if (selectionTimeout) {
            clearTimeout(selectionTimeout);
        }

        // Capture coordinates immediately
        const mouseX = e.clientX;
        const mouseY = e.clientY;

        selectionTimeout = setTimeout(() => {
            const selection = window.getSelection().toString().trim();
            
            if (selection && selection.length > 3) {
                state.selectedText = selection;
                showFab(mouseX, mouseY);
            } else {
                state.selectedText = '';
                hideFab();
            }
        }, CONFIG.fabShowDelay);
    });

    // Hide FAB when clicking elsewhere
    document.addEventListener('mousedown', (e) => {
        const fab = document.getElementById('ro-deepvoice-fab');
        const player = document.getElementById('ro-deepvoice-mini-player');
        
        if (fab && !fab.contains(e.target) && 
            (!player || !player.contains(e.target))) {
            // Don't hide immediately to allow click on FAB
            setTimeout(() => {
                if (!window.getSelection().toString().trim()) {
                    hideFab();
                }
            }, 100);
        }
    });

    // Listen for messages from popup or background script
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'getSelectedText') {
            const selection = window.getSelection().toString().trim();
            sendResponse({ text: selection });
        } else if (request.action === 'getPageContent') {
            const content = extractPageContent();
            sendResponse({ text: content });
        } else if (request.action === 'synthesize') {
            synthesizeAndPlay(request.text);
            sendResponse({ success: true });
        } else if (request.action === 'updateServerUrl') {
            state.serverUrl = request.serverUrl;
            sendResponse({ success: true });
        }
        return true; // Keep channel open for async response
    });

    // Keyboard shortcut: Alt+R to read selection
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'r') {
            const selection = window.getSelection().toString().trim();
            if (selection) {
                synthesizeAndPlay(selection);
            }
        }
    });

    console.log('Ro-DeepVoice content script loaded');
})();
