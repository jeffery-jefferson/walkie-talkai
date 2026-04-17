/**
 * Preload script for the overlay renderer.
 *
 * Exposes a safe IPC bridge via contextBridge so the renderer
 * can receive events and request window actions without Node access.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('walkieTalkai', {
  /** Subscribe to overlay events from the main process. */
  onEvent: (callback) => {
    ipcRenderer.on('overlay-event', (_event, data) => callback(data));
  },

  /** Subscribe to config updates (auto_hide_seconds, etc). */
  onConfig: (callback) => {
    ipcRenderer.on('overlay-config', (_event, data) => callback(data));
  },

  /** Request the main process to expand the overlay window. */
  expand: () => ipcRenderer.send('overlay-expand'),

  /** Request the main process to collapse the overlay window. */
  collapse: () => ipcRenderer.send('overlay-collapse'),

  /** Request the main process to set the overlay height. */
  setHeight: (h) => ipcRenderer.send('overlay-set-height', h),

  /** Toggle mouse event pass-through for transparent areas. */
  setIgnoreMouse: (ignore) => ipcRenderer.send('overlay-set-ignore-mouse', ignore),

  /** Set the overlay window opacity (0.0–1.0). */
  setOpacity: (opacity) => ipcRenderer.send('overlay-set-opacity', opacity),
});
