# Lumina Live Wallpaper

Modern live-wallpaper engine for Windows 11 — play videos, GIFs, images, YouTube,
web pages, GLSL shaders, an audio visualizer, and auto-rotating online sources
*behind* your desktop icons, independently on each monitor.

Built with Electron. Renders into the Windows desktop `WorkerW` layer, so wallpapers
sit behind your icons but above the static wallpaper.

## Features

**Sources**
- Local **video / GIF / image** (drag-and-drop or browse)
- **YouTube** (downloaded via bundled `yt-dlp`, falls back to embed)
- **Web pages** — any URL as a live wallpaper
- **Built-in GLSL shaders** — Aurora, Plasma, Starfield, Warp
- **Audio visualizer** — reacts to system audio (WASAPI loopback)
- **Online wallpapers** — search **Wallhaven** (incl. anime/general categories) and
  **Openverse** (Creative-Commons photos), with infinite scroll and click-to-pick,
  or add an auto-rotating source — no API keys required

**Per-monitor controls**
- **Scaling** — Fill / Fit / Stretch / Center
- **Effects** — brightness, saturation, blur, playback speed
- **Mouse parallax** (depth) — wallpaper shifts with the cursor
- **Audio-reactive** — any wallpaper pulses/zooms to the beat
- **Particle overlays** — rain, snow, fireflies, Matrix rain over any wallpaper
- **Info widgets** — clock, date, live weather, CPU/RAM stats (any corner)

**Playback & automation**
- **Playlists** — rotate multiple wallpapers on a timer (shuffle optional)
- **Day/night scheduling** — switch wallpapers by time of day
- **Auto-pause** behind fullscreen apps and/or on battery (saves GPU/power)

**Robustness**
- Self-heals when `explorer.exe` / the `WorkerW` desktop layer is recreated
- Handles mixed-DPI multi-monitor setups (per-monitor physical-pixel layout)

## Getting started

```bash
npm install
npm start        # or: npm run dev   (opens devtools)
```

A tray icon controls the app; the control window manages your library and monitors.

Build an installer:

```bash
npm run dist     # electron-builder (NSIS)
```

## Notes

- Windows 11 only (relies on the `WorkerW` desktop-layer technique and WASAPI loopback).
- `bin/yt-dlp.exe` is bundled for YouTube downloads.
- Config is stored in `%APPDATA%/Lumina Live Wallpaper/lumina-config.json`.

## License

MIT
