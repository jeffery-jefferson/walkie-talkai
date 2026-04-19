/**
 * Preload script for the settings renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settings', {
  getConfig: () => ipcRenderer.invoke('settings-get-config'),
  saveConfig: (config) => ipcRenderer.invoke('settings-save-config', config),
  getAvailableModels: () => ipcRenderer.invoke('settings-get-models'),
  browseDirectory: () => ipcRenderer.invoke('settings-browse-directory'),
  browseFile: () => ipcRenderer.invoke('settings-browse-file'),

  // MCP server management
  mcpGetAppServers: () => ipcRenderer.invoke('mcp-get-app-servers'),
  mcpSaveAppServers: (servers) => ipcRenderer.invoke('mcp-save-app-servers', servers),
  mcpGetExternalServers: (path) => ipcRenderer.invoke('mcp-get-external-servers', path),
  mcpGetMergedServers: () => ipcRenderer.invoke('mcp-get-merged-servers'),
  mcpGetConfigPath: () => ipcRenderer.invoke('mcp-get-config-path'),
  mcpValidateServer: (name, cfg) => ipcRenderer.invoke('mcp-validate-server', name, cfg),
  mcpBrowseExternalConfig: () => ipcRenderer.invoke('mcp-browse-external-config'),
});
