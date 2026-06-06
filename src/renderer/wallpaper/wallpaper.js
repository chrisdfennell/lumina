// Fullscreen media player for a single monitor's wallpaper.

const videoEl = document.getElementById('video');
const gifEl = document.getElementById('gif');
const ytEl = document.getElementById('yt');
const webEl = document.getElementById('web');
const vizCanvas = document.getElementById('viz');
const overlayCanvas = document.getElementById('overlay');
const messageEl = document.getElementById('message');

let ytPlayer = null;
let ytApiReady = false;
let pendingYt = null;
let current = null; // last payload
let currentVolume = 0;
let currentFit = 'cover';

// How the wallpaper is scaled to the monitor. For <video>/<img> we set CSS
// object-fit directly; the YouTube iframe can't use object-fit, so it gets an
// equivalent class instead (see index.html).
function applyFit(fit) {
  currentFit = ['cover', 'contain', 'fill', 'none'].includes(fit) ? fit : 'cover';
  videoEl.style.objectFit = currentFit;
  gifEl.style.objectFit = currentFit;
  ytEl.classList.remove('fit-cover', 'fit-contain', 'fit-fill', 'fit-none');
  ytEl.classList.add('fit-' + currentFit);
}

let currentEffects = { brightness: 100, saturation: 100, blur: 0, speed: 100, parallax: 0 };

// Per-monitor look. brightness/saturation are percentages (100 = unchanged),
// blur is px, speed is playback-rate percent (100 = 1x), parallax is 0-100.
function applyEffects(eff) {
  const e = eff || {};
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  currentEffects = {
    brightness: num(e.brightness, 100),
    saturation: num(e.saturation, 100),
    blur: num(e.blur, 0),
    speed: num(e.speed, 100),
    parallax: num(e.parallax, 0),
    audioReactive: num(e.audioReactive, 0),
    overlay: e.overlay || 'none',
    overlayIntensity: num(e.overlayIntensity, 50),
  };
  if (!currentEffects.parallax) applyParallax(null);
  // Start/stop the shared audio capture as the audio-reactive effect toggles.
  const wantAudio = currentEffects.audioReactive > 0;
  if (wantAudio && !audioReactiveOn) { audioReactiveOn = true; audioAcquire(); }
  else if (!wantAudio && audioReactiveOn) { audioReactiveOn = false; audioRelease(); }
  applyAudioReactive();
  if (typeof updateOverlay === 'function') updateOverlay(currentEffects.overlay, currentEffects.overlayIntensity);
  const filter =
    `brightness(${currentEffects.brightness / 100}) ` +
    `saturate(${currentEffects.saturation / 100}) ` +
    `blur(${currentEffects.blur}px)`;
  videoEl.style.filter = filter;
  gifEl.style.filter = filter;
  ytEl.style.filter = filter;
  webEl.style.filter = filter;
  const rate = Math.min(4, Math.max(0.1, currentEffects.speed / 100));
  try { videoEl.playbackRate = rate; } catch {}
  if (ytPlayer && ytPlayer.setPlaybackRate) {
    try { ytPlayer.setPlaybackRate(rate); } catch {}
  }
}

function hideAll() {
  videoEl.style.display = 'none';
  gifEl.style.display = 'none';
  ytEl.style.display = 'none';
  webEl.style.display = 'none';
  vizCanvas.style.display = 'none';
  messageEl.style.display = 'none';
}

function stopWeb() {
  try { webEl.src = 'about:blank'; } catch {}
}

// ---------- Shared system-audio engine (visualizer + audio-reactive) ----------
// Captured once (ref-counted) and shared, so the bars visualizer AND the
// "audio-reactive" effect can both read the same analyser without two captures.
const audio = { stream: null, ctx: null, analyser: null, data: null, refs: 0, raf: 0, level: 0, starting: false };

async function audioAcquire() {
  audio.refs++;
  if (audio.analyser || audio.starting) return;
  audio.starting = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    audio.stream = stream;
    stream.getVideoTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    audio.ctx = ctx;
    try { await ctx.resume(); } catch {}
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.8;
    src.connect(an);
    audio.analyser = an;
    audio.data = new Uint8Array(an.frequencyBinCount);
    console.log('[wp] capturing system audio (loopback)');
    if (!audio.raf) audioLoop();
  } catch (err) {
    console.log('[wp] audio capture unavailable: ' + err);
  }
  audio.starting = false;
}

function audioRelease() {
  audio.refs = Math.max(0, audio.refs - 1);
  if (audio.refs > 0) return;
  if (audio.raf) cancelAnimationFrame(audio.raf);
  audio.raf = 0;
  try { if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audio.ctx) audio.ctx.close(); } catch {}
  audio.stream = audio.ctx = audio.analyser = audio.data = null;
  audio.level = 0;
  applyAudioReactive();
}

function audioLoop() {
  audio.raf = requestAnimationFrame(audioLoop);
  if (!audio.analyser || audio.paused) return;
  audio.analyser.getByteFrequencyData(audio.data);
  // Overall level, weighted toward the low end (bass/beat).
  let sum = 0, wsum = 0;
  const n = audio.data.length;
  for (let i = 0; i < n; i++) { const w = i < n * 0.3 ? 2.2 : 1; sum += audio.data[i] * w; wsum += 255 * w; }
  audio.level = wsum ? sum / wsum : 0;
  applyAudioReactive();
}

// ---------- Audio visualizer (system-audio reactive canvas) ----------
const viz = { raf: 0, paused: false, active: false, t: 0 };

function vizResize() {
  vizCanvas.width = window.innerWidth;
  vizCanvas.height = window.innerHeight;
}
window.addEventListener('resize', () => { if (viz.active) vizResize(); });

async function startViz() {
  if (viz.active) return;
  viz.active = true;
  viz.paused = false;
  vizResize();
  await audioAcquire();
  if (!viz.raf) drawViz();
}

function stopViz() {
  if (!viz.active) return;
  viz.active = false;
  if (viz.raf) cancelAnimationFrame(viz.raf);
  viz.raf = 0;
  audioRelease();
}

function drawViz() {
  if (!viz.active) return;
  viz.raf = requestAnimationFrame(drawViz);
  if (viz.paused) return;
  const ctx = vizCanvas.getContext('2d');
  const w = vizCanvas.width, h = vizCanvas.height;
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, w, h);
  viz.t += 0.016;

  const N = 64;
  const vals = new Array(N);
  if (audio.analyser) {
    audio.analyser.getByteFrequencyData(audio.data);
    for (let i = 0; i < N; i++) vals[i] = Math.pow(audio.data[i] / 255, 1.4);
  } else {
    // Idle: gentle synthetic motion so it isn't a dead screen with no audio.
    for (let i = 0; i < N; i++) vals[i] = 0.12 + 0.1 * Math.abs(Math.sin(viz.t * 1.5 + i * 0.4)) * (1 - i / N);
  }

  const barW = w / (N * 2);
  for (let i = 0; i < N; i++) {
    const bh = vals[i] * h * 0.72;
    const grad = ctx.createLinearGradient(0, h, 0, h - bh);
    grad.addColorStop(0, '#3a1c71');
    grad.addColorStop(0.5, '#7c4dff');
    grad.addColorStop(1, '#23d5ab');
    ctx.fillStyle = grad;
    ctx.fillRect(w / 2 + i * barW + 1, h - bh, barW - 2, bh);          // right
    ctx.fillRect(w / 2 - (i + 1) * barW + 1, h - bh, barW - 2, bh);    // mirrored left
  }
}

function playViz(payload) {
  destroyYt();
  stopVideo();
  stopWeb();
  hideAll();
  applyEffects(payload.effects);
  vizCanvas.style.display = 'block';
  startViz();
}

function stopVideo() {
  try {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  } catch {}
}

function destroyYt() {
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch {}
    ytPlayer = null;
  }
  ytEl.innerHTML = '';
}

function applyVolume(v) {
  currentVolume = v;
  const muted = !v || v <= 0;
  videoEl.muted = muted;
  videoEl.volume = Math.max(0, Math.min(1, v || 0));
  if (ytPlayer && ytPlayer.setVolume) {
    try {
      if (muted) ytPlayer.mute();
      else { ytPlayer.unMute(); ytPlayer.setVolume(Math.round((v || 0) * 100)); }
    } catch {}
  }
}

function playVideo(payload) {
  destroyYt();
  stopWeb();
  stopViz();
  hideAll();
  applyFit(payload.fit);
  applyEffects(payload.effects);
  videoEl.src = payload.src;
  videoEl.loop = true;
  applyVolume(payload.volume ?? 0);
  videoEl.style.display = 'block';
  videoEl.play().then(
    () => console.log('[wp] video play() ok'),
    (err) => console.log('[wp] video play() rejected: ' + err),
  );
}
videoEl.addEventListener('loadeddata', () => {
  console.log(`[wp] video loadeddata ${videoEl.videoWidth}x${videoEl.videoHeight}`);
  // playbackRate resets when a new source loads — re-apply the current speed.
  try { videoEl.playbackRate = Math.min(4, Math.max(0.1, currentEffects.speed / 100)); } catch {}
});
videoEl.addEventListener('playing', () => console.log('[wp] video PLAYING'));
videoEl.addEventListener('error', () =>
  console.log('[wp] video ERROR ' + (videoEl.error && videoEl.error.code)));
videoEl.addEventListener('stalled', () => console.log('[wp] video stalled'));

function playGif(payload) {
  destroyYt();
  stopVideo();
  stopWeb();
  stopViz();
  hideAll();
  applyFit(payload.fit);
  applyEffects(payload.effects);
  // reload to restart animation from frame 0
  gifEl.src = payload.src + (payload.src.includes('?') ? '&' : '?') + 't=' + Date.now();
  gifEl.style.display = 'block';
}

function playImage(payload) {
  destroyYt();
  stopVideo();
  stopWeb();
  stopViz();
  hideAll();
  applyFit(payload.fit);
  applyEffects(payload.effects);
  gifEl.src = payload.src; // static image — no cache-buster needed
  gifEl.style.display = 'block';
}

// Web page or built-in shader. The content fills the screen; object-fit doesn't
// apply to an iframe, so fit modes are a no-op here (effects still apply).
function playWeb(payload) {
  destroyYt();
  stopVideo();
  stopViz();
  hideAll();
  applyEffects(payload.effects);
  // Live edit of the already-loaded custom shader: push new GLSL without a
  // reload (avoids a black flash while you tweak code).
  const sameDoc = webEl.style.display === 'block' && webEl.src === payload.src;
  if (payload.shaderCode && sameDoc) {
    messageWeb({ type: 'lumina:shaderSource', code: payload.shaderCode });
  } else {
    webEl.src = payload.src;
  }
  webEl.style.display = 'block';
}

// --- YouTube via IFrame API ---
function loadYtApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) { ytApiReady = true; return resolve(); }
    window.onYouTubeIframeAPIReady = () => { ytApiReady = true; resolve(); };
    if (!document.getElementById('yt-api')) {
      const s = document.createElement('script');
      s.id = 'yt-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  });
}

function playYouTube(payload) {
  stopVideo();
  destroyYt();
  stopWeb();
  stopViz();
  hideAll();
  applyFit(payload.fit);
  applyEffects(payload.effects);

  // Render the embed iframe immediately so the screen never sits blank/white.
  const params = new URLSearchParams({
    autoplay: '1',
    mute: payload.volume ? '0' : '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    modestbranding: '1',
    rel: '0',
    iv_load_policy: '3',
    playsinline: '1',
    loop: '1',
    playlist: payload.videoId,
    enablejsapi: '1',
  });
  const iframe = document.createElement('iframe');
  iframe.id = 'yt-frame';
  iframe.src = `https://www.youtube-nocookie.com/embed/${payload.videoId}?${params.toString()}`;
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('allowfullscreen', '');
  ytEl.appendChild(iframe);
  ytEl.style.display = 'block';

  // Attach the IFrame API for play/pause/volume control once it loads.
  // This is best-effort — the video already plays via the iframe itself.
  loadYtApi().then(() => {
    try {
      ytPlayer = new YT.Player(iframe, {
        events: {
          onReady: () => applyVolume(payload.volume ?? 0),
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) {
              try { e.target.playVideo(); } catch {}
            }
          },
          onError: () => { messageEl.style.display = 'flex'; },
        },
      });
    } catch {}
  });
}

function play(payload) {
  console.log('[wp] play received: ' + (payload ? payload.type + ' ' + (payload.videoId || payload.src) : 'null'));
  current = payload;
  if (!payload) { hideAll(); stopVideo(); destroyYt(); stopWeb(); stopViz(); return; }
  if (payload.type === 'video') playVideo(payload);
  else if (payload.type === 'gif') playGif(payload);
  else if (payload.type === 'image') playImage(payload);
  else if (payload.type === 'web') playWeb(payload);
  else if (payload.type === 'viz') playViz(payload);
  else if (payload.type === 'youtube') playYouTube(payload);
}

window.wp.onPlay(play);
function messageWeb(msg) {
  try { if (webEl.contentWindow) webEl.contentWindow.postMessage(msg, '*'); } catch {}
}

// A custom-shader player asks its host for its GLSL once it has loaded; reply
// with the code carried on the current payload.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'lumina:shaderRequest' && current && current.shaderCode) {
    messageWeb({ type: 'lumina:shaderSource', code: current.shaderCode });
  }
});
window.wp.onPause(() => {
  videoEl.pause();
  if (ytPlayer && ytPlayer.pauseVideo) try { ytPlayer.pauseVideo(); } catch {}
  messageWeb('pause');
  viz.paused = true;
  ov.paused = true;
  wx.paused = true;
  audio.paused = true;
});
window.wp.onResume(() => {
  if (current && current.type === 'video') videoEl.play().catch(() => {});
  if (ytPlayer && ytPlayer.playVideo) try { ytPlayer.playVideo(); } catch {}
  messageWeb('resume');
  viz.paused = false;
  ov.paused = false;
  wx.paused = false;
  audio.paused = false;
});
window.wp.onVolume((v) => applyVolume(v));
window.wp.onFit((f) => applyFit(f));
window.wp.onEffects((eff) => applyEffects(eff));

// Combined transform on the wallpaper layer = mouse-parallax offset + zoom,
// multiplied by the audio-reactive pulse. Both inputs feed the same transform.
const parallaxEls = [videoEl, gifEl, webEl];
let pxTx = 0, pxTy = 0, pxScale = 1, audioScale = 1, audioReactiveOn = false;
function applyTransform() {
  const s = (pxScale * audioScale).toFixed(3);
  const t = (pxTx === 0 && pxTy === 0 && s === '1.000') ? '' : `translate(${pxTx.toFixed(1)}px, ${pxTy.toFixed(1)}px) scale(${s})`;
  for (const el of parallaxEls) el.style.transform = t;
}
function applyParallax(c) {
  const amt = (currentEffects.parallax || 0) / 100;
  if (!c || amt <= 0) { pxTx = 0; pxTy = 0; pxScale = 1; applyTransform(); return; }
  const maxPx = amt * 45;
  pxTx = -c.x * maxPx;
  pxTy = -c.y * maxPx;
  pxScale = 1 + amt * 0.07; // slight zoom so edges never show
  applyTransform();
}
function applyAudioReactive() {
  const amt = (currentEffects.audioReactive || 0) / 100;
  audioScale = amt > 0 ? 1 + (audio.level || 0) * amt * 0.16 : 1;
  applyTransform();
}
window.wp.onCursor((c) => {
  applyParallax(c);
  // Forward to the web iframe (depth-parallax wallpaper reads this; others ignore).
  messageWeb({ type: 'lumina:cursor', point: c ? { x: c.x, y: c.y } : null });
});

// ---------- Info widgets (clock / date / weather / system stats) ----------
const widgetsEl = document.getElementById('widgets');
let widgetCfg = null;
let widgetData = { cpu: 0, mem: 0, weather: null };
let clockTimer = null;

function renderWidgets() {
  const c = widgetCfg;
  if (!c || !(c.clock || c.date || c.weather || c.stats)) { widgetsEl.style.display = 'none'; return; }
  widgetsEl.className = 'pos-' + (c.position || 'top-left');
  const now = new Date();
  let html = '';
  if (c.clock) {
    const h = now.getHours(), m = String(now.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    const sec = c.seconds ? ':' + String(now.getSeconds()).padStart(2, '0') : '';
    html += `<div class="w-clock">${h12}:${m}${sec}<span class="ampm"> ${ampm}</span></div>`;
  }
  if (c.date) {
    html += `<div class="w-date">${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>`;
  }
  if (c.weather) {
    const w = widgetData.weather;
    html += `<div class="w-weather">${w ? `${w.temp} · ${w.cond}` : '…'}</div>`;
  }
  if (c.stats) {
    html += `<div class="w-stats">CPU ${widgetData.cpu}%&nbsp;&nbsp;·&nbsp;&nbsp;RAM ${widgetData.mem}%</div>`;
  }
  widgetsEl.innerHTML = html;
  widgetsEl.style.display = 'block';
}

window.wp.onWidgets((cfg) => {
  widgetCfg = cfg;
  renderWidgets();
  if (clockTimer) clearInterval(clockTimer);
  if (cfg && cfg.clock) clockTimer = setInterval(renderWidgets, 1000);
});
window.wp.onWidgetData((d) => { widgetData = { ...widgetData, ...d }; renderWidgets(); });

// ---------- Particle/weather overlay (composited above any wallpaper) ----------
const ov = { raf: 0, type: 'none', intensity: 50, parts: [], cols: [], font: 16, t: 0, paused: false };

function ovResize() { overlayCanvas.width = window.innerWidth; overlayCanvas.height = window.innerHeight; }

function ovInit() {
  const w = overlayCanvas.width, h = overlayCanvas.height, I = ov.intensity / 100;
  ov.parts = []; ov.cols = [];
  if (ov.type === 'rain') {
    const n = Math.round(60 + I * 360);
    for (let i = 0; i < n; i++) ov.parts.push({ x: Math.random() * w, y: Math.random() * h, len: 8 + Math.random() * 16, sp: 7 + Math.random() * 9 + I * 6 });
  } else if (ov.type === 'snow') {
    const n = Math.round(40 + I * 260);
    for (let i = 0; i < n; i++) ov.parts.push({ x: Math.random() * w, y: Math.random() * h, r: 1 + Math.random() * 2.4, sp: 0.5 + Math.random() * 1.6, drift: Math.random() * Math.PI * 2 });
  } else if (ov.type === 'fireflies') {
    const n = Math.round(15 + I * 85);
    for (let i = 0; i < n; i++) ov.parts.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5, ph: Math.random() * Math.PI * 2 });
  } else if (ov.type === 'matrix') {
    ov.font = 16;
    const cols = Math.max(1, Math.floor(w / ov.font));
    for (let i = 0; i < cols; i++) ov.cols.push(Math.random() * -h);
  }
}

function updateOverlay(type, intensity) {
  type = ['rain', 'snow', 'fireflies', 'matrix'].includes(type) ? type : 'none';
  ov.intensity = intensity || 0;
  if (type === 'none' || ov.intensity <= 0) {
    ov.type = 'none';
    if (ov.raf) cancelAnimationFrame(ov.raf);
    ov.raf = 0;
    overlayCanvas.style.display = 'none';
    return;
  }
  ov.type = type;
  overlayCanvas.style.display = 'block';
  ovResize();
  ovInit();
  if (!ov.raf) drawOverlay();
}

function drawOverlay() {
  if (ov.type === 'none') return;
  ov.raf = requestAnimationFrame(drawOverlay);
  if (ov.paused) return;
  const ctx = overlayCanvas.getContext('2d');
  const w = overlayCanvas.width, h = overlayCanvas.height;
  ctx.clearRect(0, 0, w, h); // transparent — wallpaper shows through
  ov.t += 0.016;

  if (ov.type === 'rain') {
    ctx.strokeStyle = 'rgba(170,200,255,0.5)'; ctx.lineWidth = 1.2;
    for (const p of ov.parts) {
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 2, p.y + p.len); ctx.stroke();
      p.y += p.sp; p.x -= 0.6;
      if (p.y > h) { p.y = -p.len; p.x = Math.random() * w; }
    }
  } else if (ov.type === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const p of ov.parts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      p.y += p.sp; p.x += Math.sin(ov.t + p.drift) * 0.5;
      if (p.y > h) { p.y = -2; p.x = Math.random() * w; }
    }
  } else if (ov.type === 'fireflies') {
    for (const p of ov.parts) {
      p.x += p.vx; p.y += p.vy; p.ph += 0.05;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      if (Math.random() < 0.01) { p.vx = (Math.random() - 0.5) * 0.5; p.vy = (Math.random() - 0.5) * 0.5; }
      const a = 0.35 + 0.65 * Math.abs(Math.sin(p.ph));
      ctx.shadowBlur = 12; ctx.shadowColor = 'rgba(180,255,120,0.9)';
      ctx.fillStyle = `rgba(205,255,150,${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  } else if (ov.type === 'matrix') {
    ctx.font = `${ov.font}px monospace`;
    const trail = 12;
    for (let i = 0; i < ov.cols.length; i++) {
      const headY = ov.cols[i];
      for (let j = 0; j < trail; j++) {
        const y = headY - j * ov.font;
        if (y < 0 || y > h) continue;
        const a = 1 - j / trail;
        ctx.fillStyle = j === 0 ? `rgba(190,255,210,${a})` : `rgba(25,255,122,${a * 0.8})`;
        ctx.fillText(String.fromCharCode(0x30a0 + ((Math.random() * 96) | 0)), i * ov.font, y);
      }
      ov.cols[i] = (headY > h + trail * ov.font && Math.random() > 0.96) ? 0 : headY + ov.font * (0.5 + ov.intensity / 150);
    }
  }
}

// ---------- Night shift (time-of-day warm tint, driven by main) ----------
const nightShiftEl = document.getElementById('nightshift');
window.wp.onNightShift((warmth) => {
  const w = Math.max(0, Math.min(1, Number(warmth) || 0));
  nightShiftEl.style.opacity = (w * 0.55).toFixed(3); // cap so it never goes fully orange
});

// ---------- Live-weather precipitation overlay (rain / snow) ----------
// Independent of the manual overlay so a user's chosen overlay isn't clobbered.
const wxCanvas = document.getElementById('wxoverlay');
const wx = { raf: 0, type: 'none', intensity: 60, parts: [], t: 0, paused: false };
function wxResize() { wxCanvas.width = window.innerWidth; wxCanvas.height = window.innerHeight; }
function wxInit() {
  const w = wxCanvas.width, h = wxCanvas.height, I = wx.intensity / 100;
  wx.parts = [];
  if (wx.type === 'rain') {
    const n = Math.round(80 + I * 320);
    for (let i = 0; i < n; i++) wx.parts.push({ x: Math.random() * w, y: Math.random() * h, len: 9 + Math.random() * 16, sp: 8 + Math.random() * 9 + I * 6 });
  } else if (wx.type === 'snow') {
    const n = Math.round(50 + I * 240);
    for (let i = 0; i < n; i++) wx.parts.push({ x: Math.random() * w, y: Math.random() * h, r: 1 + Math.random() * 2.4, sp: 0.5 + Math.random() * 1.6, drift: Math.random() * Math.PI * 2 });
  }
}
window.wp.onWeather((info) => {
  const type = info && ['rain', 'snow'].includes(info.overlay) ? info.overlay : 'none';
  wx.intensity = (info && info.intensity) || 60;
  if (type === 'none') {
    wx.type = 'none';
    if (wx.raf) cancelAnimationFrame(wx.raf);
    wx.raf = 0; wxCanvas.style.display = 'none';
    return;
  }
  wx.type = type; wxCanvas.style.display = 'block';
  wxResize(); wxInit();
  if (!wx.raf) drawWx();
});
window.addEventListener('resize', () => { if (wx.type !== 'none') { wxResize(); wxInit(); } });
function drawWx() {
  if (wx.type === 'none') return;
  wx.raf = requestAnimationFrame(drawWx);
  if (wx.paused) return;
  const ctx = wxCanvas.getContext('2d');
  const w = wxCanvas.width, h = wxCanvas.height;
  ctx.clearRect(0, 0, w, h);
  wx.t += 0.016;
  if (wx.type === 'rain') {
    ctx.strokeStyle = 'rgba(170,200,255,0.5)'; ctx.lineWidth = 1.2;
    for (const p of wx.parts) {
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 2, p.y + p.len); ctx.stroke();
      p.y += p.sp; p.x -= 0.6;
      if (p.y > h) { p.y = -p.len; p.x = Math.random() * w; }
    }
  } else if (wx.type === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const p of wx.parts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      p.y += p.sp; p.x += Math.sin(wx.t + p.drift) * 0.5;
      if (p.y > h) { p.y = -2; p.x = Math.random() * w; }
    }
  }
}
