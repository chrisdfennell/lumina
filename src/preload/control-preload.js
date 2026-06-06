const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumina', {
  getState: () => ipcRenderer.invoke('state:get'),
  addFiles: (paths) => ipcRenderer.invoke('media:addFiles', paths),
  addFilesDialog: () => ipcRenderer.invoke('media:addFilesDialog'),
  addYouTube: (url) => ipcRenderer.invoke('media:addYouTube', url),
  addWeb: (url) => ipcRenderer.invoke('media:addWeb', url),
  addShader: (preset) => ipcRenderer.invoke('media:addShader', preset),
  addViz: (style) => ipcRenderer.invoke('media:addViz', style),
  addOnline: (provider, query, categories) => ipcRenderer.invoke('media:addOnline', { provider, query, categories }),
  searchOnline: (provider, query, cursor, sorting, categories) => ipcRenderer.invoke('online:search', { provider, query, cursor, sorting, categories }),
  addImageUrl: (url, name) => ipcRenderer.invoke('media:addImageUrl', { url, name }),
  retryYouTube: (id) => ipcRenderer.invoke('media:retryYouTube', id),
  removeItem: (id) => ipcRenderer.invoke('media:remove', id),
  assign: (displayId, itemId) => ipcRenderer.invoke('assign:set', { displayId, itemId }),
  clearAssignment: (displayId) => ipcRenderer.invoke('assign:clear', displayId),
  setFit: (displayId, fit) => ipcRenderer.invoke('fit:set', { displayId, fit }),
  setEffects: (displayId, effects) => ipcRenderer.invoke('effects:set', { displayId, effects }),
  setWidgets: (displayId, widgets) => ipcRenderer.invoke('widgets:set', { displayId, widgets }),
  setPlaylist: (displayId, opts) => ipcRenderer.invoke('playlist:set', { displayId, ...opts }),
  clearPlaylist: (displayId) => ipcRenderer.invoke('playlist:clear', displayId),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  onStateChanged: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },

  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  close: () => ipcRenderer.send('window:close'),
  quit: () => ipcRenderer.send('app:quit'),
});
