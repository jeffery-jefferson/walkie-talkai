/**
 * WalkieTalkAI Overlay — Electron renderer.
 *
 * Receives events from the main process via the preload-exposed
 * `window.walkieTalkai` bridge (IPC, not WebSocket).
 */

class WalkieTalkAIOverlay {
    constructor() {
        this.fullResponse = '';
        this.autoHideTimer = null;
        this.autoHideSeconds = 15;
        this.isExpanded = false;
        this._growTimer = null;
        this._cancelledSpans = []; // array of { text, fading }
        this._idleFadeTimer = null;
        this._hoverExpanded = false;
        this._configOpacity = 1.0;

        // Reasoning panel state
        this._reasoningActive = false;
        this._reasoningStartTime = 0;
        this._reasoningTimerHandle = null;

        this.init();
    }

    init() {
        this.cacheElements();

        // Listen for events from the main process via IPC bridge.
        window.walkieTalkai.onEvent((data) => this.handleEvent(data));

        // Live config updates from main process (auto_hide_seconds, opacity, etc).
        window.walkieTalkai.onConfig((data) => {
            if (typeof data.auto_hide_seconds === 'number') {
                this.autoHideSeconds = data.auto_hide_seconds;
            }
            if (typeof data.opacity === 'number') {
                this._configOpacity = data.opacity;
            }
        });

        // Toggle click-through: visible elements capture mouse,
        // transparent areas pass clicks to windows beneath.
        for (const el of [this.collapsedTab, this.container]) {
            el.addEventListener('mouseenter', () => {
                window.walkieTalkai.setIgnoreMouse(false);
            });
            el.addEventListener('mouseleave', () => {
                window.walkieTalkai.setIgnoreMouse(true);
            });
        }

        // Hover on collapsed tab to view previous output
        this.collapsedTab.addEventListener('mouseenter', () => {
            if (!this.isExpanded && this.fullResponse) {
                this._hoverExpanded = true;
                this.expandOverlay({ resetContent: false });
            }
        });

        // Collapse when mouse leaves the expanded container (hover mode only)
        this.container.addEventListener('mouseleave', () => {
            if (this._hoverExpanded) {
                this._hoverExpanded = false;
                this.collapseOverlay();
            }
        });
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
        this.reasoningArea = document.getElementById('reasoning-area');
        this.reasoningToggle = document.getElementById('reasoning-toggle');
        this.reasoningLabel = document.getElementById('reasoning-label');
        this.reasoningTimer = document.getElementById('reasoning-timer');
        this.reasoningContent = document.getElementById('reasoning-content');
        this.toolArea = document.getElementById('tool-area');
        this.toolList = document.getElementById('tool-list');

        // Click-to-expand the reasoning panel
        this.reasoningToggle.addEventListener('click', () => {
            this.reasoningArea.classList.toggle('expanded');
            this.reasoningContent.classList.toggle('hidden');
            this._growToFitContent();
        });
    }

    // -----------------------------------------------------------------------
    // Event routing
    // -----------------------------------------------------------------------

    handleEvent(data) {
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
            case 'reasoning_start':
                this.handleReasoningStart();
                break;
            case 'reasoning':
                this.handleReasoning(data);
                break;
            case 'reasoning_end':
                this.handleReasoningEnd();
                break;
            case 'tool_start':
                this.handleToolStart(data);
                break;
            case 'tool_complete':
                this.handleToolComplete(data);
                break;
            default:
                console.warn('Unknown event type:', data.type);
        }
    }

    // -----------------------------------------------------------------------
    // Event handlers (unchanged from original)
    // -----------------------------------------------------------------------

    handleStatus(data) {
        this.clearAutoHideTimer();

        // Update tab dot to always reflect current state
        this.tabDot.className = 'tab-dot ' + (data.state || '');

        switch (data.state) {
            case 'recording':
                this._hoverExpanded = false;
                this._clearIdleFadeTimer();
                window.walkieTalkai.setOpacity(this._configOpacity);
                this.statusDot.className = 'status-dot recording';
                this.statusText.textContent = 'Listening...';
                this.expandOverlay({ resetContent: true });
                this.hideError();
                break;
            case 'processing':
                this._clearIdleFadeTimer();
                window.walkieTalkai.setOpacity(this._configOpacity);
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
        this.transcriptArea.classList.remove('hidden');
        this._renderTranscriptSpans(data.text || '');
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

    // -----------------------------------------------------------------------
    // Reasoning (thinking) handlers
    // -----------------------------------------------------------------------

    handleReasoningStart() {
        this._reasoningActive = true;
        this._reasoningStartTime = Date.now();
        this.reasoningContent.textContent = '';
        this.reasoningArea.classList.remove('hidden');
        this.reasoningLabel.textContent = 'Thinking';
        this.reasoningLabel.classList.add('thinking');
        this.reasoningTimer.textContent = '';

        // Update elapsed timer every 100ms while active
        if (this._reasoningTimerHandle) clearInterval(this._reasoningTimerHandle);
        this._reasoningTimerHandle = setInterval(() => {
            const elapsed = ((Date.now() - this._reasoningStartTime) / 1000).toFixed(1);
            this.reasoningTimer.textContent = `${elapsed}s`;
        }, 100);

        this._growToFitContent();
        this.scrollToBottom();
    }

    handleReasoning(data) {
        if (!data.content) return;
        if (!this._reasoningActive) this.handleReasoningStart();
        this.reasoningContent.textContent += data.content;
        // Auto-scroll the reasoning panel if it's visible
        this.reasoningContent.scrollTop = this.reasoningContent.scrollHeight;
    }

    handleReasoningEnd() {
        this._reasoningActive = false;
        this.reasoningLabel.classList.remove('thinking');
        // Freeze the elapsed time
        if (this._reasoningTimerHandle) {
            clearInterval(this._reasoningTimerHandle);
            this._reasoningTimerHandle = null;
        }
        const elapsed = ((Date.now() - this._reasoningStartTime) / 1000).toFixed(1);
        this.reasoningLabel.textContent = 'Thought';
        this.reasoningTimer.textContent = `${elapsed}s`;
    }

    // -----------------------------------------------------------------------
    // Tool execution handlers — show what the agent is doing in real time
    // -----------------------------------------------------------------------

    handleToolStart(data) {
        this.toolArea.classList.remove('hidden');
        const item = document.createElement('div');
        item.className = 'tool-item running';
        item.dataset.toolCallId = data.tool_call_id;
        item.innerHTML = `
            <div class="tool-status"></div>
            <span class="tool-label">Running</span>
            <span class="tool-name">${this._escapeHtml(data.tool_name || 'tool')}</span>
        `;
        this.toolList.appendChild(item);
        this._growToFitContent();
        this.scrollToBottom();
    }

    handleToolComplete(data) {
        const item = this.toolList.querySelector(`[data-tool-call-id="${data.tool_call_id}"]`);
        if (!item) return;
        item.classList.remove('running');
        item.classList.add(data.success ? 'success' : 'failure');
        const label = item.querySelector('.tool-label');
        if (label) label.textContent = data.success ? 'Done' : 'Failed';
    }

    handleCancelled(data) {
        const phrase = data.phrase || '';
        const fullText = data.full_text || phrase;
        if (!phrase && !fullText) {
            // Empty = no speech detected, just silently reset
            this.collapseOverlay();
            return;
        }

        // Add the cancelled text as a struck-through span that will fade out.
        // Recording continues — new speech will appear after this span.
        this._cancelledSpans.push({ text: fullText, fading: false });
        this.transcriptArea.classList.remove('hidden');
        this._renderTranscriptSpans('');

        // Start fading the struck-through span after a short delay
        setTimeout(() => {
            const span = this._cancelledSpans.find((s) => s.text === fullText && !s.fading);
            if (span) {
                span.fading = true;
                this._renderTranscriptSpans('');
            }
            // Remove the span after the fade transition completes
            setTimeout(() => {
                this._cancelledSpans = this._cancelledSpans.filter((s) => s.text !== fullText);
                this._renderTranscriptSpans('');
            }, 2000);
        }, 500);
    }

    // -----------------------------------------------------------------------
    // Window expand / collapse via Electron IPC
    // -----------------------------------------------------------------------

    expandOverlay({ resetContent = true } = {}) {
        if (this.isExpanded) return;
        this.isExpanded = true;
        this.clearAutoHideTimer();
        this._clearIdleFadeTimer();
        if (this._growTimer) { clearTimeout(this._growTimer); this._growTimer = null; }

        // Restore full opacity (in case idle fade was active)
        window.walkieTalkai.setOpacity(this._configOpacity);

        // Hide tab immediately
        this.collapsedTab.classList.add('hidden');

        if (resetContent) {
            // Reset content for new session
            this._cancelledSpans = [];
            this.transcriptArea.classList.add('hidden');
            this.responseArea.classList.add('hidden');
            this.responseContent.innerHTML = '';
            this.fullResponse = '';

            // Reset reasoning panel
            this.reasoningArea.classList.add('hidden');
            this.reasoningArea.classList.remove('expanded');
            this.reasoningContent.classList.add('hidden');
            this.reasoningContent.textContent = '';
            this.reasoningLabel.classList.remove('thinking');
            this.reasoningTimer.textContent = '';
            if (this._reasoningTimerHandle) {
                clearInterval(this._reasoningTimerHandle);
                this._reasoningTimerHandle = null;
            }
            this._reasoningActive = false;

            // Reset tool activity list
            this.toolArea.classList.add('hidden');
            this.toolList.innerHTML = '';
        }

        // Request window resize first
        window.walkieTalkai.expand();

        // Show container after a short delay to sync with window resize
        setTimeout(() => {
            this.container.classList.remove('hidden');
            this.hideError();
        }, 50);
    }

    collapseOverlay() {
        if (!this.isExpanded) return;
        this.isExpanded = false;
        this.clearAutoHideTimer();
        if (this._growTimer) { clearTimeout(this._growTimer); this._growTimer = null; }

        // Start the collapse animation on the container
        this.container.classList.add('collapsing');

        // Request window resize (animate from expanded to tab size)
        window.walkieTalkai.collapse();

        // After animation completes, swap visibility
        setTimeout(() => {
            this.container.classList.remove('collapsing');
            this.container.classList.add('hidden');
            this.collapsedTab.classList.remove('hidden');

            // Don't clear content on collapse — keep it for hover-to-view
            this._startIdleFadeTimer();
        }, 300); // slightly longer than ANIM_DURATION (280ms)
    }

    _growToFitContent() {
        // Debounce: wait for DOM to settle before measuring and requesting resize.
        if (this._growTimer) clearTimeout(this._growTimer);
        this._growTimer = setTimeout(() => {
            this._growTimer = null;
            const needed = document.documentElement.scrollHeight;
            if (needed > window.innerHeight + 4) { // 4px tolerance
                window.walkieTalkai.setHeight(needed + 16); // +16 breathing room
            }
        }, 80);
    }

    // -----------------------------------------------------------------------
    // Idle fade (opacity reduction after 30s in tab state)
    // -----------------------------------------------------------------------

    _startIdleFadeTimer() {
        this._clearIdleFadeTimer();
        this._idleFadeTimer = setTimeout(() => {
            if (!this.isExpanded) {
                window.walkieTalkai.setOpacity(this._configOpacity * 0.5);
            }
        }, 30000);
    }

    _clearIdleFadeTimer() {
        if (this._idleFadeTimer) {
            clearTimeout(this._idleFadeTimer);
            this._idleFadeTimer = null;
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Render transcript text with inline cancelled spans + active text.
     * Cancelled spans show struck-through and fade out, while active text
     * shifts to fill the space.
     */
    _renderTranscriptSpans(activeText) {
        let html = '';
        for (const c of this._cancelledSpans) {
            const cls = c.fading ? 'cancelled-span fading' : 'cancelled-span';
            html += `<span class="${cls}">${this._escapeHtml(c.text)}</span> `;
        }
        if (activeText) {
            html += `<span class="active-span">${this._escapeHtml(activeText)}</span>`;
        }
        this.transcriptText.innerHTML = html;
        this.transcriptText.className = 'transcript-text';
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

        html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_match, lang, code) => {
            const langAttr = lang ? ` data-lang="${lang}"` : '';
            return `<pre${langAttr}><code>${code.trim()}</code></pre>`;
        });

        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
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
