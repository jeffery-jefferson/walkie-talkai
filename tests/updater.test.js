import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron — app.isPackaged is mutable so tests can toggle dev mode
vi.mock('electron', () => ({
  app: { isPackaged: true },
}));

// Mock electron-updater with an EventEmitter-based autoUpdater
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  const autoUpdater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn().mockResolvedValue({}),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null,
  });
  return { default: { autoUpdater }, autoUpdater };
});

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AppUpdater } from '../src/main/updater.js';

describe('AppUpdater', () => {
  let onStatusChange;
  let onNotify;

  beforeEach(() => {
    vi.useFakeTimers();
    onStatusChange = vi.fn();
    onNotify = vi.fn();

    // Reset the shared autoUpdater mock between tests
    autoUpdater.removeAllListeners();
    vi.clearAllMocks();

    // vi.clearAllMocks() clears onStatusChange/onNotify too, recreate after
    onStatusChange = vi.fn();
    onNotify = vi.fn();

    // Restore mock implementations cleared by clearAllMocks
    autoUpdater.checkForUpdates.mockResolvedValue({});
    autoUpdater.downloadUpdate.mockResolvedValue(undefined);

    app.isPackaged = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    app.isPackaged = true;
  });

  // ---------------------------------------------------------------------------
  // 1. Dev mode (disabled state)
  // ---------------------------------------------------------------------------
  describe('dev mode (disabled state)', () => {
    beforeEach(() => {
      app.isPackaged = false;
    });

    it('sets status to disabled', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      expect(updater.status).toBe('disabled');
    });

    it('checkForUpdates is a no-op', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      updater.checkForUpdates();
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('downloadUpdate is a no-op', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      updater.downloadUpdate();
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('installUpdate is a no-op', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      updater.installUpdate();
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('status is idle', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      expect(updater.status).toBe('idle');
    });

    it('updateVersion is null', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      expect(updater.updateVersion).toBeNull();
    });

    it('errorMessage is null', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      expect(updater.errorMessage).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Check for updates flow
  // ---------------------------------------------------------------------------
  describe('checkForUpdates flow', () => {
    it('calls autoUpdater.checkForUpdates', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      updater.checkForUpdates();
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    });

    it('status becomes checking on checking-for-update event', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('checking-for-update');
      expect(updater.status).toBe('checking');
    });

    it('calls onStatusChange with checking', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('checking-for-update');
      expect(onStatusChange).toHaveBeenCalledWith('checking');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Update available flow
  // ---------------------------------------------------------------------------
  describe('update-available flow', () => {
    it('status becomes available and updateVersion is set', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-available', { version: '1.2.3' });
      expect(updater.status).toBe('available');
      expect(updater.updateVersion).toBe('1.2.3');
    });

    it('calls onNotify with a message containing the version', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-available', { version: '1.2.3' });
      expect(onNotify).toHaveBeenCalledOnce();
      const [title, message] = onNotify.mock.calls[0];
      expect(title).toBeTruthy();
      expect(message).toContain('1.2.3');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. No update available flow
  // ---------------------------------------------------------------------------
  describe('update-not-available flow', () => {
    it('status becomes up-to-date', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-not-available', {});
      expect(updater.status).toBe('up-to-date');
    });

    it('status resets to idle after 30 seconds', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-not-available', {});
      vi.advanceTimersByTime(30000);
      expect(updater.status).toBe('idle');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Download flow
  // ---------------------------------------------------------------------------
  describe('downloadUpdate flow', () => {
    it('calls autoUpdater.downloadUpdate when available', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-available', { version: '1.2.3' });
      updater.downloadUpdate();
      expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    });

    it('status becomes downloading on download-progress event', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-available', { version: '1.2.3' });
      updater.downloadUpdate();
      autoUpdater.emit('download-progress', { percent: 50 });
      expect(updater.status).toBe('downloading');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Update downloaded flow
  // ---------------------------------------------------------------------------
  describe('update-downloaded flow', () => {
    it('status becomes ready', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-downloaded', { version: '1.2.3' });
      expect(updater.status).toBe('ready');
    });

    it('calls onNotify', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-downloaded', { version: '1.2.3' });
      expect(onNotify).toHaveBeenCalledOnce();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Install update flow
  // ---------------------------------------------------------------------------
  describe('installUpdate flow', () => {
    it('calls quitAndInstall(false, true) when status is ready', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-downloaded', { version: '1.2.3' });
      updater.installUpdate();
      expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Error handling
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    it('status becomes error and errorMessage is set', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('error', new Error('Network failed'));
      expect(updater.status).toBe('error');
      expect(updater.errorMessage).toBe('Network failed');
    });

    it('calls onNotify with the error message', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('error', new Error('Network failed'));
      expect(onNotify).toHaveBeenCalledOnce();
      const [, message] = onNotify.mock.calls[0];
      expect(message).toContain('Network failed');
    });

    it('status resets to idle after 30 seconds', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('error', new Error('Network failed'));
      vi.advanceTimersByTime(30000);
      expect(updater.status).toBe('idle');
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Concurrency guard — checkForUpdates
  // ---------------------------------------------------------------------------
  describe('concurrency guard', () => {
    it('does not call checkForUpdates again when already checking', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      // Drive status to 'checking' via event (simulates the flow after a first call)
      autoUpdater.emit('checking-for-update');
      expect(updater.status).toBe('checking');

      updater.checkForUpdates();
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });

    it('does not call checkForUpdates when downloading', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-available', { version: '1.2.3' });
      autoUpdater.emit('download-progress', {});
      expect(updater.status).toBe('downloading');

      updater.checkForUpdates();
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 11. downloadUpdate guard
  // ---------------------------------------------------------------------------
  describe('downloadUpdate guard', () => {
    it('is a no-op when status is idle', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      updater.downloadUpdate();
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op when status is checking', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('checking-for-update');
      updater.downloadUpdate();
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 12. installUpdate guard
  // ---------------------------------------------------------------------------
  describe('installUpdate guard', () => {
    it('does not call quitAndInstall when status is not ready', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      // idle
      updater.installUpdate();
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('does not call quitAndInstall when status is available', () => {
      const updater = new AppUpdater({ onStatusChange, onNotify });
      autoUpdater.emit('update-available', { version: '1.2.3' });
      updater.installUpdate();
      expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });
});
