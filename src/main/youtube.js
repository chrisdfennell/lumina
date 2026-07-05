// YouTube download via bundled yt-dlp.exe. Downloaded videos are played through
// the normal local-video path (which renders correctly behind the desktop),
// bypassing all embedding restrictions.

const { app, net } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function ytdlpPath() {
  // packaged: resources/bin; dev: <root>/bin
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', 'yt-dlp.exe'),
    path.join(__dirname, '..', '..', 'bin', 'yt-dlp.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'yt-dlp'; // fall back to PATH
}

/** Locate an ffmpeg directory so yt-dlp can merge video+audio into mp4. */
function ffmpegLocation() {
  const candidates = [
    path.join(process.resourcesPath || '', 'bin'),
    path.join(__dirname, '..', '..', 'bin'),
    'C:\\ffmpeg\\bin',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'ffmpeg.exe'))) return c;
  }
  return null;
}

function downloadsDir() {
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Existing downloaded file for a video id, or null. */
function existingDownload(videoId) {
  const dir = downloadsDir();
  try {
    // Only accept the finished, merged output (`<id>.<ext>`). Skip in-progress
    // `.part` files AND yt-dlp's per-stream fragments (`<id>.f399.mp4`,
    // `<id>.f140.m4a`) that linger when a merge never happened — playing an
    // audio-only or video-only fragment shows as a black screen.
    const fragment = new RegExp('^' + videoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.f\\d+\\.');
    const found = fs
      .readdirSync(dir)
      .find((f) => f.startsWith(videoId + '.') && !f.endsWith('.part') && !fragment.test(f));
    return found ? path.join(dir, found) : null;
  } catch {
    return null;
  }
}

/** Fetch a human title via YouTube oEmbed (no binary needed). */
function fetchTitle(videoId) {
  return new Promise((resolve) => {
    try {
      const req = net.request(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      );
      let body = '';
      req.on('response', (res) => {
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body).title || null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function buildArgs(targetUrl, outTemplate, cookiesBrowser) {
  const args = [
    // yt-dlp 2026 needs a JS runtime for YouTube; the user's Node install works.
    '--js-runtimes',
    'node',
    // Prefer H.264 (avc1) + AAC: hardware-decoded everywhere and universally
    // playable in Chromium. Only fall back to other codecs (VP9/AV1) if no H.264
    // stream exists — AV1 has no HW decode on most GPUs and would pin the CPU
    // when running perpetually as a wallpaper.
    '-f',
    'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4][vcodec^=avc1]/bestvideo[height<=1080][ext=mp4]+bestaudio/best[height<=1080][ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '-o',
    outTemplate,
    '--no-playlist',
    '--newline',
    '--no-part',
    '--retries',
    '3',
    targetUrl,
  ];
  const ff = ffmpegLocation();
  if (ff) args.push('--ffmpeg-location', ff);
  if (cookiesBrowser) args.push('--cookies-from-browser', cookiesBrowser);
  return args;
}

function runYtdlp(fileId, targetUrl, outTemplate, cookiesBrowser, onProgress) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(ytdlpPath(), buildArgs(targetUrl, outTemplate, cookiesBrowser));
    } catch (err) {
      return reject(err);
    }
    let stderr = '';
    const handle = (buf) => {
      const m = buf.toString().match(/\[download\]\s+([\d.]+)%/);
      if (m) onProgress(parseFloat(m[1]));
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      handle(d);
    });
    proc.on('error', (err) =>
      reject(new Error(/ENOENT/.test(err.message) ? 'yt-dlp not found' : err.message)),
    );
    proc.on('close', (code) => {
      if (code === 0) {
        const file = existingDownload(fileId);
        return file ? resolve(file) : reject(new Error('Download finished but the file is missing.'));
      }
      const errLine = stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('ERROR'))
        .pop();
      const e = new Error(errLine ? errLine.replace(/^ERROR:\s*/, '') : `Download failed (code ${code}).`);
      e.ageRestricted = /age|sign in to confirm/i.test(stderr);
      reject(e);
    });
  });
}

/**
 * Download a YouTube video to the downloads dir as mp4. Age-restricted videos are
 * retried using cookies from an installed browser.
 * @param {string} videoId
 * @param {(percent:number)=>void} onProgress
 * @returns {Promise<string>} path to the downloaded file
 */
async function downloadVideo(videoId, onProgress) {
  const existing = existingDownload(videoId);
  if (existing) {
    onProgress(100);
    return existing;
  }
  const outTemplate = path.join(downloadsDir(), `${videoId}.%(ext)s`);
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    return await runYtdlp(videoId, target, outTemplate, null, onProgress);
  } catch (err) {
    if (!err.ageRestricted) throw err;
    // Retry with browser cookies for age-restricted / sign-in-required videos.
    for (const browser of ['edge', 'chrome', 'firefox', 'brave']) {
      try {
        onProgress(0);
        return await runYtdlp(videoId, target, outTemplate, browser, onProgress);
      } catch (e2) {
        if (e2.ageRestricted) continue;
        throw e2;
      }
    }
    throw new Error('This video is age-restricted. Sign in to YouTube in your browser, then retry.');
  }
}

/**
 * Download a video from ANY yt-dlp-supported URL (Vimeo, X, Reddit, a direct
 * .mp4, …) to the downloads dir, keyed by a caller-supplied file id.
 * @param {string} fileId   unique id used for the output filename
 * @param {string} url      the page or media URL
 * @param {(percent:number)=>void} onProgress
 * @returns {Promise<string>} path to the downloaded file
 */
async function downloadFromUrl(fileId, url, onProgress) {
  const existing = existingDownload(fileId);
  if (existing) { onProgress(100); return existing; }
  const outTemplate = path.join(downloadsDir(), `${fileId}.%(ext)s`);
  try {
    return await runYtdlp(fileId, url, outTemplate, null, onProgress);
  } catch (err) {
    if (!err.ageRestricted) throw err;
    for (const browser of ['edge', 'chrome', 'firefox', 'brave']) {
      try { onProgress(0); return await runYtdlp(fileId, url, outTemplate, browser, onProgress); }
      catch (e2) { if (e2.ageRestricted) continue; throw e2; }
    }
    throw err;
  }
}

/** Best-effort title for any URL via a quick yt-dlp metadata call. */
function fetchTitleFromUrl(url) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(killer); resolve(v); };
    let proc;
    try {
      proc = spawn(ytdlpPath(), ['--no-playlist', '--skip-download', '--no-warnings', '--js-runtimes', 'node', '--print', '%(title)s', url]);
    } catch { return resolve(null); }
    const killer = setTimeout(() => { try { proc.kill(); } catch {} finish(null); }, 20000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => finish(null));
    proc.on('close', () => {
      const title = out.split('\n').map((l) => l.trim()).find((l) => l && l !== 'NA');
      finish(title || null);
    });
  });
}

module.exports = { downloadVideo, downloadFromUrl, fetchTitle, fetchTitleFromUrl, existingDownload, ytdlpPath };
