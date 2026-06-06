# Print overall GPU utilization (0-100) as a single integer, then exit.
# Aggregates the "GPU Engine" performance counters the way Task Manager does:
# sum the instances within each engine type (3D, VideoDecode, Copy, …), then
# report the busiest type. Polled on a timer by the main process.
$ErrorActionPreference = 'SilentlyContinue'
try {
  $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples
  $byType = @{}
  foreach ($c in $samples) {
    $t = if ($c.Path -match 'engtype_([a-z0-9]+)') { $matches[1] } else { 'other' }
    $byType[$t] = [double]$byType[$t] + [double]$c.CookedValue
  }
  $max = 0.0
  foreach ($v in $byType.Values) { if ($v -gt $max) { $max = $v } }
  if ($max -gt 100) { $max = 100 }
  [int][math]::Round($max)
} catch { }
