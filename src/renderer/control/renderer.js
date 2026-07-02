const api = window.lumina;

let state = { library: [], assignments: {}, displays: [], settings: {} };
const thumbCache = new Map(); // itemId -> dataURL (video frame grabs)

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
// Text is set via textContent so remote strings (video titles, yt-dlp errors,
// search-result names) can never inject markup into the privileged control UI.
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const itemById = (id) => state.library.find((i) => i.id === id);

// Per-monitor scaling options. Values are CSS object-fit keywords.
const FIT_OPTIONS = [
  { value: 'cover', label: 'Fill', hint: 'Cover the screen, crop overflow' },
  { value: 'contain', label: 'Fit', hint: 'Show the whole video (letterboxed)' },
  { value: 'fill', label: 'Stretch', hint: 'Stretch to fill (may distort)' },
  { value: 'none', label: 'Center', hint: 'Native size, centered' },
];

function toast(msg, ms = 2200) {
  let t = $('.toast');
  if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

// Grab a representative frame from a video file for use as a thumbnail.
// The in-flight promise is cached (and failures cached as null) so re-renders
// during e.g. download-progress broadcasts don't spawn a fresh <video> decoder
// per card per tick.
const thumbInflight = new Map(); // itemId -> pending promise (thumbCache stays sync-readable for thumbFor)
function generateThumb(item) {
  if (thumbCache.has(item.id)) return Promise.resolve(thumbCache.get(item.id));
  if (thumbInflight.has(item.id)) return thumbInflight.get(item.id);
  const inflight = new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.src = item.fileUrl;
    const done = (data) => { thumbCache.set(item.id, data || null); thumbInflight.delete(item.id); resolve(data); cleanup(); };
    const cleanup = () => { v.removeAttribute('src'); v.load(); };
    v.addEventListener('loadeddata', () => {
      try { v.currentTime = Math.min(1, (v.duration || 2) * 0.25); } catch { done(null); }
    });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320; c.height = Math.round(320 * (v.videoHeight / v.videoWidth || 0.5625));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        done(c.toDataURL('image/jpeg', 0.7));
      } catch { done(null); }
    });
    v.addEventListener('error', () => done(null));
    setTimeout(() => done(null), 5000);
  });
  thumbInflight.set(item.id, inflight); // dedupe concurrent callers
  return inflight;
}

function thumbFor(item) {
  if (item.type === 'youtube') return item.thumb;
  if (item.depth) return item.baseUrl || null;
  if (item.type === 'gif' || item.type === 'image') return item.fileUrl;
  return thumbCache.get(item.id) || null;
}

// ---------- rendering ----------
function render() {
  renderMonitors();
  renderLibrary();
  renderSettings();
  renderProfiles();
}

function renderProfiles() {
  const sel = $('#profile-select');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— saved profiles —</option>';
  for (const name of (state.profiles || [])) {
    const o = el('option', null, name); o.value = name; sel.appendChild(o);
  }
  if ((state.profiles || []).includes(cur)) sel.value = cur;
  const has = !!sel.value;
  $('#profile-load').disabled = !has;
  $('#profile-delete').disabled = !has;
}

function renderMonitors() {
  const wrap = $('#monitors');
  wrap.innerHTML = '';
  $('#monitors-hint').textContent =
    state.displays.length > 1 ? `${state.displays.length} monitors detected` : '';

  for (const d of state.displays) {
    const card = el('div', 'monitor');
    const playlist = d.playlist && d.playlist.items.length ? d.playlist : null;
    const single = d.assignedItemId ? itemById(d.assignedItemId) : null;
    // Playlist takes precedence over a single assignment (matches the backend).
    const assigned = playlist ? itemById(playlist.items[0]) : single;
    const isActive = !!(playlist || single);
    const thumb = assigned ? thumbFor(assigned) : null;
    // Video thumbnails are generated lazily; refresh the monitor previews once
    // the frame grab is ready (otherwise they stay black on first load).
    if (!thumb && assigned && assigned.type === 'video') {
      generateThumb(assigned).then((d) => { if (d) renderMonitors(); });
    }

    const preview = el('div', 'preview');
    if (d.primary) preview.appendChild(el('span', 'badge-primary', 'Primary'));
    if (playlist) preview.appendChild(el('span', 'badge-playlist', `▦ ${playlist.items.length}`));
    if (thumb) {
      const img = el('img'); img.src = thumb; preview.appendChild(img);
    } else if (assigned) {
      preview.appendChild(el('span', 'none', assigned.type === 'video' ? '▶ video' : assigned.name));
    } else {
      preview.appendChild(el('span', 'none', 'No live wallpaper'));
    }
    card.appendChild(preview);

    const meta = el('div', 'meta');
    meta.appendChild(el('div', 'name', d.label));
    meta.appendChild(el('div', 'res', d.resolution));
    const assignedText = playlist
      ? (playlist.mode === 'schedule'
          ? `🕐 Schedule · ${playlist.items.length} items`
          : `🔁 Playlist · ${playlist.items.length} items · ${playlist.intervalSec}s${playlist.shuffle ? ' · shuffle' : ''}`)
      : single ? `▶ ${single.name}` : 'Standard wallpaper';
    meta.appendChild(el('div', 'assigned', assignedText));
    card.appendChild(meta);

    // Fit / scaling selector (only meaningful once something is assigned).
    const fitRow = el('div', 'fit-row');
    fitRow.appendChild(el('label', 'fit-label', 'Scaling'));
    const fitSel = el('select', 'fit-select');
    for (const opt of FIT_OPTIONS) {
      const o = el('option', null, opt.label);
      o.value = opt.value;
      o.title = opt.hint;
      if ((d.fit || 'cover') === opt.value) o.selected = true;
      fitSel.appendChild(o);
    }
    fitSel.disabled = !assigned;
    fitSel.onchange = async (e) => {
      state = await api.setFit(d.id, e.target.value);
      render();
      toast(`Scaling: ${FIT_OPTIONS.find((f) => f.value === e.target.value)?.label || e.target.value}`);
    };
    fitRow.appendChild(fitSel);
    card.appendChild(fitRow);

    // Row 1 — choose / clear the wallpaper.
    const row1 = el('div', 'actions');
    const setBtn = el('button', 'btn', 'Set');
    setBtn.onclick = (e) => openSetMenu(e.currentTarget, d.id);
    const clearBtn = el('button', 'btn', 'Clear');
    clearBtn.disabled = !isActive;
    clearBtn.onclick = async () => {
      if (playlist) state = await api.clearPlaylist(d.id);
      state = await api.clearAssignment(d.id);
      render();
    };
    row1.append(setBtn, clearBtn);

    // Row 2 — per-monitor configuration.
    const row2 = el('div', 'actions');
    const plBtn = el('button', 'btn', '▦ Playlist');
    plBtn.title = 'Playlist / slideshow — rotate multiple wallpapers';
    plBtn.classList.toggle('active', !!playlist);
    plBtn.onclick = (e) => openPlaylistPanel(e.currentTarget, d);
    const fxBtn = el('button', 'btn', '⚙ Effects');
    fxBtn.title = 'Brightness, blur, saturation, speed';
    fxBtn.disabled = !isActive;
    fxBtn.onclick = (e) => openEffectsPanel(e.currentTarget, d);
    row2.append(plBtn, fxBtn);

    // Row 3 — info widgets.
    const row3 = el('div', 'actions');
    const w = d.widgets || {};
    const wgBtn = el('button', 'btn', '🕐 Widgets');
    wgBtn.title = 'Clock, date, weather, and system stats overlay';
    wgBtn.disabled = !isActive;
    wgBtn.classList.toggle('active', !!(w.clock || w.date || w.weather || w.stats || w.graphs || w.nowplaying));
    wgBtn.onclick = (e) => openWidgetsPanel(e.currentTarget, d);
    row3.append(wgBtn);

    card.append(row1, row2, row3);

    wrap.appendChild(card);
  }
}

// Items that can be shared as a portable .lumina preset (no local file paths).
function isPortable(it) {
  if (it.type === 'viz' || it.type === 'youtube' || it.type === 'online') return true;
  if (it.type === 'web') return !!(it.shaderPreset || it.canvasPreset || /^https?:\/\//i.test(it.url || ''));
  if (it.type === 'image') return /^https?:\/\//i.test(it.src || '');
  return false;
}

let librarySearch = '';
function renderLibrary() {
  const grid = $('#library');
  grid.innerHTML = '';
  const q = librarySearch.trim().toLowerCase();
  const items = q ? state.library.filter((it) => (it.name || '').toLowerCase().includes(q)) : state.library;
  $('#library-empty').style.display = state.library.length ? 'none' : 'block';
  $('#library-empty').textContent = q && !items.length
    ? `No wallpapers match “${librarySearch.trim()}”.`
    : 'Nothing here yet. Drop a file or add a YouTube link to get started.';
  if (q && !items.length) $('#library-empty').style.display = 'block';

  for (const item of items) {
    const downloading = item.status === 'downloading';
    const errored = item.status === 'error';
    const card = el('div', 'card');

    const iconFor = (it) => it.type === 'online' ? '🌅' : it.type === 'folder' ? '📁' : it.type === 'viz' ? '🎵' : it.type === 'albumart' ? '🎶' : it.depth ? '🏔' : it.shaderPreset ? '✨'
      : it.canvasPreset ? '🎆' : it.type === 'web' ? '🌐' : it.type === 'video' ? '🎬' : it.type === 'urlvideo' ? '🎬' : it.type === 'youtube' ? '▶' : '🖼';
    const typeLabel = (it) => it.type === 'online' ? (it.provider === 'reddit' ? 'reddit' : 'wallhaven')
      : it.type === 'folder' ? 'folder' : it.type === 'viz' ? 'audio' : it.type === 'albumart' ? 'now playing' : it.depth ? '2.5D' : it.shaderPreset === 'custom' ? 'custom' : it.shaderPreset ? 'shader' : it.canvasPreset ? 'animation' : it.type === 'youtube' ? 'youtube' : it.type === 'urlvideo' ? 'video' : it.type;

    const thumb = el('div', 'thumb');
    const src = thumbFor(item);
    if (src) {
      const img = el('img'); img.src = src; thumb.appendChild(img);
    } else {
      thumb.appendChild(el('div', 'ph', iconFor(item)));
      if (item.type === 'video' || (item.type === 'urlvideo' && item.fileUrl)) generateThumb(item).then((d) => { if (d) renderLibrary(); });
    }
    thumb.appendChild(el('div', 'type', typeLabel(item)));
    if ((item.type === 'video' || item.type === 'youtube' || item.type === 'urlvideo') && !downloading && !errored) {
      const badge = el('div', 'play-badge'); badge.appendChild(el('span', '', '▶')); thumb.appendChild(badge);
    }

    // Download progress / error overlays for YouTube items.
    if (downloading) {
      const pct = Math.round(item.progress || 0);
      const ov = el('div', 'dl-overlay');
      ov.appendChild(el('div', 'dl-label', `Downloading… ${pct}%`));
      const bar = el('div', 'dl-bar');
      const fill = el('div', 'dl-fill'); fill.style.width = `${pct}%`;
      bar.appendChild(fill); ov.appendChild(bar);
      thumb.appendChild(ov);
    } else if (errored) {
      const ov = el('div', 'dl-overlay error');
      ov.appendChild(el('div', 'dl-label', 'Download failed'));
      ov.appendChild(el('div', 'dl-err', item.error || ''));
      thumb.appendChild(ov);
    }

    const remove = el('button', 'remove', '✕');
    remove.title = 'Remove';
    remove.onclick = async () => { state = await api.removeItem(item.id); render(); toast('Removed from library'); };
    thumb.appendChild(remove);
    card.appendChild(thumb);

    const info = el('div', 'info');
    info.appendChild(el('div', 'name', item.name));
    card.appendChild(info);

    const row = el('div', 'row');
    if (downloading) {
      const b = el('button', 'btn', 'Downloading…'); b.disabled = true; row.appendChild(b);
    } else if (errored) {
      const b = el('button', 'btn', 'Retry');
      b.onclick = async () => { state = await api.retryYouTube(item.id); render(); };
      row.appendChild(b);
    } else {
      const applyBtn = el('button', 'btn primary',
        state.displays.length > 1 ? 'Apply to…' : 'Set as wallpaper');
      applyBtn.onclick = (e) => {
        if (state.displays.length > 1) openApplyMenu(e.currentTarget, item.id);
        else applyTo(state.displays[0]?.id, item.id);
      };
      row.appendChild(applyBtn);

      const preset = item.shaderPreset || item.canvasPreset;
      if (item.shaderPreset === 'custom') {
        const cog = el('button', 'btn icon-btn', '⚙');
        cog.title = 'Edit shader code';
        cog.onclick = () => openShaderEditor(item);
        row.appendChild(cog);
      } else if (item.depth) {
        const cog = el('button', 'btn icon-btn', '⚙');
        cog.title = 'Depth options';
        cog.onclick = (e) => openDepthConfig(e.currentTarget, item);
        row.appendChild(cog);
      } else if (item.type === 'folder') {
        const cog = el('button', 'btn icon-btn', '⚙');
        cog.title = 'Slideshow options';
        cog.onclick = (e) => openFolderConfig(e.currentTarget, item);
        row.appendChild(cog);
      } else if (preset && builtinOpts(item.shaderPreset ? 'shader' : 'canvas', preset).length) {
        const cog = el('button', 'btn icon-btn', '⚙');
        cog.title = 'Edit options';
        cog.onclick = (e) => openBuiltinConfig(e.currentTarget, item.shaderPreset ? 'shader' : 'canvas', preset, item);
        row.appendChild(cog);
      }

      if (isPortable(item)) {
        const share = el('button', 'btn icon-btn', '↗');
        share.title = 'Export as shareable preset';
        share.onclick = async () => {
          const res = await api.exportItem(item.id);
          if (res && res.ok) toast('Preset exported');
          else if (res && res.error) toast(res.error, 4000);
        };
        row.appendChild(share);
      }
    }
    card.appendChild(row);

    grid.appendChild(card);
  }
}

function setVolUI(v) {
  $('#volume').style.setProperty('--pct', `${v}%`);
  $('#vol-val').textContent = v === 0 ? 'Muted' : `${v}%`;
}
function renderSettings() {
  const vol = $('#volume');
  const v = Math.round((state.settings.volume ?? 0) * 100);
  vol.value = v;
  setVolUI(v);
  $('#autostart').checked = !!state.settings.autostart;
  $('#pause-fullscreen').checked = state.settings.pauseOnFullscreen !== false;
  $('#pause-battery').checked = !!state.settings.pauseOnBattery;
  $('#hotkeys').checked = state.settings.hotkeys !== false;
  $('#transitions').checked = state.settings.transitions !== false;
  $('#span-mode').checked = !!state.settings.spanMode;
  $('#night-shift').checked = !!state.settings.nightShift;
  $('#weather-reactive').checked = !!state.settings.weatherReactive;
  $('#weather-location').value = state.settings.weatherLocation || '';
  $('#weather-loc-row').hidden = !state.settings.weatherReactive;
  $('#idle-pause').value = String(state.settings.idlePauseMin || 0);
  $('#max-fps').value = String(state.settings.maxFps || 0);
  $('#battery-saver').checked = !!state.settings.batterySaver;
  if (document.activeElement !== $('#pause-apps')) $('#pause-apps').value = (state.settings.pauseApps || []).join(', ');
  if (state.version) $('#app-version').textContent = 'v' + state.version;
}

// ---------- popovers ----------
let popoverOnClose = null;
function closePopover() {
  const p = $('#apply-menu');
  p.hidden = true; p.innerHTML = '';
  p.classList.remove('effects-panel', 'playlist-panel');
  document.removeEventListener('click', onDocClick, true);
  const cb = popoverOnClose; popoverOnClose = null;
  if (cb) cb();
}
function onDocClick(e) {
  if (!$('#apply-menu').contains(e.target)) closePopover();
}
function positionPopover(anchor) {
  const p = $('#apply-menu');
  const r = anchor.getBoundingClientRect();
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = r.left, top = r.bottom + 6;
  if (left + pw > window.innerWidth - 10) left = window.innerWidth - pw - 10;
  if (top + ph > window.innerHeight - 10) top = r.top - ph - 6;
  p.style.left = `${Math.max(10, left)}px`;
  p.style.top = `${Math.max(10, top)}px`;
}
function showPopover(anchor, title, options) {
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.appendChild(el('div', 'po-head', title));
  for (const opt of options) {
    const b = el('button');
    if (opt.dot) b.appendChild(el('span', 'dot'));
    b.appendChild(document.createTextNode(opt.label));
    b.onclick = () => { closePopover(); opt.onClick(); };
    p.appendChild(b);
  }
  p.hidden = false;
  positionPopover(anchor);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// Effects sliders (brightness/saturation/blur/speed). Updates apply live to the
// wallpaper window; we deliberately don't re-render the control UI on each drag
// so the panel stays open.
const EFFECT_SLIDERS = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1, unit: '%' },
  { key: 'blur', label: 'Blur', min: 0, max: 40, step: 1, unit: 'px' },
  { key: 'speed', label: 'Speed', min: 25, max: 200, step: 5, unit: '%' },
  { key: 'parallax', label: 'Mouse parallax (depth)', min: 0, max: 100, step: 5, unit: '%' },
  { key: 'audioReactive', label: 'Audio reactive (pulse to sound)', min: 0, max: 100, step: 5, unit: '%' },
  { key: 'kenBurns', label: 'Ken Burns motion (images)', min: 0, max: 100, step: 5, unit: '%' },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100, step: 5, unit: '%' },
  { key: 'grain', label: 'Film grain', min: 0, max: 100, step: 5, unit: '%' },
  { key: 'overlayIntensity', label: 'Overlay intensity', min: 0, max: 100, step: 5, unit: '%' },
];
const DEFAULT_EFFECTS = { brightness: 100, saturation: 100, blur: 0, speed: 100, parallax: 0, audioReactive: 0, overlay: 'none', overlayIntensity: 50, vignette: 0, grain: 0, grade: 'none', kenBurns: 0 };
const OVERLAY_OPTIONS = [['none', 'None'], ['rain', '🌧 Rain'], ['snow', '❄ Snow'], ['fireflies', '🪰 Fireflies'], ['matrix', '💻 Matrix']];
const GRADE_OPTIONS = [['none', 'None'], ['warm', '🔥 Warm'], ['cool', '❄ Cool'], ['noir', '🎬 Noir'], ['vintage', '📷 Vintage'], ['vibrant', '🌈 Vibrant']];

function openEffectsPanel(anchor, d) {
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.classList.add('effects-panel');
  p.appendChild(el('div', 'po-head', `Effects · ${d.label}`));
  const eff = { ...DEFAULT_EFFECTS, ...(d.effects || {}) };

  // Overlay dropdown (particles/weather over the wallpaper).
  const ovRow = el('div', 'eff-row');
  const ovTop = el('div', 'eff-top');
  ovTop.appendChild(el('span', 'eff-label', 'Overlay'));
  ovRow.appendChild(ovTop);
  const ovSel = el('select', 'fit-select');
  for (const [val, label] of OVERLAY_OPTIONS) {
    const o = el('option', null, label); o.value = val;
    if ((eff.overlay || 'none') === val) o.selected = true;
    ovSel.appendChild(o);
  }
  ovSel.onchange = async (e) => {
    eff.overlay = e.target.value;
    d.effects = { ...(d.effects || DEFAULT_EFFECTS), overlay: e.target.value };
    state = await api.setEffects(d.id, { overlay: e.target.value });
  };
  ovRow.appendChild(ovSel);
  p.appendChild(ovRow);

  // Color-grade preset dropdown.
  const grRow = el('div', 'eff-row');
  const grTop = el('div', 'eff-top');
  grTop.appendChild(el('span', 'eff-label', 'Color grade'));
  grRow.appendChild(grTop);
  const grSel = el('select', 'fit-select');
  for (const [val, label] of GRADE_OPTIONS) {
    const o = el('option', null, label); o.value = val;
    if ((eff.grade || 'none') === val) o.selected = true;
    grSel.appendChild(o);
  }
  grSel.onchange = async (e) => {
    eff.grade = e.target.value;
    d.effects = { ...(d.effects || DEFAULT_EFFECTS), grade: e.target.value };
    state = await api.setEffects(d.id, { grade: e.target.value });
  };
  grRow.appendChild(grSel);
  p.appendChild(grRow);

  for (const s of EFFECT_SLIDERS) {
    const row = el('div', 'eff-row');
    const top = el('div', 'eff-top');
    top.appendChild(el('span', 'eff-label', s.label));
    const val = el('span', 'eff-val', `${eff[s.key]}${s.unit}`);
    top.appendChild(val);
    row.appendChild(top);
    const input = el('input', 'eff-range');
    input.type = 'range';
    input.min = s.min; input.max = s.max; input.step = s.step; input.value = eff[s.key];
    input.oninput = (e) => {
      const v = +e.target.value;
      val.textContent = `${v}${s.unit}`;
      d.effects = { ...(d.effects || DEFAULT_EFFECTS), [s.key]: v };
      // One in-flight IPC at a time (trailing-edge): a fast drag otherwise fires
      // dozens of full-state round trips whose replies can land out of order.
      pushEffect(d.id, s.key, v);
    };
    row.appendChild(input);
    p.appendChild(row);
  }

  const reset = el('button', 'eff-reset', 'Reset to defaults');
  reset.onclick = async () => {
    state = await api.setEffects(d.id, { ...DEFAULT_EFFECTS });
    closePopover();
    render();
  };
  p.appendChild(reset);

  p.hidden = false;
  positionPopover(anchor);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// Info widgets editor (clock / date / weather / system stats).
// Coalesce slider drags: keep at most one effects:set invoke in flight per
// display and only send the latest values when it settles. The final state
// arrives via the normal state:changed broadcast.
const effectQueue = new Map(); // displayId -> { pending: {key:val}|null, busy }
async function pushEffect(displayId, key, value) {
  let q = effectQueue.get(displayId);
  if (!q) { q = { pending: null, busy: false }; effectQueue.set(displayId, q); }
  q.pending = { ...(q.pending || {}), [key]: value };
  if (q.busy) return;
  q.busy = true;
  try {
    while (q.pending) {
      const send = q.pending;
      q.pending = null;
      state = await api.setEffects(displayId, send);
    }
  } finally { q.busy = false; }
}

function openWidgetsPanel(anchor, d) {
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.classList.add('effects-panel'); // reuse the scrollable panel styling
  p.appendChild(el('div', 'po-head', `Widgets · ${d.label}`));
  const w = { clock: false, seconds: false, date: false, weather: false, weatherLocation: '', stats: false, graphs: false, nowplaying: false, position: 'top-left', ...(d.widgets || {}) };

  const apply = async () => { d.widgets = { ...w }; state = await api.setWidgets(d.id, { ...w }); };

  const toggle = (key, label, indent) => {
    const row = el('label', 'wg-row' + (indent ? ' wg-indent' : ''));
    const box = el('input'); box.type = 'checkbox'; box.checked = !!w[key];
    box.onchange = () => { w[key] = box.checked; apply(); };
    row.append(box, el('span', 'wg-label', label));
    return row;
  };
  p.appendChild(toggle('clock', 'Clock'));
  p.appendChild(toggle('seconds', 'Show seconds', true));
  p.appendChild(toggle('date', 'Date'));
  p.appendChild(toggle('stats', 'System stats (CPU / RAM / GPU)'));
  p.appendChild(toggle('graphs', 'CPU / RAM / GPU graphs'));
  p.appendChild(toggle('nowplaying', 'Now playing (Spotify / media)'));
  p.appendChild(toggle('weather', 'Weather'));

  const locRow = el('div', 'wg-loc');
  const locIn = el('input', 'pl-int-input'); locIn.type = 'text';
  locIn.placeholder = 'Weather city (blank = auto-detect)'; locIn.value = w.weatherLocation || '';
  locIn.style.width = '100%';
  locIn.onchange = () => { w.weatherLocation = locIn.value.trim(); apply(); };
  locRow.appendChild(locIn);
  p.appendChild(locRow);

  const posRow = el('div', 'eff-row');
  const posTop = el('div', 'eff-top'); posTop.appendChild(el('span', 'eff-label', 'Position')); posRow.appendChild(posTop);
  const posSel = el('select', 'fit-select');
  for (const [val, label] of [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']]) {
    const o = el('option', null, label); o.value = val;
    if ((w.position || 'top-left') === val) o.selected = true;
    posSel.appendChild(o);
  }
  posSel.onchange = () => { w.position = posSel.value; apply(); };
  posRow.appendChild(posSel);
  p.appendChild(posRow);

  p.hidden = false;
  popoverOnClose = render;
  positionPopover(anchor);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// Playlist / schedule editor: pick library items to rotate on a timer OR switch
// by time of day.
function openPlaylistPanel(anchor, d) {
  const p = $('#apply-menu');
  p.classList.add('playlist-panel');

  const ready = state.library.filter(isReady);
  const pl = d.playlist || { items: [], intervalSec: 30, shuffle: false, mode: 'interval', times: {} };
  const selected = new Set(pl.items);
  let intervalSec = pl.intervalSec || 30;
  let shuffle = !!pl.shuffle;
  let mode = pl.mode === 'schedule' ? 'schedule' : 'interval';
  const times = { ...(pl.times || {}) };

  const apply = async () => {
    const items = ready.filter((it) => selected.has(it.id)).map((it) => it.id);
    d.playlist = { items, intervalSec, shuffle, mode, times };
    state = await api.setPlaylist(d.id, { items, intervalSec, shuffle, mode, times });
  };

  function build() {
    p.innerHTML = '';
    p.appendChild(el('div', 'po-head', `Playlist · ${d.label}`));

    // Mode toggle: rotate on a timer vs switch by time of day.
    const modeRow = el('div', 'pl-mode');
    const mkMode = (val, label) => {
      const b = el('button', 'pl-mode-btn', label);
      if (mode === val) b.classList.add('active');
      b.onclick = () => { mode = val; apply(); build(); };
      return b;
    };
    modeRow.append(mkMode('interval', '🔁 Rotate'), mkMode('schedule', '🕐 By time of day'));
    p.appendChild(modeRow);

    if (mode === 'interval') {
      const ctrls = el('div', 'pl-ctrls');
      const intWrap = el('label', 'pl-int');
      intWrap.appendChild(el('span', '', 'Every'));
      const intInput = el('input', 'pl-int-input');
      intInput.type = 'number'; intInput.min = 5; intInput.max = 3600; intInput.step = 5; intInput.value = intervalSec;
      intInput.onchange = () => { intervalSec = Math.max(5, +intInput.value || 30); intInput.value = intervalSec; apply(); };
      intWrap.append(intInput, el('span', '', 'sec'));
      ctrls.appendChild(intWrap);
      const shufWrap = el('label', 'pl-shuffle');
      const shufBox = el('input'); shufBox.type = 'checkbox'; shufBox.checked = shuffle;
      shufBox.onchange = () => { shuffle = shufBox.checked; apply(); };
      shufWrap.append(shufBox, el('span', '', 'Shuffle'));
      ctrls.appendChild(shufWrap);
      p.appendChild(ctrls);
    } else {
      p.appendChild(el('div', 'pl-hint', 'Check items and set the time each should start. The most recent past time wins.'));
    }

    const list = el('div', 'pl-list');
    if (!ready.length) list.appendChild(el('div', 'pl-empty', 'Add media to your library first.'));
    for (const it of ready) {
      const row = el('div', 'pl-item');
      const box = el('input'); box.type = 'checkbox'; box.checked = selected.has(it.id);
      box.onchange = () => { box.checked ? selected.add(it.id) : selected.delete(it.id); apply(); if (mode === 'schedule') build(); };
      row.appendChild(box);
      const src = thumbFor(it);
      if (src) { const img = el('img', 'pl-thumb'); img.src = src; row.appendChild(img); }
      else row.appendChild(el('span', 'pl-thumb ph', it.shaderPreset ? '✨' : it.type === 'web' ? '🌐' : it.type === 'video' ? '🎬' : '🖼'));
      const name = el('span', 'pl-name', it.name);
      name.onclick = () => { box.checked = !box.checked; box.onchange(); };
      row.appendChild(name);
      if (mode === 'schedule' && selected.has(it.id)) {
        const t = el('input', 'pl-time'); t.type = 'time'; t.value = times[it.id] || '08:00';
        if (!times[it.id]) { times[it.id] = t.value; }
        t.onchange = () => { times[it.id] = t.value; apply(); };
        row.appendChild(t);
      }
      list.appendChild(row);
    }
    p.appendChild(list);

    const clear = el('button', 'eff-reset', mode === 'schedule' ? 'Clear schedule' : 'Clear playlist');
    clear.onclick = async () => { state = await api.clearPlaylist(d.id); closePopover(); };
    p.appendChild(clear);
    positionPopover(anchor);
  }

  build();
  p.hidden = false;
  popoverOnClose = render; // refresh the monitor card after editing
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

async function applyTo(displayId, itemId) {
  if (!displayId) return;
  state = await api.assign(displayId, itemId);
  render();
  toast('Wallpaper applied');
}

function openApplyMenu(anchor, itemId) {
  const opts = state.displays.map((d) => ({
    label: `${d.label} · ${d.resolution}`,
    dot: d.assignedItemId === itemId,
    onClick: () => applyTo(d.id, itemId),
  }));
  if (state.displays.length > 1) {
    opts.push({ label: 'All monitors', onClick: () => applyTo('all', itemId) });
  }
  showPopover(anchor, 'Apply to monitor', opts);
}

const isReady = (item) => !(item.status && item.status !== 'ready');

function openSetMenu(anchor, displayId) {
  const ready = state.library.filter(isReady);
  if (!ready.length) { toast('Add some media first'); return; }
  const opts = ready.map((item) => ({
    label: `${item.type === 'youtube' ? '▶ ' : ''}${item.name}`,
    onClick: () => applyTo(displayId, item.id),
  }));
  showPopover(anchor, 'Choose media', opts);
}

// ---------- import ----------
async function addYouTube() {
  const input = $('#yt-input');
  const url = input.value.trim();
  if (!url) return;
  const res = await api.addVideo(url);
  if (!res.ok) { $('#import-error').textContent = res.error; return; }
  $('#import-error').textContent = '';
  input.value = '';
  state = res.state;
  render();
  toast('Downloading video…');
}

async function browse() {
  state = await api.addFilesDialog();
  render();
}

async function addWeb() {
  const input = $('#web-input');
  const url = input.value.trim();
  if (!url) return;
  const res = await api.addWeb(url);
  if (!res.ok) { $('#import-error').textContent = res.error; return; }
  $('#import-error').textContent = '';
  input.value = '';
  state = res.state;
  render();
  toast('Web wallpaper added');
}

// Per-preset configurable options. Shaders share a Speed option; canvas
// animations have their own (e.g. the bouncing logo's text).
const BUILTIN_OPTS = {
  dvd: [
    { key: 'text', label: 'Logo text', type: 'text', def: 'LUMINA' },
    { key: 'speed', label: 'Speed', type: 'range', min: 1, max: 12, step: 1, def: 4 },
  ],
  constellation: [
    { key: 'density', label: 'Density', type: 'range', min: 40, max: 220, step: 10, def: 120 },
    { key: 'hue', label: 'Color', type: 'hue', def: 210 },
  ],
  flowfield: [
    { key: 'density', label: 'Density', type: 'range', min: 150, max: 1100, step: 50, def: 650 },
    { key: 'palette', label: 'Palette', type: 'select', opts: [['rainbow', 'Rainbow'], ['cool', 'Cool'], ['warm', 'Warm'], ['mono', 'Mono']], def: 'rainbow' },
  ],
  bokeh: [{ key: 'hue', label: 'Color', type: 'hue', def: 260 }],
  fireworks: [{ key: 'rate', label: 'Frequency', type: 'range', min: 1, max: 10, step: 1, def: 5 }],
  gameoflife: [
    { key: 'cell', label: 'Cell size', type: 'range', min: 7, max: 24, step: 1, def: 11 },
    { key: 'hue', label: 'Color', type: 'hue', def: 160 },
    { key: 'speed', label: 'Speed', type: 'range', min: 1, max: 12, step: 1, def: 5 },
  ],
  rainglass: [{ key: 'intensity', label: 'Intensity', type: 'range', min: 1, max: 10, step: 1, def: 5 }],
};
const SHADER_SPEED = [{ key: 'speed', label: 'Speed', type: 'range', min: 25, max: 300, step: 5, def: 100, unit: '%' }];
const builtinOpts = (kind, preset) => BUILTIN_OPTS[preset] || (kind === 'shader' ? SHADER_SPEED : []);

// preset -> display title, harvested from the gallery cards at load.
const BUILTIN_TITLES = {};
function builtinPlayerURL(kind, preset, vals) {
  const base = kind === 'canvas' ? '../canvas/index.html' : '../shader/index.html';
  const q = Object.entries(vals).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
  return `${base}?preset=${encodeURIComponent(preset)}${q}`;
}

// Config popover for a built-in wallpaper — live preview + options. If `editItem`
// is given, it edits that library item; otherwise it adds a new one.
function openBuiltinConfig(anchor, kind, preset, editItem) {
  const schema = builtinOpts(kind, preset);
  const title = BUILTIN_TITLES[preset] || preset;
  const vals = {};
  schema.forEach((s) => { vals[s.key] = (editItem && editItem.options && editItem.options[s.key] != null) ? editItem.options[s.key] : s.def; });
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.classList.add('effects-panel');
  p.appendChild(el('div', 'po-head', (editItem ? 'Edit · ' : '') + title));

  const prev = el('iframe', 'builtin-preview');
  prev.setAttribute('scrolling', 'no');
  const refreshPreview = () => { prev.src = builtinPlayerURL(kind, preset, vals); };
  p.appendChild(prev);

  for (const s of schema) {
    const row = el('div', 'eff-row');
    const top = el('div', 'eff-top');
    top.appendChild(el('span', 'eff-label', s.label));
    if (s.type === 'text') {
      row.appendChild(top);
      const inp = el('input', 'pl-int-input'); inp.type = 'text'; inp.value = vals[s.key]; inp.maxLength = 24; inp.style.width = '100%';
      inp.oninput = () => { vals[s.key] = inp.value; };
      inp.onchange = refreshPreview;
      row.appendChild(inp);
    } else if (s.type === 'select') {
      row.appendChild(top);
      const sel = el('select', 'fit-select');
      for (const [v, lab] of s.opts) { const o = el('option', null, lab); o.value = v; if (v === vals[s.key]) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => { vals[s.key] = sel.value; refreshPreview(); };
      row.appendChild(sel);
    } else {
      const valEl = el('span', 'eff-val');
      if (s.type === 'hue') { valEl.className = 'hue-dot'; valEl.style.background = `hsl(${vals[s.key]},80%,60%)`; }
      else valEl.textContent = vals[s.key] + (s.unit || '');
      top.appendChild(valEl); row.appendChild(top);
      const inp = el('input', s.type === 'hue' ? 'eff-range hue-range' : 'eff-range');
      inp.type = 'range'; inp.min = s.type === 'hue' ? 0 : s.min; inp.max = s.type === 'hue' ? 360 : s.max; inp.step = s.step || 1; inp.value = vals[s.key];
      inp.oninput = () => {
        vals[s.key] = +inp.value;
        if (s.type === 'hue') valEl.style.background = `hsl(${inp.value},80%,60%)`;
        else valEl.textContent = inp.value + (s.unit || '');
      };
      inp.onchange = refreshPreview;
      row.appendChild(inp);
    }
    p.appendChild(row);
  }

  const btn = el('button', 'eff-reset add-builtin', editItem ? 'Update' : 'Add to library');
  btn.onclick = async () => {
    const name = (BUILTIN_TITLES[preset] || preset) + (vals.text ? ' · ' + String(vals.text).slice(0, 16) : '');
    if (editItem) state = await api.setOptions(editItem.id, vals, name);
    else state = await api.addBuiltin(kind, preset, vals);
    closePopover(); render(); toast(editItem ? 'Updated' : 'Wallpaper added');
  };
  p.appendChild(btn);

  p.hidden = false;
  refreshPreview();
  positionPopover(anchor);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// Options popover for a 2.5D depth wallpaper: parallax strength + invert depth.
function openDepthConfig(anchor, item) {
  const vals = {
    strength: (item.options && item.options.strength) || 25,
    invert: !!(item.options && item.options.invert),
  };
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.classList.add('effects-panel');
  p.appendChild(el('div', 'po-head', 'Depth · ' + (item.name || '')));

  const row = el('div', 'eff-row');
  const top = el('div', 'eff-top');
  top.appendChild(el('span', 'eff-label', 'Parallax strength'));
  const valEl = el('span', 'eff-val', vals.strength + '%');
  top.appendChild(valEl); row.appendChild(top);
  const rng = el('input', 'eff-range'); rng.type = 'range'; rng.min = 5; rng.max = 80; rng.step = 5; rng.value = vals.strength;
  rng.oninput = () => { vals.strength = +rng.value; valEl.textContent = rng.value + '%'; };
  row.appendChild(rng);
  p.appendChild(row);

  const inv = el('label', 'wg-row');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = vals.invert;
  cb.onchange = () => { vals.invert = cb.checked; };
  inv.appendChild(cb); inv.appendChild(el('span', 'wg-label', 'Invert depth (swap near / far)'));
  p.appendChild(inv);

  const gen = el('button', 'eff-reset add-builtin', item.depthMap ? '✨ Regenerate depth map (AI)' : '✨ Generate depth map (AI)');
  gen.onclick = () => { closePopover(); generateDepthFor(item); };
  p.appendChild(gen);

  const btn = el('button', 'eff-reset add-builtin', 'Update');
  btn.onclick = async () => { state = await api.setOptions(item.id, vals, item.name); closePopover(); render(); toast('Updated'); };
  p.appendChild(btn);

  p.hidden = false;
  positionPopover(anchor);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// ---------- AI depth-map generation (MiDaS via the main process) ----------

// Decode + resize the base image and produce the model's normalized CHW tensor.
async function imageToTensor(fileUrl, size) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image failed to load')); img.src = fileUrl; });
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, size, size);
  const { data } = g.getImageData(0, 0, size, size);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]; // MiDaS small transform
  const px = size * size;
  const chw = new Float32Array(3 * px);
  for (let i = 0; i < px; i++) {
    for (let ch = 0; ch < 3; ch++) chw[ch * px + i] = (data[i * 4 + ch] / 255 - mean[ch]) / std[ch];
  }
  return chw;
}

let depthBusy = false;
async function generateDepthFor(item) {
  if (depthBusy) { toast('Already generating a depth map — one at a time.'); return; }
  depthBusy = true;
  toast('Generating depth map… (first use downloads a 64 MB model)', 6000);
  try {
    const chw = await imageToTensor(item.baseUrl, 256);
    const res = await api.generateDepth(item.id, chw);
    if (res && res.ok) { state = res.state; render(); toast('Depth map ready ✨'); }
    else if (res && res.error) toast('Depth generation failed: ' + res.error, 6000);
  } catch (err) {
    toast('Depth generation failed: ' + (err.message || err), 6000);
  } finally { depthBusy = false; }
}

api.onDepthProgress(({ pct }) => {
  if (pct < 100) toast(`Downloading depth model… ${pct}%`, 3000);
  else toast('Model downloaded — running depth estimation…', 4000);
});

// Options popover for a folder slideshow: rotation interval + shuffle.
function openFolderConfig(anchor, item) {
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.classList.add('effects-panel');
  p.appendChild(el('div', 'po-head', 'Slideshow · ' + (item.name || '')));

  const intWrap = el('label', 'pl-int');
  intWrap.appendChild(el('span', '', 'Change every'));
  const intInput = el('input', 'pl-int-input');
  intInput.type = 'number'; intInput.min = 1; intInput.max = 1440; intInput.value = Math.round(item.intervalMin || 10);
  intWrap.append(intInput, el('span', '', 'min'));
  p.appendChild(intWrap);

  const shufWrap = el('label', 'wg-row');
  const shufBox = el('input'); shufBox.type = 'checkbox'; shufBox.checked = item.shuffle !== false;
  shufWrap.appendChild(shufBox); shufWrap.appendChild(el('span', 'wg-label', 'Shuffle (random order)'));
  p.appendChild(shufWrap);

  const btn = el('button', 'eff-reset add-builtin', 'Update');
  btn.onclick = async () => {
    state = await api.setFolderOpts(item.id, Math.max(1, +intInput.value || 10), shufBox.checked);
    closePopover(); render(); toast('Slideshow updated');
  };
  p.appendChild(btn);

  p.hidden = false;
  positionPopover(anchor);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

async function addOnline(provider, query, categories) {
  state = await api.addOnline(provider, query, categories);
  render();
  toast('Auto-rotating source added');
}

let searchCtx = null;
function closeSearch() { $('#search-modal').hidden = true; $('#search-grid').innerHTML = ''; searchCtx = null; }

function appendResults(results) {
  const grid = $('#search-grid');
  for (const r of results) {
    const cell = el('div', 'search-thumb');
    const img = el('img'); img.src = r.thumb; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    cell.appendChild(img);
    cell.appendChild(el('div', 'add-hint', '+ Add'));
    cell.onclick = async () => {
      cell.classList.add('added');
      cell.querySelector('.add-hint').textContent = '✓ Added';
      state = await api.addImageUrl(r.full, 'Online · ' + (r.title || 'image'));
    };
    grid.appendChild(cell);
  }
}

// Load the next page; called on open and again as the grid scrolls near bottom.
async function loadSearchPage() {
  const ctx = searchCtx;
  if (!ctx || ctx.loading || ctx.done) return;
  ctx.loading = true;
  const status = $('#search-status');
  if (ctx.firstLoad) status.textContent = 'Searching…';
  const res = await api.searchOnline(ctx.provider, ctx.query, ctx.cursor, ctx.sorting, ctx.categories);
  if (searchCtx !== ctx) return; // a newer search started
  ctx.loading = false;
  ctx.firstLoad = false;
  if (!res.ok) { status.textContent = 'Search failed: ' + res.error; ctx.done = true; return; }
  if (!ctx.total && !res.results.length) { status.textContent = 'No results — try a different term.'; ctx.done = true; return; }
  appendResults(res.results);
  ctx.total += res.results.length;
  ctx.cursor = res.next;
  if (res.next == null) ctx.done = true;
  status.textContent = `${ctx.total} loaded${ctx.done ? '' : ' · scroll for more'} — click any image to add it`;
  // If the first page didn't fill the grid, keep loading so scroll can trigger.
  const grid = $('#search-grid');
  if (!ctx.done && grid.scrollHeight <= grid.clientHeight + 40) loadSearchPage();
}

async function openSearch() {
  const query = $('#online-input').value.trim();
  const [provider, sorting, categories] = $('#online-src').value.split('|');
  $('#search-title').textContent = $('#online-src').selectedOptions[0].text + (query ? ' · ' + query : '');
  $('#search-grid').innerHTML = '';
  $('#search-modal').hidden = false;
  $('#search-rotate').onclick = () => { closeSearch(); addOnline(provider, query, categories); };
  searchCtx = { provider, query, sorting, categories, cursor: null, loading: false, done: false, total: 0, firstLoad: true };
  await loadSearchPage();
}

// drag & drop
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));

// allow dropping anywhere in the window
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  const paths = [];
  for (const f of e.dataTransfer.files) {
    const p = api.pathForFile ? api.pathForFile(f) : f.path;
    if (p) paths.push(p);
  }
  // also accept a dragged URL (e.g. a YouTube link)
  const text = e.dataTransfer.getData('text');
  if (paths.length) {
    state = await api.addFiles(paths);
    render();
    toast(`Added ${paths.length} item${paths.length > 1 ? 's' : ''}`);
  } else if (text && /youtu/.test(text)) {
    $('#yt-input').value = text;
    addYouTube();
  }
});

// ---------- wiring ----------
$('#btn-browse').onclick = browse;
$('#btn-yt').onclick = addYouTube;
$('#yt-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addYouTube(); });
$('#yt-input').addEventListener('input', () => { $('#import-error').textContent = ''; });
$('#btn-web').onclick = addWeb;
$('#web-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addWeb(); });
$('#web-input').addEventListener('input', () => { $('#import-error').textContent = ''; });
$('#btn-online').onclick = openSearch;
$('#online-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') openSearch(); });
$('#search-close').onclick = closeSearch;
$('#search-modal').addEventListener('click', (e) => { if (e.target.id === 'search-modal') closeSearch(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#search-modal').hidden) closeSearch(); });
$('#search-grid').addEventListener('scroll', () => {
  const g = $('#search-grid');
  if (g.scrollTop + g.clientHeight >= g.scrollHeight - 320) loadSearchPage();
});
document.querySelectorAll('.shader-card[data-shader]').forEach((b) => {
  BUILTIN_TITLES[b.dataset.shader] = b.querySelector('.sc-name').textContent;
  b.addEventListener('click', () => openBuiltinConfig(b, 'shader', b.dataset.shader));
});
document.querySelectorAll('.shader-card[data-canvas]').forEach((b) => {
  BUILTIN_TITLES[b.dataset.canvas] = b.querySelector('.sc-name').textContent;
  b.addEventListener('click', () => openBuiltinConfig(b, 'canvas', b.dataset.canvas));
});
$('#btn-viz').onclick = async () => { state = await api.addViz('bars'); render(); toast('Audio visualizer added'); };
$('#btn-depth').onclick = async () => {
  const res = await api.addDepth();
  if (res && res.ok) {
    state = res.state; render(); toast('2.5D depth wallpaper added');
    // No depth map picked → auto-generate one with MiDaS.
    if (res.generatedId) {
      const item = itemById(res.generatedId);
      if (item) generateDepthFor(item);
    }
  }
};
$('#btn-folder').onclick = async () => {
  const res = await api.addFolder();
  if (res && res.ok) { state = res.state; render(); toast('Folder slideshow added'); }
  else if (res && res.error) toast(res.error, 4000);
};
$('#btn-albumart').onclick = async () => { state = await api.addAlbumArt(); render(); toast('Now Playing wallpaper added'); };

$('#library-search').addEventListener('input', (e) => { librarySearch = e.target.value; renderLibrary(); });
$('#library-import').onclick = async () => {
  const res = await api.importItem();
  if (res && res.ok) { state = res.state; render(); toast(`Imported ${res.added} preset${res.added === 1 ? '' : 's'}`); }
  else if (res && res.error) toast(res.error, 4000);
};

// ---------- Community gallery ----------
function closeGallery() { $('#gallery-modal').hidden = true; $('#gallery-grid').innerHTML = ''; }

async function openGallery() {
  $('#gallery-modal').hidden = false;
  $('#gallery-grid').innerHTML = '';
  $('#gallery-status').textContent = 'Loading gallery…';
  const res = await api.fetchGallery();
  if (!res || !res.ok) { $('#gallery-status').textContent = (res && res.error) || 'Gallery unavailable.'; return; }
  if (!res.entries.length) { $('#gallery-status').textContent = 'The gallery is empty so far — share a preset via pull request!'; return; }
  $('#gallery-status').textContent = '';
  const grid = $('#gallery-grid');
  for (const entry of res.entries) {
    const card = el('div', 'gallery-card');
    const prev = el('div', 'gallery-preview');
    if (entry.preview) {
      const img = el('img'); img.src = entry.preview; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      prev.appendChild(img);
    } else {
      prev.appendChild(el('span', 'ph', entry.item.shaderCode || entry.item.shaderPreset ? '✨' : entry.item.canvasPreset ? '🎆' : '🌐'));
    }
    card.appendChild(prev);
    const info = el('div', 'gallery-info');
    info.appendChild(el('div', 'name', entry.name));
    if (entry.author) info.appendChild(el('div', 'gallery-author', 'by ' + entry.author));
    if (entry.description) info.appendChild(el('div', 'gallery-desc', entry.description));
    const install = el('button', 'btn primary', 'Add to library');
    install.onclick = async () => {
      install.disabled = true;
      const r = await api.installGalleryItem(entry.item);
      if (r && r.ok) { state = r.state; render(); toast(`Added “${entry.name}”`); }
      else { install.disabled = false; if (r && r.error) toast(r.error, 4000); }
    };
    info.appendChild(install);
    card.appendChild(info);
    grid.appendChild(card);
  }
}
$('#library-gallery').onclick = openGallery;
$('#gallery-close').onclick = closeGallery;

// ---------- Custom GLSL shader editor ----------
const STARTER_SHADER = `void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = (gl_FragCoord.xy * 2.0 - u_res.xy) / u_res.y;
  float t = u_time * 0.3;
  float n = fbm(p * 2.0 + vec2(t, -t));
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + n * 4.0 + t);
  col *= 0.55 + 0.45 * uv.y;
  gl_FragColor = vec4(col, 1.0);
}`;

let editorItem = null;
let editorDebounce = null;

function openShaderEditor(editItem) {
  editorItem = editItem || null;
  $('#editor-title').textContent = editItem ? 'Edit shader' : 'Custom shader';
  $('#editor-code').value = (editItem && editItem.shaderCode) || STARTER_SHADER;
  $('#editor-name').value = editItem ? (editItem.name || '') : '';
  const status = $('#editor-status'); status.textContent = ''; status.className = 'editor-status';
  $('#shader-editor').hidden = false;
  // The preview requests its source once loaded (lumina:shaderRequest below).
  $('#editor-preview').src = '../shader/index.html?preset=custom';
}
function closeShaderEditor() {
  $('#shader-editor').hidden = true;
  $('#editor-preview').src = 'about:blank';
  editorItem = null;
}
function pushEditorSource() {
  const w = $('#editor-preview').contentWindow;
  if (w) w.postMessage({ type: 'lumina:shaderSource', code: $('#editor-code').value }, '*');
}

$('#btn-custom-shader').onclick = () => openShaderEditor(null);
$('#editor-close').onclick = closeShaderEditor;
$('#shader-editor').addEventListener('click', (e) => { if (e.target.id === 'shader-editor') closeShaderEditor(); });
$('#editor-code').addEventListener('input', () => { clearTimeout(editorDebounce); editorDebounce = setTimeout(pushEditorSource, 250); });
$('#editor-code').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { // insert two spaces instead of leaving the textarea
    e.preventDefault();
    const t = e.target, s = t.selectionStart, end = t.selectionEnd;
    t.value = t.value.slice(0, s) + '  ' + t.value.slice(end);
    t.selectionStart = t.selectionEnd = s + 2;
  }
});
$('#editor-save').onclick = async () => {
  const name = $('#editor-name').value.trim() || 'Custom shader';
  state = await api.saveShaderCode(editorItem ? editorItem.id : null, name, $('#editor-code').value);
  const wasEdit = !!editorItem;
  closeShaderEditor();
  render();
  toast(wasEdit ? 'Shader updated' : 'Shader saved to library');
};

// Messages from the editor's preview iframe: source request + compile status.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || $('#shader-editor').hidden) return;
  if (d.type === 'lumina:shaderRequest') {
    pushEditorSource();
  } else if (d.type === 'lumina:shaderStatus') {
    const s = $('#editor-status');
    if (d.log) { s.textContent = d.log.trim(); s.className = 'editor-status err'; }
    else { s.textContent = 'Compiled ✓'; s.className = 'editor-status ok'; }
  }
});

$('#volume').addEventListener('input', (e) => setVolUI(+e.target.value));
$('#volume').addEventListener('change', async (e) => {
  state = await api.setSettings({ volume: +e.target.value / 100 });
});
$('#autostart').addEventListener('change', async (e) => {
  state = await api.setSettings({ autostart: e.target.checked });
  toast(e.target.checked ? 'Will start with Windows' : 'Autostart disabled');
});
$('#pause-fullscreen').addEventListener('change', async (e) => {
  state = await api.setSettings({ pauseOnFullscreen: e.target.checked });
  toast(e.target.checked ? 'Will pause behind fullscreen apps' : 'Fullscreen pause off');
});
$('#pause-battery').addEventListener('change', async (e) => {
  state = await api.setSettings({ pauseOnBattery: e.target.checked });
  toast(e.target.checked ? 'Will pause on battery' : 'Battery pause off');
});
$('#hotkeys').addEventListener('change', async (e) => {
  state = await api.setSettings({ hotkeys: e.target.checked });
  toast(e.target.checked ? 'Global hotkeys on' : 'Global hotkeys off');
});
$('#transitions').addEventListener('change', async (e) => {
  state = await api.setSettings({ transitions: e.target.checked });
  toast(e.target.checked ? 'Crossfade transitions on' : 'Transitions off');
});
$('#span-mode').addEventListener('change', async (e) => {
  state = await api.setSettings({ spanMode: e.target.checked });
  render();
  toast(e.target.checked ? 'Spanning across all monitors' : 'Per-monitor wallpapers');
});
$('#night-shift').addEventListener('change', async (e) => {
  state = await api.setSettings({ nightShift: e.target.checked });
  toast(e.target.checked ? 'Night shift on' : 'Night shift off');
});
$('#weather-reactive').addEventListener('change', async (e) => {
  $('#weather-loc-row').hidden = !e.target.checked;
  state = await api.setSettings({ weatherReactive: e.target.checked });
  toast(e.target.checked ? 'Weather-reactive on' : 'Weather-reactive off');
});
$('#weather-location').addEventListener('change', async (e) => {
  state = await api.setSettings({ weatherLocation: e.target.value.trim() });
});
$('#idle-pause').addEventListener('change', async (e) => {
  state = await api.setSettings({ idlePauseMin: +e.target.value });
  toast(+e.target.value ? `Pause after ${e.target.value} min idle` : 'Idle pause off');
});
$('#max-fps').addEventListener('change', async (e) => {
  state = await api.setSettings({ maxFps: +e.target.value });
  toast(+e.target.value ? `Wallpaper FPS capped at ${e.target.value}` : 'FPS uncapped');
});
$('#battery-saver').addEventListener('change', async (e) => {
  state = await api.setSettings({ batterySaver: e.target.checked });
  toast(e.target.checked ? 'Battery saver on' : 'Battery saver off');
});
$('#pause-apps').addEventListener('change', async (e) => {
  const apps = e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  state = await api.setSettings({ pauseApps: apps });
  toast(apps.length ? `Pausing for ${apps.length} app${apps.length === 1 ? '' : 's'}` : 'App pause rules cleared');
});

// ---- Profiles ----
$('#profile-select').addEventListener('change', () => {
  const has = !!$('#profile-select').value;
  $('#profile-load').disabled = !has;
  $('#profile-delete').disabled = !has;
});
$('#profile-save').onclick = async () => {
  const name = $('#profile-name').value.trim();
  if (!name) { toast('Enter a profile name'); return; }
  state = await api.saveProfile(name);
  $('#profile-name').value = '';
  render();
  $('#profile-select').value = name;
  toast('Profile saved: ' + name);
};
$('#profile-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#profile-save').click(); });
$('#profile-load').onclick = async () => {
  const name = $('#profile-select').value;
  if (!name) return;
  state = await api.loadProfile(name);
  render();
  toast('Loaded profile: ' + name);
};
$('#profile-delete').onclick = async () => {
  const name = $('#profile-select').value;
  if (!name) return;
  state = await api.deleteProfile(name);
  render();
  toast('Deleted profile: ' + name);
};
$('#profile-export').onclick = async () => {
  const res = await api.exportConfig();
  if (res && res.ok) toast('Config exported');
};
$('#profile-import').onclick = async () => {
  const res = await api.importConfig();
  if (res && res.ok) { state = res.state; render(); toast('Config imported'); }
  else if (res && res.error) toast('Import failed: ' + res.error);
};

$('#app-version').onclick = () => api.checkForUpdates();
$('#check-updates').onclick = () => api.checkForUpdates();

$('#btn-min').onclick = () => api.minimize();
$('#btn-tray').onclick = () => api.hide();
$('#btn-close').onclick = () => api.close();

api.onStateChanged((s) => { state = s; render(); });

api.onUpdate((kind, p) => {
  if (kind === 'checking') toast('Checking for updates…');
  else if (kind === 'available') toast(`Downloading update ${p?.version || ''}…`);
  else if (kind === 'progress') toast(`Downloading update… ${p?.percent || 0}%`);
  else if (kind === 'ready') toast(`Update ${p?.version || ''} ready — restart to apply`, 6000);
  else if (kind === 'none') toast('You’re on the latest version');
  else if (kind === 'error') toast(`Update failed: ${p?.message || 'unknown error'}`, 6000);
});

// init
(async () => {
  state = await api.getState();
  render();
})();
