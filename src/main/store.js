// Tiny JSON-file persistence in the app's userData directory.
// Holds the media library and per-monitor wallpaper assignments.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'lumina-config.json');

const DEFAULTS = {
  library: [], // [{ id, type: 'video'|'gif'|'youtube', name, src, thumb? }]
  assignments: {}, // { [displayId]: libraryItemId }
  playlists: {}, // { [displayId]: { items: [libraryItemId], intervalSec, shuffle } }
  fits: {}, // { [displayId]: 'cover'|'contain'|'fill'|'none' } — CSS object-fit
  effects: {}, // { [displayId]: { brightness, saturation, blur, speed } }
  widgets: {}, // { [displayId]: { clock, seconds, date, weather, weatherLocation, stats, position } }
  profiles: {}, // { [name]: { assignments, fits, effects, playlists, widgets } }
  settings: {
    volume: 0, // muted by default
    autostart: false,
    pauseOnFullscreen: true,
    pauseOnBattery: false,
    hotkeys: true,
    nightShift: false,      // time-of-day warm tint + dimming
    weatherReactive: false, // auto rain/snow overlay from live weather
    weatherLocation: '',    // blank = auto-locate by IP (wttr.in)
    idlePauseMin: 0,        // pause after N minutes idle (0 = off)
    transitions: true,      // crossfade between wallpapers on switch
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
    cache.settings = { ...DEFAULTS.settings, ...(cache.settings || {}) };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist config:', err);
  }
}

function getState() {
  return load();
}

function setLibrary(library) {
  load().library = library;
  save();
}

function setAssignments(assignments) {
  load().assignments = assignments;
  save();
}

function setFits(fits) {
  load().fits = fits;
  save();
}

function setEffects(effects) {
  load().effects = effects;
  save();
}

function setWidgets(widgets) {
  load().widgets = widgets;
  save();
}

function setProfiles(profiles) {
  load().profiles = profiles;
  save();
}

/** Replace the entire config (used by import). */
function replaceState(next) {
  cache = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...next };
  cache.settings = { ...DEFAULTS.settings, ...(cache.settings || {}) };
  save();
  return cache;
}

function setPlaylists(playlists) {
  load().playlists = playlists;
  save();
}

function setSettings(partial) {
  const s = load();
  s.settings = { ...s.settings, ...partial };
  save();
}

module.exports = { getState, setLibrary, setAssignments, setPlaylists, setFits, setEffects, setWidgets, setProfiles, setSettings, replaceState, FILE };
