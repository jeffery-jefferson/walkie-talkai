/**
 * System tray icon and context menu.
 */

import { Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVAILABLE_MODELS } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

export class SystemTray {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.isEnabled
   * @param {() => string}  opts.currentModel
   * @param {(enabled: boolean) => void} opts.onToggle
   * @param {() => void} opts.onSettings
   * @param {() => void} opts.onReset
   * @param {(model: string) => void} opts.onSwitchModel
   * @param {() => void} opts.onRestart
   * @param {() => void} opts.onQuit
   */
  constructor(opts) {
    this._opts = opts;
    this._tray = null;
  }

  start() {
    const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
    this._tray = new Tray(icon);
    this._tray.setToolTip('WalkieTalkAI');
    this._rebuildMenu();
  }

  /** Rebuild the context menu (call after model change, enable/disable, etc.). */
  rebuildMenu() {
    this._rebuildMenu();
  }

  /** Show a balloon notification (Windows). */
  notify(title, content) {
    if (this._tray) {
      this._tray.displayBalloon({ title, content, iconType: 'info' });
    }
  }

  stop() {
    if (this._tray) {
      this._tray.destroy();
      this._tray = null;
    }
  }

  // -------------------------------------------------------------------------

  _rebuildMenu() {
    if (!this._tray) return;
    const {
      isEnabled, currentModel, onToggle, onSettings, onReset,
      onSwitchModel, onOpenLog, onRestart, onQuit,
    } = this._opts;
    const enabled = isEnabled();

    const modelSubmenu = AVAILABLE_MODELS.map((m) => ({
      label: m,
      type: 'radio',
      checked: m === currentModel(),
      click: () => onSwitchModel(m),
    }));

    const menu = Menu.buildFromTemplate([
      { label: enabled ? 'Enabled' : 'Disabled', type: 'checkbox', checked: enabled, click: () => onToggle(!enabled) },
      { type: 'separator' },
      { label: 'Settings...', click: onSettings },
      { label: 'Reset Conversation', click: onReset },
      { label: 'Switch Model', submenu: modelSubmenu },
      { label: 'Open Log File', click: onOpenLog },
      { type: 'separator' },
      { label: 'Restart', click: onRestart },
      { label: 'Quit', click: onQuit },
    ]);

    this._tray.setContextMenu(menu);
  }
}
