'use strict';

// Update checking through electron-updater with a generic feed. Downloading and
// installing is intentionally left off: that needs a signed release pipeline.

function createUpdater({ forceDevConfig = false } = {}) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Unpacked dev runs are skipped by electron-updater unless this is set.
  if (forceDevConfig) autoUpdater.forceDevUpdateConfig = true;
  return autoUpdater;
}

function checkForUpdates(updater, { feedUrl, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      updater.removeListener('update-available', onAvailable);
      updater.removeListener('update-not-available', onNone);
      updater.removeListener('error', onError);
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    const onAvailable = (info) => finish({ ok: true, available: true, version: info && info.version });
    const onNone = (info) => finish({ ok: true, available: false, version: (info && info.version) || null });
    const onError = (err) => finish({ ok: false, error: (err && err.message) || String(err) });

    updater.on('update-available', onAvailable);
    updater.on('update-not-available', onNone);
    updater.on('error', onError);
    timer = setTimeout(() => finish({ ok: false, error: 'update check timed out' }), timeoutMs);

    try {
      if (feedUrl) updater.setFeedURL({ provider: 'generic', url: feedUrl });
      const pending = updater.checkForUpdates();
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => finish({ ok: false, error: (err && err.message) || String(err) }));
      }
    } catch (err) {
      finish({ ok: false, error: (err && err.message) || String(err) });
    }
  });
}

module.exports = { createUpdater, checkForUpdates };
