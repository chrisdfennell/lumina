// Win32 "live wallpaper" engine.
//
// Windows draws the desktop wallpaper in a window of class "WorkerW" (or on
// "Progman" itself). By asking Progman to spawn a WorkerW and then re-parenting
// our own borderless windows *into* that WorkerW, our content renders behind the
// desktop icons but above the static wallpaper — i.e. it becomes a live wallpaper.
//
// All HWNDs are handled as 64-bit unsigned integers (uintptr) normalized to
// BigInt so we never juggle koffi pointer objects across the FFI boundary.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

// HWND / handles as pointer-sized unsigned ints.
const FindWindowW = user32.func('__stdcall', 'FindWindowW', 'uint64', ['str16', 'str16']);
const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', 'uint64', ['uint64', 'uint64', 'str16', 'str16']);
const SendMessageTimeoutW = user32.func('__stdcall', 'SendMessageTimeoutW', 'int64', ['uint64', 'uint', 'uint64', 'int64', 'uint', 'uint', 'uint64']);
const SetParent = user32.func('__stdcall', 'SetParent', 'uint64', ['uint64', 'uint64']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', ['uint64', 'int']);
const GetParent = user32.func('__stdcall', 'GetParent', 'uint64', ['uint64']);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', ['uint64']);
const GetAncestor = user32.func('__stdcall', 'GetAncestor', 'uint64', ['uint64', 'uint']);
const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'int64', ['uint64', 'int']);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64']);

// EnumWindows callback prototype: BOOL CALLBACK proc(HWND, LPARAM)
const EnumWindowsProc = koffi.proto('__stdcall', 'EnumWindowsProc', 'bool', ['uint64', 'int64']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'bool', ['void*', 'int64']);

// --- constants ---
const WM_SPAWN_WORKERW = 0x052c;
const SMTO_ABORTIFHUNG = 0x0002;

const SWP_NOACTIVATE = 0x0010;
const SWP_NOZORDER = 0x0004;
const SWP_SHOWWINDOW = 0x0040;

const SW_SHOW = 5;

const GWL_STYLE = -16;
const WS_CHILD = 0x40000000n;
const WS_POPUP = 0x80000000n;
const GA_PARENT = 1;

const toBig = (v) => (v == null ? 0n : BigInt(v));

let cachedWorkerW = 0n;

/**
 * Ask the desktop to create the WorkerW layer and locate the one that sits
 * behind the desktop icons.
 * @returns {bigint} the WorkerW handle (or Progman as a fallback), 0n on failure.
 */
function resolveWallpaperHost() {
  const progman = toBig(FindWindowW('Progman', null));
  if (progman === 0n) return 0n;

  // Nudge Progman into spawning the WorkerW behind the icons.
  SendMessageTimeoutW(progman, WM_SPAWN_WORKERW, 0n, 0n, SMTO_ABORTIFHUNG, 1000, 0n);

  let workerW = 0n;

  const cb = koffi.register((hwnd) => {
    const defView = toBig(FindWindowExW(toBig(hwnd), 0n, 'SHELLDLL_DefView', null));
    if (defView !== 0n) {
      // The WorkerW we want is the sibling that comes *after* the window which
      // hosts SHELLDLL_DefView (the icon layer).
      workerW = toBig(FindWindowExW(0n, toBig(hwnd), 'WorkerW', null));
    }
    return true; // keep enumerating
  }, koffi.pointer(EnumWindowsProc));

  try {
    EnumWindows(cb, 0n);
  } finally {
    koffi.unregister(cb);
  }

  // Fallbacks for shell variants where the layout differs.
  if (workerW === 0n) {
    workerW = toBig(FindWindowExW(progman, 0n, 'WorkerW', null));
  }
  if (workerW === 0n) {
    // Last resort: parent directly onto Progman. Icons may sit above our content.
    workerW = progman;
  }

  cachedWorkerW = workerW;
  if (process.env.LUMINA_DEBUG) console.log(`[wallpaper] progman=${progman} workerW=${workerW}`);
  return workerW;
}

function getWorkerW() {
  if (cachedWorkerW === 0n) return resolveWallpaperHost();
  return cachedWorkerW;
}

/**
 * Read the native HWND out of an Electron BrowserWindow as a BigInt.
 * @param {import('electron').BrowserWindow} win
 * @returns {bigint}
 */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  // 64-bit Electron on Windows: handle is the first 8 bytes, little-endian.
  return buf.readBigUInt64LE(0);
}

/**
 * Attach a BrowserWindow into the desktop wallpaper layer and position it.
 * @param {import('electron').BrowserWindow} win
 * @param {{x:number,y:number,width:number,height:number}} rect physical px,
 *        relative to the virtual-screen origin.
 */
function attachWindow(win, rect) {
  const host = getWorkerW();
  if (host === 0n) throw new Error('Could not locate the desktop wallpaper host (WorkerW).');

  const child = hwndOf(win);
  // Make the window a TRUE child of the wallpaper host. Without WS_CHILD,
  // SetParent leaves it as an "owned popup" that Windows doesn't clip/paint as
  // part of the desktop layer — so the static wallpaper repaints over it
  // intermittently (the "bleed-through"). WS_CHILD makes it stable.
  const style = toBig(GetWindowLongPtrW(child, GWL_STYLE));
  SetWindowLongPtrW(child, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);
  const prevParent = SetParent(child, host);
  if (process.env.LUMINA_DEBUG) {
    console.log(`[wallpaper] attach child=${child} -> host=${host} (prevParent=${prevParent}) rect=${JSON.stringify(rect)}`);
  }
  ShowWindow(child, SW_SHOW);
  positionWindow(win, rect);
}

/**
 * Force a window to a physical-pixel rect (relative to the WorkerW origin)
 * without re-parenting. Used to (re)assert geometry after Electron's own
 * post-show layout — which clamps frameless windows to the monitor work area
 * (excluding the taskbar) and would otherwise leave a gap along the taskbar
 * edge on every monitor.
 * @param {import('electron').BrowserWindow} win
 * @param {{x:number,y:number,width:number,height:number}} rect
 */
function positionWindow(win, rect) {
  const child = hwndOf(win);
  SetWindowPos(
    child,
    0n, // HWND_TOP — keep our content at the front of the WorkerW child z-order
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
    SWP_NOACTIVATE | SWP_SHOWWINDOW,
  );
}

/**
 * Detach a window from the wallpaper layer (re-parent to the desktop root) so it
 * can be hidden or destroyed cleanly.
 * @param {import('electron').BrowserWindow} win
 */
function detachWindow(win) {
  try {
    const child = hwndOf(win);
    SetParent(child, 0n);
  } catch {
    // window may already be destroyed
  }
}

/** Force a fresh WorkerW lookup (e.g. after the shell restarts). */
function invalidateHost() {
  cachedWorkerW = 0n;
}

/**
 * Detect whether a wallpaper window has been orphaned from the desktop layer —
 * which happens when explorer.exe (the shell) restarts and Windows tears down
 * and recreates the WorkerW. In that case our window is still alive but no
 * longer parented to a valid host, so it stops showing on the desktop.
 * @param {import('electron').BrowserWindow} win
 * @returns {boolean} true if the window needs to be re-attached.
 */
function needsReattach(win) {
  try {
    const child = hwndOf(win);
    // Native handle is gone — the shell tore down our window along with the old
    // WorkerW. The window must be rebuilt, not just re-parented.
    if (!IsWindow(child)) return true;
    if (cachedWorkerW === 0n) return true; // host not resolved yet
    if (!IsWindow(cachedWorkerW)) return true; // host window destroyed (shell restarted)
    // GetParent returns 0 for these windows (style quirk); GetAncestor is reliable.
    return toBig(GetAncestor(child, GA_PARENT)) !== cachedWorkerW; // re-parented away
  } catch {
    return true; // can't read the handle — treat as broken so we rebuild
  }
}

/** Whether a window's underlying native HWND is still a valid window. */
function isNativeAlive(win) {
  try {
    return !!IsWindow(hwndOf(win));
  } catch {
    return false;
  }
}

module.exports = {
  attachWindow,
  positionWindow,
  detachWindow,
  invalidateHost,
  needsReattach,
  isNativeAlive,
  resolveWallpaperHost,
};
