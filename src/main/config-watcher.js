/**
 * Watch config.yaml for changes and trigger a reload callback.
 *
 * Uses chokidar (fs.watch-based, reliable cross-platform).
 */

import chokidar from 'chokidar';
import { loadConfig } from './config.js';

export class ConfigWatcher {
  /**
   * @param {string} configPath  Absolute path to config.yaml
   * @param {(config: object) => void} onChanged  Called with the new config on change
   */
  constructor(configPath, onChanged) {
    this._configPath = configPath;
    this._onChanged = onChanged;
    this._watcher = null;
  }

  start() {
    this._watcher = chokidar.watch(this._configPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this._watcher.on('change', () => {
      try {
        const cfg = loadConfig();
        this._onChanged(cfg);
      } catch (err) {
        console.error('Config reload failed:', err.message);
      }
    });
  }

  stop() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }
}
