/**
 * Auto-updater wrapper with a simple state machine API.
 */

import { app } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const BUSY_STATES = new Set(['checking', 'downloading', 'disabled']);

export class AppUpdater {
  /**
   * @param {object} opts
   * @param {(status: string) => void} opts.onStatusChange
   * @param {(title: string, message: string) => void} opts.onNotify
   */
  constructor(opts) {
    this._onStatusChange = opts.onStatusChange;
    this._onNotify = opts.onNotify;
    this._status = 'idle';
    this._updateVersion = null;
    this._errorMessage = null;
    this._resetTimer = null;

    if (!app.isPackaged) {
      console.log('Auto-updater disabled (dev mode)');
      this._status = 'disabled';
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    autoUpdater.on('checking-for-update', () => {
      this._setState('checking');
    });

    autoUpdater.on('update-available', (info) => {
      this._updateVersion = info.version;
      this._setState('available');
      this._onNotify('Update Available', `Version ${info.version} is available`);
    });

    autoUpdater.on('update-not-available', () => {
      this._setState('up-to-date');
      this._scheduleReset(30_000);
    });

    autoUpdater.on('download-progress', () => {
      if (this._status !== 'downloading') this._setState('downloading');
    });

    autoUpdater.on('update-downloaded', (info) => {
      this._setState('ready');
      this._onNotify('Update Ready', `Version ${info.version} will install on next restart`);
    });

    autoUpdater.on('error', (err) => {
      this._errorMessage = err.message;
      this._setState('error');
      this._onNotify('Update Error', err.message);
      this._scheduleReset(30_000);
    });
  }

  get status() { return this._status; }
  get updateVersion() { return this._updateVersion; }
  get errorMessage() { return this._errorMessage; }

  /** Check GitHub Releases for a new version. No-op if disabled or already busy. */
  checkForUpdates() {
    if (BUSY_STATES.has(this._status)) return;
    autoUpdater.checkForUpdates();
  }

  /** Download the available update. Only works when status is 'available'. */
  downloadUpdate() {
    if (this._status !== 'available') return;
    autoUpdater.downloadUpdate();
  }

  /** Quit the app and install the downloaded update. Only works when status is 'ready'. */
  installUpdate() {
    if (this._status !== 'ready') return;
    autoUpdater.quitAndInstall(false, true);
  }

  // ---------------------------------------------------------------------------

  _setState(status) {
    this._status = status;
    this._onStatusChange(status);
  }

  _scheduleReset(ms) {
    clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => this._setState('idle'), ms);
  }
}
