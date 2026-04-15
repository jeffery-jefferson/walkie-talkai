class WalkieTalkAIOverlay {
    constructor(wsUrl = 'ws://127.0.0.1:8765') {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.fullResponse = '';
        this.autoHideTimer = null;
        this.autoHideSeconds = 15;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000;
        this.isConnected = false;
        this.isExpanded = false;
        this._growTimer = null;
        
        this.init();
    }
    
    init() {
        this.cacheElements();
        this.connectWebSocket();
    }
    
    cacheElements() {
        this.collapsedTab = document.getElementById('collapsed-tab');
        this.tabDot = this.collapsedTab.querySelector('.tab-dot');
        this.container = document.getElementById('overlay-container');
        this.statusArea = document.getElementById('status-area');
        this.statusDot = this.statusArea.querySelector('.status-dot');
        this.statusText = this.statusArea.querySelector('.status-text');
        this.transcriptArea = document.getElementById('transcript-area');
        this.transcriptText = document.getElementById('transcript-text');
        this.responseArea = document.getElementById('response-area');
        this.responseContent = document.getElementById('response-content');
        this.errorArea = document.getElementById('error-area');
        this.errorMessage = document.getElementById('error-message');
    }
    
    connectWebSocket() {
        try {
            this.ws = new WebSocket(this.wsUrl);
            
            this.ws.addEventListener('open', () => {
                console.log('Connected to WalkieTalkAI server');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.hideError();
            });
            
            this.ws.addEventListener('message', (event) => {
                this.handleMessage(event);
            });
            
            this.ws.addEventListener('close', () => {
                console.log('WebSocket connection closed');
                this.isConnected = false;
                this.scheduleReconnect();
            });
            
            this.ws.addEventListener('error', (error) => {
                console.error('WebSocket error:', error);
                this.isConnected = false;
            });
        } catch (error) {
            console.error('Failed to create WebSocket connection:', error);
            this.scheduleReconnect();
        }
    }
    
    scheduleReconnect() {
        const baseDelay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        const jitter = Math.random() * 1000;
        const delay = baseDelay + jitter;
        
        this.reconnectAttempts++;
        
        console.log(`Reconnecting in ${Math.round(delay/1000)}s... (attempt ${this.reconnectAttempts})`);
        
        setTimeout(() => {
            if (!this.isConnected) {
                this.connectWebSocket();
            }
        }, delay);
    }
    
    handleMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('Received message:', data);
            
            switch (data.type) {
                case 'status':
                    this.handleStatus(data);
                    break;
                case 'transcript':
                    this.handleTranscript(data);
                    break;
                case 'token':
                    this.handleToken(data);
                    break;
                case 'done':
                    this.handleDone(data);
                    break;
                case 'error':
                    this.handleError(data);
                    break;
                case 'cancelled':
                    this.handleCancelled(data);
                    break;
                case 'hide':
                    this.handleHide();
                    break;
                default:
                    console.warn('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
        }
    }
    
    handleStatus(data) {
        this.clearAutoHideTimer();
        
        // Update tab dot to always reflect current state
        this.tabDot.className = 'tab-dot ' + (data.state || '');
        
        switch (data.state) {
            case 'recording':
                this.statusDot.className = 'status-dot recording';
                this.statusText.textContent = 'Listening...';
                this.expandOverlay();
                this.hideError();
                break;
            case 'processing':
                this.statusDot.className = 'status-dot processing';
                this.statusText.textContent = 'Thinking...';
                break;
            case 'idle':
                this.statusDot.className = 'status-dot idle';
                this.statusText.textContent = 'Ready';
                this.startAutoHideTimer();
                break;
            default:
                this.statusDot.className = 'status-dot';
                this.statusText.textContent = 'Ready';
        }
    }
    
    handleTranscript(data) {
        this.transcriptText.className = 'transcript-text';
        this.transcriptText.textContent = data.text;
        this.transcriptArea.classList.remove('hidden');
        this._growToFitContent();
        this.scrollToBottom();
    }
    
    handleToken(data) {
        if (!data.content) return;
        
        this.responseArea.classList.remove('hidden');
        
        const tokenSpan = document.createElement('span');
        tokenSpan.className = 'token';
        tokenSpan.textContent = data.content;
        
        this.responseContent.appendChild(tokenSpan);
        this.fullResponse += data.content;
        
        this.scrollToBottom();
    }
    
    handleDone(data) {
        if (data.full_text) {
            this.responseContent.innerHTML = this.renderMarkdown(data.full_text);
            this.fullResponse = data.full_text;
        }
        
        this.scrollToBottom();
        this.startAutoHideTimer();
    }
    
    handleError(data) {
        this.errorMessage.textContent = data.message || 'An unknown error occurred';
        this.errorArea.classList.remove('hidden');
        this.startAutoHideTimer();
    }
    
    handleHide() {
        this.collapseOverlay();
    }
    
    handleCancelled(data) {
        const phrase = data.phrase || '';
        const fullText = data.full_text || phrase;
        if (!phrase && !fullText) {
            // Empty = no speech detected, just silently reset
            this.collapseOverlay();
            return;
        }
        // Show the full transcript with strikethrough
        this.transcriptText.className = 'transcript-text cancelled';
        this.transcriptText.textContent = fullText;
        this.transcriptArea.classList.remove('hidden');
        this.responseArea.classList.add('hidden');
        this.responseContent.innerHTML = '';
        this.fullResponse = '';

        // Fade out the strikethrough text, then clear for new transcription
        requestAnimationFrame(() => {
            this.transcriptText.classList.add('fading');
        });
        const onFaded = () => {
            this.transcriptText.removeEventListener('transitionend', onFaded);
            this.transcriptText.className = 'transcript-text';
            this.transcriptText.textContent = '';
            this.transcriptArea.classList.add('hidden');
            this.statusText.textContent = 'Ready';
            this.statusDot.className = 'status-dot idle';
            this.startAutoHideTimer();
        };
        this.transcriptText.addEventListener('transitionend', onFaded);
        // Fallback if transitionend doesn't fire
        setTimeout(() => {
            if (this.transcriptText.classList.contains('fading')) {
                onFaded();
            }
        }, 1000);
    }
    
    // Expand overlay: resize window to full card, show card, hide tab
    expandOverlay() {
        if (this.isExpanded) return;
        this.isExpanded = true;
        this.clearAutoHideTimer();
        if (this._growTimer) { clearTimeout(this._growTimer); this._growTimer = null; }
        
        // Hide tab, show card
        this.collapsedTab.classList.add('hidden');
        this.container.classList.remove('hidden');
        
        // Reset content for new session
        this.transcriptArea.classList.add('hidden');
        this.responseArea.classList.add('hidden');
        this.responseContent.innerHTML = '';
        this.fullResponse = '';
        this.hideError();
        
        // Resize window via pywebview API
        this._callAPI('expand');
    }
    
    // Collapse overlay: resize window to tiny tab, show tab, hide card
    collapseOverlay() {
        if (!this.isExpanded) return;
        this.isExpanded = false;
        this.clearAutoHideTimer();
        if (this._growTimer) { clearTimeout(this._growTimer); this._growTimer = null; }
        
        // Hide card, show tab
        this.container.classList.add('hidden');
        this.collapsedTab.classList.remove('hidden');
        
        // Clear content
        this.transcriptArea.classList.add('hidden');
        this.responseArea.classList.add('hidden');
        this.responseContent.innerHTML = '';
        this.fullResponse = '';
        this.hideError();
        
        // Resize window via pywebview API
        this._callAPI('collapse');
    }
    
    _callAPI(method, ...args) {
        // pywebview exposes the js_api object as window.pywebview.api
        if (window.pywebview && window.pywebview.api && window.pywebview.api[method]) {
            try {
                window.pywebview.api[method](...args);
            } catch (e) {
                console.warn('pywebview API call failed:', method, e);
            }
        }
    }
    
    _growToFitContent() {
        // Debounce: wait for DOM to settle before measuring and requesting resize.
        if (this._growTimer) clearTimeout(this._growTimer);
        this._growTimer = setTimeout(() => {
            this._growTimer = null;
            const needed = document.documentElement.scrollHeight;
            if (needed > window.innerHeight + 4) { // 4px tolerance
                this._callAPI('set_height', needed + 16); // +16 breathing room
            }
        }, 80);
    }
    
    hideError() {
        this.errorArea.classList.add('hidden');
    }
    
    startAutoHideTimer() {
        this.clearAutoHideTimer();
        this.autoHideTimer = setTimeout(() => {
            this.collapseOverlay();
        }, this.autoHideSeconds * 1000);
    }
    
    clearAutoHideTimer() {
        if (this.autoHideTimer) {
            clearTimeout(this.autoHideTimer);
            this.autoHideTimer = null;
        }
    }
    
    scrollToBottom() {
        this.container.scrollTop = this.container.scrollHeight;
        this.responseContent.scrollTop = this.responseContent.scrollHeight;
    }
    
    renderMarkdown(text) {
        if (!text) return '';
        
        let html = text;
        
        html = html.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;');
        
        html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (match, lang, code) => {
            const langAttr = lang ? ` data-lang="${lang}"` : '';
            return `<pre${langAttr}><code>${code.trim()}</code></pre>`;
        });
        
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        if (html.trim()) {
            html = '<p>' + html + '</p>';
            html = html.replace(/<p><\/p>/g, '');
            html = html.replace(/<p>\s*<\/p>/g, '');
        }
        
        return html;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.overlay = new WalkieTalkAIOverlay();
});

// Handle window focus/blur for better UX
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.overlay) {
        if (!window.overlay.isConnected) {
            window.overlay.connectWebSocket();
        }
    }
});