// Media-source helpers shared by the main process.

const path = require('path');

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.ogv']);
const GIF_EXT = new Set(['.gif']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.avif', '.jfif']);

/** Extract a YouTube video id from any common URL shape, or null. */
function parseYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const url = input.trim();
  // Bare 11-char id
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*\bv=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Classify a local file path as 'video' | 'gif' | 'image' | null. */
function classifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (GIF_EXT.has(ext)) return 'gif';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

const MEDIA_FILTERS = [
  {
    name: 'Videos, GIFs & Images',
    extensions: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'gif',
      'png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'jfif'],
  },
  { name: 'All Files', extensions: ['*'] },
];

module.exports = { parseYouTubeId, classifyFile, MEDIA_FILTERS, VIDEO_EXT, GIF_EXT, IMAGE_EXT };
