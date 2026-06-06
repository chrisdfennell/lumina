// Launches the real Electron runtime with a clean environment.
// Clears ELECTRON_RUN_AS_NODE, which (when set) makes electron.exe run as a
// plain Node process — breaking `require('electron')` in the main process.
const { spawn } = require('child_process');
const electronPath = require('electron'); // resolves to the electron.exe path string

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});
child.on('close', (code) => process.exit(code ?? 0));
