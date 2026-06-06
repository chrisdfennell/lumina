// Detects whether the focused (foreground) window is a fullscreen app covering
// a whole monitor — e.g. a game or a fullscreen video. Used to auto-pause the
// wallpaper so we don't waste GPU behind something the user can't see anyway.

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'uint64', []);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['uint64', 'void*']);
const MonitorFromWindow = user32.func('__stdcall', 'MonitorFromWindow', 'uint64', ['uint64', 'uint']);
const GetMonitorInfoW = user32.func('__stdcall', 'GetMonitorInfoW', 'bool', ['uint64', 'void*']);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['uint64', 'void*', 'int']);

const MONITOR_DEFAULTTONEAREST = 2;

// Shell surfaces that legitimately cover a monitor but are NOT "an app" — the
// desktop itself, the taskbar, and the Start/search shell. Ignore these.
const SHELL_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'WindowsDashboard',
  'Windows.UI.Core.CoreWindow', // Start menu / search overlay
]);

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return buf.toString('utf16le', 0, n * 2);
}

/**
 * @returns {boolean} true when the foreground window fills (or exceeds) the
 *   bounds of the monitor it sits on and isn't a desktop/shell surface.
 */
function isFullscreenAppForeground() {
  const fg = GetForegroundWindow();
  if (!fg) return false;
  const cls = className(fg);
  if (SHELL_CLASSES.has(cls)) return false;

  const wr = Buffer.alloc(16);
  if (!GetWindowRect(fg, wr)) return false;
  const left = wr.readInt32LE(0), top = wr.readInt32LE(4), right = wr.readInt32LE(8), bottom = wr.readInt32LE(12);

  const mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
  if (!mon) return false;
  const mi = Buffer.alloc(40);
  mi.writeUInt32LE(40, 0); // cbSize
  if (!GetMonitorInfoW(mon, mi)) return false;
  const mLeft = mi.readInt32LE(4), mTop = mi.readInt32LE(8), mRight = mi.readInt32LE(12), mBottom = mi.readInt32LE(16);

  // Fullscreen when the window covers the whole monitor rect (not just work area).
  return left <= mLeft && top <= mTop && right >= mRight && bottom >= mBottom;
}

module.exports = { isFullscreenAppForeground };
