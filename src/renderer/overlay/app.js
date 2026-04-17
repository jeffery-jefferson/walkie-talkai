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
        this._lastMouseX = 0;
        this._lastMouseY = 0;
        this._hoverPollTimer = null;
        this._configOpacity = 1.0;

        // Prompt system state
        this._promptQueue = [];      // FIFO queue of pending prompt events
        this._activePrompt = null;   // Currently displayed prompt { requestId, promptType, ... }

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

        // Listen for prompt requests (permissions, user input, elicitation).
        window.walkieTalkai.onPrompt((data) => this.enqueuePrompt(data));

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
                // Don't re-enable click-through during hover-expand transition
                if (!this._hoverExpanded) {
                    window.walkieTalkai.setIgnoreMouse(true);
                }
            });
        }

        // Hover on collapsed tab to view previous output
        this.collapsedTab.addEventListener('mouseenter', () => {
            if (!this.isExpanded && this.fullResponse) {
                this._hoverExpanded = true;
                this.clearAutoHideTimer();
                this.expandOverlay({ resetContent: false });
                // Start polling for mouse exit after container appears
                setTimeout(() => this._startHoverPoll(), 100);
            }
        });

        // Detect mouse leaving the overlay while hover-expanded.
        // Uses a poll interval because transparent Electron windows
        // don't reliably fire mouseleave on inner elements.
        this._hoverPollTimer = null;
        document.addEventListener('mousemove', (e) => {
            if (!this._hoverExpanded) return;
            this._lastMouseX = e.clientX;
            this._lastMouseY = e.clientY;
        });

        // When mouse leaves the document/window entirely, collapse
        document.addEventListener('mouseleave', () => {
            if (this._hoverExpanded) {
                this._endHoverExpand();
            }
        });

        // Poll: if mouse is outside any visible element, collapse
        this._startHoverPoll = () => {
            if (this._hoverPollTimer) return;
            this._hoverPollTimer = setInterval(() => {
                if (!this._hoverExpanded) {
                    clearInterval(this._hoverPollTimer);
                    this._hoverPollTimer = null;
                    return;
                }
                const el = document.elementFromPoint(this._lastMouseX, this._lastMouseY);
                // If mouse isn't over any overlay element, collapse
                if (!el || (!this.container.contains(el) && !this.collapsedTab.contains(el))) {
                    this._endHoverExpand();
                }
            }, 200);
        };
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
        this.promptArea = document.getElementById('prompt-area');
        this.promptMessage = document.getElementById('prompt-message');
        this.promptBody = document.getElementById('prompt-body');
        this.promptActions = document.getElementById('prompt-actions');

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
                if (this._hoverPollTimer) { clearInterval(this._hoverPollTimer); this._hoverPollTimer = null; }
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
            // Don't reset content if a prompt is showing
            if (this._activePrompt) {
                resetContent = false;
            }
        }

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
        // Don't collapse while a prompt is active
        if (this._activePrompt) return;
        this.isExpanded = false;
        this._hoverExpanded = false;
        if (this._hoverPollTimer) { clearInterval(this._hoverPollTimer); this._hoverPollTimer = null; }
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

    /** End a hover-expand: restore click-through and collapse. */
    _endHoverExpand() {
        if (!this._hoverExpanded) return;
        this._hoverExpanded = false;
        if (this._hoverPollTimer) { clearInterval(this._hoverPollTimer); this._hoverPollTimer = null; }
        window.walkieTalkai.setIgnoreMouse(true);
        this.collapseOverlay();
    }

    _growToFitContent() {
        // Only grow when expanded — prevent ghost window after collapse
        if (!this.isExpanded) return;
        // Debounce: wait for DOM to settle before measuring and requesting resize.
        if (this._growTimer) clearTimeout(this._growTimer);
        this._growTimer = setTimeout(() => {
            this._growTimer = null;
            if (!this.isExpanded) return; // re-check after debounce
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
        if (this._activePrompt) return; // don't auto-hide with prompt active
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

    // -----------------------------------------------------------------------
    // Prompt system — permissions, user input, elicitation
    // -----------------------------------------------------------------------

    /**
     * Add a prompt to the queue. If no prompt is active, show it immediately.
     */
    enqueuePrompt(data) {
        if (this._activePrompt) {
            this._promptQueue.push(data);
            return;
        }
        this._showPrompt(data);
    }

    /**
     * Display a prompt in the overlay. Expands and switches to interactive mode.
     */
    _showPrompt(data) {
        this._activePrompt = data;
        this.clearAutoHideTimer();
        this._clearIdleFadeTimer();
        window.walkieTalkai.setOpacity(this._configOpacity);

        // Expand overlay if collapsed
        if (!this.isExpanded) {
            this.expandOverlay({ resetContent: false });
        }

        // Enter interactive mode (focusable, no click-through)
        window.walkieTalkai.setInteractive(true);

        // Render based on prompt type
        switch (data.promptType) {
            case 'permission':
                this._renderPermissionPrompt(data);
                break;
            case 'user_input':
                this._renderUserInputPrompt(data);
                break;
            case 'elicitation':
                this._renderElicitationPrompt(data);
                break;
        }

        this.promptArea.classList.remove('hidden');
        this._growToFitContent();
        this.scrollToBottom();
    }

    /**
     * Send response and advance to next queued prompt or restore overlay state.
     */
    _dismissPrompt(response) {
        if (!this._activePrompt) return;
        const requestId = this._activePrompt.requestId;

        window.walkieTalkai.respondPrompt(requestId, response);

        // Clear prompt UI
        this.promptArea.classList.add('hidden');
        this.promptMessage.innerHTML = '';
        this.promptBody.innerHTML = '';
        this.promptActions.innerHTML = '';
        this._activePrompt = null;

        // Show next queued prompt or exit interactive mode
        if (this._promptQueue.length > 0) {
            this._showPrompt(this._promptQueue.shift());
        } else {
            window.walkieTalkai.setInteractive(false);
            this._growToFitContent();
            this.startAutoHideTimer();
        }
    }

    // -- Permission prompt --------------------------------------------------

    _renderPermissionPrompt(data) {
        const kind = data.kind || 'unknown';
        const toolName = data.details?.toolName || kind;

        // Build message with badge
        this.promptMessage.innerHTML =
            `<div class="prompt-kind-badge permission">Permission</div>` +
            `<div><strong>${this._escapeHtml(toolName)}</strong> wants to execute a ` +
            `<em>${this._escapeHtml(kind)}</em> action.</div>`;

        // Details
        this.promptBody.innerHTML = this._renderPermissionDetails(data);

        // Action buttons
        this.promptActions.innerHTML = '';
        const actions = [
            { label: 'Allow', cls: 'allow', action: 'allow' },
            { label: 'Deny', cls: 'deny', action: 'deny' },
            { label: 'Allow for Session', cls: 'session', action: 'allow_session' },
            { label: 'Allow All', cls: 'all', action: 'allow_all' },
        ];

        for (const a of actions) {
            const btn = document.createElement('button');
            btn.className = `prompt-btn ${a.cls}`;
            btn.textContent = a.label;
            btn.addEventListener('click', () => {
                if (a.action === 'deny') {
                    this._showDenyFeedback();
                } else {
                    this._dismissPrompt({ action: a.action });
                }
            });
            this.promptActions.appendChild(btn);
        }
    }

    _renderPermissionDetails(data) {
        const details = data.details || {};
        const parts = [];
        if (details.command) parts.push(`<strong>Command:</strong> <code>${this._escapeHtml(String(details.command))}</code>`);
        if (details.path) parts.push(`<strong>Path:</strong> <code>${this._escapeHtml(String(details.path))}</code>`);
        if (details.url) parts.push(`<strong>URL:</strong> <code>${this._escapeHtml(String(details.url))}</code>`);
        return parts.length > 0
            ? `<div style="font-size:11px;color:#a6adc8;line-height:1.5">${parts.join('<br>')}</div>`
            : '';
    }

    _showDenyFeedback() {
        // Replace buttons with feedback textarea + confirm deny
        this.promptActions.innerHTML = '';

        const fb = document.createElement('div');
        fb.className = 'prompt-feedback-area';

        const textarea = document.createElement('textarea');
        textarea.className = 'prompt-text-input';
        textarea.placeholder = 'Reason for denying (optional)';
        textarea.rows = 2;
        fb.appendChild(textarea);

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'prompt-btn deny';
        confirmBtn.textContent = 'Confirm Deny';
        confirmBtn.addEventListener('click', () => {
            this._dismissPrompt({ action: 'deny', feedback: textarea.value || undefined });
        });
        fb.appendChild(confirmBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'prompt-btn';
        cancelBtn.textContent = 'Back';
        cancelBtn.addEventListener('click', () => {
            this._renderPermissionPrompt(this._activePrompt);
        });
        fb.appendChild(cancelBtn);

        this.promptActions.appendChild(fb);
        textarea.focus();
        this._growToFitContent();
    }

    // -- User input prompt --------------------------------------------------

    _renderUserInputPrompt(data) {
        this.promptMessage.innerHTML =
            `<div class="prompt-kind-badge user-input">Question</div>` +
            `<div>${this._escapeHtml(data.question)}</div>`;

        this.promptBody.innerHTML = '';
        this.promptActions.innerHTML = '';

        // Choice buttons
        if (data.choices && data.choices.length > 0) {
            for (const choice of data.choices) {
                const btn = document.createElement('button');
                btn.className = 'prompt-choice-btn';
                btn.textContent = choice;
                btn.addEventListener('click', () => {
                    this._dismissPrompt({ answer: choice, wasFreeform: false });
                });
                this.promptBody.appendChild(btn);
            }
        }

        // Freeform text input
        if (data.allowFreeform) {
            const inputArea = document.createElement('div');
            inputArea.style.marginTop = '6px';

            const textarea = document.createElement('textarea');
            textarea.className = 'prompt-text-input';
            textarea.placeholder = 'Type your answer...';
            textarea.rows = 2;
            inputArea.appendChild(textarea);

            const submitBtn = document.createElement('button');
            submitBtn.className = 'prompt-btn allow';
            submitBtn.textContent = 'Submit';
            submitBtn.style.marginTop = '4px';
            submitBtn.addEventListener('click', () => {
                this._dismissPrompt({ answer: textarea.value, wasFreeform: true });
            });
            inputArea.appendChild(submitBtn);

            // Allow Enter to submit (Shift+Enter for newline)
            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this._dismissPrompt({ answer: textarea.value, wasFreeform: true });
                }
            });

            this.promptBody.appendChild(inputArea);
            setTimeout(() => textarea.focus(), 60);
        }

        // Cancel button
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'prompt-btn deny';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this._dismissPrompt({ answer: '', wasFreeform: true });
        });
        this.promptActions.appendChild(cancelBtn);
    }

    // -- Elicitation prompt (form-based) ------------------------------------

    _renderElicitationPrompt(data) {
        const source = data.source ? ` (${this._escapeHtml(data.source)})` : '';
        this.promptMessage.innerHTML =
            `<div class="prompt-kind-badge elicitation">Form${source}</div>` +
            `<div>${this._escapeHtml(data.message)}</div>`;

        this.promptBody.innerHTML = '';
        this.promptActions.innerHTML = '';

        // URL mode: show a link and Accept/Cancel
        if (data.mode === 'url' && data.url) {
            const link = document.createElement('div');
            link.innerHTML = `<div style="font-size:11px;color:#a6adc8;margin-bottom:6px">` +
                `A URL has been opened in your browser.</div>`;
            this.promptBody.appendChild(link);
        }

        // Form fields from schema
        const formValues = {};
        if (data.requestedSchema && data.requestedSchema.properties) {
            for (const [key, field] of Object.entries(data.requestedSchema.properties)) {
                const fieldEl = this._renderFormField(key, field, formValues);
                this.promptBody.appendChild(fieldEl);
            }
        }

        // Accept / Decline / Cancel buttons
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'prompt-btn allow';
        acceptBtn.textContent = 'Accept';
        acceptBtn.addEventListener('click', () => {
            this._dismissPrompt({ action: 'accept', content: { ...formValues } });
        });
        this.promptActions.appendChild(acceptBtn);

        const declineBtn = document.createElement('button');
        declineBtn.className = 'prompt-btn deny';
        declineBtn.textContent = 'Decline';
        declineBtn.addEventListener('click', () => {
            this._dismissPrompt({ action: 'decline' });
        });
        this.promptActions.appendChild(declineBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'prompt-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this._dismissPrompt({ action: 'cancel' });
        });
        this.promptActions.appendChild(cancelBtn);
    }

    /**
     * Render a single form field and bind its value to formValues[key].
     */
    _renderFormField(key, field, formValues) {
        const wrapper = document.createElement('div');
        wrapper.className = 'prompt-form-field';

        // Label
        const label = document.createElement('label');
        label.textContent = field.title || key;
        wrapper.appendChild(label);

        // Description
        if (field.description) {
            const desc = document.createElement('div');
            desc.className = 'field-description';
            desc.textContent = field.description;
            wrapper.appendChild(desc);
        }

        // Set default
        if (field.default !== undefined) {
            formValues[key] = field.default;
        }

        if (field.type === 'boolean') {
            const checkDiv = document.createElement('div');
            checkDiv.className = 'prompt-form-checkbox';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!field.default;
            formValues[key] = !!field.default;
            cb.addEventListener('change', () => { formValues[key] = cb.checked; });
            const cbLabel = document.createElement('span');
            cbLabel.textContent = field.title || key;
            checkDiv.appendChild(cb);
            checkDiv.appendChild(cbLabel);
            wrapper.appendChild(checkDiv);
        } else if (field.enum) {
            // Dropdown select
            const sel = document.createElement('select');
            for (const opt of field.enum) {
                const o = document.createElement('option');
                o.value = opt;
                o.textContent = (field.enumNames && field.enumNames[field.enum.indexOf(opt)]) || opt;
                sel.appendChild(o);
            }
            sel.value = field.default || field.enum[0];
            formValues[key] = sel.value;
            sel.addEventListener('change', () => { formValues[key] = sel.value; });
            wrapper.appendChild(sel);
        } else if (field.oneOf) {
            // Radio-style dropdown
            const sel = document.createElement('select');
            for (const opt of field.oneOf) {
                const o = document.createElement('option');
                o.value = opt.const;
                o.textContent = opt.title;
                sel.appendChild(o);
            }
            sel.value = field.default || field.oneOf[0].const;
            formValues[key] = sel.value;
            sel.addEventListener('change', () => { formValues[key] = sel.value; });
            wrapper.appendChild(sel);
        } else if (field.type === 'array') {
            // Multi-select checkboxes
            const msDiv = document.createElement('div');
            msDiv.className = 'prompt-form-multi-select';
            formValues[key] = Array.isArray(field.default) ? [...field.default] : [];

            const items = field.items?.enum || field.items?.anyOf?.map(a => a.const) || [];
            const itemLabels = field.items?.anyOf?.map(a => a.title) || items;

            for (let i = 0; i < items.length; i++) {
                const itemLabel = document.createElement('label');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = items[i];
                cb.checked = formValues[key].includes(items[i]);
                cb.addEventListener('change', () => {
                    if (cb.checked) {
                        if (!formValues[key].includes(cb.value)) formValues[key].push(cb.value);
                    } else {
                        formValues[key] = formValues[key].filter(v => v !== cb.value);
                    }
                });
                itemLabel.appendChild(cb);
                itemLabel.appendChild(document.createTextNode(' ' + (itemLabels[i] || items[i])));
                msDiv.appendChild(itemLabel);
            }
            wrapper.appendChild(msDiv);
        } else if (field.type === 'number' || field.type === 'integer') {
            const input = document.createElement('input');
            input.type = 'number';
            if (field.minimum !== undefined) input.min = field.minimum;
            if (field.maximum !== undefined) input.max = field.maximum;
            if (field.type === 'integer') input.step = 1;
            input.value = field.default !== undefined ? field.default : '';
            formValues[key] = field.default !== undefined ? field.default : 0;
            input.addEventListener('input', () => {
                const v = field.type === 'integer' ? parseInt(input.value) : parseFloat(input.value);
                formValues[key] = isNaN(v) ? 0 : v;
            });
            wrapper.appendChild(input);
        } else {
            // String input
            const input = document.createElement('input');
            input.type = field.format === 'email' ? 'email'
                       : field.format === 'uri' ? 'url'
                       : field.format === 'date' ? 'date'
                       : field.format === 'date-time' ? 'datetime-local'
                       : 'text';
            input.value = field.default || '';
            input.placeholder = field.title || key;
            formValues[key] = field.default || '';
            input.addEventListener('input', () => { formValues[key] = input.value; });
            wrapper.appendChild(input);
        }

        return wrapper;
    }

    // -- Utilities ----------------------------------------------------------

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.overlay = new WalkieTalkAIOverlay();
});
