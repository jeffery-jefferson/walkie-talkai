/**
 * Electron main process — app lifecycle, overlay window, tray,
 * STT pipeline, Copilot integration, config watcher.
 */

import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getUserConfigPath, PROJECT_ROOT } from './config.js';
import { loadAllMcpServers, loadAppMcpConfig, saveAppMcpConfig, loadExternalMcpConfig, getAppMcpConfigPath } from './mcp-config.js';
import { installLogger, getLogPath } from './logger.js';
import { ConfigWatcher } from './config-watcher.js';

// Install the file logger before anything else so nothing is lost
installLogger();
import { SystemTray } from './tray.js';
import { SttPipeline } from './stt-pipeline.js';
import { CopilotManager } from './copilot.js';
import { registerSettingsIPC, registerMcpIPC } from './ipc-handlers.js';
import {
  StatusEvent, TranscriptEvent, TokenEvent,
  DoneEvent, ErrorEvent, CancelledEvent,
  ReasoningEvent, ReasoningStartEvent, ReasoningEndEvent,
  ToolStartEvent, ToolCompleteEvent,
  PermissionPromptEvent, UserInputPromptEvent, ElicitationPromptEvent,
} from './protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_WIDTH = 100;
const TAB_HEIGHT = 24;
const ANIM_STEPS = 20;
const ANIM_DURATION = 280; // ms

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let overlayWindow = null;
let settingsWindow = null;
let config = null;
let expandedWidth = 340;
let expandedHeight = 260;
let animTimer = null;

let tray = null;
let sttPipeline = null;
let copilot = null;
let configWatcher = null;
let isEnabled = true;
let requestGen = 0; // stale response counter

// Prompt system state — pending promises keyed by requestId
const pendingPrompts = new Map();
let promptCounter = 0;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for permissions

// ---------------------------------------------------------------------------
// Send event to overlay renderer
// ---------------------------------------------------------------------------

function sendOverlayEvent(event) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-event', event);
  }
}

/**
 * Send a prompt to the overlay and return a Promise that resolves with the
 * user's response. Used as the copilot prompt handler.
 */
function sendOverlayPrompt(request) {
  return new Promise((resolve, reject) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      // No overlay → can't ask user, deny permissions / cancel elicitation
      if (request.promptType === 'permission') {
        resolve({ action: 'allow' }); // safe fallback
      } else {
        resolve({ action: 'cancel' });
      }
      return;
    }

    const requestId = `prompt-${++promptCounter}`;
    let timer = null;

    // Timeout for permissions only (5 min)
    if (request.promptType === 'permission') {
      timer = setTimeout(() => {
        pendingPrompts.delete(requestId);
        resolve({ action: 'deny', feedback: 'Timed out waiting for user response' });
      }, PERMISSION_TIMEOUT_MS);
    }

    pendingPrompts.set(requestId, { resolve, reject, timer, promptType: request.promptType });

    // Build the appropriate protocol event
    let event;
    switch (request.promptType) {
      case 'permission':
        event = PermissionPromptEvent(requestId, request.kind, {
          toolName: request.toolName,
          ...request.details,
        });
        break;
      case 'user_input':
        event = UserInputPromptEvent(requestId, request.question, request.choices, request.allowFreeform);
        break;
      case 'elicitation':
        event = ElicitationPromptEvent(
          requestId, request.message, request.requestedSchema,
          request.mode, request.url, request.source,
        );
        break;
      default:
        resolve({ action: 'cancel' });
        return;
    }

    overlayWindow.webContents.send('overlay-prompt', event);
  });
}

/**
 * Flush all pending prompts (e.g. on session reset, app quit).
 */
function flushPendingPrompts() {
  for (const [id, pending] of pendingPrompts) {
    clearTimeout(pending.timer);
    if (pending.promptType === 'permission') {
      pending.resolve({ action: 'deny', feedback: 'Session reset' });
    } else {
      pending.resolve({ action: 'cancel' });
    }
  }
  pendingPrompts.clear();
}

// ---------------------------------------------------------------------------
// Window position helpers
// ---------------------------------------------------------------------------

function getOverlayPosition(cfg) {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const margin = 12;
  const pos = cfg.overlay.position || 'top-left';
  const w = cfg.overlay.max_width || 340;
  const h = TAB_HEIGHT;

  const positions = {
    'top-left':      { x: margin, y: margin },
    'top-right':     { x: screenW - w - margin, y: margin },
    'top-center':    { x: Math.round((screenW - w) / 2), y: margin },
    'bottom-left':   { x: margin, y: screenH - h - margin },
    'bottom-right':  { x: screenW - w - margin, y: screenH - h - margin },
    'bottom-center': { x: Math.round((screenW - w) / 2), y: screenH - h - margin },
  };

  return positions[pos] || positions['top-left'];
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

function easeInOut(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animateResize(win, fromW, fromH, toW, toH) {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  const stepDelay = ANIM_DURATION / ANIM_STEPS;
  let step = 0;

  animTimer = setInterval(() => {
    step++;
    const t = easeInOut(step / ANIM_STEPS);
    const w = Math.round(fromW + (toW - fromW) * t);
    const h = Math.round(fromH + (toH - fromH) * t);
    if (!win.isDestroyed()) win.setSize(w, h);
    if (step >= ANIM_STEPS) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }, stepDelay);
}

// ---------------------------------------------------------------------------
// Overlay window
// ---------------------------------------------------------------------------

function createOverlayWindow() {
  const pos = getOverlayPosition(config);
  expandedWidth = config.overlay.max_width;
  expandedHeight = config.overlay.max_height;

  overlayWindow = new BrowserWindow({
    width: TAB_WIDTH,
    height: TAB_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setOpacity(config.overlay.opacity);

  // Let clicks pass through transparent areas to windows beneath.
  // The renderer toggles this off on mouseenter over visible elements.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));

  // Push the current auto-hide timer to the renderer once it's ready
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('overlay-config', {
      auto_hide_seconds: config.overlay.auto_hide_seconds,
      opacity: config.overlay.opacity,
    });
  });

  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function registerOverlayIPC() {
  ipcMain.on('overlay-expand', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [curW, curH] = overlayWindow.getSize();
    animateResize(overlayWindow, curW, curH, expandedWidth, expandedHeight);
  });

  ipcMain.on('overlay-collapse', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const [curW, curH] = overlayWindow.getSize();
    animateResize(overlayWindow, curW, curH, TAB_WIDTH, TAB_HEIGHT);
  });

  ipcMain.on('overlay-set-height', (_event, h) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    // Only resize if window is already at expanded width (not collapsed tab)
    const [curW] = overlayWindow.getSize();
    if (curW <= TAB_WIDTH) return;
    const bounded = Math.min(Math.max(h, TAB_HEIGHT), expandedHeight);
    const [, curH] = overlayWindow.getSize();
    animateResize(overlayWindow, curW, curH, expandedWidth, bounded);
  });

  ipcMain.on('overlay-set-ignore-mouse', (_event, ignore) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (ignore) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      overlayWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on('overlay-set-opacity', (_event, opacity) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setOpacity(opacity);
  });

  // Interactive mode toggle — prompt system needs keyboard focus
  ipcMain.on('overlay-set-interactive', (_event, active) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (active) {
      overlayWindow.setFocusable(true);
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.focus();
    } else {
      overlayWindow.setFocusable(false);
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  // Prompt response from overlay renderer
  ipcMain.on('overlay-prompt-response', (event, requestId, response) => {
    // Validate sender — only accept from overlay window
    if (!overlayWindow || event.sender !== overlayWindow.webContents) return;
    const pending = pendingPrompts.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPrompts.delete(requestId);
      pending.resolve(response);
    }
  });
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 820,
    height: 680,
    center: true,
    alwaysOnTop: true,
    resizable: true,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildSystemPrompt(cfg) {
  const parts = [cfg.copilot.system_prompt];

  if (cfg.context.working_directory) {
    parts.push(`The user's working directory is: ${cfg.context.working_directory}`);
  }

  if (cfg.context.custom_instructions) {
    try {
      const text = fs.readFileSync(cfg.context.custom_instructions, 'utf8');
      if (text.trim()) parts.push(`Custom instructions:\n${text.trim()}`);
    } catch { /* ignore missing file */ }
  }

  return parts.join('\n\n');
}

function buildPrompt(cfg, spokenText) {
  const parts = [];

  if (cfg.context.working_directory) {
    parts.push(`[Working directory: ${cfg.context.working_directory}]`);
  }

  if (cfg.context.custom_instructions) {
    try {
      const text = fs.readFileSync(cfg.context.custom_instructions, 'utf8');
      if (text.trim()) parts.push(`[Custom instructions: ${text.trim()}]`);
    } catch { /* ignore */ }
  }

  parts.push(spokenText);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Core pipeline: final text → Copilot → stream tokens → overlay
// ---------------------------------------------------------------------------

async function handleFinalText(text) {
  requestGen++;
  const myGen = requestGen;
  const t0 = Date.now();
  const log = (msg) => {
    const ts = new Date().toISOString().substring(11, 23);
    console.log(`[${ts}] [pipeline#${myGen}] ${msg}`);
  };

  log(`final text (${text.length} chars): ${JSON.stringify(text.slice(0, 120))}`);
  sendOverlayEvent(StatusEvent('processing'));
  sendOverlayEvent(TranscriptEvent(text));

  let heartbeat = null;
  try {
    // Ensure Copilot is running
    if (!copilot.isRunning) {
      try {
        await copilot.restart();
      } catch (err) {
        sendOverlayEvent(ErrorEvent(`Copilot unavailable: ${err.message}`));
        sendOverlayEvent(StatusEvent('idle'));
        return;
      }
    }

    const prompt = buildPrompt(config, text);
    log(`built prompt (${prompt.length} chars), sending to Copilot`);
    let fullResponse = '';
    let tokenCount = 0;
    let reasoningCount = 0;
    let toolCount = 0;
    let lastActivity = Date.now();

    // Heartbeat — warn if the pipeline has been silent for a while. Helps
    // distinguish "actively working but quiet" from "hung".
    heartbeat = setInterval(() => {
      const idle = ((Date.now() - lastActivity) / 1000).toFixed(1);
      const running = ((Date.now() - t0) / 1000).toFixed(1);
      log(`heartbeat — ${running}s elapsed, ${idle}s since last event (tokens=${tokenCount}, reasoning=${reasoningCount}, tools=${toolCount})`);
    }, 5000);

    for await (const event of copilot.send(prompt)) {
      lastActivity = Date.now();
      if (requestGen !== myGen) {
        log('abandoning stale response');
        return;
      }
      switch (event.kind) {
        case 'reasoning_start':
          log('reasoning started');
          sendOverlayEvent(ReasoningStartEvent());
          break;
        case 'reasoning':
          reasoningCount++;
          sendOverlayEvent(ReasoningEvent(event.content));
          break;
        case 'reasoning_end':
          log(`reasoning ended (${reasoningCount} chunks)`);
          reasoningCount = 0;
          sendOverlayEvent(ReasoningEndEvent());
          break;
        case 'tool_start':
          toolCount++;
          log(`tool_start: ${event.toolName}`);
          sendOverlayEvent(ToolStartEvent(event.toolCallId, event.toolName));
          break;
        case 'tool_complete':
          log(`tool_complete: ${event.toolName} ${event.success ? 'ok' : 'FAILED'}`);
          sendOverlayEvent(ToolCompleteEvent(event.toolCallId, event.toolName, event.success));
          break;
        case 'token':
          tokenCount++;
          fullResponse += event.content;
          sendOverlayEvent(TokenEvent(event.content));
          break;
      }
    }

    if (requestGen !== myGen) return;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    log(`done in ${elapsed}s — ${tokenCount} tokens, ${fullResponse.length} chars, ${toolCount} tool calls`);
    sendOverlayEvent(DoneEvent(fullResponse));
  } catch (err) {
    if (requestGen !== myGen) return;
    log(`ERROR: ${err.message}`);
    console.error('Copilot error:', err.message);
    sendOverlayEvent(ErrorEvent(err.message));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  if (requestGen === myGen) {
    sendOverlayEvent(StatusEvent('idle'));
  }
}

// ---------------------------------------------------------------------------
// Config change handler — hot-reload settings without restarting the app
// ---------------------------------------------------------------------------

/**
 * Deep-mutate the `target` object to match `source` contents while keeping
 * the same object identity. This way all components holding a reference to
 * `config` automatically see the updated values.
 */
function updateConfigInPlace(target, source) {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      updateConfigInPlace(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function repositionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const pos = getOverlayPosition(config);
  overlayWindow.setPosition(pos.x, pos.y);
}

async function onConfigChanged(newConfig) {
  // Snapshot old values before mutating — so we can detect what changed
  const old = JSON.parse(JSON.stringify(config));
  updateConfigInPlace(config, newConfig);

  // 1. Copilot model change
  if (copilot?.isRunning && config.copilot.model !== old.copilot.model) {
    try {
      await copilot.switchModel(config.copilot.model);
      tray?.rebuildMenu();
    } catch (err) {
      console.error('Model switch failed:', err.message);
    }
  }

  // 2. Copilot system prompt / context change — requires session recreate
  const systemPromptChanged =
    config.copilot.system_prompt !== old.copilot.system_prompt ||
    config.context.working_directory !== old.context.working_directory ||
    config.context.custom_instructions !== old.context.custom_instructions;
  if (copilot?.isRunning && systemPromptChanged) {
    try {
      const systemPrompt = buildSystemPrompt(config);
      const { merged: mcpServers } = loadAllMcpServers(config.mcp?.external_config_path);
      await copilot.stop();
      await copilot.init(config.copilot.model, systemPrompt, mcpServers);
      copilot.setPromptHandler(sendOverlayPrompt);
    } catch (err) {
      console.error('Copilot session reinit failed:', err.message);
    }
  }

  // 2b. MCP external config path change — reload MCP servers and reinit session
  const mcpPathChanged =
    (config.mcp?.external_config_path || null) !== (old.mcp?.external_config_path || null);
  if (copilot?.isRunning && mcpPathChanged && !systemPromptChanged) {
    try {
      const { merged: mcpServers } = loadAllMcpServers(config.mcp?.external_config_path);
      await copilot.updateMcpServers(mcpServers);
    } catch (err) {
      console.error('MCP config reload failed:', err.message);
    }
  }

  // 3. Activation hotkey change
  if (sttPipeline && config.activation.hotkey !== old.activation.hotkey) {
    try {
      sttPipeline.setHotkey(config.activation.hotkey);
    } catch (err) {
      console.error('Hotkey update failed:', err.message);
    }
  }

  // 4. STT model/sample-rate change — expensive, needs engine reload
  if (sttPipeline && (
    config.stt.model_path !== old.stt.model_path ||
    config.stt.sample_rate !== old.stt.sample_rate ||
    JSON.stringify(config.stt.hotwords) !== JSON.stringify(old.stt.hotwords)
  )) {
    try {
      await sttPipeline.reloadEngine();
    } catch (err) {
      console.error('STT engine reload failed:', err.message);
    }
  }

  // 5. Overlay position
  if (config.overlay.position !== old.overlay.position) {
    repositionOverlay();
  }

  // 6. Overlay opacity
  if (config.overlay.opacity !== old.overlay.opacity && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setOpacity(config.overlay.opacity);
  }

  // 7. Overlay dimensions — updated expandedWidth/Height take effect on next expand
  if (config.overlay.max_width !== old.overlay.max_width) {
    expandedWidth = config.overlay.max_width;
  }
  if (config.overlay.max_height !== old.overlay.max_height) {
    expandedHeight = config.overlay.max_height;
  }

  // 8. Overlay auto-hide timer and opacity — push to renderer
  if ((config.overlay.auto_hide_seconds !== old.overlay.auto_hide_seconds || config.overlay.opacity !== old.overlay.opacity) && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-config', {
      auto_hide_seconds: config.overlay.auto_hide_seconds,
      opacity: config.overlay.opacity,
    });
  }

  // Note: activation.cancel_phrases and buildPrompt inputs are read live from
  // `config` each time they're used, so no explicit action is needed there.
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // 1. Load config
  try {
    config = loadConfig();
  } catch (err) {
    console.error('Failed to load config:', err.message);
    app.quit();
    return;
  }

  // 2. Register IPC
  registerOverlayIPC();
  registerSettingsIPC(
    () => config,
    (cfg) => onConfigChanged(cfg),
  );
  registerMcpIPC(
    () => config,
    async (mcpServers) => {
      try {
        await copilot?.updateMcpServers(mcpServers);
      } catch (err) {
        console.error('MCP server update failed:', err.message);
      }
    },
  );

  // 3. Create overlay window
  createOverlayWindow();

  // 4. Start system tray
  tray = new SystemTray({
    isEnabled: () => isEnabled,
    currentModel: () => copilot?.currentModel || config.copilot.model,
    onToggle: (enabled) => {
      isEnabled = enabled;
      if (tray) tray.rebuildMenu();
    },
    onSettings: () => openSettingsWindow(),
    onReset: async () => {
      try { await copilot?.reset(); } catch (err) {
        console.error('Reset failed:', err.message);
      }
    },
    onSwitchModel: async (model) => {
      try {
        await copilot?.switchModel(model);
        config.copilot.model = model;
        if (tray) tray.rebuildMenu();
      } catch (err) {
        console.error('Switch model failed:', err.message);
      }
    },
    onOpenLog: () => {
      shell.openPath(getLogPath()).catch((err) => {
        console.error('Failed to open log file:', err.message);
      });
    },
    onRestart: () => {
      app.relaunch();
      app.quit();
    },
    onQuit: () => app.quit(),
  });
  tray.start();

  // 5. Start Copilot
  copilot = new CopilotManager();
  const startupErrors = [];
  try {
    const systemPrompt = buildSystemPrompt(config);
    const { merged: mcpServers, collisions } = loadAllMcpServers(config.mcp?.external_config_path);
    if (collisions.length > 0) {
      console.log(`MCP server name collisions (app overrides external): ${collisions.join(', ')}`);
    }
    const serverCount = Object.keys(mcpServers).length;
    if (serverCount > 0) {
      console.log(`Loading ${serverCount} MCP server(s): ${Object.keys(mcpServers).join(', ')}`);
    }
    await copilot.init(config.copilot.model, systemPrompt, mcpServers);
    copilot.setPromptHandler(sendOverlayPrompt);
  } catch (err) {
    console.error('Copilot init failed:', err.message);
    startupErrors.push(`Copilot: ${err.message}`);
  }

  // 6. Start STT pipeline
  sttPipeline = new SttPipeline({
    config,
    onRecordingStart: () => {
      if (!isEnabled) return;
      sendOverlayEvent(StatusEvent('recording'));
    },
    onPartialText: (text) => {
      if (!isEnabled) return;
      sendOverlayEvent(TranscriptEvent(text));
    },
    onFinalText: (text) => {
      if (!isEnabled) return;
      handleFinalText(text);
    },
    onRecordingStop: () => {
      if (!isEnabled) return;
      sendOverlayEvent(StatusEvent('processing'));
    },
    onCancelled: (phrase, fullText) => {
      if (!isEnabled) return;
      sendOverlayEvent(CancelledEvent(phrase, fullText));
    },
  });
  try {
    await sttPipeline.start();
  } catch (err) {
    console.error('STT pipeline init failed:', err.message);
    startupErrors.push(`STT: ${err.message}`);
  }

  // 7. Start config watcher
  configWatcher = new ConfigWatcher(getUserConfigPath(), onConfigChanged);
  configWatcher.start();

  // 8. Startup notification
  const msg = startupErrors.length > 0
    ? `Started with errors:\n${startupErrors.join('\n')}`
    : 'WalkieTalkAI started';
  console.log(msg);
  setTimeout(() => tray?.notify('WalkieTalkAI', msg), 1000);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async () => {
  if (animTimer) clearInterval(animTimer);
  flushPendingPrompts();
  configWatcher?.stop();
  sttPipeline?.stop();
  try { await copilot?.stop(); } catch { /* ignore */ }
  tray?.stop();
});
