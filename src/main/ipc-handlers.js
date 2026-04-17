/**
 * IPC handler registration for settings window communication.
 */

import { ipcMain, dialog } from 'electron';
import { loadConfig, saveConfig, getUserConfigPath, AVAILABLE_MODELS } from './config.js';
import {
  loadAppMcpConfig, saveAppMcpConfig, loadExternalMcpConfig,
  getAppMcpConfigPath, loadAllMcpServers, validateServer,
} from './mcp-config.js';

/**
 * Register ipcMain handlers for the settings renderer.
 *
 * @param {() => object} getConfig  Return current live config
 * @param {(cfg: object) => void} onConfigSaved  Called after config is saved
 */
export function registerSettingsIPC(getConfig, onConfigSaved) {
  ipcMain.handle('settings-get-config', () => {
    return getConfig();
  });

  ipcMain.handle('settings-get-models', () => {
    return AVAILABLE_MODELS;
  });

  ipcMain.handle('settings-save-config', (_event, cfg) => {
    try {
      saveConfig(cfg, getUserConfigPath());
      onConfigSaved(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings-browse-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('settings-browse-file', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}

/**
 * Register ipcMain handlers for MCP server configuration.
 *
 * @param {() => object} getConfig  Return current live config
 * @param {(mcpServers: object) => void} onMcpChanged  Called after MCP servers are saved
 */
export function registerMcpIPC(getConfig, onMcpChanged) {
  ipcMain.handle('mcp-get-app-servers', () => {
    try {
      return { ok: true, servers: loadAppMcpConfig() };
    } catch (err) {
      return { ok: false, error: err.message, servers: {} };
    }
  });

  ipcMain.handle('mcp-save-app-servers', async (_event, servers) => {
    try {
      saveAppMcpConfig(servers);
      const config = getConfig();
      const { merged } = loadAllMcpServers(config.mcp?.external_config_path);
      await onMcpChanged(merged);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mcp-get-external-servers', (_event, filePath) => {
    try {
      const servers = loadExternalMcpConfig(filePath || null);
      return { ok: true, servers };
    } catch (err) {
      return { ok: false, error: err.message, servers: {} };
    }
  });

  ipcMain.handle('mcp-get-merged-servers', () => {
    try {
      const config = getConfig();
      const { merged, collisions } = loadAllMcpServers(config.mcp?.external_config_path);
      return { ok: true, servers: merged, collisions };
    } catch (err) {
      return { ok: false, error: err.message, servers: {}, collisions: [] };
    }
  });

  ipcMain.handle('mcp-get-config-path', () => {
    return getAppMcpConfigPath();
  });

  ipcMain.handle('mcp-validate-server', (_event, name, cfg) => {
    try {
      validateServer(name, cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mcp-browse-external-config', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}
