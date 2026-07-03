// Fullscreen media player for a single monitor's wallpaper.

const videoEl = document.getElementById('video');
const videoEl2 = document.getElementById('video2');
const videoEls = [videoEl, videoEl2];
let activeVideo = videoEl; // the layer currently shown (the other is the standby)
const gifEl = document.getElementById('gif');
const gifEl2 = document.getElementById('gif2');
const gifEls = [gifEl, gifEl2];
let activeGif = gifEl;
const ytEl = document.getElementById('yt');
const webEl = document.getElementById('web');
const vizCanvas = document.getElementById('viz');
const overlayCanvas = document.getElementById('overlay');
const messageEl = document.getElementById('message');
const albumArtEl = document.getElementById('albumart');

let ytPlayer = null;
let ytApiReady = false;
let pendingYt = null;
let current = null; // last payload
// Bumped on every play(); async continuations (YT API load, deferred layer
// retirement, …) compare against it and bail if the wallpaper switched.
let playGen = 0;
let currentVolume = 0;
let currentFit = 'cover';

// How the wallpaper is scaled to the monitor. For <video>/<img> we set CSS
// object-fit directly; the YouTube iframe can't use object-fit, so it gets an
// equivalent class instead (see index.html).
function applyFit(fit) {
  currentFit = ['cover', 'contain', 'fill', 'none'].includes(fit) ? fit : 'cover';
  videoEls.forEach((v) => { v.style.objectFit = currentFit; });
  gifEls.forEach((g) => { g.style.objectFit = currentFit; });
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
    vignette: num(e.vignette, 0),
    grain: num(e.grain, 0),
    grade: e.grade || 'none',
    kenBurns: num(e.kenBurns, 0),
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
    `blur(${currentEffects.blur}px) ` +
    gradeFilter(currentEffects.grade);
  videoEls.forEach((v) => { v.style.filter = filter; });
  gifEls.forEach((g) => { g.style.filter = filter; });
  ytEl.style.filter = filter;
  webEl.style.filter = filter;
  updateVignette(currentEffects.vignette);
  updateGrain(currentEffects.grain);
  updateKenBurns(currentEffects.kenBurns);
  const rate = Math.min(4, Math.max(0.1, currentEffects.speed / 100));
  videoEls.forEach((v) => { try { v.playbackRate = rate; } catch {} });
  if (ytPlayer && ytPlayer.setPlaybackRate) {
    try { ytPlayer.setPlaybackRate(rate); } catch {}
  }
}

// ---- Color-grade presets (appended to the per-layer CSS filter) ----
function gradeFilter(grade) {
  switch (grade) {
    case 'warm': return 'sepia(0.25) saturate(1.15) hue-rotate(-8deg) contrast(1.03)';
    case 'cool': return 'saturate(1.1) hue-rotate(12deg) brightness(1.02)';
    case 'noir': return 'grayscale(1) contrast(1.25) brightness(0.98)';
    case 'vintage': return 'sepia(0.45) contrast(0.92) saturate(0.9) brightness(1.05)';
    case 'vibrant': return 'saturate(1.5) contrast(1.1)';
    default: return '';
  }
}

// ---- Vignette (radial darkening at the edges) ----
const vignetteEl = document.getElementById('vignette');
function updateVignette(amount) {
  const a = Math.max(0, Math.min(100, amount || 0)) / 100;
  vignetteEl.style.opacity = a.toFixed(3);
}

// ---- Film grain (small noise texture regenerated a few times a second) ----
const grainEl = document.getElementById('grain');
const grain = { raf: 0, on: false, last: 0 };
function updateGrain(amount) {
  const a = Math.max(0, Math.min(100, amount || 0)) / 100;
  grainEl.style.opacity = (a * 0.5).toFixed(3);
  const want = a > 0;
  if (want && !grain.on) { grain.on = true; grainEl.style.display = 'block'; drawGrain(); }
  else if (!want && grain.on) { grain.on = false; grainEl.style.display = 'none'; if (grain.raf) cancelAnimationFrame(grain.raf); grain.raf = 0; }
}
function drawGrain(now) {
  if (!grain.on) return;
  grain.raf = requestAnimationFrame(drawGrain);
  if (grain.paused) return;
  if (now && now - grain.last < 60) return; // ~16fps is plenty for grain
  grain.last = now || 0;
  const ctx = grainEl.getContext('2d');
  const w = grainEl.width, h = grainEl.height;
  if (!grain.img || grain.img.width !== w || grain.img.height !== h) grain.img = ctx.createImageData(w, h);
  const d = grain.img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(grain.img, 0, 0);
}

// ---- Ken Burns slow pan/zoom for still images ----
function updateKenBurns(amount) {
  const a = Math.max(0, Math.min(100, amount || 0));
  const on = a > 0 && (current && (current.type === 'image' || current.type === 'gif'));
  gifEls.forEach((g) => g.classList.remove('kenburns'));
  if (on) {
    activeGif.style.setProperty('--kb-zoom', (1 + a / 100 * 0.18).toFixed(3));
    activeGif.classList.add('kenburns');
  }
}

function hideGifs() {
  gifEls.forEach((g) => { g.style.display = 'none'; g.style.opacity = '1'; g.classList.remove('kenburns'); });
}
function hideNonVideo() {
  hideGifs();
  ytEl.style.display = 'none';
  webEl.style.display = 'none';
  vizCanvas.style.display = 'none';
  messageEl.style.display = 'none';
  albumArtEl.style.display = 'none';
}
// Like hideNonVideo but leaves the gif layers alone (image crossfade manages them).
function hideForImage() {
  ytEl.style.display = 'none';
  webEl.style.display = 'none';
  vizCanvas.style.display = 'none';
  messageEl.style.display = 'none';
  albumArtEl.style.display = 'none';
}
function hideAll() {
  videoEls.forEach((v) => { v.style.display = 'none'; v.style.opacity = '1'; });
  hideNonVideo();
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
  let stream = null, ctx = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    ctx = new AudioContext();
    try { await ctx.resume(); } catch {}
    // Every ref was released while the capture was still starting — tear down
    // now, or the capture + rAF loop would run forever with nothing to stop it.
    if (audio.refs === 0) {
      stream.getTracks().forEach((t) => t.stop());
      try { ctx.close(); } catch {}
      return;
    }
    audio.stream = stream;
    audio.ctx = ctx;
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
    try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (ctx) ctx.close(); } catch {}
    console.log('[wp] audio capture unavailable: ' + err);
  } finally {
    audio.starting = false;
  }
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
const viz = { raf: 0, paused: false, active: false, t: 0, vals: new Float32Array(64), grad: null };

// 1px-wide strip of the bar gradient, stretched to each bar's height at draw
// time — same look as a per-bar createLinearGradient without allocating 64
// gradients per frame.
function makeVizGrad(px) {
  const c = document.createElement('canvas');
  c.width = 1; c.height = Math.max(1, Math.round(px));
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, c.height, 0, 0);
  grad.addColorStop(0, '#3a1c71');
  grad.addColorStop(0.5, '#7c4dff');
  grad.addColorStop(1, '#23d5ab');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, c.height);
  return c;
}

function vizResize() {
  vizCanvas.width = window.innerWidth;
  vizCanvas.height = window.innerHeight;
  viz.grad = makeVizGrad(vizCanvas.height * 0.72);
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

function drawViz(now) {
  if (!viz.active) return;
  viz.raf = requestAnimationFrame(drawViz);
  if (viz.paused || !gate('viz', now)) return;
  const ctx = vizCanvas.getContext('2d');
  const w = vizCanvas.width, h = vizCanvas.height;
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, w, h);
  viz.t += 0.016;

  const N = 64;
  const vals = viz.vals;
  if (audio.analyser) {
    audio.analyser.getByteFrequencyData(audio.data);
    for (let i = 0; i < N; i++) vals[i] = Math.pow(audio.data[i] / 255, 1.4);
  } else {
    // Idle: gentle synthetic motion so it isn't a dead screen with no audio.
    for (let i = 0; i < N; i++) vals[i] = 0.12 + 0.1 * Math.abs(Math.sin(viz.t * 1.5 + i * 0.4)) * (1 - i / N);
  }

  if (!viz.grad) viz.grad = makeVizGrad(h * 0.72);
  const barW = w / (N * 2);
  for (let i = 0; i < N; i++) {
    const bh = vals[i] * h * 0.72;
    if (bh < 1 || barW <= 2) continue;
    ctx.drawImage(viz.grad, w / 2 + i * barW + 1, h - bh, barW - 2, bh);          // right
    ctx.drawImage(viz.grad, w / 2 - (i + 1) * barW + 1, h - bh, barW - 2, bh);    // mirrored left
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

// Now-playing album-art wallpaper. The art + track text are pushed separately
// from main (wallpaper:albumart) since they change as songs change.
function playAlbumArt(payload) {
  destroyYt();
  stopVideo();
  stopWeb();
  stopViz();
  hideAll();
  applyEffects(payload.effects);
  albumArtEl.style.display = 'block';
}
window.wp.onAlbumArt((d) => {
  const aaBg = document.getElementById('aa-bg');
  const aaArt = document.getElementById('aa-art');
  const aaTitle = document.getElementById('aa-title');
  const aaArtist = document.getElementById('aa-artist');
  // Escape quotes/backslashes so the URL can't break out of the url("…") token.
  if (d.artUrl) { aaBg.style.backgroundImage = `url("${String(d.artUrl).replace(/["\\]/g, '\\$&')}")`; aaArt.src = d.artUrl; }
  else { aaBg.style.backgroundImage = 'linear-gradient(135deg,#2a1a4a,#0a0c14)'; aaArt.removeAttribute('src'); }
  aaTitle.textContent = d.title || 'Nothing playing';
  aaArtist.textContent = d.artist || '';
  // New album art → new dominant color (wait for the <img> to decode).
  if (d.artUrl && current && current.type === 'albumart') setTimeout(sampleAccent, 800);
});

function stopVideo() {
  videoEls.forEach((v) => {
    try { v.pause(); v.removeAttribute('src'); v.load(); v.style.opacity = '1'; fxClear(v); } catch {}
  });
}

// ---- Transition styles (fade / slide / zoom / dip-to-black) ----
// The incoming layer starts in the style's "enter" state and settles to rest;
// slide/zoom use the individual translate/scale CSS properties so they compose
// with (not clobber) the parallax transform.
const txStyle = (payload) => payload.transition || (payload.crossfade !== false ? 'fade' : 'none');
function fxEnter(el, style) {
  el.style.opacity = '0';
  if (style === 'slide') el.style.translate = '5% 0px';
  else if (style === 'zoom') el.style.scale = '1.1';
}
function fxSettle(el) {
  el.style.opacity = '1';
  el.style.translate = '0px 0px';
  el.style.scale = '1';
}
function fxClear(el) { el.style.translate = ''; el.style.scale = ''; }

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
  // Only the active video carries audio; the standby layer stays muted.
  videoEls.forEach((vid) => {
    vid.muted = muted || vid !== activeVideo;
    vid.volume = Math.max(0, Math.min(1, v || 0));
  });
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
  hideForImage();
  applyFit(payload.fit);
  applyEffects(payload.effects);

  const gen = playGen;
  // Let a visible photo participate in the transition: it fades out (it sits
  // above the video layers) once the incoming video has a frame, instead of
  // being hard-cut before the video even starts.
  const gifOut = gifEls.filter((g) => g.style.display === 'block');
  const fadeGifs = payload.crossfade !== false && gifOut.length > 0;
  if (!fadeGifs) hideGifs();

  const incoming = (activeVideo === videoEl) ? videoEl2 : videoEl;
  const outgoing = activeVideo;
  const style = txStyle(payload);
  // Only transition when there's an actually-playing video to change over from.
  const fade = style !== 'none' && outgoing !== incoming
    && outgoing.style.display === 'block' && !outgoing.paused && outgoing.currentTime > 0;

  incoming.src = payload.src;
  incoming.loop = true;
  incoming._loopStart = payload.loopStart || 0;
  incoming._loopEnd = payload.loopEnd || 0;
  incoming.style.objectFit = currentFit;
  incoming.style.zIndex = '2';
  fxClear(incoming);
  if (fade) fxEnter(incoming, style); else incoming.style.opacity = '1';
  incoming.style.display = 'block';
  outgoing.style.zIndex = '1';
  activeVideo = incoming;
  applyVolume(currentVolume);
  // Dip-to-black: darken the old layer first, then reveal over the black gap.
  if (fade && style === 'dip') outgoing.style.opacity = '0';

  const retireOutgoing = () => {
    // Don't retire the layer if a newer switch has since reused it as the active one.
    if (outgoing === incoming || outgoing === activeVideo) return;
    try { outgoing.pause(); outgoing.removeAttribute('src'); outgoing.load(); } catch {}
    outgoing.style.display = 'none';
    outgoing.style.opacity = '1';
    fxClear(outgoing);
  };

  incoming.play().then(
    () => console.log('[wp] video play() ok'),
    (err) => console.log('[wp] video play() rejected: ' + err),
  );

  if (fade) {
    // Reveal the incoming layer once it has a first frame, then retire the old.
    const begin = () => setTimeout(() => { fxSettle(incoming); setTimeout(retireOutgoing, 650); }, style === 'dip' ? 350 : 0);
    incoming.addEventListener('playing', begin, { once: true });
    setTimeout(() => { if (incoming.style.opacity === '0') begin(); }, 600);
  } else {
    retireOutgoing();
  }

  if (fadeGifs) {
    let gifFadeStarted = false;
    const fadeOutGifs = () => {
      if (gifFadeStarted || gen !== playGen) return;
      gifFadeStarted = true;
      gifOut.forEach((g) => { g.style.opacity = '0'; });
      setTimeout(() => { if (gen === playGen) hideGifs(); }, 650);
    };
    incoming.addEventListener('playing', fadeOutGifs, { once: true });
    setTimeout(fadeOutGifs, 800); // fallback if 'playing' never fires
  }
}
videoEls.forEach((vid) => {
  vid.addEventListener('loadeddata', () => {
    // playbackRate resets when a new source loads — re-apply the current speed.
    try { vid.playbackRate = Math.min(4, Math.max(0.1, currentEffects.speed / 100)); } catch {}
    // Jump to the loop-in point so trimmed videos never show their opening.
    if (vid._loopStart > 0 && vid.currentTime < vid._loopStart) {
      try { vid.currentTime = vid._loopStart; } catch {}
    }
  });
  // Loop trim: wrap back to loopStart at loopEnd (and after a native loop to 0).
  vid.addEventListener('timeupdate', () => {
    const start = vid._loopStart || 0;
    try {
      if (vid._loopEnd > start && vid.currentTime >= vid._loopEnd) vid.currentTime = start;
      else if (start > 0 && vid.currentTime < start - 0.1 && !vid.seeking) vid.currentTime = start;
    } catch {}
  });
  vid.addEventListener('error', () => console.log('[wp] video ERROR ' + (vid.error && vid.error.code)));
});

// Shared image/gif display with a two-layer crossfade so playlist switches
// between photos dissolve instead of hard-cutting.
function showOnGif(payload, src) {
  destroyYt();
  stopWeb();
  stopViz();
  hideForImage();
  applyFit(payload.fit);

  const gen = playGen;
  const style = txStyle(payload);
  // Let a playing video participate in the fade: the incoming image (above the
  // video layers) dissolves in over it, and the video is stopped only after the
  // reveal — instead of hard-cutting to black before the image has loaded.
  const videoLive = videoEls.some((v) => v.style.display === 'block' && !v.paused && v.currentTime > 0);
  const fadeVideo = style !== 'none' && videoLive;
  if (!fadeVideo) stopVideo();

  const incoming = (activeGif === gifEl) ? gifEl2 : gifEl;
  const outgoing = activeGif;
  const fade = fadeVideo ||
    (style !== 'none' && outgoing !== incoming && outgoing.style.display === 'block');

  incoming.style.zIndex = '2';
  outgoing.style.zIndex = '1';
  fxClear(incoming);
  if (fade) fxEnter(incoming, style); else incoming.style.opacity = '1';
  incoming.style.display = 'block';
  activeGif = incoming;
  applyEffects(payload.effects); // filters on both layers + Ken Burns on the new active one
  // Dip-to-black: darken the outgoing layers first, reveal over the black gap.
  if (fade && style === 'dip') {
    if (outgoing !== incoming) outgoing.style.opacity = '0';
    if (fadeVideo) videoEls.forEach((v) => { if (v.style.display === 'block') v.style.opacity = '0'; });
  }

  const retire = () => {
    if (outgoing === incoming || outgoing === activeGif) return;
    outgoing.style.display = 'none';
    outgoing.style.opacity = '1';
    outgoing.classList.remove('kenburns');
    outgoing.removeAttribute('src');
    fxClear(outgoing);
  };
  const reveal = () => {
    setTimeout(() => {
      fxSettle(incoming);
      const finish = () => { retire(); if (fadeVideo && gen === playGen) stopVideo(); };
      if (fade) setTimeout(finish, 650); else finish();
    }, fade && style === 'dip' ? 350 : 0);
  };

  incoming.onload = reveal;
  incoming.onerror = () => console.log('[wp] image load error');
  incoming.src = src;
  if (incoming.complete && incoming.naturalWidth) reveal(); // cached / instant
}

function playGif(payload) {
  // reload with a cache-buster to restart the animation from frame 0
  showOnGif(payload, payload.src + (payload.src.includes('?') ? '&' : '?') + 't=' + Date.now());
}

function playImage(payload) {
  showOnGif(payload, payload.src); // static image — no cache-buster needed
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
const ytApiWaiters = [];
function loadYtApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) { ytApiReady = true; return resolve(); }
    // Queue every caller — reassigning onYouTubeIframeAPIReady per call would
    // strand earlier pending promises.
    ytApiWaiters.push(resolve);
    if (!window.onYouTubeIframeAPIReady) {
      window.onYouTubeIframeAPIReady = () => { ytApiReady = true; ytApiWaiters.splice(0).forEach((r) => r()); };
    }
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
  const gen = playGen;
  loadYtApi().then(() => {
    if (gen !== playGen) return; // wallpaper switched while the API loaded
    try {
      ytPlayer = new YT.Player(iframe, {
        events: {
          onReady: () => { if (gen === playGen) applyVolume(payload.volume ?? 0); },
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

// ---- Accent sampling: report the wallpaper's dominant color to the host ----
// Drawn media only (video / image / gif / album art); shader and web wallpapers
// can't be sampled across the iframe boundary. Remote images may taint the
// canvas — the try/catch simply skips those.
const accentCanvas = document.createElement('canvas');
accentCanvas.width = accentCanvas.height = 24;
function sampleAccent() {
  if (!current) return;
  let src = null;
  if (current.type === 'video' && activeVideo.videoWidth) src = activeVideo;
  else if ((current.type === 'gif' || current.type === 'image') && activeGif.naturalWidth) src = activeGif;
  else if (current.type === 'albumart') {
    const art = document.getElementById('aa-art');
    if (art && art.naturalWidth) src = art;
  }
  if (!src) return;
  try {
    const S = 24;
    const ctx = accentCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, S, S);
    const { data } = ctx.getImageData(0, 0, S, S);
    // "Vibrant" pick: prefer saturated mid-brightness pixels, average the top 10%.
    const px = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0;
      const lum = max / 255;
      px.push({ r, g, b, score: sat * (lum > 0.25 && lum < 0.95 ? 1 : 0.2) + lum * 0.05 });
    }
    px.sort((a, b) => b.score - a.score);
    const top = px.slice(0, Math.max(1, Math.floor(px.length * 0.1)));
    const avg = (k) => Math.round(top.reduce((s, p) => s + p[k], 0) / top.length);
    const hex = '#' + [avg('r'), avg('g'), avg('b')].map((v) => v.toString(16).padStart(2, '0')).join('');
    window.wp.sendAccent(hex);
  } catch { /* tainted canvas (remote image) — skip */ }
}
window.wp.onAccentRequest(() => sampleAccent());

function play(payload) {
  console.log('[wp] play received: ' + (payload ? payload.type + ' ' + (payload.videoId || payload.src) : 'null'));
  playGen++;
  current = payload;
  // Sample once the new media has a frame on screen.
  const gen = playGen;
  setTimeout(() => { if (gen === playGen) sampleAccent(); }, 1500);
  if (!payload) { hideAll(); stopVideo(); destroyYt(); stopWeb(); stopViz(); return; }
  if (payload.type === 'video') playVideo(payload);
  else if (payload.type === 'gif') playGif(payload);
  else if (payload.type === 'image') playImage(payload);
  else if (payload.type === 'web') playWeb(payload);
  else if (payload.type === 'viz') playViz(payload);
  else if (payload.type === 'albumart') playAlbumArt(payload);
  else if (payload.type === 'youtube') playYouTube(payload);
}

window.wp.onPlay(play);
// Target the web-wallpaper frame's real origin when it has one; file:-based
// built-in players have an opaque origin, where only '*' can match.
function webTargetOrigin() {
  try {
    const u = new URL(webEl.src);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : '*';
  } catch { return '*'; }
}
function messageWeb(msg) {
  try { if (webEl.contentWindow) webEl.contentWindow.postMessage(msg, webTargetOrigin()); } catch {}
}

// A custom-shader player asks its host for its GLSL once it has loaded; reply
// with the code carried on the current payload.
window.addEventListener('message', (e) => {
  if (e.source !== webEl.contentWindow) return; // only our wallpaper frame — not e.g. the YouTube embed
  const d = e.data;
  if (d && d.type === 'lumina:shaderRequest' && current && current.shaderCode) {
    messageWeb({ type: 'lumina:shaderSource', code: current.shaderCode });
  }
});
window.wp.onPause(() => {
  videoEls.forEach((v) => { try { v.pause(); } catch {} });
  if (ytPlayer && ytPlayer.pauseVideo) try { ytPlayer.pauseVideo(); } catch {}
  messageWeb('pause');
  viz.paused = true;
  ov.paused = true;
  wx.paused = true;
  grain.paused = true;
  audio.paused = true;
});
window.wp.onResume(() => {
  if (current && current.type === 'video') activeVideo.play().catch(() => {});
  if (ytPlayer && ytPlayer.playVideo) try { ytPlayer.playVideo(); } catch {}
  messageWeb('resume');
  viz.paused = false;
  ov.paused = false;
  wx.paused = false;
  grain.paused = false;
  audio.paused = false;
});
window.wp.onVolume((v) => applyVolume(v));
window.wp.onFit((f) => applyFit(f));
window.wp.onEffects((eff) => applyEffects(eff));

// Combined transform on the wallpaper layer = mouse-parallax offset + zoom,
// multiplied by the audio-reactive pulse. Both inputs feed the same transform.
const parallaxEls = [videoEl, videoEl2, gifEl, gifEl2, webEl];
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
  // Feed the level into shader/web wallpapers so they can react internally
  // (u_audio uniform) — scaled by the audio-reactive amount.
  if (amt > 0 && current && current.type === 'web') {
    messageWeb({ type: 'lumina:audio', level: (audio.level || 0) * amt });
  }
}
window.wp.onCursor((c) => {
  applyParallax(c);
  // Forward to the web iframe (depth-parallax wallpaper reads this; others ignore).
  messageWeb({ type: 'lumina:cursor', point: c ? { x: c.x, y: c.y } : null });
});

// ---- Power profile: framerate cap (gates the host's animated loops) +
// render scale, both forwarded to the shader/canvas iframe. ----
let frameMinMs = 0; // 0 = uncapped
const frameLast = {};
function gate(key, now) {
  if (!frameMinMs) return true;
  now = now || performance.now();
  if (now - (frameLast[key] || 0) < frameMinMs - 1) return false;
  frameLast[key] = now;
  return true;
}
window.wp.onPower((p) => {
  const fps = p && p.fps > 0 ? p.fps : 0;
  frameMinMs = fps > 0 ? 1000 / fps : 0;
  messageWeb({ type: 'lumina:power', fps, scale: (p && p.scale) || 1 });
});

// ---------- Info widgets (clock / date / weather / system stats) ----------
const widgetsEl = document.getElementById('widgets');
let widgetCfg = null;
let widgetData = { cpu: 0, mem: 0, weather: null };
let clockTimer = null;

function renderWidgets() {
  const c = widgetCfg;
  const anyOn = c && (c.clock || c.date || c.weather || c.stats || c.graphs || c.nowplaying || c.battery || c.net || c.countdown);
  if (!anyOn) { widgetsEl.style.display = 'none'; return; }
  widgetsEl.className = 'pos-' + (c.position || 'top-left');
  // Theming: scale (zoom keeps corner anchoring intact), color, opacity,
  // and a free position as % offsets when position is 'custom'.
  widgetsEl.style.zoom = String((c.size || 100) / 100);
  widgetsEl.style.color = c.color || '#ffffff';
  widgetsEl.style.opacity = String((c.opacity != null ? c.opacity : 100) / 100);
  if (c.position === 'custom') {
    widgetsEl.style.left = (c.posX != null ? c.posX : 4) + '%';
    widgetsEl.style.top = (c.posY != null ? c.posY : 6) + '%';
    widgetsEl.style.right = 'auto'; widgetsEl.style.bottom = 'auto';
  } else {
    widgetsEl.style.left = widgetsEl.style.top = widgetsEl.style.right = widgetsEl.style.bottom = '';
  }
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
    // temp/cond echo the raw wttr.in response body — escape like now-playing.
    html += `<div class="w-weather">${w ? `${escapeHtml(w.temp)} · ${escapeHtml(w.cond)}` : '…'}</div>`;
  }
  if (c.countdown && c.countdownTo) {
    const target = new Date(c.countdownTo);
    const ms = target - now;
    const label = c.countdownLabel ? escapeHtml(c.countdownLabel) + ' · ' : '';
    let text;
    if (!Number.isFinite(ms)) text = '';
    else if (ms <= 0) text = `${label}🎉`;
    else {
      const d = Math.floor(ms / 86400000);
      const hh = String(Math.floor(ms / 3600000) % 24).padStart(2, '0');
      const mm = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
      const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
      text = `${label}${d > 0 ? d + 'd ' : ''}${hh}:${mm}:${ss}`;
    }
    if (text) html += `<div class="w-countdown">${text}</div>`;
  }
  if (c.stats) {
    let s = `CPU ${widgetData.cpu}%&nbsp;&nbsp;·&nbsp;&nbsp;RAM ${widgetData.mem}%`;
    if (widgetData.gpu != null) s += `&nbsp;&nbsp;·&nbsp;&nbsp;GPU ${widgetData.gpu}%`;
    html += `<div class="w-stats">${s}</div>`;
  }
  if (c.battery && batteryInfo) {
    const pct = Math.round(batteryInfo.level * 100);
    html += `<div class="w-battery">${pct <= 20 && !batteryInfo.charging ? '🪫' : '🔋'} ${pct}%${batteryInfo.charging ? ' ⚡' : ''}</div>`;
  }
  if (c.net && widgetData.net) {
    const fmt = (bps) => {
      if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
      if (bps >= 1024) return (bps / 1024).toFixed(0) + ' KB/s';
      return Math.round(bps) + ' B/s';
    };
    html += `<div class="w-net">↓ ${fmt(widgetData.net.down)}&nbsp;&nbsp;↑ ${fmt(widgetData.net.up)}</div>`;
  }
  if (c.graphs) {
    html += `<canvas id="w-graph" class="w-graph" width="210" height="48"></canvas>`;
  }
  if (c.nowplaying) {
    const np = widgetData.nowPlaying;
    html += `<div class="w-np">${np ? `♪ ${escapeHtml(np.title)}${np.artist ? ' — ' + escapeHtml(np.artist) : ''}` : '♪ —'}</div>`;
  }
  widgetsEl.innerHTML = html;
  widgetsEl.style.display = 'block';
  if (c.graphs) drawStatGraph();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// Rolling CPU/RAM/GPU sparklines drawn from recent samples.
const statHist = { cpu: [], mem: [], gpu: [] };
function drawStatGraph() {
  const cv = document.getElementById('w-graph');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const line = (arr, color) => {
    if (arr.length < 2) return;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = (i / (arr.length - 1)) * w;
      const y = h - (Math.max(0, Math.min(100, v)) / 100) * (h - 2) - 1;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  };
  line(statHist.cpu, 'rgba(124,77,255,0.95)');
  line(statHist.mem, 'rgba(35,213,171,0.95)');
  if (widgetData.gpu != null) line(statHist.gpu, 'rgba(255,138,38,0.95)');
  ctx.font = '10px "Segoe UI", sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`CPU ${widgetData.cpu}%`, 2, 11);
  ctx.fillText(`RAM ${widgetData.mem}%`, 72, 11);
  if (widgetData.gpu != null) ctx.fillText(`GPU ${widgetData.gpu}%`, 142, 11);
}

// Battery state via the renderer-local Battery Status API — no polling needed.
let batteryInfo = null;
let batteryHooked = false;
function hookBattery() {
  if (batteryHooked || !navigator.getBattery) return;
  batteryHooked = true;
  navigator.getBattery().then((b) => {
    const update = () => { batteryInfo = { level: b.level, charging: b.charging }; renderWidgets(); };
    b.addEventListener('levelchange', update);
    b.addEventListener('chargingchange', update);
    update();
  }).catch(() => {});
}

window.wp.onWidgets((cfg) => {
  widgetCfg = cfg;
  if (cfg && cfg.battery) hookBattery();
  renderWidgets();
  if (clockTimer) clearInterval(clockTimer);
  // The 1s tick drives the clock seconds AND a live countdown.
  if (cfg && (cfg.clock || (cfg.countdown && cfg.countdownTo))) clockTimer = setInterval(renderWidgets, 1000);
});
window.wp.onWidgetData((d) => {
  widgetData = { ...widgetData, ...d };
  if (typeof d.cpu === 'number') { statHist.cpu.push(d.cpu); if (statHist.cpu.length > 60) statHist.cpu.shift(); }
  if (typeof d.mem === 'number') { statHist.mem.push(d.mem); if (statHist.mem.length > 60) statHist.mem.shift(); }
  if (typeof d.gpu === 'number') { statHist.gpu.push(d.gpu); if (statHist.gpu.length > 60) statHist.gpu.shift(); }
  renderWidgets();
});

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
  } else if (ov.type === 'leaves' || ov.type === 'sakura') {
    const n = Math.round((ov.type === 'sakura' ? 25 : 20) + I * (ov.type === 'sakura' ? 110 : 90));
    for (let i = 0; i < n; i++) ov.parts.push({
      x: Math.random() * w, y: Math.random() * h,
      r: (ov.type === 'sakura' ? 3 : 5) + Math.random() * (ov.type === 'sakura' ? 3 : 5),
      sp: 0.5 + Math.random() * 1.1,
      sway: Math.random() * Math.PI * 2,
      rot: Math.random() * Math.PI * 2,
      rs: (Math.random() - 0.5) * 0.04,
      hue: ov.type === 'sakura' ? 335 + Math.random() * 20 : 15 + Math.random() * 35,
    });
  } else if (ov.type === 'embers') {
    const n = Math.round(25 + I * 130);
    for (let i = 0; i < n; i++) ov.parts.push({
      x: Math.random() * w, y: h + Math.random() * h,
      r: 1 + Math.random() * 2.2,
      sp: 0.6 + Math.random() * 1.8,
      sway: Math.random() * Math.PI * 2,
      ph: Math.random() * Math.PI * 2,
    });
  } else if (ov.type === 'stars') {
    const n = Math.round(60 + I * 220);
    for (let i = 0; i < n; i++) ov.parts.push({
      x: Math.random() * w, y: Math.random() * h * 0.85,
      r: 0.5 + Math.random() * 1.3,
      ph: Math.random() * Math.PI * 2,
    });
    ov.shooters = []; // occasional shooting-star streaks
  }
}

function updateOverlay(type, intensity) {
  type = ['rain', 'snow', 'fireflies', 'matrix', 'leaves', 'sakura', 'embers', 'stars'].includes(type) ? type : 'none';
  if (intensity <= 0) type = 'none';
  // Unchanged → don't reseed the particles (applyEffects calls this on every
  // effects change; reseeding makes rain/snow visibly jump during slider drags).
  if (type === ov.type && (type === 'none' || (intensity || 0) === ov.intensity)) return;
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

function drawOverlay(now) {
  if (ov.type === 'none') return;
  ov.raf = requestAnimationFrame(drawOverlay);
  if (ov.paused || !gate('ov', now)) return;
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
  } else if (ov.type === 'leaves' || ov.type === 'sakura') {
    const sakura = ov.type === 'sakura';
    for (const p of ov.parts) {
      p.sway += 0.02; p.rot += p.rs;
      p.y += p.sp; p.x += Math.sin(p.sway) * (sakura ? 0.8 : 1.1);
      if (p.y > h + p.r * 2) { p.y = -p.r * 2; p.x = Math.random() * w; }
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = sakura
        ? `hsla(${p.hue}, 85%, 82%, 0.9)`
        : `hsla(${p.hue}, 70%, 45%, 0.85)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, p.r, p.r * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (ov.type === 'embers') {
    for (const p of ov.parts) {
      p.sway += 0.03; p.ph += 0.06;
      p.y -= p.sp; p.x += Math.sin(p.sway) * 0.6;
      if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
      const a = 0.35 + 0.55 * Math.abs(Math.sin(p.ph));
      ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(255,120,30,0.9)';
      ctx.fillStyle = `rgba(255,${140 + ((p.ph * 40) % 60) | 0},40,${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  } else if (ov.type === 'stars') {
    // Twinkling field + the occasional shooting star.
    ctx.fillStyle = 'rgba(255,255,255,1)';
    for (const p of ov.parts) {
      p.ph += 0.03;
      ctx.globalAlpha = 0.25 + 0.6 * Math.abs(Math.sin(p.ph));
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (Math.random() < 0.004 * (0.5 + ov.intensity / 100) && ov.shooters.length < 3) {
      const x = Math.random() * w * 0.8;
      ov.shooters.push({ x, y: Math.random() * h * 0.35, vx: 9 + Math.random() * 7, vy: 3 + Math.random() * 3, life: 1 });
    }
    for (const s of ov.shooters) {
      s.x += s.vx; s.y += s.vy; s.life -= 0.02;
      const grad = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 8, s.y - s.vy * 8);
      grad.addColorStop(0, `rgba(255,255,255,${Math.max(0, s.life)})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = grad; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 8, s.y - s.vy * 8); ctx.stroke();
    }
    ov.shooters = ov.shooters.filter((s) => s.life > 0 && s.x < w + 200 && s.y < h + 200);
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
window.addEventListener('resize', () => {
  if (wx.type !== 'none') { wxResize(); wxInit(); }
  if (ov.type !== 'none') { ovResize(); ovInit(); }
});
function drawWx(now) {
  if (wx.type === 'none') return;
  wx.raf = requestAnimationFrame(drawWx);
  if (wx.paused || !gate('wx', now)) return;
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
