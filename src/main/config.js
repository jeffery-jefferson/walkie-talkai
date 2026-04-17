/**
 * Configuration management for walkie-talkai.
 *
 * Loads config.default.yaml, deep-merges with config.yaml overrides,
 * validates, and exposes load/save helpers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Navigate from src/main/ → project root */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const VALID_POSITIONS = new Set([
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'top-center', 'bottom-center',
]);

export const AVAILABLE_MODELS = [
  'claude-sonnet-4', 'claude-sonnet-4.5', 'claude-sonnet-4.6',
  'claude-haiku-4.5', 'claude-opus-4.5', 'claude-opus-4.6',
  'gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini',
  'gpt-4.1',
];

/** Default config values (mirrors config.default.yaml). */
const DEFAULTS = {
  copilot: {
    model: 'gpt-4.1',
    system_prompt:
      'You are a helpful voice assistant. Be concise and direct.\n' +
      'Respond in plain text unless code is specifically requested.\n',
  },
  context: {
    working_directory: null,
    include_clipboard: false,
    custom_instructions: null,
  },
  activation: {
    hotkey: 'ctrl+shift+space',
    cancel_phrases: ['scrap that', 'nevermind', 'never mind', 'scratch that'],
  },
  stt: {
    model_path: 'models/sherpa-onnx/kroko-128l-en',
    sample_rate: 16000,
  },
  overlay: {
    position: 'top-left',
    opacity: 0.92,
    auto_hide_seconds: 15,
    max_width: 340,
    max_height: 260,
  },
  mcp: {
    external_config_path: null,
  },
  tray: {
    enabled: true,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge `override` into `base`. Dicts merge recursively;
 * arrays and scalars are replaced.
 */
export function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key]) &&
      typeof value === 'object' && value !== null && !Array.isArray(value)
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Validate a config object. Throws on invalid values.
 */
export function validate(cfg) {
  if (!cfg.copilot?.model || typeof cfg.copilot.model !== 'string') {
    throw new Error('copilot.model must be a non-empty string');
  }
  if (!Number.isInteger(cfg.stt?.sample_rate) || cfg.stt.sample_rate <= 0) {
    throw new Error('stt.sample_rate must be a positive integer');
  }
  if (typeof cfg.overlay?.opacity !== 'number' || cfg.overlay.opacity < 0 || cfg.overlay.opacity > 1) {
    throw new Error('overlay.opacity must be between 0.0 and 1.0');
  }
  if (!VALID_POSITIONS.has(cfg.overlay?.position)) {
    throw new Error(`overlay.position must be one of: ${[...VALID_POSITIONS].sort().join(', ')}`);
  }
  if (!Number.isInteger(cfg.overlay?.auto_hide_seconds) || cfg.overlay.auto_hide_seconds <= 0) {
    throw new Error('overlay.auto_hide_seconds must be a positive integer');
  }
  if (!Number.isInteger(cfg.overlay?.max_width) || cfg.overlay.max_width <= 0) {
    throw new Error('overlay.max_width must be a positive integer');
  }
  if (!Number.isInteger(cfg.overlay?.max_height) || cfg.overlay.max_height <= 0) {
    throw new Error('overlay.max_height must be a positive integer');
  }
  if (cfg.context?.custom_instructions && !fs.existsSync(cfg.context.custom_instructions)) {
    throw new Error(`custom_instructions file not found: ${cfg.context.custom_instructions}`);
  }
  if (cfg.mcp?.external_config_path && typeof cfg.mcp.external_config_path !== 'string') {
    throw new Error('mcp.external_config_path must be a string path or null');
  }
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load configuration with resolution order:
 * 1. Built-in DEFAULTS
 * 2. config.default.yaml (project root)
 * 3. config.yaml (project root)
 * 4. Explicit path (if provided)
 */
export function loadConfig(explicitPath) {
  let data = structuredClone(DEFAULTS);

  // Layer 1 — config.default.yaml
  const defaultYaml = path.join(PROJECT_ROOT, 'config.default.yaml');
  if (fs.existsSync(defaultYaml)) {
    const parsed = YAML.parse(fs.readFileSync(defaultYaml, 'utf8'));
    if (parsed) data = deepMerge(data, parsed);
  }

  // Layer 2 — config.yaml (user overrides)
  const userYaml = path.join(PROJECT_ROOT, 'config.yaml');
  if (fs.existsSync(userYaml)) {
    const parsed = YAML.parse(fs.readFileSync(userYaml, 'utf8'));
    if (parsed) data = deepMerge(data, parsed);
  }

  // Layer 3 — explicit path
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`Config file not found: ${explicitPath}`);
    }
    const parsed = YAML.parse(fs.readFileSync(explicitPath, 'utf8'));
    if (parsed) data = deepMerge(data, parsed);
  }

  validate(data);
  return data;
}

/**
 * Save configuration to a YAML file, preserving key order.
 */
export function saveConfig(cfg, filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(cfg, { sortMapEntries: false }), 'utf8');
}

/**
 * Return the absolute path to config.yaml in the project root.
 */
export function getUserConfigPath() {
  return path.join(PROJECT_ROOT, 'config.yaml');
}

export { PROJECT_ROOT };
