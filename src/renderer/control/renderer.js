const api = window.lumina;

let state = { library: [], assignments: {}, displays: [], settings: {} };
const thumbCache = new Map(); // itemId -> dataURL (video frame grabs)

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
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

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// Grab a representative frame from a video file for use as a thumbnail.
function generateThumb(item) {
  if (thumbCache.has(item.id)) return Promise.resolve(thumbCache.get(item.id));
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata'; v.src = item.fileUrl;
    const done = (data) => { if (data) thumbCache.set(item.id, data); resolve(data); cleanup(); };
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
}

function thumbFor(item) {
  if (item.type === 'youtube') return item.thumb;
  if (item.type === 'gif' || item.type === 'image') return item.fileUrl;
  return thumbCache.get(item.id) || null;
}

// ---------- rendering ----------
function render() {
  renderMonitors();
  renderLibrary();
  renderSettings();
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
    wgBtn.classList.toggle('active', !!(w.clock || w.date || w.weather || w.stats));
    wgBtn.onclick = (e) => openWidgetsPanel(e.currentTarget, d);
    row3.append(wgBtn);

    card.append(row1, row2, row3);

    wrap.appendChild(card);
  }
}

function renderLibrary() {
  const grid = $('#library');
  grid.innerHTML = '';
  $('#library-empty').style.display = state.library.length ? 'none' : 'block';

  for (const item of state.library) {
    const downloading = item.type === 'youtube' && item.status === 'downloading';
    const errored = item.type === 'youtube' && item.status === 'error';
    const card = el('div', 'card');

    const iconFor = (it) => it.type === 'online' ? '🌅' : it.type === 'viz' ? '🎵' : it.shaderPreset ? '✨'
      : it.type === 'web' ? '🌐' : it.type === 'video' ? '🎬' : it.type === 'youtube' ? '▶' : '🖼';
    const typeLabel = (it) => it.type === 'online' ? (it.provider === 'reddit' ? 'reddit' : 'wallhaven')
      : it.type === 'viz' ? 'audio' : it.shaderPreset ? 'shader' : it.type === 'youtube' ? 'youtube' : it.type;

    const thumb = el('div', 'thumb');
    const src = thumbFor(item);
    if (src) {
      const img = el('img'); img.src = src; thumb.appendChild(img);
    } else {
      thumb.appendChild(el('div', 'ph', iconFor(item)));
      if (item.type === 'video') generateThumb(item).then((d) => { if (d) renderLibrary(); });
    }
    thumb.appendChild(el('div', 'type', typeLabel(item)));
    if ((item.type === 'video' || item.type === 'youtube') && !downloading && !errored) {
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
  { key: 'overlayIntensity', label: 'Overlay intensity', min: 0, max: 100, step: 5, unit: '%' },
];
const DEFAULT_EFFECTS = { brightness: 100, saturation: 100, blur: 0, speed: 100, parallax: 0, audioReactive: 0, overlay: 'none', overlayIntensity: 50 };
const OVERLAY_OPTIONS = [['none', 'None'], ['rain', '🌧 Rain'], ['snow', '❄ Snow'], ['fireflies', '🪰 Fireflies'], ['matrix', '💻 Matrix']];

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
    input.oninput = async (e) => {
      const v = +e.target.value;
      val.textContent = `${v}${s.unit}`;
      d.effects = { ...(d.effects || DEFAULT_EFFECTS), [s.key]: v };
      state = await api.setEffects(d.id, { [s.key]: v });
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
function openWidgetsPanel(anchor, d) {
  const p = $('#apply-menu');
  p.innerHTML = '';
  p.classList.add('effects-panel'); // reuse the scrollable panel styling
  p.appendChild(el('div', 'po-head', `Widgets · ${d.label}`));
  const w = { clock: false, seconds: false, date: false, weather: false, weatherLocation: '', stats: false, position: 'top-left', ...(d.widgets || {}) };

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
  p.appendChild(toggle('stats', 'System stats (CPU / RAM)'));
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

const isReady = (item) => !(item.type === 'youtube' && item.status && item.status !== 'ready');

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
  const res = await api.addYouTube(url);
  if (!res.ok) { $('#import-error').textContent = res.error; return; }
  $('#import-error').textContent = '';
  input.value = '';
  state = res.state;
  render();
  toast('Downloading from YouTube…');
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

async function addShader(preset) {
  state = await api.addShader(preset);
  render();
  toast('Shader added to library');
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
  for (const f of e.dataTransfer.files) if (f.path) paths.push(f.path);
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
document.querySelectorAll('.shader-card[data-shader]').forEach((b) =>
  b.addEventListener('click', () => addShader(b.dataset.shader)));
$('#btn-viz').onclick = async () => { state = await api.addViz('bars'); render(); toast('Audio visualizer added'); };

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

$('#btn-min').onclick = () => api.minimize();
$('#btn-tray').onclick = () => api.hide();
$('#btn-close').onclick = () => api.close();

api.onStateChanged((s) => { state = s; render(); });

// init
(async () => {
  state = await api.getState();
  render();
})();
