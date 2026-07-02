const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lumina', {
  getState: () => ipcRenderer.invoke('state:get'),
  // File.path was removed in Electron 32 — drag-drop resolves paths through this.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  addFiles: (paths) => ipcRenderer.invoke('media:addFiles', paths),
  addFilesDialog: () => ipcRenderer.invoke('media:addFilesDialog'),
  addYouTube: (url) => ipcRenderer.invoke('media:addYouTube', url),
  addVideo: (url) => ipcRenderer.invoke('media:addVideo', url),
  addWeb: (url) => ipcRenderer.invoke('media:addWeb', url),
  addBuiltin: (kind, preset, options) => ipcRenderer.invoke('media:addBuiltin', { kind, preset, options }),
  setOptions: (id, options, name) => ipcRenderer.invoke('media:setOptions', { id, options, name }),
  saveShaderCode: (id, name, code) => ipcRenderer.invoke('media:saveShaderCode', { id, name, code }),
  exportItem: (id) => ipcRenderer.invoke('media:exportItem', id),
  importItem: () => ipcRenderer.invoke('media:importItem'),
  addViz: (style) => ipcRenderer.invoke('media:addViz', style),
  addAlbumArt: () => ipcRenderer.invoke('media:addAlbumArt'),
  addDepth: () => ipcRenderer.invoke('media:addDepth'),
  generateDepth: (id, tensor) => ipcRenderer.invoke('depth:generate', { id, tensor }),
  onDepthProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('depth:progress', listener);
    return () => ipcRenderer.removeListener('depth:progress', listener);
  },
  addFolder: () => ipcRenderer.invoke('media:addFolder'),
  setFolderOpts: (id, intervalMin, shuffle) => ipcRenderer.invoke('media:setFolderOpts', { id, intervalMin, shuffle }),
  fetchGallery: () => ipcRenderer.invoke('gallery:fetch'),
  installGalleryItem: (item) => ipcRenderer.invoke('gallery:install', item),
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
  saveProfile: (name) => ipcRenderer.invoke('profile:save', name),
  loadProfile: (name) => ipcRenderer.invoke('profile:load', name),
  deleteProfile: (name) => ipcRenderer.invoke('profile:delete', name),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),

  onStateChanged: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },

  onUpdate: (cb) => {
    const map = {
      'update:available': 'available', 'update:ready': 'ready', 'update:error': 'error',
      'update:checking': 'checking', 'update:none': 'none', 'update:progress': 'progress',
    };
    const listeners = Object.entries(map).map(([chan, kind]) => {
      const fn = (_e, p) => cb(kind, p);
      ipcRenderer.on(chan, fn);
      return [chan, fn];
    });
    return () => listeners.forEach(([chan, fn]) => ipcRenderer.removeListener(chan, fn));
  },

  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  hide: () => ipcRenderer.send('window:hide'),
  close: () => ipcRenderer.send('window:close'),
  quit: () => ipcRenderer.send('app:quit'),
});
