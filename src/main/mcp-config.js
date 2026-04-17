/**
 * MCP (Model Context Protocol) server configuration management.
 *
 * App-owned config lives at `<userData>/mcp.json` and is fully editable.
 * Users may also reference an external MCP JSON file (read-only).
 * Both sources are merged before being passed to the Copilot SDK.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Return the absolute path to the app-owned mcp.json. */
export function getAppMcpConfigPath() {
  return path.join(app.getPath('userData'), 'mcp.json');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ALLOWED_REMOTE_TYPES = new Set(['http', 'sse']);

/**
 * Validate a single MCP server entry. Throws on invalid shape.
 * @param {string} name  Server name (for error messages)
 * @param {object} cfg   Server config object
 */
export function validateServer(name, cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`MCP server "${name}": config must be an object`);
  }

  // tools — required, must be string array
  if (!Array.isArray(cfg.tools)) {
    throw new Error(`MCP server "${name}": "tools" must be an array of strings (use ["*"] for all)`);
  }
  for (const t of cfg.tools) {
    if (typeof t !== 'string') {
      throw new Error(`MCP server "${name}": each entry in "tools" must be a string`);
    }
  }

  // timeout — optional, must be positive number
  if (cfg.timeout !== undefined) {
    if (typeof cfg.timeout !== 'number' || cfg.timeout <= 0) {
      throw new Error(`MCP server "${name}": "timeout" must be a positive number (ms)`);
    }
  }

  const type = cfg.type || 'local';

  if (ALLOWED_REMOTE_TYPES.has(type)) {
    // Remote server
    if (!cfg.url || typeof cfg.url !== 'string') {
      throw new Error(`MCP server "${name}": remote server requires a "url" string`);
    }
    try {
      const parsed = new URL(cfg.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`MCP server "${name}": url must use http or https protocol`);
      }
    } catch (e) {
      if (e.message.includes('MCP server')) throw e;
      throw new Error(`MCP server "${name}": invalid url "${cfg.url}"`);
    }
    if (cfg.headers !== undefined) {
      if (typeof cfg.headers !== 'object' || Array.isArray(cfg.headers)) {
        throw new Error(`MCP server "${name}": "headers" must be a key-value object`);
      }
    }
  } else if (type === 'local' || type === 'stdio') {
    // Local server
    if (!cfg.command || typeof cfg.command !== 'string') {
      throw new Error(`MCP server "${name}": local server requires a "command" string`);
    }
    if (!Array.isArray(cfg.args)) {
      throw new Error(`MCP server "${name}": "args" must be an array of strings`);
    }
    if (cfg.env !== undefined) {
      if (typeof cfg.env !== 'object' || Array.isArray(cfg.env)) {
        throw new Error(`MCP server "${name}": "env" must be a key-value object`);
      }
    }
    if (cfg.cwd !== undefined) {
      if (typeof cfg.cwd !== 'string') {
        throw new Error(`MCP server "${name}": "cwd" must be a string`);
      }
    }
  } else {
    throw new Error(`MCP server "${name}": unknown type "${type}" (use "local", "stdio", "http", or "sse")`);
  }
}

/**
 * Validate an entire mcpServers record.
 * @param {Record<string, object>} servers
 */
export function validateMcpServers(servers) {
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('mcpServers must be a key-value object');
  }
  for (const [name, cfg] of Object.entries(servers)) {
    validateServer(name, cfg);
  }
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Parse an MCP JSON file. Returns `{ mcpServers: {} }` on missing/empty file.
 * @param {string} filePath
 * @returns {{ mcpServers: Record<string, object> }}
 */
function parseMcpFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { mcpServers: {} };
  }
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return { mcpServers: {} };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in MCP config: ${filePath}`);
  }

  const servers = parsed.mcpServers || {};
  return { mcpServers: servers };
}

/**
 * Load the app-owned MCP config from `<userData>/mcp.json`.
 * Returns an empty servers object if the file doesn't exist.
 */
export function loadAppMcpConfig() {
  const configPath = getAppMcpConfigPath();
  const { mcpServers } = parseMcpFile(configPath);
  if (Object.keys(mcpServers).length > 0) {
    validateMcpServers(mcpServers);
  }
  return mcpServers;
}

/**
 * Load an external MCP JSON file (read-only source).
 * @param {string|null} filePath
 */
export function loadExternalMcpConfig(filePath) {
  if (!filePath) return {};
  const { mcpServers } = parseMcpFile(filePath);
  if (Object.keys(mcpServers).length > 0) {
    validateMcpServers(mcpServers);
  }
  return mcpServers;
}

/**
 * Save the app-owned MCP config. Only the app config is writable.
 * @param {Record<string, object>} servers
 */
export function saveAppMcpConfig(servers) {
  validateMcpServers(servers);
  const configPath = getAppMcpConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge app and external MCP servers. App entries take precedence on
 * name collision. Returns a `collisions` list for UI display.
 *
 * @param {Record<string, object>} appServers
 * @param {Record<string, object>} externalServers
 * @returns {{ merged: Record<string, object>, collisions: string[] }}
 */
export function getMergedMcpServers(appServers, externalServers) {
  const collisions = [];
  const merged = { ...externalServers };

  for (const [name, cfg] of Object.entries(appServers)) {
    if (name in merged) {
      collisions.push(name);
    }
    merged[name] = cfg;
  }

  return { merged, collisions };
}

/**
 * Convenience: load both sources, merge, and return SDK-ready config.
 * @param {string|null} externalPath
 * @returns {{ mcpServers: Record<string, object>, collisions: string[] }}
 */
export function loadAllMcpServers(externalPath) {
  const appServers = loadAppMcpConfig();
  const externalServers = loadExternalMcpConfig(externalPath);
  return getMergedMcpServers(appServers, externalServers);
}
