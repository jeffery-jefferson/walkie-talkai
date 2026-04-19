/**
 * Direct Copilot SDK integration — no more subprocess sidecar.
 *
 * Absorbs the logic from sidecar/session.mjs into the main process.
 */

import { CopilotClient } from '@github/copilot-sdk';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

export class CopilotManager {
  constructor() {
    this.client = null;
    this.session = null;
    this._model = null;
    this._systemPrompt = null;
    this._mcpServers = null;
    this._deltaUnsub = null;
    this._messageUnsub = null;
    this._reasoningUnsub = null;
    this._toolStartUnsub = null;
    this._toolCompleteUnsub = null;
    this._turnEndUnsub = null;
    this._idleUnsub = null;
    this._errorUnsub = null;
    this._running = false;

    // Prompt system state
    this._promptHandler = null;       // (request) => Promise<response>  set by main.js
    this._sessionApprovals = new Map(); // toolName → true  (per-session auto-approvals)
    this._approveAll = false;           // blanket approve for rest of session
    this._pendingPrompts = 0;           // counter for in-flight user prompts
  }

  get isRunning() {
    return this._running;
  }

  get currentModel() {
    return this._model;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async init(model, systemPrompt, mcpServers) {
    this._model = model;
    this._systemPrompt = systemPrompt;
    this._mcpServers = mcpServers || null;

    // In Electron, process.execPath is the Electron binary. The SDK's
    // getNodeExecPath() reads it to spawn the CLI server subprocess.
    // Temporarily point it at "node" so the SDK spawns system Node.js.
    const savedExecPath = process.execPath;
    process.execPath = 'node';
    this.client = new CopilotClient();
    await this.client.start();
    process.execPath = savedExecPath;

    const sessionOpts = {
      model,
      streaming: true,
      onPermissionRequest: (req, inv) => this._handlePermission(req, inv),
      onUserInputRequest: (req, inv) => this._handleUserInput(req, inv),
      onElicitationRequest: (ctx) => this._handleElicitation(ctx),
      systemMessage: { mode: 'replace', content: systemPrompt },
    };
    if (this._mcpServers && Object.keys(this._mcpServers).length > 0) {
      sessionOpts.mcpServers = this._mcpServers;
    }
    this.session = await this.client.createSession(sessionOpts);

    this._attachDiagnosticLogging();

    this._running = true;
    console.log(`Copilot session ready (model: ${model})`);
  }

  async stop() {
    this._cleanupListeners();
    this._detachDiagnosticLogging();
    this._running = false;

    if (this.session) {
      try { await this.session.destroy(); } catch { /* ignore */ }
      this.session = null;
    }
    if (this.client) {
      try { await this.client.stop(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // -----------------------------------------------------------------------
  // Send — async generator yielding tokens
  // -----------------------------------------------------------------------

  /**
   * Send a prompt and yield events as they arrive.
   *
   * Yields tagged events:
   *   { kind: 'reasoning_start' }
   *   { kind: 'reasoning', content: '...' }
   *   { kind: 'reasoning_end' }
   *   { kind: 'token', content: '...' }
   *
   * @param {string} prompt
   * @returns {string} Full response text (via generator return value)
   */
  async *send(prompt) {
    if (!this.session) {
      throw new Error('Copilot session not initialized');
    }

    this._cleanupListeners();

    let fullText = '';
    let streamedAnyToken = false;
    const eventQueue = [];
    let resolveWait = null;
    let done = false;
    let error = null;
    let activeReasoningId = null;
    const push = (event) => {
      eventQueue.push(event);
      if (resolveWait) { resolveWait(); resolveWait = null; }
    };

    const finishReasoningIfActive = () => {
      if (activeReasoningId !== null) {
        push({ kind: 'reasoning_end' });
        activeReasoningId = null;
      }
    };

    // Streaming response chunks (when streaming is supported)
    this._deltaUnsub = this.session.on('assistant.message_delta', (e) => {
      const chunk = e?.data?.deltaContent;
      if (chunk) {
        finishReasoningIfActive();
        fullText += chunk;
        streamedAnyToken = true;
        push({ kind: 'token', content: chunk });
      }
    });

    // Full message event — fires once per turn. For models that don't emit
    // deltas (or very short responses), this is our ONLY signal for content.
    // If we already streamed tokens, skip; otherwise yield the full content.
    this._messageUnsub = this.session.on('assistant.message', (e) => {
      const content = e?.data?.content;
      if (!content) return;
      console.log(`[copilot] assistant.message received (${content.length} chars, streamed=${streamedAnyToken})`);
      if (!streamedAnyToken) {
        finishReasoningIfActive();
        fullText = content;
        push({ kind: 'token', content });
      }
    });

    // Streaming reasoning/thinking chunks
    this._reasoningUnsub = this.session.on('assistant.reasoning_delta', (e) => {
      const chunk = e?.data?.deltaContent;
      const id = e?.data?.reasoningId;
      if (id && id !== activeReasoningId) {
        activeReasoningId = id;
        push({ kind: 'reasoning_start' });
      }
      if (chunk) push({ kind: 'reasoning', content: chunk });
    });

    // Tool execution — shows "running: toolName" while the agent works.
    // The complete event doesn't carry toolName, so we correlate by toolCallId.
    const toolNameById = new Map();
    this._toolStartUnsub = this.session.on('tool.execution_start', (e) => {
      toolNameById.set(e.data.toolCallId, e.data.toolName);
      push({
        kind: 'tool_start',
        toolCallId: e.data.toolCallId,
        toolName: e.data.toolName,
      });
    });

    this._toolCompleteUnsub = this.session.on('tool.execution_complete', (e) => {
      const toolName = toolNameById.get(e.data.toolCallId) || 'tool';
      toolNameById.delete(e.data.toolCallId);
      push({
        kind: 'tool_complete',
        toolCallId: e.data.toolCallId,
        toolName,
        success: e.data.success,
      });
    });

    // Turn boundary — fires after each assistant turn. In multi-turn agentic
    // flows the model may execute several turns (tool calls → server round-trip
    // → next turn) before the conversation is truly complete. We must NOT set
    // `done` here — otherwise the generator exits prematurely on tool-only
    // turns and the pipeline throws "no response" while the SDK continues.
    this._turnEndUnsub = this.session.on('assistant.turn_end', () => {
      console.log('[copilot] assistant.turn_end received');
      finishReasoningIfActive();
      // Wake the generator so queued events are yielded, but do NOT break.
      if (resolveWait) { resolveWait(); resolveWait = null; }
    });

    // True "done" signal — session becomes idle (no pending work).
    // The SDK fires session.idle while awaiting user permission responses
    // (the CLI considers "waiting for user input" as idle). We must DISCARD
    // that idle signal — not latch it — because after the user responds,
    // the SDK still needs to send the result back to the server, run the
    // tool, and stream the model's response. The server will fire a fresh
    // session.idle when the conversation truly completes.
    this._idleUnsub = this.session.on('session.idle', () => {
      if (this._pendingPrompts > 0) {
        console.log(`[copilot] session.idle ignored — ${this._pendingPrompts} pending prompt(s)`);
        return;
      }
      console.log('[copilot] session.idle resolved (fullText.length=' + fullText.length + ')');
      finishReasoningIfActive();
      done = true;
      if (resolveWait) { resolveWait(); resolveWait = null; }
    });

    // Real error event is "session.error" — "error" does not fire reliably.
    this._errorUnsub = this.session.on('session.error', (e) => {
      const rawMsg = e?.data?.message || e?.data?.error || JSON.stringify(e?.data);
      console.error('[copilot] session.error:', rawMsg);

      // Enrich common failure modes with actionable hints
      let msg = rawMsg;
      if (/list models/i.test(rawMsg)) {
        msg = `${rawMsg}\n\nCan't reach api.githubcopilot.com. ` +
              `If you're on a corporate network, set HTTPS_PROXY before launching. ` +
              `Run \`curl -v https://api.githubcopilot.com\` in a terminal to verify reachability.`;
      } else if (/auth|unauth|401|403/i.test(rawMsg)) {
        msg = `${rawMsg}\n\nAuthentication issue — run \`gh auth login\` and make sure your ` +
              `account has an active Copilot subscription.`;
      }

      error = new Error(msg);
      done = true;
      if (resolveWait) { resolveWait(); resolveWait = null; }
    });

    // Send the prompt
    console.log(`[copilot] sending prompt (${prompt.length} chars)`);
    try {
      const msgId = await this.session.send({ prompt });
      console.log(`[copilot] session.send returned messageId=${msgId}`);
    } catch (err) {
      console.error('[copilot] session.send threw:', err.message);
      throw err;
    }

    // Yield events as they arrive, with a safety timeout
    const MAX_WAIT_MS = 180000; // 3 minutes max per turn
    const startedAt = Date.now();
    try {
      while (true) {
        while (eventQueue.length > 0) {
          yield eventQueue.shift();
        }
        if (done) break;

        const elapsed = Date.now() - startedAt;
        if (elapsed > MAX_WAIT_MS) {
          console.error(`[copilot] timed out after ${MAX_WAIT_MS}ms — streamed=${streamedAnyToken}`);
          throw new Error(`Copilot response timed out after ${MAX_WAIT_MS / 1000}s`);
        }

        await new Promise((resolve) => { resolveWait = resolve; });
      }

      // Propagate errors so main.js can show them to the user
      if (error) {
        throw error;
      }

      // If we completed with no content at all, that's also a failure
      if (!streamedAnyToken && !fullText) {
        throw new Error('Copilot returned no response — check model availability and auth');
      }
    } finally {
      this._cleanupListeners();
    }

    this._cleanupListeners();

    if (error) {
      throw new Error(`Copilot error: ${error.message || error}`);
    }

    return fullText;
  }

  // -----------------------------------------------------------------------
  // Model switching and session reset
  // -----------------------------------------------------------------------

  async switchModel(model) {
    if (!this.session) throw new Error('Session not initialized');
    await this.session.setModel(model);
    this._model = model;
    console.log(`Copilot model switched to ${model}`);
  }

  /** Update MCP servers — requires full session recreate. */
  async updateMcpServers(mcpServers) {
    this._mcpServers = mcpServers || null;
    if (this._running) {
      await this.reset();
      console.log('Copilot session recreated with updated MCP servers');
    }
  }

  async reset() {
    if (!this.session) return;
    this.clearSessionApprovals();
    this._pendingPrompts = 0;

    const model = this._model;
    const systemPrompt = this._systemPrompt;

    this._detachDiagnosticLogging();
    await this.session.destroy();

    const sessionOpts = {
      model,
      streaming: true,
      onPermissionRequest: (req, inv) => this._handlePermission(req, inv),
      onUserInputRequest: (req, inv) => this._handleUserInput(req, inv),
      onElicitationRequest: (ctx) => this._handleElicitation(ctx),
      systemMessage: { mode: 'replace', content: systemPrompt },
    };
    if (this._mcpServers && Object.keys(this._mcpServers).length > 0) {
      sessionOpts.mcpServers = this._mcpServers;
    }
    this.session = await this.client.createSession(sessionOpts);

    this._attachDiagnosticLogging();
    console.log('Copilot session reset');
  }

  // -----------------------------------------------------------------------
  // Auto-restart on failure
  // -----------------------------------------------------------------------

  async restart() {
    const model = this._model;
    const systemPrompt = this._systemPrompt;

    await this.stop();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.init(model, systemPrompt, this._mcpServers);
        console.log(`Copilot restarted (attempt ${attempt})`);
        return;
      } catch (err) {
        console.error(`Copilot restart attempt ${attempt} failed:`, err.message);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
        }
      }
    }
    throw new Error('Copilot restart failed after max retries');
  }

  // -----------------------------------------------------------------------
  // Prompt system — interactive permissions, user input, elicitation
  // -----------------------------------------------------------------------

  /**
   * Set the handler that sends prompts to the overlay and returns responses.
   * Called by main.js during setup.
   * @param {(request: object) => Promise<object>} handler
   */
  setPromptHandler(handler) {
    this._promptHandler = handler;
  }

  /** Clear per-session tool approvals. Called on session reset/restart. */
  clearSessionApprovals() {
    this._sessionApprovals.clear();
    this._approveAll = false;
  }

  /**
   * SDK permission handler — checks cache, then delegates to overlay prompt.
   * @param {object} request  { kind, toolCallId, toolName?, ...details }
   * @param {object} invocation  { sessionId }
   * @returns {Promise<object>} PermissionRequestResult
   */
  async _handlePermission(request, _invocation) {
    const toolKey = request.toolName || request.kind;

    // Check blanket approval
    if (this._approveAll) {
      return { kind: 'approved' };
    }

    // Check per-tool session approval
    if (this._sessionApprovals.has(toolKey)) {
      return { kind: 'approved' };
    }

    // No prompt handler = auto-approve (fallback)
    if (!this._promptHandler) {
      return { kind: 'approved' };
    }

    // Delegate to overlay — track pending count so session.idle doesn't
    // prematurely terminate the generator while we await user input.
    this._pendingPrompts++;
    try {
      const response = await this._promptHandler({
        promptType: 'permission',
        kind: request.kind,
        toolName: toolKey,
        details: { ...request },
      });

      switch (response.action) {
        case 'allow':
          return { kind: 'approved' };
        case 'allow_session':
          this._sessionApprovals.set(toolKey, true);
          return { kind: 'approved' };
        case 'allow_all':
          this._approveAll = true;
          return { kind: 'approved' };
        case 'deny':
        default:
          return {
            kind: 'denied-interactively-by-user',
            ...(response.feedback ? { feedback: response.feedback } : {}),
          };
      }
    } finally {
      this._pendingPrompts--;
    }
  }

  /**
   * SDK user-input handler — shows a question in the overlay.
   * @param {object} request  { question, choices?, allowFreeform? }
   * @param {object} invocation  { sessionId }
   * @returns {Promise<object>} UserInputResponse
   */
  async _handleUserInput(request, _invocation) {
    if (!this._promptHandler) {
      return { answer: '', wasFreeform: true };
    }

    this._pendingPrompts++;
    try {
      const response = await this._promptHandler({
        promptType: 'user_input',
        question: request.question,
        choices: request.choices || null,
        allowFreeform: request.allowFreeform !== false,
      });

      return {
        answer: response.answer || '',
        wasFreeform: !!response.wasFreeform,
      };
    } finally {
      this._pendingPrompts--;
    }
  }

  /**
   * SDK elicitation handler — shows a form or opens a URL.
   * @param {object} context  { sessionId, message, requestedSchema?, mode?, url?, elicitationSource? }
   * @returns {Promise<object>} ElicitationResult
   */
  async _handleElicitation(context) {
    // URL mode: open in default browser, let user accept/cancel
    if (context.mode === 'url' && context.url) {
      const { shell } = await import('electron');
      shell.openExternal(context.url);
    }

    if (!this._promptHandler) {
      return { action: 'cancel' };
    }

    this._pendingPrompts++;
    try {
      const response = await this._promptHandler({
        promptType: 'elicitation',
        message: context.message,
        requestedSchema: context.requestedSchema || null,
        mode: context.mode || 'form',
        url: context.url || null,
        source: context.elicitationSource || null,
      });

      // Validate response action
      const validActions = ['accept', 'decline', 'cancel'];
      const action = validActions.includes(response.action) ? response.action : 'cancel';

      const result = { action };
      if (action === 'accept' && response.content) {
        result.content = this._validateElicitationContent(response.content, context.requestedSchema);
      }
      return result;
    } finally {
      this._pendingPrompts--;
    }
  }

  /**
   * Validate/coerce elicitation form values against the schema before
   * returning to the SDK. Drops unknown fields, coerces types.
   */
  _validateElicitationContent(content, schema) {
    if (!schema || !schema.properties) return content;

    const validated = {};
    for (const [key, fieldSchema] of Object.entries(schema.properties)) {
      if (!(key in content)) continue;
      const val = content[key];

      if (fieldSchema.type === 'boolean') {
        validated[key] = val === true || val === 'true';
      } else if (fieldSchema.type === 'number' || fieldSchema.type === 'integer') {
        const num = Number(val);
        if (!isNaN(num)) validated[key] = fieldSchema.type === 'integer' ? Math.round(num) : num;
      } else if (fieldSchema.type === 'array') {
        validated[key] = Array.isArray(val) ? val.map(String) : [];
      } else {
        validated[key] = String(val);
      }
    }
    return validated;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  _cleanupListeners() {
    if (this._deltaUnsub) { this._deltaUnsub(); this._deltaUnsub = null; }
    if (this._messageUnsub) { this._messageUnsub(); this._messageUnsub = null; }
    if (this._reasoningUnsub) { this._reasoningUnsub(); this._reasoningUnsub = null; }
    if (this._toolStartUnsub) { this._toolStartUnsub(); this._toolStartUnsub = null; }
    if (this._toolCompleteUnsub) { this._toolCompleteUnsub(); this._toolCompleteUnsub = null; }
    if (this._turnEndUnsub) { this._turnEndUnsub(); this._turnEndUnsub = null; }
    if (this._idleUnsub) { this._idleUnsub(); this._idleUnsub = null; }
    if (this._errorUnsub) { this._errorUnsub(); this._errorUnsub = null; }
  }

  /**
   * Attach per-session diagnostic logging. These subscriptions stay active
   * for the full session lifetime (distinct from the per-request listeners
   * above). Every interesting SDK event is logged with a timestamp so the
   * user can verify the agent is actually progressing, even when the UI
   * appears quiet.
   */
  _attachDiagnosticLogging() {
    if (this._diagUnsubs) return;
    this._diagUnsubs = [];

    const log = (label, detail) => {
      const ts = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
      const msg = detail ? `[${ts}] [copilot] ${label}: ${detail}` : `[${ts}] [copilot] ${label}`;
      console.log(msg);
    };

    const on = (eventName, handler) => {
      this._diagUnsubs.push(this.session.on(eventName, handler));
    };

    // Turn lifecycle
    on('assistant.turn_start', () => log('turn_start'));
    on('assistant.turn_end', (e) => {
      const reason = e?.data?.reason || '';
      log('turn_end', reason);
    });
    on('assistant.intent', (e) => log('intent', e?.data?.intent || JSON.stringify(e?.data).slice(0, 120)));

    // Reasoning (size-based logging to avoid flooding)
    let reasoningBytes = 0;
    let reasoningStart = 0;
    on('assistant.reasoning_delta', (e) => {
      if (reasoningBytes === 0) {
        reasoningStart = Date.now();
        log('reasoning_delta', 'started');
      }
      reasoningBytes += (e?.data?.deltaContent || '').length;
    });
    on('assistant.reasoning', (e) => {
      const len = (e?.data?.content || '').length;
      const elapsed = reasoningStart ? ((Date.now() - reasoningStart) / 1000).toFixed(1) : '?';
      log('reasoning', `complete, ${len} chars, ${elapsed}s`);
      reasoningBytes = 0; reasoningStart = 0;
    });

    // Response
    let messageBytes = 0;
    on('assistant.message_delta', (e) => {
      messageBytes += (e?.data?.deltaContent || '').length;
    });
    on('assistant.message', (e) => {
      const len = messageBytes || (e?.data?.content || '').length;
      log('message', `${len} chars`);
      messageBytes = 0;
    });

    // Tool calls
    on('tool.execution_start', (e) => {
      const name = e?.data?.toolName || '?';
      const args = e?.data?.arguments ? JSON.stringify(e.data.arguments).slice(0, 140) : '';
      log('tool.execution_start', args ? `${name} args=${args}` : name);
    });
    on('tool.execution_progress', (e) => {
      log('tool.execution_progress', e?.data?.toolCallId || '');
    });
    on('tool.execution_complete', (e) => {
      const ok = e?.data?.success ? 'success' : 'FAILED';
      log('tool.execution_complete', `${e?.data?.toolCallId} ${ok}`);
    });

    // Shell commands (agent running terminal commands)
    on('command.queued', (e) => log('command.queued', e?.data?.command || ''));
    on('command.execute', (e) => log('command.execute', e?.data?.command || ''));
    on('command.completed', (e) => {
      const ok = e?.data?.exitCode === 0 ? 'ok' : `exit=${e?.data?.exitCode}`;
      log('command.completed', ok);
    });

    // Permission & approval
    on('permission.requested', (e) => log('permission.requested', e?.data?.toolName || ''));
    on('permission.completed', (e) => log('permission.completed', e?.data?.approved ? 'approved' : 'denied'));

    // Session-level signals (very useful for "is anything happening?")
    on('session.idle', () => log('session.idle'));
    on('session.info', (e) => log('session.info', JSON.stringify(e?.data).slice(0, 140)));
    on('session.warning', (e) => log('session.warning', e?.data?.message || ''));
    on('session.error', (e) => log('session.error', e?.data?.message || JSON.stringify(e?.data)));
    on('session.background_tasks_changed', (e) =>
      log('session.background_tasks_changed', `tasks=${e?.data?.taskCount ?? '?'}`));
    on('session.compaction_start', () => log('session.compaction_start'));
    on('session.compaction_complete', () => log('session.compaction_complete'));
    on('session.usage_info', (e) => log('session.usage_info', JSON.stringify(e?.data).slice(0, 120)));

    // Subagents
    on('subagent.started', (e) => log('subagent.started', e?.data?.name || ''));
    on('subagent.completed', (e) => log('subagent.completed', e?.data?.name || ''));
    on('subagent.failed', (e) => log('subagent.failed', e?.data?.name || ''));

    // Generic error
    on('error', (e) => log('error', e?.message || JSON.stringify(e).slice(0, 140)));

    // Catch-all — log EVERY event type we haven't already wired up.
    // This is our safety net for discovering new or unexpected events.
    const KNOWN = new Set([
      'assistant.turn_start', 'assistant.turn_end', 'assistant.intent',
      'assistant.reasoning_delta', 'assistant.reasoning',
      'assistant.message_delta', 'assistant.message',
      'assistant.streaming_delta',
      'tool.execution_start', 'tool.execution_progress', 'tool.execution_complete',
      'command.queued', 'command.execute', 'command.completed',
      'permission.requested', 'permission.completed',
      'session.idle', 'session.info', 'session.warning', 'session.error',
      'session.background_tasks_changed', 'session.compaction_start',
      'session.compaction_complete', 'session.usage_info',
      'subagent.started', 'subagent.completed', 'subagent.failed',
      'error',
    ]);
    this._diagUnsubs.push(this.session.on((event) => {
      if (!KNOWN.has(event?.type)) {
        log(`unhandled-event`, `${event?.type} data=${JSON.stringify(event?.data).slice(0, 140)}`);
      }
    }));

    log('diagnostic logging attached');
  }

  _detachDiagnosticLogging() {
    if (!this._diagUnsubs) return;
    for (const u of this._diagUnsubs) {
      try { u(); } catch { /* ignore */ }
    }
    this._diagUnsubs = null;
  }
}
