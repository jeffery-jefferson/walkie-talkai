/**
 * Event type builders for overlay IPC communication.
 *
 * Each builder returns a plain object matching the JSON shapes
 * consumed by the overlay renderer (app.js handleMessage switch).
 */

function normalizeTranscriptionCase(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export const StatusEvent = (state) => ({ type: 'status', state });

export const TranscriptEvent = (text) => ({ type: 'transcript', text: normalizeTranscriptionCase(text) });

export const TokenEvent = (content) => ({ type: 'token', content });

export const DoneEvent = (fullText) => ({ type: 'done', full_text: fullText });

export const ErrorEvent = (message) => ({ type: 'error', message });

export const CancelledEvent = (phrase, fullText) => ({
  type: 'cancelled',
  phrase: normalizeTranscriptionCase(phrase),
  full_text: normalizeTranscriptionCase(fullText),
});

export const HideEvent = () => ({ type: 'hide' });

/** Incremental reasoning/thinking tokens from the model. */
export const ReasoningEvent = (content) => ({ type: 'reasoning', content });

/** Model switched to a new reasoning block — prepare to stream fresh chunks. */
export const ReasoningStartEvent = () => ({ type: 'reasoning_start' });

/** Model finished reasoning, about to start writing the response. */
export const ReasoningEndEvent = () => ({ type: 'reasoning_end' });

/** Agent started running a tool (file read, edit, shell, etc). */
export const ToolStartEvent = (toolCallId, toolName) => ({
  type: 'tool_start',
  tool_call_id: toolCallId,
  tool_name: toolName,
});

/** Agent finished running a tool. */
export const ToolCompleteEvent = (toolCallId, toolName, success) => ({
  type: 'tool_complete',
  tool_call_id: toolCallId,
  tool_name: toolName,
  success,
});

// -----------------------------------------------------------------------
// User prompt events — modular prompt system for permissions, user input,
// and elicitation requests from the Copilot SDK.
// -----------------------------------------------------------------------

/**
 * Permission prompt — tool wants approval to run.
 * @param {string} requestId  Unique ID for correlating response
 * @param {string} kind       "shell"|"write"|"mcp"|"read"|"url"|"custom-tool"
 * @param {object} details    Extra context (toolName, command, path, etc.)
 */
export const PermissionPromptEvent = (requestId, kind, details = {}) => ({
  type: 'prompt',
  promptType: 'permission',
  requestId,
  kind,
  details,
});

/**
 * User input prompt — agent is asking the user a question.
 * @param {string} requestId     Unique ID for correlating response
 * @param {string} question      The question text
 * @param {string[]} [choices]   Optional multiple-choice options
 * @param {boolean} [allowFreeform] Whether freeform text is accepted
 */
export const UserInputPromptEvent = (requestId, question, choices, allowFreeform) => ({
  type: 'prompt',
  promptType: 'user_input',
  requestId,
  question,
  choices: choices || null,
  allowFreeform: allowFreeform !== false,
});

/**
 * Elicitation prompt — agent wants structured form input.
 * @param {string} requestId        Unique ID for correlating response
 * @param {string} message          Description of what's needed
 * @param {object} [requestedSchema] JSON Schema for form fields
 * @param {string} [mode]           "form" or "url"
 * @param {string} [url]            URL to open (url mode)
 * @param {string} [source]         Elicitation source (e.g. MCP server name)
 */
export const ElicitationPromptEvent = (requestId, message, requestedSchema, mode, url, source) => ({
  type: 'prompt',
  promptType: 'elicitation',
  requestId,
  message,
  requestedSchema: requestedSchema || null,
  mode: mode || 'form',
  url: url || null,
  source: source || null,
});
