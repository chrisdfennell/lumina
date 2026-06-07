const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wp', {
  onPlay: (cb) => ipcRenderer.on('wallpaper:play', (_e, payload) => cb(payload)),
  onPause: (cb) => ipcRenderer.on('wallpaper:pause', () => cb()),
  onResume: (cb) => ipcRenderer.on('wallpaper:resume', () => cb()),
  onVolume: (cb) => ipcRenderer.on('wallpaper:volume', (_e, v) => cb(v)),
  onFit: (cb) => ipcRenderer.on('wallpaper:fit', (_e, f) => cb(f)),
  onEffects: (cb) => ipcRenderer.on('wallpaper:effects', (_e, eff) => cb(eff)),
  onCursor: (cb) => ipcRenderer.on('wallpaper:cursor', (_e, c) => cb(c)),
  onWidgets: (cb) => ipcRenderer.on('wallpaper:widgets', (_e, w) => cb(w)),
  onWidgetData: (cb) => ipcRenderer.on('wallpaper:widgetdata', (_e, d) => cb(d)),
  onNightShift: (cb) => ipcRenderer.on('wallpaper:nightshift', (_e, w) => cb(w)),
  onWeather: (cb) => ipcRenderer.on('wallpaper:weather', (_e, info) => cb(info)),
  onPower: (cb) => ipcRenderer.on('wallpaper:power', (_e, p) => cb(p)),
});
