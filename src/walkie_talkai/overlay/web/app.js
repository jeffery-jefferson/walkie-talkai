class WalkieTalkAIOverlay {
    constructor(wsUrl = 'ws://127.0.0.1:8765') {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.fullResponse = '';
        this.autoHideTimer = null;
        this.autoHideSeconds = 15;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 30000; // 30 seconds max
        this.isConnected = false;
        
        this.init();
    }
    
    init() {
        this.cacheElements();
        this.connectWebSocket();
    }
    
    cacheElements() {
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
        // Exponential backoff with jitter
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
        
        switch (data.state) {
            case 'recording':
                this.statusDot.className = 'status-dot recording';
                this.statusText.textContent = 'Listening...';
                this.showOverlay();
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
        this.transcriptText.textContent = data.text;
        this.transcriptArea.classList.remove('hidden');
        this.scrollToBottom();
    }
    
    handleToken(data) {
        if (!data.content) return;
        
        // Show response area if hidden
        this.responseArea.classList.remove('hidden');
        
        // Create token element with animation
        const tokenSpan = document.createElement('span');
        tokenSpan.className = 'token';
        tokenSpan.textContent = data.content;
        
        this.responseContent.appendChild(tokenSpan);
        this.fullResponse += data.content;
        
        this.scrollToBottom();
    }
    
    handleDone(data) {
        if (data.full_text) {
            // Re-render with proper markdown formatting
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
        this.hideOverlay();
    }
    
    showOverlay() {
        this.clearAutoHideTimer();
        this.container.classList.remove('hidden');
        
        // Reset content for new session
        this.transcriptArea.classList.add('hidden');
        this.responseArea.classList.add('hidden');
        this.responseContent.innerHTML = '';
        this.fullResponse = '';
        this.hideError();
    }
    
    hideOverlay() {
        this.clearAutoHideTimer();
        this.container.classList.add('hidden');
        
        // Clear content after transition
        setTimeout(() => {
            if (this.container.classList.contains('hidden')) {
                this.transcriptArea.classList.add('hidden');
                this.responseArea.classList.add('hidden');
                this.responseContent.innerHTML = '';
                this.fullResponse = '';
                this.hideError();
            }
        }, 300);
    }
    
    hideError() {
        this.errorArea.classList.add('hidden');
    }
    
    startAutoHideTimer() {
        this.clearAutoHideTimer();
        this.autoHideTimer = setTimeout(() => {
            this.hideOverlay();
        }, this.autoHideSeconds * 1000);
    }
    
    clearAutoHideTimer() {
        if (this.autoHideTimer) {
            clearTimeout(this.autoHideTimer);
            this.autoHideTimer = null;
        }
    }
    
    scrollToBottom() {
        this.responseContent.scrollTop = this.responseContent.scrollHeight;
    }
    
    renderMarkdown(text) {
        if (!text) return '';
        
        let html = text;
        
        // Escape HTML first
        html = html.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;');
        
        // Code blocks (```lang\n...\n```)
        html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (match, lang, code) => {
            const langAttr = lang ? ` data-lang="${lang}"` : '';
            return `<pre${langAttr}><code>${code.trim()}</code></pre>`;
        });
        
        // Inline code (`code`)
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Bold (**text**)
        html = html.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
        
        // Italic (*text*)
        html = html.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
        
        // Line breaks
        html = html.replace(/\n\n/g, '</p><p>');
        html = html.replace(/\n/g, '<br>');
        
        // Wrap in paragraphs
        if (html.trim()) {
            html = '<p>' + html + '</p>';
            
            // Clean up empty paragraphs
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
        // Reconnect if needed when window becomes visible
        if (!window.overlay.isConnected) {
            window.overlay.connectWebSocket();
        }
    }
});