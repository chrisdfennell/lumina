// Auto-update via electron-updater. Checks GitHub Releases for a newer
// installer (matched against the published latest.yml), downloads it in the
// background, and offers a one-click restart-to-update. No-ops in dev / when
// the app isn't packaged, so `npm start` never hits the network for this.

const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

let started = false;
let autoUpdater = null;
let notifyFn = null;
let logFile = null;

// Append a line to userData/updater.log so a stuck update can be diagnosed
// after the fact (electron-updater otherwise only writes to the console).
function logLine(level, ...args) {
  const msg = `[${level}] ${args.map((a) => (a && a.stack) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`;
  console.log('[updater]', msg);
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'updater.log');
    fs.appendFileSync(logFile, msg + '\n');
  } catch {}
}

function initAutoUpdate(getWindow) {
  if (started) return;
  started = true;

  notifyFn = (channel, payload) => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // electron-updater throws if there's no app-update.yml (i.e. unpackaged dev
  // build). Only run for real installs.
  if (!app.isPackaged) return;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    logLine('error', 'electron-updater not available:', err);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Mirror electron-updater's own logging into our file for diagnosis.
  autoUpdater.logger = { info: (m) => logLine('info', m), warn: (m) => logLine('warn', m), error: (m) => logLine('error', m), debug: () => {} };

  autoUpdater.on('checking-for-update', () => logLine('info', 'checking for update'));
  autoUpdater.on('update-not-available', (info) => { logLine('info', 'up to date', info?.version); notifyFn('update:none', { version: info?.version }); });

  autoUpdater.on('update-available', (info) => {
    logLine('info', 'update available', info?.version);
    notifyFn('update:available', { version: info?.version });
  });

  autoUpdater.on('download-progress', (p) => {
    notifyFn('update:progress', { percent: Math.round(p?.percent || 0) });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    logLine('info', 'update downloaded', info?.version);
    notifyFn('update:ready', { version: info?.version });
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Lumina ${info?.version || ''} is ready to install.`,
      detail: 'Restart to apply the update. Your wallpapers and settings are kept.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    logLine('error', 'auto-update error:', err);
    notifyFn('update:error', { message: String((err && err.message) || err) });
  });

  // Check shortly after launch, then every 6 hours.
  setTimeout(() => checkForUpdatesNow(false), 8000);
  setInterval(() => checkForUpdatesNow(false), 6 * 60 * 60 * 1000);
}

// Manually trigger a check (e.g. from the tray). `interactive` surfaces an
// "already up to date" / error toast; the periodic check stays quiet.
function checkForUpdatesNow(interactive) {
  if (!app.isPackaged) {
    if (interactive && notifyFn) notifyFn('update:error', { message: 'Updates only run in the installed app, not in dev mode.' });
    return;
  }
  if (!autoUpdater) return;
  if (interactive && notifyFn) notifyFn('update:checking', {});
  autoUpdater.checkForUpdates().catch((e) => {
    logLine('error', 'update check failed:', e);
    if (notifyFn) notifyFn('update:error', { message: String((e && e.message) || e) });
  });
}

module.exports = { initAutoUpdate, checkForUpdatesNow };
