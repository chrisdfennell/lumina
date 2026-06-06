<div align="center">

# 🌌 Lumina Live Wallpaper

### Modern live-wallpaper engine for Windows 11

Play **videos, GIFs, images, YouTube, web pages, GLSL shaders, an audio visualizer,
and auto-rotating online sources** — *behind your desktop icons*, independently on every monitor.

<br/>

![Platform](https://img.shields.io/badge/Windows%2011-0078D6?style=for-the-badge&logo=windows11&logoColor=white)
![Electron](https://img.shields.io/badge/Electron%2031-47848F?style=for-the-badge&logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![License MIT](https://img.shields.io/badge/License-MIT-3FB950?style=for-the-badge)

![Multi-monitor](https://img.shields.io/badge/🖥️_Multi--monitor-7C4DFF?style=for-the-badge)
![No API keys](https://img.shields.io/badge/🔑_No_API_keys-23D5AB?style=for-the-badge)
![Audio reactive](https://img.shields.io/badge/🎵_Audio_reactive-FF5E62?style=for-the-badge)
![GPU friendly](https://img.shields.io/badge/⚡_Auto--pause-FFB020?style=for-the-badge)

</div>

---

## ✨ Overview

Lumina renders content into the Windows desktop **`WorkerW`** layer, so your wallpaper
sits *behind the icons* but *above* the static desktop background — a true live
wallpaper. It's built with **Electron**, runs entirely locally, and needs **no API keys**.

Every monitor is configured independently: its own source, scaling, color effects,
parallax, audio-reactivity, particle overlays, and info widgets.

---

## 🎨 Sources

| Source | Notes |
| --- | --- |
| 🎬 **Video / GIF / Image** | Drag-and-drop or browse — `mp4`, `webm`, `mkv`, `gif`, `png`, `jpg`, `webp`… |
| ▶️ **YouTube** | Downloaded via bundled `yt-dlp` (falls back to an embed) |
| 🌐 **Web pages** | Any URL as a live, interactive wallpaper |
| ✨ **GLSL shaders** | 13 built-ins (Aurora · Plasma · Synthwave · Nebula…) **+ write your own** in the in-app editor with live preview |
| 🎆 **Canvas animations** | Constellation · Flow field · Bokeh · Fireworks · Rain-on-glass · Game of Life · Bouncing logo — all configurable |
| 🏔 **2.5D depth** | Turn a photo into a fake-3D wallpaper that shifts with your mouse (optional depth map) |
| 🎵 **Audio visualizer** | Reacts to system audio (WASAPI loopback) |
| 🌅 **Online wallpapers** | Search **Wallhaven** (incl. anime/general) & **Openverse** (CC photos) — infinite scroll, click-to-pick, or auto-rotate. *No keys.* |
| 📦 **Shareable presets** | Export any shader/animation/source as a `.lumina` file and import others' |

---

## 🖥️ Per-monitor controls

| Control | What it does |
| --- | --- |
| **Scaling** | Fill · Fit · Stretch · Center |
| **Effects** | Brightness · Saturation · Blur · Playback speed |
| **Mouse parallax** | Wallpaper shifts with the cursor for a 3D depth feel |
| **Audio-reactive** | *Any* wallpaper pulses & zooms to the beat |
| **Particle overlays** | 🌧️ Rain · ❄️ Snow · 🪰 Fireflies · 💻 Matrix — over any wallpaper |
| **Info widgets** | 🕐 Clock · 📅 Date · 🌤️ Weather · 📊 CPU/RAM (text **or** live graphs) · 🎵 Now playing — any corner |

---

## 🔁 Playback & automation

- **Playlists** — rotate multiple wallpapers on a timer (shuffle optional), with smooth **video crossfades**
- **Day/night scheduling** — switch wallpapers by time of day
- **Night shift** — automatic warm tint & dimming that ramps in after dark
- **Weather-reactive** — live rain/snow overlay that matches your local weather
- **Auto-pause** — behind fullscreen apps, on battery, and/or when you're idle, to save GPU & power
- **Profiles** — save & switch your whole multi-monitor setup; export/import as JSON
- **Global hotkeys & tray** — pause-all (`Ctrl+Alt+P`), next wallpaper (`Ctrl+Alt+N`), per-display tray menu
- **Auto-update** — packaged builds check GitHub Releases and update in the background
- **Self-healing** — automatically re-attaches if `explorer.exe` / the desktop layer restarts
- **Mixed-DPI aware** — correct per-monitor physical-pixel layout on multi-monitor setups

---

## 🚀 Getting started

```bash
npm install
npm start          # run the app   (npm run dev for devtools)
```

A **tray icon** keeps it running; the control window manages your library and monitors.

### Build a Windows installer

```bash
npm run dist       # electron-builder → NSIS installer in dist/
```

---

## 🧩 How it works

```
Progman ──► WorkerW (desktop wallpaper host)
                └── Lumina BrowserWindow  ◄── re-parented here (WS_CHILD)
                       └── <video> / <canvas> / shader / web iframe
```

- Re-parents borderless Electron windows into the desktop `WorkerW` so content
  renders behind icons.
- Disables DirectComposition + forces device-scale-factor 1 so the GPU swap-chain
  presents correctly in the re-parented, mixed-DPI window.
- Win32 FFI via [`koffi`](https://koffi.dev) (`SetParent`, `SetWindowPos`, loopback audio, …).

---

## ⚙️ Tech & config

- **Electron 31** · vanilla JS · `koffi` for Win32 · `yt-dlp` for YouTube
- Config: `%APPDATA%/Lumina Live Wallpaper/lumina-config.json`
- Online sources: [Wallhaven](https://wallhaven.cc) (SFW) & [Openverse](https://openverse.org) (Creative-Commons)
- Weather: [wttr.in](https://wttr.in)

> **Windows 11 only** — relies on the `WorkerW` desktop technique and WASAPI loopback.

---

## 📋 Roadmap ideas

- [ ] Unsplash / Pexels sources (optional API keys)
- [ ] Drag-to-reorder playlists
- [x] Profiles / import-export
- [x] Auto-update
- [x] Custom GLSL shader editor
- [x] Shareable `.lumina` presets
- [x] 2.5D depth-parallax wallpapers
- [x] Night shift & weather-reactive overlays
- [x] CPU/RAM graph & now-playing widgets

---

## 📄 License

[MIT](LICENSE) © chrisdfennell
