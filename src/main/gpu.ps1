# Emit overall GPU utilization (0-100) as a single integer per sample, forever.
# Aggregates the "GPU Engine" performance counters the way Task Manager does:
# sum the instances within each engine type (3D, VideoDecode, Copy, …), then
# report the busiest type.
#
# Uses Get-Counter -Continuous so the PDH query (a wildcard over 1000+ engine
# instances) is opened ONCE and then streamed — re-running Get-Counter per tick
# costs ~8s each time. Output goes straight to the console stream + Flush so
# each line reaches the parent process immediately.
$ErrorActionPreference = 'SilentlyContinue'
Get-Counter '\GPU Engine(*)\Utilization Percentage' -Continuous -SampleInterval 2 -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $byType = @{}
    foreach ($c in $_.CounterSamples) {
      $t = if ($c.Path -match 'engtype_([a-z0-9]+)') { $matches[1] } else { 'other' }
      $byType[$t] = [double]$byType[$t] + [double]$c.CookedValue
    }
    $max = 0.0
    foreach ($v in $byType.Values) { if ($v -gt $max) { $max = $v } }
    if ($max -gt 100) { $max = 100 }
    [Console]::Out.WriteLine([int][math]::Round($max))
    [Console]::Out.Flush()
  } catch { }
}
