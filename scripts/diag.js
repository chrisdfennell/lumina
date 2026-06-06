// Diagnostic: prints display ids + userData path, then exits.
const { app, screen } = require('electron');
app.whenReady().then(() => {
  const displays = screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    primary: d.id === screen.getPrimaryDisplay().id,
    bounds: d.bounds,
    scale: d.scaleFactor,
  }));
  console.log('DIAG_JSON=' + JSON.stringify({ userData: app.getPath('userData'), displays }));
  app.quit();
});
