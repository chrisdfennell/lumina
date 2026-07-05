// Detects whether ANY monitor is fully covered by a fullscreen app window —
// e.g. a game or a fullscreen video — regardless of which window has focus.
// Used to auto-pause the wallpapers so we don't waste GPU while a game is
// running, even when the user is interacting with another monitor.

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

// Distinct proto name — koffi type names are global and wallpaper.js already
// registers 'EnumWindowsProc'.
const EnumWindowsProc = koffi.proto('__stdcall', 'FgEnumWindowsProc', 'bool', ['uint64', 'int64']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'bool', [koffi.pointer(EnumWindowsProc), 'int64']);
const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'uint64', []);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['uint64']);
const IsIconic = user32.func('__stdcall', 'IsIconic', 'bool', ['uint64']);
const GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'int32', ['uint64', 'int']);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['uint64', 'void*']);
const MonitorFromWindow = user32.func('__stdcall', 'MonitorFromWindow', 'uint64', ['uint64', 'uint']);
const GetMonitorInfoW = user32.func('__stdcall', 'GetMonitorInfoW', 'bool', ['uint64', 'void*']);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['uint64', 'void*', 'int']);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['uint64', 'void*']);
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'uint64', ['uint32', 'bool', 'uint32']);
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['uint64']);
const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['uint64', 'uint32', 'void*', 'void*']);
const DwmGetWindowAttribute = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32', ['uint64', 'uint32', 'void*', 'uint32']);

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MONITOR_DEFAULTTONEAREST = 2;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CAPTION = 0x00c00000; // titled window — a maximized app, never a fullscreen game
// Overlay hallmarks: click-through, tool window, or never-activates. Real games
// have none of these; the NVIDIA/Discord overlays and FPS counters do.
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_NOACTIVATE = 0x08000000;
const EX_OVERLAY_MASK = WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
const DWMWA_CLOAKED = 14;

// Shell surfaces that legitimately cover a monitor but are NOT "an app" — the
// desktop itself (which hosts our own wallpaper windows), the taskbar, and the
// task-view / alt-tab overlays.
const SHELL_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'WindowsDashboard',
  'XamlExplorerHostIslandWindow', // task view / alt-tab (Win11)
  'MultitaskingViewFrame',        // task view (Win10)
  'ForegroundStaging',            // alt-tab transition staging
]);

// UWP apps — including Game Pass / Store games — surface as CoreWindow, so we
// can't ignore that class wholesale. Only ignore CoreWindows that belong to
// the shell itself (Start menu, search, lock screen, input host).
const SHELL_PROCESSES = new Set([
  'explorer.exe',
  'startmenuexperiencehost.exe',
  'searchhost.exe',
  'searchapp.exe',
  'searchui.exe',
  'shellexperiencehost.exe',
  'lockapp.exe',
  'textinputhost.exe',
]);

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return buf.toString('utf16le', 0, n * 2);
}

function windowPid(hwnd) {
  const pidBuf = Buffer.alloc(4);
  GetWindowThreadProcessId(hwnd, pidBuf);
  return pidBuf.readUInt32LE(0);
}

/** Window rect covers (or exceeds) the full rect of the monitor it sits on. */
function coversItsMonitor(hwnd) {
  const wr = Buffer.alloc(16);
  if (!GetWindowRect(hwnd, wr)) return false;
  const left = wr.readInt32LE(0), top = wr.readInt32LE(4), right = wr.readInt32LE(8), bottom = wr.readInt32LE(12);

  const mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!mon) return false;
  const mi = Buffer.alloc(40);
  mi.writeUInt32LE(40, 0); // cbSize
  if (!GetMonitorInfoW(mon, mi)) return false;
  const mLeft = mi.readInt32LE(4), mTop = mi.readInt32LE(8), mRight = mi.readInt32LE(12), mBottom = mi.readInt32LE(16);

  // Fullscreen when the window covers the whole monitor rect (not just work area).
  return left <= mLeft && top <= mTop && right >= mRight && bottom >= mBottom;
}

// Suspended/hidden UWP windows report IsWindowVisible but are cloaked by DWM
// and drawn nowhere — without this check they'd read as permanent fullscreen.
function isCloaked(hwnd) {
  const buf = Buffer.alloc(4);
  const hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4);
  return hr === 0 && buf.readUInt32LE(0) !== 0;
}

/** @returns {string|null} lowercased exe name for a pid (e.g. "chrome.exe"). */
function processNameFromPid(pid) {
  if (!pid) return null;
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return null;
  try {
    const buf = Buffer.alloc(1024); // up to 512 wide chars
    const sizeBuf = Buffer.alloc(4); sizeBuf.writeUInt32LE(512, 0);
    if (QueryFullProcessImageNameW(h, 0, buf, sizeBuf)) {
      const n = sizeBuf.readUInt32LE(0);
      const full = buf.toString('utf16le', 0, n * 2);
      return full.split(/[\\/]/).pop().toLowerCase();
    }
  } catch { /* ignore */ } finally { CloseHandle(h); }
  return null;
}

/**
 * @returns {boolean} true when any visible, non-shell app window fully covers
 *   a monitor — focused or not. A game on one screen keeps this true while the
 *   user pokes around on another screen.
 */
function isFullscreenAppRunning() {
  let found = false;
  try {
    EnumWindows((hwnd) => {
      try {
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
        const cls = className(hwnd);
        if (SHELL_CLASSES.has(cls)) return true;
        const style = GetWindowLongW(hwnd, GWL_STYLE) >>> 0;
        if ((style & WS_CAPTION) === WS_CAPTION) return true;
        const ex = GetWindowLongW(hwnd, GWL_EXSTYLE) >>> 0;
        if (ex & EX_OVERLAY_MASK) return true;
        if (!coversItsMonitor(hwnd)) return true;
        if (isCloaked(hwnd)) return true;
        const pid = windowPid(hwnd);
        if (!pid || pid === process.pid) return true; // one of our own windows
        if (cls === 'Windows.UI.Core.CoreWindow') {
          const exe = processNameFromPid(pid);
          if (!exe || SHELL_PROCESSES.has(exe)) return true;
        }
        found = true;
        return false; // stop enumerating
      } catch { return true; }
    }, 0);
  } catch { /* enumeration failed — err on the side of not pausing */ }
  return found;
}

/** @returns {string|null} the lowercased exe name of the foreground window's process (e.g. "chrome.exe"). */
function foregroundProcessName() {
  const fg = GetForegroundWindow();
  if (!fg) return null;
  return processNameFromPid(windowPid(fg));
}

module.exports = { isFullscreenAppRunning, foregroundProcessName };
