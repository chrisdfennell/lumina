# Emit the current Windows "now playing" media as compact JSON {title, artist},
# or nothing if no session. Uses the System Media Transport Controls (SMTC)
# WinRT API via reflection — works for Spotify, browsers, Groove, etc.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $type) {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $t = $asTask.Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if ($s) {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($p.Title) {
      [pscustomobject]@{ title = $p.Title; artist = $p.Artist } | ConvertTo-Json -Compress
    }
  }
} catch { }
