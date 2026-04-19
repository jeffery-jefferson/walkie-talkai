/**
 * Settings window renderer logic.
 */

let cancelPhrases = [];
let hotwords = [];

// -----------------------------------------------------------------------
// Hotkey capture — click to record, press keys to set
// -----------------------------------------------------------------------

/**
 * Map DOM KeyboardEvent.code to the hotkey tokens our parser understands.
 * Uses `code` rather than `key` so the combo is layout-independent.
 */
function codeToToken(code) {
    if (code.startsWith('Key')) return code.slice(3).toLowerCase();           // KeyA → a
    if (code.startsWith('Digit')) return code.slice(5);                       // Digit1 → 1
    if (/^F\d+$/.test(code)) return code.toLowerCase();                       // F1 → f1
    const map = {
        Space: 'space', Tab: 'tab', Enter: 'enter', Escape: 'esc',
        Backspace: 'backspace', Delete: 'delete', Insert: 'insert',
        Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        Backquote: 'backquote', Minus: 'minus', Equal: 'equal',
        BracketLeft: 'bracketleft', BracketRight: 'bracketright',
        Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'quote',
        Comma: 'comma', Period: 'period', Slash: 'slash',
    };
    return map[code] || null;
}

function setupHotkeyCapture() {
    const input = document.getElementById('activation-hotkey');
    const clearBtn = document.getElementById('clear-hotkey');

    let capturing = false;
    let pressed = new Set();
    let committed = '';

    const startCapture = () => {
        capturing = true;
        pressed.clear();
        input.classList.add('capturing');
        input.value = 'Press keys...';
    };

    const stopCapture = () => {
        capturing = false;
        pressed.clear();
        input.classList.remove('capturing');
        input.value = committed;
        input.blur();
    };

    input.addEventListener('focus', startCapture);
    input.addEventListener('click', startCapture);

    // Cancel on blur if no combo was committed
    input.addEventListener('blur', () => {
        if (capturing) {
            capturing = false;
            input.classList.remove('capturing');
            input.value = committed;
        }
    });

    document.addEventListener('keydown', (e) => {
        if (!capturing) return;
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
            stopCapture();
            return;
        }

        // Build combo: modifiers (in canonical order) + non-modifier key
        const mods = [];
        if (e.ctrlKey) mods.push('ctrl');
        if (e.shiftKey) mods.push('shift');
        if (e.altKey) mods.push('alt');
        if (e.metaKey) mods.push('meta');

        // Identify the non-modifier key
        const isModifierKey = [
            'Control', 'ControlLeft', 'ControlRight',
            'Shift', 'ShiftLeft', 'ShiftRight',
            'Alt', 'AltLeft', 'AltRight',
            'Meta', 'MetaLeft', 'MetaRight',
        ].includes(e.code) || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);

        if (isModifierKey) {
            // Show modifiers-only as the user builds the combo
            input.value = mods.length ? mods.join('+') + '+...' : 'Press keys...';
            return;
        }

        const token = codeToToken(e.code);
        if (!token) {
            input.value = `Unsupported key: ${e.code}`;
            return;
        }

        const combo = [...mods, token].join('+');
        committed = combo;
        stopCapture();
    }, true);

    clearBtn.addEventListener('click', () => {
        committed = '';
        input.value = '';
    });

    // Let loadSettings() seed the committed value
    window._setHotkey = (v) => { committed = v || ''; input.value = committed; };
}
setupHotkeyCapture();

// -----------------------------------------------------------------------
// Tab switching
// -----------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelector('.tab.active').classList.remove('active');
        document.querySelector('.panel.active').classList.remove('active');
        tab.classList.add('active');
        document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    });
});

// -----------------------------------------------------------------------
// Populate form from config
// -----------------------------------------------------------------------

async function loadSettings() {
    const [config, models] = await Promise.all([
        window.settings.getConfig(),
        window.settings.getAvailableModels(),
    ]);

    // Copilot tab
    const modelSelect = document.getElementById('copilot-model');
    modelSelect.innerHTML = '';
    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === config.copilot.model) opt.selected = true;
        modelSelect.appendChild(opt);
    }
    document.getElementById('copilot-system-prompt').value = config.copilot.system_prompt || '';

    // Context tab
    document.getElementById('context-working-dir').value = config.context.working_directory || '';
    document.getElementById('context-custom-instructions').value = config.context.custom_instructions || '';
    document.getElementById('context-include-clipboard').checked = config.context.include_clipboard;

    // Activation tab
    window._setHotkey(config.activation.hotkey || '');
    cancelPhrases = [...(config.activation.cancel_phrases || [])];
    renderCancelPhrases();

    // Speech tab
    document.getElementById('stt-model-path').value = config.stt.model_path || '';
    document.getElementById('stt-sample-rate').value = config.stt.sample_rate || 16000;
    hotwords = [...(config.stt.hotwords || [])];
    renderHotwords();

    // Overlay tab
    document.getElementById('overlay-position').value = config.overlay.position || 'top-left';
    document.getElementById('overlay-opacity').value = config.overlay.opacity;
    document.getElementById('opacity-value').textContent = config.overlay.opacity.toFixed(2);
    document.getElementById('overlay-auto-hide').value = config.overlay.auto_hide_seconds || 15;
    document.getElementById('overlay-max-width').value = config.overlay.max_width || 340;
    document.getElementById('overlay-max-height').value = config.overlay.max_height || 260;
}

// -----------------------------------------------------------------------
// Cancel phrases list
// -----------------------------------------------------------------------

function renderCancelPhrases() {
    const list = document.getElementById('cancel-phrases-list');
    list.innerHTML = '';
    cancelPhrases.forEach((phrase, idx) => {
        const item = document.createElement('div');
        item.className = 'phrase-item';
        item.innerHTML = `<span>${escapeHtml(phrase)}</span>`;
        const btn = document.createElement('button');
        btn.className = 'phrase-remove';
        btn.textContent = 'x';
        btn.addEventListener('click', () => {
            cancelPhrases.splice(idx, 1);
            renderCancelPhrases();
        });
        item.appendChild(btn);
        list.appendChild(item);
    });
}

document.getElementById('add-cancel-phrase').addEventListener('click', () => {
    const input = document.getElementById('cancel-phrase-input');
    const val = input.value.trim();
    if (val && !cancelPhrases.includes(val)) {
        cancelPhrases.push(val);
        renderCancelPhrases();
        input.value = '';
    }
});

// -----------------------------------------------------------------------
// Hotwords list
// -----------------------------------------------------------------------

function renderHotwords() {
    const list = document.getElementById('hotwords-list');
    list.innerHTML = '';
    hotwords.forEach((word, idx) => {
        const item = document.createElement('div');
        item.className = 'phrase-item';
        item.innerHTML = `<span>${escapeHtml(word)}</span>`;
        const btn = document.createElement('button');
        btn.className = 'phrase-remove';
        btn.textContent = 'x';
        btn.addEventListener('click', () => {
            hotwords.splice(idx, 1);
            renderHotwords();
        });
        item.appendChild(btn);
        list.appendChild(item);
    });
}

document.getElementById('add-hotword').addEventListener('click', () => {
    const input = document.getElementById('hotword-input');
    const val = input.value.trim();
    if (val && !hotwords.includes(val)) {
        hotwords.push(val);
        renderHotwords();
        input.value = '';
    }
});

// -----------------------------------------------------------------------
// Opacity slider live preview
// -----------------------------------------------------------------------

document.getElementById('overlay-opacity').addEventListener('input', (e) => {
    document.getElementById('opacity-value').textContent = parseFloat(e.target.value).toFixed(2);
});

// -----------------------------------------------------------------------
// Browse buttons
// -----------------------------------------------------------------------

document.getElementById('browse-working-dir').addEventListener('click', async () => {
    const dir = await window.settings.browseDirectory();
    if (dir) document.getElementById('context-working-dir').value = dir;
});

document.getElementById('browse-custom-instructions').addEventListener('click', async () => {
    const file = await window.settings.browseFile();
    if (file) document.getElementById('context-custom-instructions').value = file;
});

document.getElementById('browse-stt-model').addEventListener('click', async () => {
    const dir = await window.settings.browseDirectory();
    if (dir) document.getElementById('stt-model-path').value = dir;
});

// -----------------------------------------------------------------------
// Build config from form
// -----------------------------------------------------------------------

function buildConfig() {
    const extPath = document.getElementById('mcp-external-path')?.value || null;
    return {
        copilot: {
            model: document.getElementById('copilot-model').value,
            system_prompt: document.getElementById('copilot-system-prompt').value,
        },
        context: {
            working_directory: document.getElementById('context-working-dir').value || null,
            include_clipboard: document.getElementById('context-include-clipboard').checked,
            custom_instructions: document.getElementById('context-custom-instructions').value || null,
        },
        activation: {
            hotkey: document.getElementById('activation-hotkey').value,
            cancel_phrases: [...cancelPhrases],
        },
        stt: {
            model_path: document.getElementById('stt-model-path').value,
            sample_rate: parseInt(document.getElementById('stt-sample-rate').value, 10),
            hotwords: [...hotwords],
        },
        overlay: {
            position: document.getElementById('overlay-position').value,
            opacity: parseFloat(document.getElementById('overlay-opacity').value),
            auto_hide_seconds: parseInt(document.getElementById('overlay-auto-hide').value, 10),
            max_width: parseInt(document.getElementById('overlay-max-width').value, 10),
            max_height: parseInt(document.getElementById('overlay-max-height').value, 10),
        },
        mcp: {
            external_config_path: extPath || null,
        },
        tray: { enabled: true },
    };
}

// -----------------------------------------------------------------------
// Save / Cancel / OK
// -----------------------------------------------------------------------

async function save() {
    const cfg = buildConfig();
    const result = await window.settings.saveConfig(cfg);
    if (!result.ok) {
        alert('Validation error: ' + result.error);
        return false;
    }
    return true;
}

document.getElementById('btn-apply').addEventListener('click', () => save());
document.getElementById('btn-ok').addEventListener('click', async () => {
    if (await save()) window.close();
});
document.getElementById('btn-cancel').addEventListener('click', () => window.close());

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// -----------------------------------------------------------------------
// MCP Servers Panel
// -----------------------------------------------------------------------

let mcpAppServers = {};
let mcpEditingName = null; // null = adding, string = editing existing

function maskSecret(value) {
    if (!value || typeof value !== 'string') return value;
    const lower = value.toLowerCase();
    const secretPatterns = ['token', 'key', 'secret', 'password', 'auth', 'bearer'];
    if (secretPatterns.some(p => lower.includes(p)) || value.length > 20) {
        return value.slice(0, 4) + '••••••••';
    }
    return value;
}

function serverTypeBadge(cfg) {
    const type = cfg.type || 'local';
    if (type === 'http' || type === 'sse') {
        return `<span class="mcp-server-badge mcp-badge-remote">${type.toUpperCase()}</span>`;
    }
    return '<span class="mcp-server-badge mcp-badge-local">LOCAL</span>';
}

function serverDetail(cfg) {
    const type = cfg.type || 'local';
    if (type === 'http' || type === 'sse') {
        return escapeHtml(cfg.url || '');
    }
    const parts = [cfg.command || ''];
    if (cfg.args?.length) parts.push(cfg.args.join(' '));
    return escapeHtml(parts.join(' '));
}

function renderAppServers() {
    const list = document.getElementById('mcp-app-servers-list');
    const entries = Object.entries(mcpAppServers);

    if (entries.length === 0) {
        list.innerHTML = '<div class="mcp-empty">No app MCP servers configured.</div>';
        return;
    }

    list.innerHTML = entries.map(([name, cfg]) => `
        <div class="mcp-server-item" data-name="${escapeHtml(name)}">
            <div class="mcp-server-info">
                <span class="mcp-server-name">${escapeHtml(name)}</span>
                ${serverTypeBadge(cfg)}
                <div class="mcp-server-detail">${serverDetail(cfg)}</div>
            </div>
            <div class="mcp-server-actions">
                <button class="mcp-edit-btn" data-name="${escapeHtml(name)}">Edit</button>
                <button class="mcp-delete-btn danger" data-name="${escapeHtml(name)}">Delete</button>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.mcp-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openEditor(btn.dataset.name));
    });
    list.querySelectorAll('.mcp-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteServer(btn.dataset.name));
    });
}

function renderExternalServers(servers, collisions = []) {
    const list = document.getElementById('mcp-external-servers-list');
    const entries = Object.entries(servers);

    if (entries.length === 0) {
        list.innerHTML = '<div class="mcp-empty">No external servers loaded.</div>';
        return;
    }

    list.innerHTML = entries.map(([name, cfg]) => {
        const isShadowed = collisions.includes(name);
        const shadowBadge = isShadowed
            ? '<span class="mcp-server-badge mcp-badge-shadowed">shadowed by app</span>'
            : '';

        // Mask sensitive values in read-only view
        let detail = serverDetail(cfg);
        if ((cfg.type === 'http' || cfg.type === 'sse') && cfg.headers) {
            const maskedHeaders = Object.entries(cfg.headers)
                .map(([k, v]) => `${k}=${maskSecret(v)}`)
                .join(', ');
            detail += ` <span class="mcp-masked">[headers: ${escapeHtml(maskedHeaders)}]</span>`;
        }
        if (cfg.env) {
            const maskedEnv = Object.entries(cfg.env)
                .map(([k, v]) => `${k}=${maskSecret(v)}`)
                .join(', ');
            detail += ` <span class="mcp-masked">[env: ${escapeHtml(maskedEnv)}]</span>`;
        }

        return `
            <div class="mcp-server-item ${isShadowed ? 'shadowed' : ''}">
                <div class="mcp-server-info">
                    <span class="mcp-server-name">${escapeHtml(name)}</span>
                    ${serverTypeBadge(cfg)}
                    ${shadowBadge}
                    <div class="mcp-server-detail">${detail}</div>
                </div>
            </div>
        `;
    }).join('');
}

function openEditor(existingName) {
    const editor = document.getElementById('mcp-editor');
    const title = document.getElementById('mcp-editor-title');
    const errorEl = document.getElementById('mcp-editor-error');
    errorEl.textContent = '';

    if (existingName && mcpAppServers[existingName]) {
        mcpEditingName = existingName;
        title.textContent = `Edit: ${existingName}`;
        const cfg = mcpAppServers[existingName];
        document.getElementById('mcp-server-name').value = existingName;
        document.getElementById('mcp-server-name').disabled = true;
        document.getElementById('mcp-server-type').value = cfg.type || 'local';
        toggleEditorFields(cfg.type || 'local');

        if (cfg.type === 'http' || cfg.type === 'sse') {
            document.getElementById('mcp-server-url').value = cfg.url || '';
            document.getElementById('mcp-server-headers').value =
                cfg.headers ? Object.entries(cfg.headers).map(([k, v]) => `${k}=${v}`).join('\n') : '';
        } else {
            document.getElementById('mcp-server-command').value = cfg.command || '';
            document.getElementById('mcp-server-args').value = (cfg.args || []).join('\n');
            document.getElementById('mcp-server-cwd').value = cfg.cwd || '';
            document.getElementById('mcp-server-env').value =
                cfg.env ? Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
        }

        const tools = cfg.tools || ['*'];
        document.getElementById('mcp-server-tools').value = tools.join(', ');
        document.getElementById('mcp-server-timeout').value = cfg.timeout || '';
    } else {
        mcpEditingName = null;
        title.textContent = 'Add MCP Server';
        document.getElementById('mcp-server-name').value = '';
        document.getElementById('mcp-server-name').disabled = false;
        document.getElementById('mcp-server-type').value = 'local';
        toggleEditorFields('local');
        document.getElementById('mcp-server-command').value = '';
        document.getElementById('mcp-server-args').value = '';
        document.getElementById('mcp-server-cwd').value = '';
        document.getElementById('mcp-server-env').value = '';
        document.getElementById('mcp-server-url').value = '';
        document.getElementById('mcp-server-headers').value = '';
        document.getElementById('mcp-server-tools').value = '*';
        document.getElementById('mcp-server-timeout').value = '';
    }

    editor.style.display = 'block';
}

function closeEditor() {
    document.getElementById('mcp-editor').style.display = 'none';
    mcpEditingName = null;
}

function toggleEditorFields(type) {
    const isRemote = type === 'http' || type === 'sse';
    document.getElementById('mcp-local-fields').style.display = isRemote ? 'none' : 'block';
    document.getElementById('mcp-remote-fields').style.display = isRemote ? 'block' : 'none';
}

function parseKeyValueLines(text) {
    const result = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return result;
}

function buildServerFromEditor() {
    const type = document.getElementById('mcp-server-type').value;
    const toolsRaw = document.getElementById('mcp-server-tools').value.trim();
    const tools = toolsRaw === '*' ? ['*'] : toolsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const timeoutRaw = document.getElementById('mcp-server-timeout').value;
    const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : undefined;

    if (type === 'http' || type === 'sse') {
        const cfg = {
            type,
            url: document.getElementById('mcp-server-url').value.trim(),
            tools,
        };
        const headers = parseKeyValueLines(document.getElementById('mcp-server-headers').value);
        if (Object.keys(headers).length) cfg.headers = headers;
        if (timeout) cfg.timeout = timeout;
        return cfg;
    }

    const cfg = {
        type: type === 'local' ? undefined : type,
        command: document.getElementById('mcp-server-command').value.trim(),
        args: document.getElementById('mcp-server-args').value.split('\n').map(a => a.trim()).filter(Boolean),
        tools,
    };
    const cwd = document.getElementById('mcp-server-cwd').value.trim();
    if (cwd) cfg.cwd = cwd;
    const env = parseKeyValueLines(document.getElementById('mcp-server-env').value);
    if (Object.keys(env).length) cfg.env = env;
    if (timeout) cfg.timeout = timeout;
    return cfg;
}

async function saveEditorServer() {
    const errorEl = document.getElementById('mcp-editor-error');
    errorEl.textContent = '';

    const name = document.getElementById('mcp-server-name').value.trim();
    if (!name) {
        errorEl.textContent = 'Server name is required.';
        return;
    }
    if (!mcpEditingName && mcpAppServers[name]) {
        errorEl.textContent = `A server named "${name}" already exists.`;
        return;
    }

    const cfg = buildServerFromEditor();

    const validation = await window.settings.mcpValidateServer(name, cfg);
    if (!validation.ok) {
        errorEl.textContent = validation.error;
        return;
    }

    mcpAppServers[name] = cfg;
    const result = await window.settings.mcpSaveAppServers(mcpAppServers);
    if (!result.ok) {
        errorEl.textContent = result.error;
        delete mcpAppServers[name];
        return;
    }

    closeEditor();
    renderAppServers();
    await refreshExternalServers();
}

async function deleteServer(name) {
    delete mcpAppServers[name];
    const result = await window.settings.mcpSaveAppServers(mcpAppServers);
    if (!result.ok) {
        alert('Failed to save: ' + result.error);
        return;
    }
    renderAppServers();
    await refreshExternalServers();
}

async function refreshExternalServers() {
    const config = await window.settings.getConfig();
    const extPath = config.mcp?.external_config_path;
    if (!extPath) {
        renderExternalServers({});
        return;
    }
    const extResult = await window.settings.mcpGetExternalServers(extPath);
    const appNames = Object.keys(mcpAppServers);
    const collisions = Object.keys(extResult.servers || {}).filter(n => appNames.includes(n));
    renderExternalServers(extResult.servers || {}, collisions);
}

async function loadMcpPanel() {
    // Load app MCP config path display
    const configPath = await window.settings.mcpGetConfigPath();
    const pathEl = document.getElementById('mcp-config-path');
    pathEl.textContent = configPath;
    pathEl.title = configPath;

    // Load app servers
    const appResult = await window.settings.mcpGetAppServers();
    mcpAppServers = appResult.servers || {};
    renderAppServers();

    // Load external path from config and display external servers
    const config = await window.settings.getConfig();
    document.getElementById('mcp-external-path').value = config.mcp?.external_config_path || '';
    await refreshExternalServers();
}

// --- MCP event listeners ---

document.getElementById('mcp-add-server').addEventListener('click', () => openEditor(null));
document.getElementById('mcp-editor-cancel').addEventListener('click', closeEditor);
document.getElementById('mcp-editor-save').addEventListener('click', saveEditorServer);

document.getElementById('mcp-server-type').addEventListener('change', (e) => {
    toggleEditorFields(e.target.value);
});

document.getElementById('mcp-browse-cwd').addEventListener('click', async () => {
    const dir = await window.settings.browseDirectory();
    if (dir) document.getElementById('mcp-server-cwd').value = dir;
});

document.getElementById('mcp-browse-external').addEventListener('click', async () => {
    const file = await window.settings.mcpBrowseExternalConfig();
    if (!file) return;
    document.getElementById('mcp-external-path').value = file;
    // Save the external path to config
    const config = await window.settings.getConfig();
    config.mcp = config.mcp || {};
    config.mcp.external_config_path = file;
    await window.settings.saveConfig(config);
    await refreshExternalServers();
});

document.getElementById('mcp-clear-external').addEventListener('click', async () => {
    document.getElementById('mcp-external-path').value = '';
    const config = await window.settings.getConfig();
    config.mcp = config.mcp || {};
    config.mcp.external_config_path = null;
    await window.settings.saveConfig(config);
    renderExternalServers({});
});

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadMcpPanel();
});
