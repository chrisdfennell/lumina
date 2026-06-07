const { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, nativeImage, shell, powerMonitor, session, desktopCapturer, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const wallpaper = require('./wallpaper');
const { isFullscreenAppForeground, foregroundProcessName } = require('./foreground');
const store = require('./store');
const { parseYouTubeId, classifyFile, MEDIA_FILTERS } = require('./media');
const youtube = require('./youtube');
const { initAutoUpdate, checkForUpdatesNow } = require('./updater');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const isDev = process.argv.includes('--dev');

// How a wallpaper is scaled to its monitor. Values are CSS object-fit keywords
// applied directly in the wallpaper renderer.
const FIT_MODES = ['cover', 'contain', 'fill', 'none'];
const DEFAULT_FIT = 'cover';
const normalizeFit = (f) => (FIT_MODES.includes(f) ? f : DEFAULT_FIT);

// Per-monitor visual effects. Percent values are 100 = unchanged; blur is px.
const OVERLAY_TYPES = ['none', 'rain', 'snow', 'fireflies', 'matrix'];
const GRADE_PRESETS = ['none', 'warm', 'cool', 'noir', 'vintage', 'vibrant'];
const DEFAULT_EFFECTS = { brightness: 100, saturation: 100, blur: 0, speed: 100, parallax: 0, audioReactive: 0, overlay: 'none', overlayIntensity: 50, vignette: 0, grain: 0, grade: 'none', kenBurns: 0 };
const clamp = (v, lo, hi, dflt) =>
  (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
function normalizeEffects(e) {
  e = e || {};
  return {
    brightness: clamp(e.brightness, 0, 200, 100),
    saturation: clamp(e.saturation, 0, 200, 100),
    blur: clamp(e.blur, 0, 40, 0),
    speed: clamp(e.speed, 25, 200, 100),
    parallax: clamp(e.parallax, 0, 100, 0),
    audioReactive: clamp(e.audioReactive, 0, 100, 0),
    overlay: OVERLAY_TYPES.includes(e.overlay) ? e.overlay : 'none',
    overlayIntensity: clamp(e.overlayIntensity, 0, 100, 50),
    vignette: clamp(e.vignette, 0, 100, 0),
    grain: clamp(e.grain, 0, 100, 0),
    grade: GRADE_PRESETS.includes(e.grade) ? e.grade : 'none',
    kenBurns: clamp(e.kenBurns, 0, 100, 0),
  };
}
const effectsKey = (e) => {
  const n = normalizeEffects(e);
  return `${n.brightness},${n.saturation},${n.blur},${n.speed},${n.parallax},${n.audioReactive},${n.overlay},${n.overlayIntensity},${n.vignette},${n.grain},${n.grade},${n.kenBurns}`;
};

// Per-monitor info widgets (clock / date / weather / system stats).
const WIDGET_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
function normalizeWidgets(w) {
  w = w || {};
  return {
    clock: !!w.clock,
    seconds: !!w.seconds,
    date: !!w.date,
    weather: !!w.weather,
    weatherLocation: typeof w.weatherLocation === 'string' ? w.weatherLocation.slice(0, 60) : '',
    stats: !!w.stats,
    graphs: !!w.graphs,
    nowplaying: !!w.nowplaying,
    position: WIDGET_POSITIONS.includes(w.position) ? w.position : 'top-left',
  };
}
const widgetsActive = (w) => w.clock || w.date || w.weather || w.stats || w.graphs || w.nowplaying;

// Critical for live wallpapers. Two separate problems are solved here:
//
// 1) Chromium's occlusion detection thinks a window re-parented behind the
//    desktop icons is hidden and STOPS painting it (blank/white). Disable it.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Render cross-origin iframes (the YouTube embed) in-process so they share the
// main frame's compositing surface — otherwise the out-of-process iframe paints
// to a separate surface that doesn't present in the reparented wallpaper window.
app.commandLine.appendSwitch('disable-site-isolation-trials');
//
// 2) THE key fix. Chromium presents window content via DirectComposition (a DWM
//    visual attached to the window's HWND). Once the window is SetParent()'d into
//    the desktop's WorkerW, that DComp visual is never composited onto the
//    desktop — the window sits in the correct layer (with GPU on it even shows an
//    opaque white backbuffer over the wallpaper) but the actual rendered content
//    never appears. Disabling Direct Composition forces the legacy swap-chain
//    present path, which DOES paint into a reparented child window. GPU
//    rasterization and video decode are kept, so playback stays smooth.
app.commandLine.appendSwitch('disable-direct-composition');
//
// 3) Multi-monitor DPI. We size/position the reparented wallpaper windows with
//    raw Win32 SetWindowPos in PHYSICAL pixels (see wallpaper.js / physicalLayout).
//    On a monitor with fractional scaling (e.g. 150%), Chromium's presented
//    surface can desync from that physical resize and end up painting only the
//    top-left LOGICAL-sized region (e.g. 1707×1067 of a 2560×1600 screen),
//    leaving the static wallpaper showing through the rest. Forcing the device
//    scale factor to 1 makes device pixels == physical pixels everywhere, so the
//    surface always fills the window. This app already computes all wallpaper
//    geometry in physical pixels, so the layout math is unaffected.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Single instance — re-launching just focuses the control window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let controlWin = null;
let tray = null;
let isQuitting = false;
/** @type {Map<string, BrowserWindow>} displayId -> wallpaper window */
const wallpaperWindows = new Map();
let reconcileTimer = null;

// Auto-pause state (fullscreen apps / battery).
let autoPaused = false;
let pauseTimer = null;
let onBattery = false;

// Playlist rotation: displayId -> { idx, timer, intervalSec, key }.
const rotation = new Map();
const MIN_INTERVAL = 5; // seconds — floor to keep rotation sane

// Mouse parallax cursor polling.
let cursorTimer = null;

// Online wallpaper sources (fetch + auto-rotate): displayId -> { timer }.
const onlineState = new Map();

// -------------------------------------------------------------------------
// Display geometry
// -------------------------------------------------------------------------

/** Stable id for a display across reconciles. */
function displayKey(d) {
  return String(d.id);
}

/**
 * Compute, for each display, its physical-pixel rect relative to the
 * virtual-screen origin (which is where WorkerW's (0,0) lives).
 */
function physicalLayout() {
  const displays = screen.getAllDisplays();
  const corners = displays.map((d) => {
    const tl = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
    return {
      d,
      physX: tl.x,
      physY: tl.y,
      physW: Math.round(d.bounds.width * d.scaleFactor),
      physH: Math.round(d.bounds.height * d.scaleFactor),
    };
  });
  const virtLeft = Math.min(...corners.map((c) => c.physX));
  const virtTop = Math.min(...corners.map((c) => c.physY));
  const map = new Map();
  // Span mode: a single window covering the whole virtual desktop (the union of
  // all monitor rects, in physical pixels) → one wallpaper across every screen.
  if (store.getState().settings.spanMode) {
    const virtRight = Math.max(...corners.map((c) => c.physX + c.physW));
    const virtBottom = Math.max(...corners.map((c) => c.physY + c.physH));
    map.set('span', {
      display: screen.getPrimaryDisplay(),
      rect: { x: 0, y: 0, width: virtRight - virtLeft, height: virtBottom - virtTop },
    });
    return map;
  }
  for (const c of corners) {
    map.set(displayKey(c.d), {
      display: c.d,
      rect: { x: c.physX - virtLeft, y: c.physY - virtTop, width: c.physW, height: c.physH },
    });
  }
  return map;
}

/** Sanitize a stored playlist: drop ids no longer in the library, clamp interval. */
function normalizePlaylist(pl) {
  const empty = { items: [], intervalSec: 30, shuffle: false, mode: 'interval', times: {} };
  if (!pl || !Array.isArray(pl.items)) return empty;
  const lib = new Set(store.getState().library.map((i) => i.id));
  const items = pl.items.filter((id) => lib.has(id));
  const times = {};
  if (pl.times) for (const id of items) {
    if (typeof pl.times[id] === 'string' && /^\d{1,2}:\d{2}$/.test(pl.times[id])) times[id] = pl.times[id];
  }
  return {
    items,
    intervalSec: Math.max(MIN_INTERVAL, Math.round(+pl.intervalSec || 30)),
    shuffle: !!pl.shuffle,
    mode: pl.mode === 'schedule' ? 'schedule' : 'interval',
    times,
  };
}

const parseHM = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

/** Pick the scheduled item for the current time of day (wraps past midnight). */
function resolveScheduledItem(pl) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const entries = pl.items
    .map((id) => ({ id, mins: parseHM(pl.times[id]) }))
    .filter((e) => e.mins != null)
    .sort((a, b) => a.mins - b.mins);
  if (!entries.length) return pl.items[0];
  let chosen = entries[entries.length - 1]; // before the first slot → previous day's last
  for (const e of entries) if (e.mins <= cur) chosen = e;
  return chosen.id;
}

/** The library item id a display should show right now (playlist/schedule-aware). */
function currentItemIdFor(displayId) {
  const { assignments, playlists } = store.getState();
  const pl = normalizePlaylist(playlists[displayId]);
  if (pl.items.length) {
    if (pl.mode === 'schedule') return resolveScheduledItem(pl);
    const idx = (rotation.get(displayId)?.idx || 0) % pl.items.length;
    return pl.items[idx];
  }
  return assignments[displayId] || null;
}

function describeDisplays() {
  const { assignments, fits, effects, playlists, widgets, settings } = store.getState();
  const primaryId = screen.getPrimaryDisplay().id;
  // Span mode presents a single virtual "display" so the whole rest of the
  // pipeline (apply menu, effects, widgets, cursor, …) works unchanged.
  if (settings.spanMode) {
    const ds = screen.getAllDisplays();
    const left = Math.min(...ds.map((d) => d.bounds.x));
    const top = Math.min(...ds.map((d) => d.bounds.y));
    const right = Math.max(...ds.map((d) => d.bounds.x + d.bounds.width));
    const bottom = Math.max(...ds.map((d) => d.bounds.y + d.bounds.height));
    const pxRight = Math.max(...ds.map((d) => Math.round((d.bounds.x + d.bounds.width) * d.scaleFactor)));
    const pxLeft = Math.min(...ds.map((d) => Math.round(d.bounds.x * d.scaleFactor)));
    const pxBottom = Math.max(...ds.map((d) => Math.round((d.bounds.y + d.bounds.height) * d.scaleFactor)));
    const pxTop = Math.min(...ds.map((d) => Math.round(d.bounds.y * d.scaleFactor)));
    return [{
      id: 'span',
      index: 0,
      label: `All displays (spanned · ${ds.length})`,
      resolution: `${pxRight - pxLeft} × ${pxBottom - pxTop}`,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      primary: true,
      assignedItemId: assignments['span'] || null,
      playlist: normalizePlaylist(playlists['span']),
      fit: normalizeFit(fits['span']),
      effects: normalizeEffects(effects['span']),
      widgets: normalizeWidgets(widgets['span']),
    }];
  }
  return screen.getAllDisplays().map((d, idx) => {
    const key = displayKey(d);
    return {
      id: key,
      index: idx,
      label: `Display ${idx + 1}`,
      resolution: `${Math.round(d.bounds.width * d.scaleFactor)} × ${Math.round(d.bounds.height * d.scaleFactor)}`,
      bounds: d.bounds,
      primary: d.id === primaryId,
      assignedItemId: assignments[key] || null,
      playlist: normalizePlaylist(playlists[key]),
      fit: normalizeFit(fits[key]),
      effects: normalizeEffects(effects[key]),
      widgets: normalizeWidgets(widgets[key]),
    };
  });
}

// -------------------------------------------------------------------------
// Wallpaper windows
// -------------------------------------------------------------------------

function createWallpaperWindow(display, rect) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: rect.width,
    height: rect.height,
    // Pin a minimum size equal to the full monitor. Electron/Chromium otherwise
    // clamps a frameless window to the monitor work area (excluding the taskbar)
    // on show, which leaves the wallpaper short along the taskbar edge. A min
    // size that large stops the clamp from shrinking it below the full screen.
    minWidth: rect.width,
    minHeight: rect.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    show: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true, // allow covering the taskbar area
    hasShadow: false,
    thickFrame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'wallpaper-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenu(null);
  if (isDev) {
    // Guarded: a broken stdout pipe (e.g. piped log filter closing) would
    // otherwise throw EPIPE from console.log and crash the main process.
    win.webContents.on('console-message', (_e, level, message) => {
      try { console.log(`[wp-renderer] ${message}`); } catch {}
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      try { console.log(`[wp-renderer] did-fail-load ${code} ${desc} ${url}`); } catch {}
    });
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'wallpaper', 'index.html'));
  // Show without activating so Electron marks the window VISIBLE. Without this,
  // Electron still considers the window hidden (we created it with show:false and
  // only do a Win32 ShowWindow during attach), so Chromium never paints it —
  // the window stays blank/white. This makes Chromium render its content.
  win.showInactive();
  return win;
}

/**
 * Keep a wallpaper window pinned to its full physical-pixel rect. Electron
 * clamps frameless windows to the monitor work area (excluding the taskbar)
 * shortly AFTER show, and again on some display events — which would otherwise
 * leave the bottom of the wallpaper short by the taskbar height. We re-assert
 * the raw Win32 geometry a few times after attach, and whenever Electron resizes
 * the window away from the rect we want.
 */
function enforceGeometry(win, rect) {
  win._desiredRect = rect;
  const apply = () => {
    if (win.isDestroyed() || !win._desiredRect) return;
    win._applyingGeom = true;
    try {
      wallpaper.positionWindow(win, win._desiredRect);
    } catch (err) {
      if (isDev) console.log('positionWindow failed:', err);
    } finally {
      win._applyingGeom = false;
    }
  };
  apply();
  for (const ms of [120, 400, 1000]) setTimeout(apply, ms);

  if (!win._geomHooked) {
    win._geomHooked = true;
    win.on('resize', () => {
      // Ignore the WM_SIZE our own SetWindowPos triggers; only react when
      // Electron clamped us to something other than the desired physical size.
      if (win._applyingGeom || win.isDestroyed() || !win._desiredRect) return;
      setTimeout(apply, 0);
    });
  }
}

function mediaPayload(item, fit, effects) {
  if (!item || item.type === 'online') return null; // online resolved via startOnline()
  const { settings } = store.getState();
  fit = normalizeFit(fit);
  effects = normalizeEffects(effects);
  const crossfade = settings.transitions !== false;
  if (item.type === 'youtube') {
    // Downloaded → play the local file via the working video path.
    if (item.localPath && fs.existsSync(item.localPath)) {
      return { type: 'video', src: pathToFileURL(item.localPath).href, volume: settings.volume, fit, effects, crossfade };
    }
    // Not yet downloaded → fall back to the embed.
    return { type: 'youtube', videoId: item.videoId, volume: settings.volume, fit, effects };
  }
  if (item.type === 'urlvideo') {
    // Plays once downloaded; nothing to show while it's still fetching.
    if (item.localPath && fs.existsSync(item.localPath)) {
      return { type: 'video', src: pathToFileURL(item.localPath).href, volume: settings.volume, fit, effects, crossfade };
    }
    return null;
  }
  if (item.type === 'viz') {
    return { type: 'viz', style: item.vizStyle || 'bars', fit, effects };
  }
  if (item.type === 'albumart') {
    return { type: 'albumart', fit, effects }; // art pushed separately via wallpaper:albumart
  }
  if (item.type === 'web') {
    let src = item.url;
    const optq = item.options
      ? Object.entries(item.options).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('')
      : '';
    // 2.5D depth-parallax wallpaper (base image + optional depth map).
    if (item.depth && item.base) {
      const file = pathToFileURL(path.join(__dirname, '..', 'renderer', 'depth', 'index.html')).href;
      const toUrl = (p) => (/^https?:\/\//i.test(p) ? p : pathToFileURL(p).href);
      const q = new URLSearchParams();
      q.set('base', toUrl(item.base));
      if (item.depthMap) q.set('map', toUrl(item.depthMap));
      q.set('strength', String((item.options && item.options.strength) || 25));
      q.set('invert', (item.options && item.options.invert) ? '1' : '0');
      return { type: 'web', src: `${file}?${q.toString()}`, fit, effects };
    }
    if (item.shaderPreset) {
      const file = pathToFileURL(path.join(__dirname, '..', 'renderer', 'shader', 'index.html')).href;
      // Custom shaders run user GLSL injected after load; the `id` token forces
      // a fresh iframe load when switching between two custom shaders.
      const idq = item.shaderPreset === 'custom' ? `&id=${encodeURIComponent(item.id)}` : '';
      src = `${file}?preset=${encodeURIComponent(item.shaderPreset)}${idq}${optq}`;
    } else if (item.canvasPreset) {
      const file = pathToFileURL(path.join(__dirname, '..', 'renderer', 'canvas', 'index.html')).href;
      src = `${file}?preset=${encodeURIComponent(item.canvasPreset)}${optq}`;
    }
    const payload = { type: 'web', src, fit, effects };
    if (item.shaderPreset === 'custom' && item.shaderCode) payload.shaderCode = item.shaderCode;
    return payload;
  }
  return {
    type: item.type, // 'video' | 'gif' | 'image'
    // src may be a local file path or a remote http(s) URL (picked online image).
    src: /^https?:\/\//i.test(item.src) ? item.src : pathToFileURL(item.src).href,
    volume: settings.volume,
    fit,
    effects,
    crossfade,
  };
}

function sendMediaTo(win, item, fit, effects) {
  const payload = mediaPayload(item, fit, effects);
  if (!payload) return;
  const dispatch = () => win.webContents.send('wallpaper:play', payload);
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }
}

/** Send widget config, waiting for the renderer to finish loading first. */
function sendWidgetsTo(win, wid) {
  const dispatch = () => { if (!win.isDestroyed()) win.webContents.send('wallpaper:widgets', wid); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', dispatch);
  else dispatch();
}

/**
 * Bring wallpaper windows in line with current displays + assignments.
 * Idempotent: only creates/destroys/repositions/re-sends media when something
 * actually changed. This is essential — repositioning windows can itself emit
 * `display-metrics-changed`, and a non-idempotent reconcile would loop forever
 * (constantly reloading the media, which renders as a blank/white screen).
 */
function reconcile() {
  const layout = physicalLayout();
  const { library, fits, effects, widgets } = store.getState();
  const byId = new Map(library.map((it) => [it.id, it]));

  const desired = new Set();
  for (const [displayId, info] of layout) {
    const itemId = currentItemIdFor(displayId);
    const item = itemId ? byId.get(itemId) : null;
    if (!item) continue; // unassigned display keeps the normal wallpaper
    desired.add(displayId);

    const fit = normalizeFit(fits[displayId]);
    const eff = normalizeEffects(effects[displayId]);
    const effKey = effectsKey(eff);
    const rectKey = `${info.rect.x},${info.rect.y},${info.rect.width},${info.rect.height}`;
    let win = wallpaperWindows.get(displayId);
    if (!win || win.isDestroyed()) {
      win = createWallpaperWindow(info.display, info.rect);
      win._rectKey = null;
      win._itemId = null;
      win._fit = null;
      win._effKey = null;
      win._widgetsKey = null;
      // Give a freshly-loaded window the current night-shift / weather + power state.
      win.webContents.on('did-finish-load', () => { pushAmbientTo(win); pushPowerTo(win); });
      wallpaperWindows.set(displayId, win);
    }

    // (Re)attach + position only when the geometry actually changed.
    if (win._rectKey !== rectKey) {
      try {
        wallpaper.attachWindow(win, info.rect);
        win._rectKey = rectKey;
        enforceGeometry(win, info.rect);
      } catch (err) {
        console.error('attachWindow failed:', err);
      }
    }

    // (Re)load media only when the assigned item actually changed.
    if (win._itemId !== item.id) {
      stopOnline(displayId); // clear any previous online rotation on this display
      if (item.type === 'online') startOnline(displayId, item);
      else sendMediaTo(win, item, fit, eff);
      win._itemId = item.id;
      win._fit = fit;
      win._effKey = effKey;
    } else {
      // Fit / effect-only changes: update live without reloading (no flash).
      if (win._fit !== fit) {
        win.webContents.send('wallpaper:fit', fit);
        win._fit = fit;
      }
      if (win._effKey !== effKey) {
        win.webContents.send('wallpaper:effects', eff);
        win._effKey = effKey;
      }
    }

    // Widget config (clock/date/weather/stats) — live, independent of media.
    const wid = normalizeWidgets(widgets[displayId]);
    const widKey = JSON.stringify(wid);
    if (win._widgetsKey !== widKey) {
      sendWidgetsTo(win, wid);
      win._widgetsKey = widKey;
    }
  }

  // Tear down windows for displays that are gone or no longer assigned.
  for (const [displayId, win] of [...wallpaperWindows]) {
    if (!desired.has(displayId)) {
      if (!win.isDestroyed()) {
        wallpaper.detachWindow(win);
        win.destroy();
      }
      wallpaperWindows.delete(displayId);
      stopOnline(displayId);
    }
  }

  // If we're currently auto-paused, keep any freshly-created windows paused too
  // (give their media a moment to load first so the pause sticks).
  if (autoPaused) setTimeout(() => { if (autoPaused) setWallpapersPaused(true); }, 400);

  syncRotationTimers();
  refreshCursorMonitor();
  refreshWidgetMonitor();
  refreshAmbientMonitor();
  refreshAlbumArtMonitor();
}

// -------------------------------------------------------------------------
// Playlist rotation timers
// -------------------------------------------------------------------------

/** Advance a display's playlist to the next (or a random) item and refresh it. */
function advanceRotation(displayId) {
  // Don't rotate while auto-paused — nothing is visible, and swapping media
  // would restart playback and visually defeat the pause.
  if (autoPaused) return;
  const pl = normalizePlaylist(store.getState().playlists[displayId]);
  if (pl.items.length < 2) return;
  const r = rotation.get(displayId) || { idx: 0 };
  let next;
  if (pl.shuffle) {
    do { next = Math.floor(Math.random() * pl.items.length); }
    while (next === r.idx % pl.items.length && pl.items.length > 1);
  } else {
    next = (r.idx + 1) % pl.items.length;
  }
  r.idx = next;
  rotation.set(displayId, r);
  reconcile(); // idempotent — re-sends only the display whose item changed
}

/** Create/refresh/clear rotation timers to match the current playlists. */
function syncRotationTimers() {
  const { playlists } = store.getState();
  const activeIds = new Set();

  for (const d of describeDisplays()) {
    const pl = normalizePlaylist(playlists[d.id]);
    if (pl.items.length < 2) continue; // nothing to rotate/schedule
    activeIds.add(d.id);
    const key = `${pl.mode}|${pl.items.join(',')}|${pl.intervalSec}|${pl.shuffle}|${JSON.stringify(pl.times)}`;
    const existing = rotation.get(d.id);
    if (existing && existing.timer && existing.key === key) continue; // unchanged
    if (existing && existing.timer) clearInterval(existing.timer);
    const idx = existing ? existing.idx % pl.items.length : 0;
    // Interval mode advances on a timer; schedule mode re-resolves by clock.
    const timer = pl.mode === 'schedule'
      ? setInterval(() => reconcile(), 30000)
      : setInterval(() => advanceRotation(d.id), pl.intervalSec * 1000);
    rotation.set(d.id, { idx, timer, key });
  }

  // Clear timers for displays no longer rotating.
  for (const [displayId, r] of [...rotation]) {
    if (!activeIds.has(displayId)) {
      if (r.timer) clearInterval(r.timer);
      rotation.delete(displayId);
    }
  }
}

function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    wallpaper.invalidateHost();
    reconcile();
    broadcastState();
  }, 250);
}

// -------------------------------------------------------------------------
// Shell-restart watchdog
// -------------------------------------------------------------------------
//
// When explorer.exe restarts (crash, Windows update, sometimes a display
// change), Windows destroys and recreates the WorkerW host. Our re-parented
// wallpaper windows survive as live windows but get orphaned, so they vanish
// from the desktop. Poll periodically and re-attach when that happens.
let watchdogTimer = null;
function startShellWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!wallpaperWindows.size) return;

    let broken = false;
    for (const win of wallpaperWindows.values()) {
      if (win.isDestroyed()) { broken = true; break; }
      if (!win._rectKey) continue; // freshly created, not attached yet — ignore
      if (wallpaper.needsReattach(win)) { broken = true; break; }
    }
    if (!broken) return;

    if (isDev || process.env.LUMINA_DEBUG) console.log('[watchdog] shell/WorkerW changed — rebuilding wallpapers');
    wallpaper.invalidateHost();

    // When the shell tears down the WorkerW it also destroys our child windows.
    // Electron doesn't know the native handle died, so we can't just re-attach —
    // destroy any window whose native handle is gone and let reconcile() rebuild
    // it fresh against the new WorkerW. Windows still alive are just re-attached.
    for (const [id, win] of [...wallpaperWindows]) {
      const dead = win.isDestroyed() || !wallpaper.isNativeAlive(win);
      if (dead) {
        try { if (!win.isDestroyed()) win.destroy(); } catch {}
        wallpaperWindows.delete(id);
      } else {
        win._rectKey = null; // force re-attach into the new host
      }
    }
    reconcile();
  }, 1500);
}

// -------------------------------------------------------------------------
// Online wallpaper sources (Wallhaven / subreddit) — fetch + rotate
// -------------------------------------------------------------------------

/**
 * Search a provider with pagination.
 * @returns {{ results: Array<{thumb,full,title}>, next: (number|string|null) }}
 *   `next` is the cursor for the following page (page number for Wallhaven,
 *   `after` token for Reddit), or null when there are no more results.
 */
// Fetch JSON, but turn an HTML/error response (rate-limit / block pages) into a
// clear message instead of a cryptic "Unexpected token '<'" JSON parse error.
async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const host = (() => { try { return new URL(url).hostname; } catch { return 'the source'; } })();
    if (res.status === 429) throw new Error(`${host} is rate-limiting — wait a moment and try again.`);
    throw new Error(`${host} blocked the request or returned no data. Try again, or use Wallhaven.`);
  }
}

async function searchOnline(provider, query, sorting = 'relevance', cursor = null, categories = '111') {
  if (provider === 'openverse') {
    const page = cursor || 1;
    const json = await fetchJson(
      // page_size capped at 20 for anonymous Openverse requests.
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query || 'wallpaper')}&page=${page}&page_size=20&mature=false&aspect_ratio=wide`,
      { 'User-Agent': 'Lumina/0.1' },
    );
    const results = (json.results || [])
      .filter((r) => r.url)
      .map((r) => ({ full: r.url, thumb: r.thumbnail || r.url, title: r.title || '' }));
    return { results, next: page < (json.page_count || 1) ? page + 1 : null };
  }
  if (provider === 'reddit') {
    const sub = (query || 'wallpapers').replace(/[^\w]/g, '') || 'wallpapers';
    const after = cursor || '';
    const json = await fetchJson(
      `https://www.reddit.com/r/${sub}/hot.json?limit=50&raw_json=1&after=${encodeURIComponent(after)}`,
      { 'User-Agent': 'windows:com.lumina.wallpaper:v0.1 (live wallpaper app)', 'Accept': 'application/json' },
    );
    const results = (json.data?.children || [])
      .map((c) => c.data)
      .filter((d) => d && /\.(jpe?g|png|webp)$/i.test(d.url || ''))
      .map((d) => ({ full: d.url, thumb: /^https?:\/\//.test(d.thumbnail || '') ? d.thumbnail : d.url, title: d.title || '' }));
    return { results, next: json.data?.after || null };
  }
  // Wallhaven — no API key, SFW only. categories: general|anime|people bitmask.
  const q = encodeURIComponent(query || '');
  const page = cursor || 1;
  const cats = /^[01]{3}$/.test(categories) ? categories : '111';
  const json = await fetchJson(
    `https://wallhaven.cc/api/v1/search?q=${q}&categories=${cats}&purity=100&sorting=${sorting}&atleast=1920x1080&page=${page}`,
    { 'User-Agent': 'Lumina/0.1' },
  );
  const results = (json.data || [])
    .filter((d) => d.path)
    .map((d) => ({ full: d.path, thumb: d.thumbs?.small || d.thumbs?.original || d.path, title: d.resolution || '' }));
  const meta = json.meta || {};
  const next = (meta.current_page && meta.last_page && meta.current_page < meta.last_page) ? meta.current_page + 1 : null;
  return { results, next };
}

async function fetchOnlineImage(item) {
  const { results } = await searchOnline(item.provider, item.query, 'random', null, item.categories || '111');
  return results.length ? results[Math.floor(Math.random() * results.length)].full : null;
}

async function showOnline(displayId, item) {
  const win = wallpaperWindows.get(displayId);
  if (!win || win.isDestroyed()) return;
  let url = null;
  try { url = await fetchOnlineImage(item); } catch (err) { if (isDev) console.log('online fetch failed:', err); }
  if (!url || win.isDestroyed()) return;
  const { effects, fits } = store.getState();
  const payload = { type: 'image', src: url, fit: normalizeFit(fits[displayId]), effects: normalizeEffects(effects[displayId]) };
  const dispatch = () => { if (!win.isDestroyed()) win.webContents.send('wallpaper:play', payload); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', dispatch);
  else dispatch();
}

function startOnline(displayId, item) {
  stopOnline(displayId);
  showOnline(displayId, item);
  const mins = Math.max(5, Math.round(+item.intervalMin || 30));
  const timer = setInterval(() => showOnline(displayId, item), mins * 60 * 1000);
  onlineState.set(displayId, { timer });
}

function stopOnline(displayId) {
  const s = onlineState.get(displayId);
  if (s && s.timer) clearInterval(s.timer);
  onlineState.delete(displayId);
}

// -------------------------------------------------------------------------
// Auto-pause (save GPU/battery behind fullscreen apps or on battery)
// -------------------------------------------------------------------------

function setWallpapersPaused(paused) {
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(paused ? 'wallpaper:pause' : 'wallpaper:resume');
  }
}

/** Decide whether wallpapers should be auto-paused right now, and apply it. */
function evaluateAutoPause() {
  const { settings } = store.getState();
  let idle = false;
  if (settings.idlePauseMin > 0) {
    try { idle = powerMonitor.getSystemIdleTime() >= settings.idlePauseMin * 60; } catch {}
  }
  let appMatch = false;
  if (settings.pauseApps && settings.pauseApps.length) {
    try {
      const fg = foregroundProcessName();
      if (fg) appMatch = settings.pauseApps.some((a) => a && fg === String(a).toLowerCase());
    } catch {}
  }
  const wantPause =
    (settings.pauseOnFullscreen && isFullscreenAppForeground()) ||
    (settings.pauseOnBattery && onBattery) ||
    idle || appMatch;

  if (wantPause && !autoPaused) {
    autoPaused = true;
    setWallpapersPaused(true);
  } else if (!wantPause && autoPaused) {
    autoPaused = false;
    setWallpapersPaused(false);
  }
}

// -------------------------------------------------------------------------
// Mouse parallax — feed the cursor position (per display) to the renderer.
// -------------------------------------------------------------------------

// A depth-parallax wallpaper needs cursor input even when the parallax effect
// is off, since it does its own per-pixel displacement.
function displayHasDepth(displayId) {
  const { assignments, library } = store.getState();
  const it = library.find((i) => i.id === assignments[displayId]);
  return !!(it && it.depth);
}

function sendCursor() {
  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch { return; }
  for (const d of describeDisplays()) {
    if (!d.effects.parallax && !displayHasDepth(d.id)) continue;
    const win = wallpaperWindows.get(d.id);
    if (!win || win.isDestroyed()) continue;
    const b = d.bounds; // DIP bounds; cursor is in DIP too
    // Only parallax when the cursor is actually on THIS monitor; otherwise
    // recenter (x:0,y:0) so a wallpaper doesn't keep shifting from the other screen.
    const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    const nx = inside ? ((pt.x - b.x) / b.width) * 2 - 1 : 0;
    const ny = inside ? ((pt.y - b.y) / b.height) * 2 - 1 : 0;
    win.webContents.send('wallpaper:cursor', { x: nx, y: ny, amount: d.effects.parallax });
  }
}

function refreshCursorMonitor() {
  const anyParallax = describeDisplays().some((d) => d.effects.parallax > 0 || displayHasDepth(d.id));
  if (anyParallax && !cursorTimer) {
    cursorTimer = setInterval(sendCursor, 33); // ~30fps
  } else if (!anyParallax && cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
    for (const win of wallpaperWindows.values()) {
      if (!win.isDestroyed()) win.webContents.send('wallpaper:cursor', null); // reset
    }
  }
}

// -------------------------------------------------------------------------
// Widget data (CPU/RAM stats + weather) pushed to wallpapers that show them.
// -------------------------------------------------------------------------
let widgetTimer = null;
let lastCpuSample = null;
let weatherCache = null;       // { temp, cond }
let weatherFetchedAt = 0;
let weatherLoc = null;
let nowPlayingCache = null;    // { title, artist }
let nowPlayingTimer = null;
let nowPlayingBusy = false;

// Query Windows "now playing" via the bundled SMTC PowerShell helper. Best-effort:
// resolves to null on any failure or timeout so it never blocks the widget loop.
function fetchNowPlaying() {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (val) => { if (done) return; done = true; clearTimeout(killer); resolve(val); };
    // In a packaged build the script is unpacked from the asar so PowerShell can read it.
    const scriptPath = path.join(__dirname, 'nowplaying.ps1').replace('app.asar', 'app.asar.unpacked');
    let ps;
    try {
      ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true });
    } catch { return resolve(null); }
    const killer = setTimeout(() => { try { ps.kill(); } catch {} finish(null); }, 4500);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('error', () => finish(null));
    ps.on('close', () => {
      try {
        const o = JSON.parse(out.trim());
        finish(o && o.title ? { title: String(o.title).slice(0, 60), artist: String(o.artist || '').slice(0, 60) } : null);
      } catch { finish(null); }
    });
  });
}

// ---- GPU utilization (0-100) via a long-lived streaming gpu.ps1 helper ----
// Get-Counter over the GPU-engine wildcard costs ~8s to (re)open, so we run one
// persistent `-Continuous` process and read its streamed samples rather than
// spawning per tick.
let gpuCache = null;
let gpuProc = null;
let gpuWanted = false;

function startGpuMonitor() {
  gpuWanted = true;
  if (gpuProc) return;
  const scriptPath = path.join(__dirname, 'gpu.ps1').replace('app.asar', 'app.asar.unpacked');
  try {
    gpuProc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true });
  } catch { gpuProc = null; return; }
  let buf = '';
  gpuProc.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const n = parseInt(line.trim(), 10);
      if (!Number.isFinite(n)) continue;
      const val = Math.max(0, Math.min(100, n));
      const changed = val !== gpuCache;
      gpuCache = val;
      if (changed) pushWidgetData();
    }
  });
  gpuProc.on('error', () => { gpuProc = null; });
  gpuProc.on('close', () => {
    gpuProc = null;
    // Restart if a stats/graphs widget still wants it (e.g. the process died).
    if (gpuWanted) setTimeout(() => { if (gpuWanted && !gpuProc) startGpuMonitor(); }, 3000);
  });
}
function stopGpuMonitor() {
  gpuWanted = false;
  if (gpuProc) { try { gpuProc.kill(); } catch {} gpuProc = null; }
  gpuCache = null;
}

// ---- Now-playing album-art wallpaper ----
let albumArtTimer = null;
let albumArtBusy = false;
const albumArtPath = () => path.join(app.getPath('userData'), 'albumart.jpg');

function displayHasAlbumArt(displayId) {
  const { assignments, library } = store.getState();
  const it = library.find((i) => i.id === assignments[displayId]);
  return !!(it && it.type === 'albumart');
}

function fetchAlbumArt() {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(killer); resolve(v); };
    const script = path.join(__dirname, 'albumart.ps1').replace('app.asar', 'app.asar.unpacked');
    let ps;
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, albumArtPath()], { windowsHide: true });
    } catch { return resolve(null); }
    const killer = setTimeout(() => { try { ps.kill(); } catch {} finish(null); }, 6000);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('error', () => finish(null));
    ps.on('close', () => { try { const o = JSON.parse(out.trim()); finish(o && o.title ? o : null); } catch { finish(null); } });
  });
}

async function refreshAlbumArt() {
  if (albumArtBusy) return;
  albumArtBusy = true;
  try {
    const np = await fetchAlbumArt();
    const data = np
      ? {
        title: String(np.title || '').slice(0, 80),
        artist: String(np.artist || '').slice(0, 80),
        artUrl: np.art && fs.existsSync(np.art) ? pathToFileURL(np.art).href + '?t=' + Date.now() : null,
      }
      : { title: '', artist: '', artUrl: null };
    for (const [id, win] of wallpaperWindows) {
      if (!win.isDestroyed() && displayHasAlbumArt(id)) win.webContents.send('wallpaper:albumart', data);
    }
  } finally { albumArtBusy = false; }
}

function refreshAlbumArtMonitor() {
  const need = describeDisplays().some((d) => displayHasAlbumArt(d.id));
  if (need && !albumArtTimer) { albumArtTimer = setInterval(refreshAlbumArt, 4000); refreshAlbumArt(); }
  else if (!need && albumArtTimer) { clearInterval(albumArtTimer); albumArtTimer = null; }
}

async function refreshNowPlaying() {
  if (nowPlayingBusy) return;
  nowPlayingBusy = true;
  try {
    const np = await fetchNowPlaying();
    const changed = JSON.stringify(np) !== JSON.stringify(nowPlayingCache);
    nowPlayingCache = np;
    if (changed) pushWidgetData();
  } finally { nowPlayingBusy = false; }
}

function cpuPercent() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  if (!lastCpuSample) { lastCpuSample = { idle, total }; return 0; }
  const di = idle - lastCpuSample.idle, dt = total - lastCpuSample.total;
  lastCpuSample = { idle, total };
  return dt > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - di / dt)))) : 0;
}

async function refreshWeather() {
  const { settings } = store.getState();
  const want = describeDisplays().filter((d) => d.widgets.weather);
  const reactive = !!settings.weatherReactive;
  if (!want.length && !reactive) return;
  // Widget location wins; otherwise the global reactive location (blank = auto).
  const loc = ((want.map((d) => d.widgets.weatherLocation).find((l) => l)) || settings.weatherLocation || '').trim();
  const fresh = weatherCache && weatherLoc === loc && (Date.now() - weatherFetchedAt) < 3 * 60 * 1000;
  if (fresh) { if (reactive) pushAmbientAll(); return; }
  try {
    const url = `https://wttr.in/${encodeURIComponent(loc)}?format=%t|%C`;
    const res = await fetch(url, { headers: { 'User-Agent': 'curl/8' } });
    const txt = (await res.text()).trim();
    if (txt && txt.includes('|') && !/unknown location|sorry/i.test(txt)) {
      const [temp, cond] = txt.split('|');
      weatherCache = { temp: temp.replace('+', '').trim(), cond: (cond || '').trim() };
      weatherLoc = loc; weatherFetchedAt = Date.now();
      pushWidgetData();
      if (reactive) pushAmbientAll();
    }
  } catch { /* offline — keep last value */ }
}

function pushWidgetData() {
  const data = { cpu: cpuPercent(), mem: Math.round(100 * (1 - os.freemem() / os.totalmem())) };
  data.gpu = gpuCache; // null until the first sample / when unavailable
  if (weatherCache) data.weather = weatherCache;
  data.nowPlaying = nowPlayingCache; // null clears the widget when nothing plays
  const { widgets } = store.getState();
  for (const [id, win] of wallpaperWindows) {
    if (win.isDestroyed()) continue;
    if (widgetsActive(normalizeWidgets(widgets[id]))) win.webContents.send('wallpaper:widgetdata', data);
  }
}

// Push CPU/RAM (and cached weather/now-playing) once per second; also nudge a
// weather re-fetch, which self-throttles via the cache below.
function widgetTick() {
  pushWidgetData();
  if (describeDisplays().some((d) => d.widgets.weather)) refreshWeather();
}

function refreshWidgetMonitor() {
  const ds = describeDisplays();
  const needPoll = ds.some((d) => d.widgets.stats || d.widgets.weather || d.widgets.graphs);
  if (needPoll && !widgetTimer) {
    widgetTimer = setInterval(widgetTick, 1000);
    widgetTick();
  } else if (!needPoll && widgetTimer) {
    clearInterval(widgetTimer);
    widgetTimer = null;
  }
  // GPU% is only worth the perf-counter loop when a stats / graphs widget shows it.
  if (ds.some((d) => d.widgets.stats || d.widgets.graphs)) startGpuMonitor();
  else stopGpuMonitor();
  // Now-playing is polled on its own slower cadence (PowerShell spawn is costly).
  const needNP = ds.some((d) => d.widgets.nowplaying);
  if (needNP && !nowPlayingTimer) {
    nowPlayingTimer = setInterval(refreshNowPlaying, 5000);
    refreshNowPlaying();
  } else if (!needNP && nowPlayingTimer) {
    clearInterval(nowPlayingTimer);
    nowPlayingTimer = null;
    nowPlayingCache = null;
  }
  if (ds.some((d) => d.widgets.weather)) refreshWeather();
}

/** Start/stop the polling loop depending on whether any trigger is enabled. */
function refreshAutoPauseMonitor() {
  const { settings } = store.getState();
  const active = settings.pauseOnFullscreen || settings.pauseOnBattery || (settings.idlePauseMin > 0) || (settings.pauseApps && settings.pauseApps.length > 0);
  if (active && !pauseTimer) {
    pauseTimer = setInterval(evaluateAutoPause, 1500);
    evaluateAutoPause();
  } else if (!active && pauseTimer) {
    clearInterval(pauseTimer);
    pauseTimer = null;
    if (autoPaused) { autoPaused = false; setWallpapersPaused(false); }
  }
}

// -------------------------------------------------------------------------
// Ambient automations: night-shift (time-of-day warm tint) + weather-reactive
// precipitation overlay. Both are global settings, pushed to every wallpaper.
// -------------------------------------------------------------------------
let ambientTimer = null;

// 0 during the day, ramping to 1 overnight. Smooth dawn/dusk transitions.
function currentWarmth() {
  if (!store.getState().settings.nightShift) return 0;
  const now = new Date();
  const hr = now.getHours() + now.getMinutes() / 60;
  if (hr >= 8 && hr < 18) return 0;            // daytime
  if (hr >= 18 && hr < 21) return (hr - 18) / 3; // dusk ramp up
  if (hr >= 6 && hr < 8) return 1 - (hr - 6) / 2; // dawn ramp down
  return 1;                                     // night
}

function condToOverlay(cond) {
  const c = String(cond || '').toLowerCase();
  if (/(snow|sleet|blizzard|ice|flurr)/.test(c)) return 'snow';
  if (/(rain|drizzle|shower|thunder|storm)/.test(c)) return 'rain';
  return 'none';
}

function pushAmbientTo(win) {
  if (!win || win.isDestroyed()) return;
  const { settings } = store.getState();
  win.webContents.send('wallpaper:nightshift', currentWarmth());
  const overlay = (settings.weatherReactive && weatherCache) ? condToOverlay(weatherCache.cond) : 'none';
  win.webContents.send('wallpaper:weather', { overlay, intensity: 60 });
}

function pushAmbientAll() {
  for (const win of wallpaperWindows.values()) pushAmbientTo(win);
}

// Power profile: framerate cap + render scale, tightened when battery-saver is
// on and we're unplugged. Sent to every wallpaper so its animated content can
// throttle itself.
function powerProfile() {
  const { settings } = store.getState();
  const saving = settings.batterySaver && onBattery;
  let fps = settings.maxFps > 0 ? settings.maxFps : 0;
  if (saving) fps = fps > 0 ? Math.min(fps, 30) : 30;
  const scale = saving ? 0.75 : 1;
  return { fps, scale };
}
function pushPowerTo(win) {
  if (win && !win.isDestroyed()) win.webContents.send('wallpaper:power', powerProfile());
}
function pushPowerAll() {
  for (const win of wallpaperWindows.values()) pushPowerTo(win);
}

/** Start/stop the ~minute ambient loop based on whether either feature is on. */
function refreshAmbientMonitor() {
  const { settings } = store.getState();
  const active = settings.nightShift || settings.weatherReactive;
  if (active && !ambientTimer) {
    ambientTimer = setInterval(() => { pushAmbientAll(); if (store.getState().settings.weatherReactive) refreshWeather(); }, 60 * 1000);
  } else if (!active && ambientTimer) {
    clearInterval(ambientTimer);
    ambientTimer = null;
  }
  pushAmbientAll();
  if (settings.weatherReactive) refreshWeather();
}

// -------------------------------------------------------------------------
// Control window + tray
// -------------------------------------------------------------------------

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: 'Lumina Live Wallpaper',
    backgroundColor: '#0f1117',
    icon: path.join(ASSETS, 'icon.png'),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'control-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWin.setMenu(null);
  controlWin.loadFile(path.join(__dirname, '..', 'renderer', 'control', 'index.html'));
  if (isDev) controlWin.webContents.openDevTools({ mode: 'detach' });

  controlWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      controlWin.hide();
    }
  });
}

function buildState() {
  const { library, assignments, settings } = store.getState();
  // Items with a src get a fileUrl (local path → file URL, or pass a remote URL
  // through unchanged). youtube/web/online have no src.
  const toUrl = (p) => (/^https?:\/\//i.test(p) ? p : pathToFileURL(p).href);
  const enriched = library.map((it) => {
    if (it.depth && it.base) return { ...it, baseUrl: toUrl(it.base) }; // thumbnail = base image
    if (it.type === 'urlvideo' && it.localPath) return { ...it, fileUrl: toUrl(it.localPath) }; // for the thumbnail
    if (it.src) return { ...it, fileUrl: toUrl(it.src) };
    return it;
  });
  return {
    library: enriched,
    assignments,
    settings,
    version: app.getVersion(),
    displays: describeDisplays(),
    profiles: Object.keys(store.getState().profiles || {}).sort(),
  };
}

function broadcastState() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('state:changed', buildState());
  }
  rebuildTray();
}

/** Run a yt-dlp download for a library item, streaming progress to the UI. */
function startYouTubeDownload(itemId, videoId) {
  const getItem = () => store.getState().library.find((i) => i.id === itemId);

  // Best-effort: replace the placeholder name with the real video title.
  youtube.fetchTitle(videoId).then((title) => {
    const it = getItem();
    if (it && title) {
      it.name = title;
      store.setLibrary(store.getState().library);
      broadcastState();
    }
  });

  let lastBroadcast = -1;
  youtube
    .downloadVideo(videoId, (percent) => {
      const it = getItem();
      if (!it) return;
      it.progress = percent;
      const rounded = Math.floor(percent);
      if (rounded !== lastBroadcast) {
        lastBroadcast = rounded;
        broadcastState();
      }
    })
    .then((filePath) => {
      const it = getItem();
      if (!it) return;
      it.localPath = filePath;
      it.status = 'ready';
      it.progress = 100;
      delete it.error;
      store.setLibrary(store.getState().library);
      reconcile(); // in case it's already assigned to a monitor
      broadcastState();
    })
    .catch((err) => {
      const it = getItem();
      if (!it) return;
      it.status = 'error';
      it.error = String(err.message || err);
      store.setLibrary(store.getState().library);
      broadcastState();
    });
}

/** Add (or re-trigger) a YouTube library item and start its download. */
function addYouTubeUrl(url) {
  const videoId = parseYouTubeId(url);
  if (!videoId) return { ok: false, error: 'That doesn’t look like a valid YouTube link.' };
  const state = store.getState();
  let item = state.library.find((i) => i.type === 'youtube' && i.videoId === videoId);
  if (item && item.localPath && fs.existsSync(item.localPath)) return { ok: true, state: buildState() };
  if (!item) {
    item = {
      id: crypto.randomUUID(), type: 'youtube', name: `YouTube · ${videoId}`, videoId,
      thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, status: 'downloading', progress: 0,
    };
    state.library.push(item);
  } else {
    item.status = 'downloading'; item.progress = 0; delete item.error;
  }
  store.setLibrary(state.library);
  broadcastState();
  startYouTubeDownload(item.id, videoId);
  return { ok: true, state: buildState() };
}

/** Download a video from any yt-dlp-supported URL into a library item. */
function startUrlVideoDownload(itemId, url) {
  const getItem = () => store.getState().library.find((i) => i.id === itemId);

  // Best-effort: replace the hostname placeholder with the real title.
  youtube.fetchTitleFromUrl(url).then((title) => {
    const it = getItem();
    if (it && title && it.status !== 'ready') { it.name = title; store.setLibrary(store.getState().library); broadcastState(); }
  });

  let lastBroadcast = -1;
  youtube
    .downloadFromUrl(itemId, url, (percent) => {
      const it = getItem();
      if (!it) return;
      it.progress = percent;
      const rounded = Math.floor(percent);
      if (rounded !== lastBroadcast) { lastBroadcast = rounded; broadcastState(); }
    })
    .then((filePath) => {
      const it = getItem();
      if (!it) return;
      it.localPath = filePath;
      it.status = 'ready';
      it.progress = 100;
      delete it.error;
      store.setLibrary(store.getState().library);
      reconcile();
      // If it's already assigned to a monitor, swap the (black) placeholder for the file.
      const st = store.getState();
      for (const [displayId, win] of wallpaperWindows) {
        if (!win.isDestroyed() && win._itemId === itemId) {
          sendMediaTo(win, getItem(), normalizeFit(st.fits[displayId]), normalizeEffects(st.effects[displayId]));
        }
      }
      broadcastState();
    })
    .catch((err) => {
      const it = getItem();
      if (!it) return;
      it.status = 'error';
      it.error = String(err.message || err);
      store.setLibrary(store.getState().library);
      broadcastState();
    });
}

// -------------------------------------------------------------------------
// Manual controls (tray + global hotkeys)
// -------------------------------------------------------------------------
let manualPaused = false;
// "Ready" = not a still-downloading / errored download (youtube or any URL video).
const itemReady = (i) => !(i.status && i.status !== 'ready');

function togglePauseAll() {
  manualPaused = !manualPaused;
  setWallpapersPaused(manualPaused);
  rebuildTray();
}

/** Advance every monitor to its next wallpaper (playlist → next item, else next library item). */
function cycleWallpapers() {
  const state = store.getState();
  const ready = state.library.filter(itemReady);
  for (const d of describeDisplays()) {
    const pl = normalizePlaylist(state.playlists[d.id]);
    if (pl.items.length >= 2) { advanceRotation(d.id); continue; }
    if (!ready.length) continue;
    const curId = state.assignments[d.id];
    const idx = ready.findIndex((i) => i.id === curId);
    state.assignments[d.id] = ready[(idx + 1) % ready.length].id;
  }
  store.setAssignments(state.assignments);
  reconcile();
  broadcastState();
}

/** Apply a saved profile's per-monitor setup. Shared by the IPC and the tray. */
function applyProfile(name) {
  const s = store.getState();
  const p = s.profiles[name];
  if (!p) return;
  const clone = (o) => JSON.parse(JSON.stringify(o || {}));
  store.setAssignments(clone(p.assignments));
  store.setFits(clone(p.fits));
  store.setEffects(clone(p.effects));
  store.setPlaylists(clone(p.playlists));
  store.setWidgets(clone(p.widgets));
  reconcile();
  broadcastState();
}

function setDisplayItem(displayId, itemId) {
  const s = store.getState();
  delete s.playlists[displayId];
  if (itemId) s.assignments[displayId] = itemId;
  else delete s.assignments[displayId];
  store.setAssignments(s.assignments);
  store.setPlaylists(s.playlists);
  reconcile();
  broadcastState();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Lumina Live Wallpaper');
  tray.on('double-click', showControl);
  rebuildTray();
}

/** Rebuild the tray menu to reflect current displays, library and profiles. */
function rebuildTray() {
  if (!tray) return;
  const state = store.getState();
  const ready = state.library.filter(itemReady);
  const template = [
    { label: 'Open Lumina', click: showControl },
    { type: 'separator' },
    { label: manualPaused ? 'Resume all' : 'Pause all', click: togglePauseAll },
    { label: 'Next wallpaper', click: cycleWallpapers, enabled: ready.length > 0 },
    { type: 'separator' },
  ];
  for (const d of describeDisplays()) {
    const cur = currentItemIdFor(d.id);
    const sub = ready.map((it) => ({
      label: it.name.length > 38 ? it.name.slice(0, 37) + '…' : it.name,
      type: 'radio', checked: it.id === cur,
      click: () => setDisplayItem(d.id, it.id),
    }));
    if (ready.length) sub.push({ type: 'separator' });
    sub.push({ label: 'Clear', click: () => setDisplayItem(d.id, null) });
    template.push({ label: `${d.label}${d.primary ? ' · primary' : ''}`, submenu: sub });
  }
  const profNames = Object.keys(state.profiles || {}).sort();
  if (profNames.length) {
    template.push({ type: 'separator' });
    template.push({ label: 'Load profile', submenu: profNames.map((n) => ({ label: n, click: () => applyProfile(n) })) });
  }
  template.push({ type: 'separator' });
  template.push({ label: 'Check for updates…', click: () => checkForUpdatesNow(true) });
  template.push({ type: 'separator' }, { label: 'Quit', click: () => quitApp() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function registerHotkeys() {
  try {
    const a = globalShortcut.register('CommandOrControl+Alt+P', togglePauseAll);
    const b = globalShortcut.register('CommandOrControl+Alt+N', cycleWallpapers);
    if (isDev || process.env.LUMINA_DEBUG) console.log(`[hotkeys] pause=${a} next=${b}`);
  } catch (err) { if (isDev) console.log('hotkey register failed:', err); }
}
function refreshHotkeys() {
  globalShortcut.unregisterAll();
  if (store.getState().settings.hotkeys !== false) registerHotkeys();
}

function showControl() {
  if (!controlWin || controlWin.isDestroyed()) createControlWindow();
  controlWin.show();
  controlWin.focus();
}

function quitApp() {
  isQuitting = true;
  stopGpuMonitor();
  for (const win of wallpaperWindows.values()) {
    if (!win.isDestroyed()) {
      wallpaper.detachWindow(win);
      win.destroy();
    }
  }
  wallpaperWindows.clear();
  app.quit();
}

// -------------------------------------------------------------------------
// IPC
// -------------------------------------------------------------------------

function addFiles(paths) {
  const state = store.getState();
  const existing = new Set(state.library.map((i) => i.src));
  let added = 0;
  for (const p of paths) {
    const type = classifyFile(p);
    if (!type || existing.has(p)) continue;
    state.library.push({
      id: crypto.randomUUID(),
      type,
      name: path.basename(p),
      src: p,
    });
    existing.add(p);
    added++;
  }
  if (added) store.setLibrary(state.library);
  return added;
}

function registerIpc() {
  ipcMain.handle('state:get', () => buildState());

  ipcMain.handle('media:addFiles', (_e, paths) => {
    addFiles(paths || []);
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:addFilesDialog', async () => {
    const res = await dialog.showOpenDialog(controlWin, {
      title: 'Add videos, GIFs, or images',
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS,
    });
    if (!res.canceled) addFiles(res.filePaths);
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:addYouTube', (_e, url) => addYouTubeUrl(url));

  // Generic "add a video by URL": YouTube links keep the rich thumbnail path;
  // anything else (Vimeo, X/Twitter, Reddit, a direct .mp4, …) downloads via
  // yt-dlp's generic extractors.
  ipcMain.handle('media:addVideo', (_e, url) => {
    url = String(url || '').trim();
    if (parseYouTubeId(url)) return addYouTubeUrl(url);
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Enter a valid video URL (https://…).' };
    const state = store.getState();
    let item = state.library.find((i) => i.type === 'urlvideo' && i.url === url);
    if (item && item.localPath && fs.existsSync(item.localPath)) return { ok: true, state: buildState() };
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    if (!item) {
      item = { id: crypto.randomUUID(), type: 'urlvideo', name: host, url, status: 'downloading', progress: 0 };
      state.library.push(item);
    } else {
      item.status = 'downloading'; item.progress = 0; delete item.error;
    }
    store.setLibrary(state.library);
    broadcastState();
    startUrlVideoDownload(item.id, url);
    return { ok: true, state: buildState() };
  });

  ipcMain.handle('media:addWeb', (_e, url) => {
    url = String(url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Enter a valid http(s) URL.' };
    const state = store.getState();
    if (!state.library.some((i) => i.type === 'web' && i.url === url)) {
      let name = url;
      try { name = new URL(url).hostname.replace(/^www\./, ''); } catch {}
      state.library.push({ id: crypto.randomUUID(), type: 'web', name, url });
      store.setLibrary(state.library);
    }
    broadcastState();
    return { ok: true, state: buildState() };
  });

  const BUILTINS = {
    shader: {
      aurora: 'Aurora', plasma: 'Plasma', starfield: 'Starfield', warp: 'Warp',
      nebula: 'Nebula', fire: 'Fire', tunnel: 'Tunnel', caustics: 'Caustics',
      synthwave: 'Synthwave', vortex: 'Vortex', sunset: 'Sunset', clouds: 'Clouds', mesh: 'Gradient',
    },
    canvas: {
      constellation: 'Constellation', flowfield: 'Flow Field', bokeh: 'Bokeh',
      dvd: 'Bouncing Logo', gameoflife: 'Game of Life', fireworks: 'Fireworks', rainglass: 'Rain on Glass',
    },
  };
  ipcMain.handle('media:addBuiltin', (_e, { kind, preset, options }) => {
    const map = BUILTINS[kind];
    if (!map || !map[preset]) return buildState();
    const field = kind === 'canvas' ? 'canvasPreset' : 'shaderPreset';
    const opts = options && typeof options === 'object' ? options : {};
    // A nice display name: append a custom logo text or non-default options hint.
    let name = map[preset];
    if (opts.text) name += ` · ${String(opts.text).slice(0, 16)}`;
    const state = store.getState();
    state.library.push({ id: crypto.randomUUID(), type: 'web', [field]: preset, name, options: opts });
    store.setLibrary(state.library);
    broadcastState();
    return buildState();
  });

  // Add or update a user-authored GLSL shader. With an id it edits in place and
  // live-reloads any monitor showing it; otherwise it creates a new library item.
  ipcMain.handle('media:saveShaderCode', (_e, { id, name, code }) => {
    const state = store.getState();
    const clean = String(code || '');
    const title = String(name || 'Custom shader').slice(0, 40) || 'Custom shader';
    let item;
    if (id) {
      item = state.library.find((i) => i.id === id);
      if (!item) return buildState();
      item.name = title; item.shaderCode = clean;
    } else {
      item = { id: crypto.randomUUID(), type: 'web', shaderPreset: 'custom', shaderCode: clean, name: title, options: {} };
      state.library.push(item);
    }
    store.setLibrary(state.library);
    for (const [displayId, win] of wallpaperWindows) {
      if (win.isDestroyed() || win._itemId !== item.id) continue;
      sendMediaTo(win, item, normalizeFit(state.fits[displayId]), normalizeEffects(state.effects[displayId]));
    }
    broadcastState();
    return buildState();
  });

  // Add a 2.5D depth-parallax wallpaper: pick a base image, then optionally a
  // depth map (white = near). With no depth map, image luminance is used.
  ipcMain.handle('media:addDepth', async () => {
    const base = await dialog.showOpenDialog({
      title: 'Pick a base image for the 2.5D wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }],
    });
    if (base.canceled || !base.filePaths.length) return { ok: false };
    const map = await dialog.showOpenDialog({
      title: 'Optional: pick a depth map (white = near, black = far) — Cancel to auto-generate',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    });
    const state = store.getState();
    const item = {
      id: crypto.randomUUID(), type: 'web', depth: true, base: base.filePaths[0],
      name: '2.5D · ' + path.basename(base.filePaths[0]).replace(/\.[^.]+$/, '').slice(0, 18),
      options: { strength: 25, invert: false },
    };
    if (!map.canceled && map.filePaths.length) item.depthMap = map.filePaths[0];
    state.library.push(item);
    store.setLibrary(state.library);
    broadcastState();
    return { ok: true, state: buildState() };
  });

  ipcMain.handle('online:search', async (_e, { provider, query, cursor, sorting, categories }) => {
    try {
      const p = ['openverse', 'reddit'].includes(provider) ? provider : 'wallhaven';
      const { results, next } = await searchOnline(p, query, sorting || 'relevance', cursor || null, categories || '111');
      return { ok: true, results, next };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // ---- Shareable wallpaper presets (.lumina files) ----
  // Only portable items export: shaders, animations, custom GLSL, visualizer,
  // online sources, YouTube links, and remote images. Local files are skipped.
  const exportableItem = (item) => {
    const name = item.name;
    if (item.type === 'web') {
      const o = { type: 'web', name, options: item.options || {} };
      if (item.shaderPreset) o.shaderPreset = item.shaderPreset;
      if (item.canvasPreset) o.canvasPreset = item.canvasPreset;
      if (item.shaderCode) o.shaderCode = item.shaderCode;
      if (!o.shaderPreset && !o.canvasPreset) {
        if (item.url && /^https?:\/\//i.test(item.url)) o.url = item.url; else return null;
      }
      return o;
    }
    if (item.type === 'viz') return { type: 'viz', name, vizStyle: item.vizStyle || 'bars' };
    if (item.type === 'youtube') return { type: 'youtube', name, videoId: item.videoId, url: item.url };
    if (item.type === 'online') return { type: 'online', name, provider: item.provider, query: item.query, categories: item.categories, intervalMin: item.intervalMin };
    if (item.type === 'image' && /^https?:\/\//i.test(item.src || '')) return { type: 'image', name, src: item.src };
    return null;
  };

  const sanitizeImported = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || 'Imported wallpaper').slice(0, 60);
    if (raw.type === 'web') {
      const o = { type: 'web', name, options: (raw.options && typeof raw.options === 'object') ? raw.options : {} };
      if (raw.shaderPreset) o.shaderPreset = String(raw.shaderPreset);
      if (raw.canvasPreset) o.canvasPreset = String(raw.canvasPreset);
      if (raw.shaderCode) o.shaderCode = String(raw.shaderCode);
      if (!o.shaderPreset && !o.canvasPreset) {
        if (raw.url && /^https?:\/\//i.test(raw.url)) o.url = String(raw.url); else return null;
      }
      return o;
    }
    if (raw.type === 'viz') return { type: 'viz', name, vizStyle: String(raw.vizStyle || 'bars') };
    if (raw.type === 'youtube' && raw.videoId) return { type: 'youtube', name, videoId: String(raw.videoId), url: raw.url ? String(raw.url) : undefined };
    if (raw.type === 'online') return { type: 'online', name, provider: String(raw.provider || 'wallhaven'), query: String(raw.query || ''), categories: String(raw.categories || '111'), intervalMin: Number(raw.intervalMin) || 30 };
    if (raw.type === 'image' && raw.src && /^https?:\/\//i.test(raw.src)) return { type: 'image', name, src: String(raw.src) };
    return null;
  };

  ipcMain.handle('media:exportItem', async (_e, id) => {
    const item = store.getState().library.find((i) => i.id === id);
    if (!item) return { ok: false, error: 'Item not found' };
    const data = exportableItem(item);
    if (!data) return { ok: false, error: 'Local files can’t be shared as presets — only shaders, animations, online sources, and links.' };
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export wallpaper preset',
      defaultPath: `${String(item.name || 'wallpaper').replace(/[^\w.-]+/g, '_')}.lumina`,
      filters: [{ name: 'Lumina preset', extensions: ['lumina', 'json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    try {
      fs.writeFileSync(filePath, JSON.stringify({ lumina: 'wallpaper-preset', version: 1, item: data }, null, 2), 'utf8');
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('media:importItem', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import wallpaper preset(s)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Lumina preset', extensions: ['lumina', 'json'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false };
    const state = store.getState();
    let added = 0;
    for (const fp of filePaths) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const items = Array.isArray(parsed.items) ? parsed.items : (parsed.item ? [parsed.item] : []);
        for (const raw of items) {
          const data = sanitizeImported(raw);
          if (data) { state.library.push({ id: crypto.randomUUID(), ...data }); added++; }
        }
      } catch { /* skip unreadable / invalid files */ }
    }
    if (added) { store.setLibrary(state.library); broadcastState(); }
    return { ok: added > 0, added, error: added ? undefined : 'No valid presets found in the selected file(s).', state: buildState() };
  });

  ipcMain.handle('media:addImageUrl', (_e, { url, name }) => {
    const state = store.getState();
    if (url && !state.library.some((i) => i.src === url)) {
      state.library.push({ id: crypto.randomUUID(), type: 'image', name: name || 'Online image', src: url });
      store.setLibrary(state.library);
    }
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:setOptions', (_e, { id, options, name }) => {
    const state = store.getState();
    const item = state.library.find((i) => i.id === id);
    if (!item) return buildState();
    item.options = options && typeof options === 'object' ? options : {};
    if (name) item.name = name;
    store.setLibrary(state.library);
    // Live-reload the wallpaper on any monitor currently showing this item.
    for (const [displayId, win] of wallpaperWindows) {
      if (win.isDestroyed() || win._itemId !== id) continue;
      sendMediaTo(win, item, normalizeFit(state.fits[displayId]), normalizeEffects(state.effects[displayId]));
    }
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:addOnline', (_e, { provider, query, categories }) => {
    provider = ['openverse', 'reddit'].includes(provider) ? provider : 'wallhaven';
    const q = String(query || '').trim();
    const state = store.getState();
    const name = provider === 'openverse' ? `Openverse · ${q || 'wallpaper'}`
      : provider === 'reddit' ? `r/${q || 'wallpapers'}` : `Wallhaven · ${q || 'random'}`;
    state.library.push({ id: crypto.randomUUID(), type: 'online', provider, query: q, categories: categories || '111', intervalMin: 30, name });
    store.setLibrary(state.library);
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:addViz', (_e, style) => {
    const state = store.getState();
    if (!state.library.some((i) => i.type === 'viz')) {
      state.library.push({ id: crypto.randomUUID(), type: 'viz', vizStyle: style || 'bars', name: 'Audio Visualizer' });
      store.setLibrary(state.library);
    }
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:addAlbumArt', () => {
    const state = store.getState();
    if (!state.library.some((i) => i.type === 'albumart')) {
      state.library.push({ id: crypto.randomUUID(), type: 'albumart', name: 'Now Playing' });
      store.setLibrary(state.library);
    }
    broadcastState();
    return buildState();
  });

  ipcMain.handle('media:retryYouTube', (_e, id) => {
    const item = store.getState().library.find((i) => i.id === id);
    if (item && (item.type === 'youtube' || item.type === 'urlvideo')) {
      item.status = 'downloading';
      item.progress = 0;
      delete item.error;
      store.setLibrary(store.getState().library);
      broadcastState();
      if (item.type === 'youtube') startYouTubeDownload(item.id, item.videoId);
      else startUrlVideoDownload(item.id, item.url);
    }
    return buildState();
  });

  ipcMain.handle('media:remove', (_e, id) => {
    const state = store.getState();
    const removed = state.library.find((i) => i.id === id);
    state.library = state.library.filter((i) => i.id !== id);
    for (const k of Object.keys(state.assignments)) {
      if (state.assignments[k] === id) delete state.assignments[k];
    }
    // Strip the removed item from any playlists.
    for (const k of Object.keys(state.playlists)) {
      const pl = state.playlists[k];
      if (pl && Array.isArray(pl.items)) {
        pl.items = pl.items.filter((x) => x !== id);
        if (!pl.items.length) delete state.playlists[k];
      }
    }
    store.setLibrary(state.library);
    store.setAssignments(state.assignments);
    store.setPlaylists(state.playlists);
    // Clean up a downloaded YouTube file.
    if (removed && removed.localPath) {
      try { fs.unlinkSync(removed.localPath); } catch {}
    }
    reconcile();
    broadcastState();
    return buildState();
  });

  ipcMain.handle('assign:set', (_e, { displayId, itemId }) => {
    const state = store.getState();
    if (displayId === 'all') {
      for (const d of describeDisplays()) state.assignments[d.id] = itemId;
    } else {
      state.assignments[displayId] = itemId;
    }
    store.setAssignments(state.assignments);
    reconcile();
    broadcastState();
    return buildState();
  });

  ipcMain.handle('fit:set', (_e, { displayId, fit }) => {
    const state = store.getState();
    const value = normalizeFit(fit);
    if (displayId === 'all') {
      for (const d of describeDisplays()) state.fits[d.id] = value;
    } else {
      state.fits[displayId] = value;
    }
    store.setFits(state.fits);
    reconcile();
    broadcastState();
    return buildState();
  });

  ipcMain.handle('effects:set', (_e, { displayId, effects }) => {
    const state = store.getState();
    const targets = displayId === 'all' ? describeDisplays().map((d) => d.id) : [displayId];
    for (const id of targets) {
      state.effects[id] = normalizeEffects({ ...(state.effects[id] || {}), ...effects });
    }
    store.setEffects(state.effects);
    // Live-update the affected wallpaper windows without reloading media.
    for (const id of targets) {
      const win = wallpaperWindows.get(id);
      if (win && !win.isDestroyed()) {
        win.webContents.send('wallpaper:effects', state.effects[id]);
        win._effKey = effectsKey(state.effects[id]);
      }
    }
    refreshCursorMonitor();
    return buildState();
  });

  ipcMain.handle('widgets:set', (_e, { displayId, widgets }) => {
    const state = store.getState();
    const targets = displayId === 'all' ? describeDisplays().map((d) => d.id) : [displayId];
    for (const id of targets) {
      state.widgets[id] = normalizeWidgets({ ...(state.widgets[id] || {}), ...widgets });
    }
    store.setWidgets(state.widgets);
    for (const id of targets) {
      const win = wallpaperWindows.get(id);
      if (win && !win.isDestroyed()) {
        const wid = normalizeWidgets(state.widgets[id]);
        win.webContents.send('wallpaper:widgets', wid);
        win._widgetsKey = JSON.stringify(wid);
      }
    }
    refreshWidgetMonitor();
    broadcastState();
    return buildState();
  });

  ipcMain.handle('assign:clear', (_e, displayId) => {
    const state = store.getState();
    if (displayId === 'all') {
      state.assignments = {};
    } else {
      delete state.assignments[displayId];
    }
    store.setAssignments(state.assignments);
    reconcile();
    broadcastState();
    return buildState();
  });

  ipcMain.handle('playlist:set', (_e, { displayId, items, intervalSec, shuffle, mode, times }) => {
    const state = store.getState();
    const targets = displayId === 'all' ? describeDisplays().map((d) => d.id) : [displayId];
    for (const id of targets) {
      if (!items || !items.length) {
        delete state.playlists[id];
      } else {
        state.playlists[id] = normalizePlaylist({ items, intervalSec, shuffle, mode, times });
      }
      const r = rotation.get(id);
      if (r) r.idx = 0; // restart rotation from the top
    }
    store.setPlaylists(state.playlists);
    reconcile(); // updates the live wallpaper; control UI refreshes on panel close
    return buildState();
  });

  ipcMain.handle('playlist:clear', (_e, displayId) => {
    const state = store.getState();
    const targets = displayId === 'all' ? Object.keys(state.playlists) : [displayId];
    for (const id of targets) delete state.playlists[id];
    store.setPlaylists(state.playlists);
    reconcile();
    broadcastState();
    return buildState();
  });

  ipcMain.handle('settings:set', (_e, partial) => {
    const spanChanged = partial && Object.prototype.hasOwnProperty.call(partial, 'spanMode');
    store.setSettings(partial || {});
    if (spanChanged) reconcile(); // rebuild windows for span ↔ per-monitor
    // push volume changes live
    const { settings, library, assignments } = store.getState();
    const byId = new Map(library.map((it) => [it.id, it]));
    for (const [displayId, win] of wallpaperWindows) {
      if (win.isDestroyed()) continue;
      win.webContents.send('wallpaper:volume', settings.volume);
    }
    applyAutostart(settings.autostart);
    refreshAutoPauseMonitor();
    refreshAmbientMonitor();
    refreshHotkeys();
    pushPowerAll();
    broadcastState();
    return buildState();
  });

  // ----- Profiles (snapshot/restore the whole per-monitor setup) -----
  ipcMain.handle('profile:save', (_e, name) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return buildState();
    const s = store.getState();
    s.profiles[name] = JSON.parse(JSON.stringify({
      assignments: s.assignments, fits: s.fits, effects: s.effects, playlists: s.playlists, widgets: s.widgets,
    }));
    store.setProfiles(s.profiles);
    broadcastState();
    return buildState();
  });

  ipcMain.handle('profile:load', (_e, name) => {
    applyProfile(name);
    return buildState();
  });

  ipcMain.handle('profile:delete', (_e, name) => {
    const s = store.getState();
    delete s.profiles[name];
    store.setProfiles(s.profiles);
    broadcastState();
    return buildState();
  });

  ipcMain.handle('config:export', async () => {
    const res = await dialog.showSaveDialog(controlWin, {
      title: 'Export Lumina config', defaultPath: 'lumina-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    try { fs.writeFileSync(res.filePath, JSON.stringify(store.getState(), null, 2), 'utf8'); return { ok: true, path: res.filePath }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('config:import', async () => {
    const res = await dialog.showOpenDialog(controlWin, {
      title: 'Import Lumina config', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    try {
      const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      if (!data || typeof data !== 'object' || !Array.isArray(data.library)) throw new Error('Not a valid Lumina config file.');
      store.replaceState(data);
      reconcile();
      applyAutostart(store.getState().settings.autostart);
      refreshAutoPauseMonitor();
      refreshAmbientMonitor();
      refreshHotkeys();
      broadcastState();
      return { ok: true, state: buildState() };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.on('window:minimize', () => controlWin && controlWin.minimize());
  ipcMain.on('window:hide', () => controlWin && controlWin.hide());
  ipcMain.on('window:close', () => controlWin && controlWin.close());
  ipcMain.on('app:quit', () => quitApp());
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:checkForUpdates', () => { checkForUpdatesNow(true); });
}

function applyAutostart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
  } catch (err) {
    console.error('autostart failed', err);
  }
}

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------

app.on('second-instance', showControl);

app.whenReady().then(() => {
  // Let the audio-visualizer wallpaper capture SYSTEM audio (Windows loopback)
  // without a picker. We hand back a screen video source (required by the API)
  // plus the loopback audio; the renderer keeps only the audio track.
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback(sources.length ? { video: sources[0], audio: 'loopback' } : {});
      }).catch(() => callback({}));
    }, { useSystemPicker: false });
  } catch (err) {
    console.error('display-media handler setup failed:', err);
  }

  // Let arbitrary web pages be used as wallpapers: most sites send
  // X-Frame-Options / CSP frame-ancestors headers that forbid being embedded in
  // an iframe (→ blank/black). Strip those so the web-wallpaper iframe can load
  // them. (Local/personal app; this only relaxes framing for our own windows.)
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders || {};
      for (const key of Object.keys(headers)) {
        const k = key.toLowerCase();
        if (k === 'x-frame-options') delete headers[key];
        else if (k === 'content-security-policy') {
          headers[key] = (headers[key] || []).map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
        }
      }
      callback({ responseHeaders: headers });
    });
  } catch (err) {
    console.error('header-strip setup failed:', err);
  }

  registerIpc();
  createControlWindow();
  createTray();
  reconcile();

  // React to monitor changes.
  screen.on('display-added', scheduleReconcile);
  screen.on('display-removed', scheduleReconcile);
  screen.on('display-metrics-changed', scheduleReconcile);

  // Track battery state for auto-pause.
  try { onBattery = powerMonitor.isOnBatteryPower(); } catch {}
  powerMonitor.on('on-battery', () => { onBattery = true; evaluateAutoPause(); pushPowerAll(); });
  powerMonitor.on('on-ac', () => { onBattery = false; evaluateAutoPause(); pushPowerAll(); });
  refreshAutoPauseMonitor();
  refreshAmbientMonitor();
  startShellWatchdog();
  refreshHotkeys();

  const { settings } = store.getState();
  applyAutostart(settings.autostart);

  // Background auto-update (packaged builds only).
  initAutoUpdate(() => controlWin);

  // Launched at login with --hidden: stay in tray.
  if (process.argv.includes('--hidden') && controlWin) controlWin.hide();
});

app.on('window-all-closed', (e) => {
  // Keep running in the tray; wallpapers persist.
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
