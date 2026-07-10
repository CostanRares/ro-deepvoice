// Ro-DeepVoice Plugin - Background Service Worker

// Default settings
const DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:5000'
};

// TTS API call - done in background to bypass Mixed Content blocking
async function synthesizeTTS(text, settings) {
    const url = settings.serverUrl || DEFAULT_SETTINGS.serverUrl;
    console.log(`[Background] TTS request to ${url}/tts`);
    
    try {
        // Parametrii de sinteză (viteză, noise_scale, noise_scale_w) sunt aplicați
        // optim, per model, de către gateway — clientul trimite doar modelul și vocea.
        const payload = {
            text: text,
            model: settings.model || 'vits1_biblie',
            speaker: settings.speaker !== undefined ? settings.speaker : ((settings.model === 'vits2_biblie') ? 1 : 0)
        };
        
        const response = await fetch(`${url}/tts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Eroare la sintetizare');
        }

        const data = await response.json();
        console.log('[Background] TTS response received, success:', data.success);
        return data;
    } catch (error) {
        console.error('[Background] TTS Error:', error);
        throw error;
    }
}

// Initialize extension
chrome.runtime.onInstalled.addListener((details) => {
    console.log('Ro-DeepVoice extension installed:', details.reason);
    
    // Set default settings on install
    if (details.reason === 'install') {
        chrome.storage.local.set(DEFAULT_SETTINGS);
    }

    // Create context menu items
    createContextMenus();
});

// Create context menu items
function createContextMenus() {
    // Remove existing menus first
    chrome.contextMenus.removeAll(() => {
        // Read selected text
        chrome.contextMenus.create({
            id: 'ro-deepvoice-read-selection',
            title: 'Citește cu Ro-DeepVoice',
            contexts: ['selection']
        });

        // Read entire page
        chrome.contextMenus.create({
            id: 'ro-deepvoice-read-page',
            title: 'Citește pagina cu Ro-DeepVoice',
            contexts: ['page']
        });

        // Separator
        chrome.contextMenus.create({
            id: 'ro-deepvoice-separator',
            type: 'separator',
            contexts: ['selection', 'page']
        });

        // Open popup
        chrome.contextMenus.create({
            id: 'ro-deepvoice-open-popup',
            title: 'Deschide Ro-DeepVoice',
            contexts: ['selection', 'page']
        });
    });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    // Salvează ultima selecție (din click-dreapta) ca să poată fi preluată de popup.
    // Esențial pentru PDF-uri/documente, unde content script-ul nu poate citi selecția
    // (vizualizatorul PDF al Chrome este izolat), dar contextMenus oferă selectionText.
    if (info.selectionText) {
        chrome.storage.local.set({
            lastSelection: info.selectionText,
            lastSelectionTime: Date.now()
        });
    }

    switch (info.menuItemId) {
        case 'ro-deepvoice-read-selection':
            if (info.selectionText) {
                await sendToContentScript(tab.id, 'synthesize', { text: info.selectionText });
            }
            break;

        case 'ro-deepvoice-read-page':
            const result = await sendToContentScript(tab.id, 'getPageContent');
            if (result && result.text) {
                await sendToContentScript(tab.id, 'synthesize', { text: result.text });
            }
            break;

        case 'ro-deepvoice-open-popup':
            // Open the popup programmatically
            chrome.action.openPopup();
            break;
    }
});

// Send message to content script
async function sendToContentScript(tabId, action, data = {}) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action, ...data });
        return response;
    } catch (error) {
        console.error('Error sending message to content script:', error);
        
        // Try to inject content script if not loaded
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            await chrome.scripting.insertCSS({
                target: { tabId: tabId },
                files: ['content.css']
            });
            
            // Retry sending message
            const response = await chrome.tabs.sendMessage(tabId, { action, ...data });
            return response;
        } catch (injectError) {
            console.error('Error injecting content script:', injectError);
            return null;
        }
    }
}

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getSettings') {
        chrome.storage.local.get(null, (settings) => {
            sendResponse(settings);
        });
        return true; // Async response
    }
    
    if (request.action === 'saveSettings') {
        chrome.storage.local.set(request.settings, () => {
            // Notify all tabs about settings update
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'updateServerUrl',
                        serverUrl: request.settings.serverUrl
                    }).catch(() => {}); // Ignore errors for tabs without content script
                });
            });
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'synthesize') {
        // Forward to active tab
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (tabs[0]) {
                await sendToContentScript(tabs[0].id, 'synthesize', { text: request.text });
            }
        });
        sendResponse({ success: true });
        return true;
    }

    // NEW: Handle TTS request from content script - fetch done here to bypass Mixed Content
    if (request.action === 'ttsRequest') {
        (async () => {
            try {
                // Get settings from storage
                const settings = await chrome.storage.local.get(['serverUrl', 'speaker', 'model']);
                let serverUrl = settings.serverUrl || DEFAULT_SETTINGS.serverUrl;
                
                // Fix: ensure we use 127.0.0.1 instead of localhost
                if (serverUrl.includes('localhost')) {
                    serverUrl = serverUrl.replace('localhost', '127.0.0.1');
                    settings.serverUrl = serverUrl;
                }
                
                console.log('[Background] ttsRequest received, using serverUrl:', serverUrl);
                const data = await synthesizeTTS(request.text, settings);
                sendResponse({ success: true, data: data });
            } catch (error) {
                console.error('[Background] ttsRequest error:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Async response
    }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
    console.log('Command received:', command);
    
    if (command === 'read-selection') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            const result = await sendToContentScript(tab.id, 'getSelectedText');
            if (result && result.text) {
                await sendToContentScript(tab.id, 'synthesize', { text: result.text });
            }
        }
    }
});

// Keep service worker alive (for long-running operations)
let keepAliveInterval = null;

function startKeepAlive() {
    if (!keepAliveInterval) {
        keepAliveInterval = setInterval(() => {
            // Ping to keep alive
            chrome.runtime.getPlatformInfo(() => {});
        }, 20000);
    }
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// Start keep-alive when extension is active
chrome.runtime.onStartup.addListener(() => {
    console.log('Ro-DeepVoice extension started');
    startKeepAlive();
});

console.log('Ro-DeepVoice background service worker loaded');
