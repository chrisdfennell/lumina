// Auto-update via electron-updater. Checks GitHub Releases for a newer
// installer (matched against the published latest.yml), downloads it in the
// background, and offers a one-click restart-to-update. No-ops in dev / when
// the app isn't packaged, so `npm start` never hits the network for this.

const { app, dialog } = require('electron');

let started = false;

function initAutoUpdate(getWindow) {
  if (started) return;
  started = true;

  // electron-updater throws if there's no app-update.yml (i.e. unpackaged dev
  // build). Only run for real installs.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('electron-updater not available:', err);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const notify = (channel, payload) => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  autoUpdater.on('update-available', (info) => {
    notify('update:available', { version: info?.version });
  });

  autoUpdater.on('download-progress', (p) => {
    notify('update:progress', { percent: Math.round(p?.percent || 0) });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    notify('update:ready', { version: info?.version });
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
    console.error('auto-update error:', err);
  });

  // Check shortly after launch, then every 6 hours.
  const check = () => autoUpdater.checkForUpdates().catch((e) => console.error('update check failed:', e));
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

module.exports = { initAutoUpdate };
