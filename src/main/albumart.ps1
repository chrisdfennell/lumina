# Output the current Windows "now playing" track as JSON {title, artist, art}
# and, when available, write the album-art thumbnail to the path given as the
# first argument. Uses SMTC (System Media Transport Controls) via WinRT.
param([string]$OutPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, $type) {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $t = $asTask.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result
  }
  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if (-not $s) { return }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $art = ''
  if ($OutPath -and $p.Thumbnail) {
    try {
      [void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
      $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $size = [uint32]$stream.Size
      if ($size -gt 0) {
        $reader = [Windows.Storage.Streams.DataReader]::new($stream)
        Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        [System.IO.File]::WriteAllBytes($OutPath, $bytes)
        $art = $OutPath
      }
    } catch { }
  }
  [pscustomobject]@{ title = $p.Title; artist = $p.Artist; art = $art } | ConvertTo-Json -Compress
} catch { }
