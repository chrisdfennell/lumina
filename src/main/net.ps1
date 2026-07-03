# Emit total network bytes as "received sent" lines every 2s, forever.
# Get-NetAdapterStatistics is a cheap CIM query (no PDH warmup), summed over
# hardware adapters. The parent computes deltas to get up/down rates.
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  try {
    $rx = 0L; $tx = 0L
    foreach ($s in (Get-NetAdapterStatistics)) {
      $rx += [long]$s.ReceivedBytes
      $tx += [long]$s.SentBytes
    }
    [Console]::Out.WriteLine("$rx $tx")
    [Console]::Out.Flush()
  } catch { }
  Start-Sleep -Seconds 2
}
