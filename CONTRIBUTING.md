# Contributing to Lumina

Thanks for wanting to help! There are three easy ways in:

1. **Share a wallpaper preset** — no code needed. Export your shader/animation/source
   as a `.lumina` file (↗ button on a library card) and PR it to
   [lumina-gallery](https://github.com/chrisdfennell/lumina-gallery).
2. **Report bugs / suggest features** — use the issue templates. For open-ended ideas,
   start a [Discussion](https://github.com/chrisdfennell/lumina/discussions).
3. **Contribute code** — read on.

## Dev setup

```bash
git clone https://github.com/chrisdfennell/lumina.git
cd lumina
npm install
npm run dev     # runs with devtools + console logging
```

**Windows 11 required** — the whole app is built around the `WorkerW` desktop technique.

## Where things live

| Area | Files |
| --- | --- |
| Main process (windows, IPC, playlists, monitors) | `src/main/main.js` |
| Win32 / WorkerW attach (koffi FFI) | `src/main/wallpaper.js` |
| AI depth maps (ONNX / MiDaS) | `src/main/depth.js` |
| PowerShell helpers (now playing, GPU, network) | `src/main/*.ps1` |
| Control window UI | `src/renderer/control/` |
| Wallpaper renderer (playback, effects, widgets, overlays) | `src/renderer/wallpaper/` |
| Built-in shader / canvas / depth players | `src/renderer/shader|canvas|depth/` |

## Ground rules

- **Vanilla JS, no frameworks.** The project deliberately has two runtime deps
  (`koffi`, `electron-updater`) plus `onnxruntime-node`. New dependencies need a strong reason.
- **Security posture matters.** Remote strings (titles, API responses) are rendered with
  `textContent` — never `innerHTML`. IPC handlers validate their inputs. Keep it that way.
- **Idle cost is the product.** Wallpapers run 24/7 — avoid per-frame allocations,
  gate loops behind visibility/need, and clean up timers and processes.
- **Test on real monitors.** Especially mixed-DPI multi-monitor if you touch geometry.
- One feature per PR, and please fill in the PR template's "how it was tested" section.

## Releases (maintainer)

Push a `v*` tag → GitHub Actions builds the NSIS installer and publishes the release;
existing installs pick it up via the auto-updater.
