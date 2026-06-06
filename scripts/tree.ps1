Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Tree {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
}
"@

$global:lines = New-Object System.Collections.ArrayList

function HasDefView($h) {
  $global:hasDef = $false
  $cb = [Tree+EnumProc]{ param($c,$l) if ([Tree]::Cls($c) -eq 'SHELLDLL_DefView') { $global:hasDef=$true }; return $true }
  [void][Tree]::EnumChildWindows($h, $cb, [IntPtr]::Zero)
  return $global:hasDef
}

$global:z = 0
$topCb = [Tree+EnumProc]{
  param($h,$l)
  $c = [Tree]::Cls($h)
  if ($c -eq 'WorkerW' -or $c -eq 'Progman') {
    $r = New-Object Tree+RECT; [void][Tree]::GetWindowRect($h,[ref]$r)
    $vis = [Tree]::IsWindowVisible($h)
    $def = HasDefView $h
    $global:z++
    [void]$global:lines.Add("[z$($global:z)] hwnd=$([Int64]$h) class=$c visible=$vis hasDefView=$def rect=($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom))")
    $childCb = [Tree+EnumProc]{
      param($ch,$ll)
      $cc = [Tree]::Cls($ch)
      if ($cc -eq 'SHELLDLL_DefView' -or $cc -eq 'WorkerW' -or $cc -like 'Chrome_*') {
        $rr = New-Object Tree+RECT; [void][Tree]::GetWindowRect($ch,[ref]$rr)
        [void]$global:lines.Add("    child hwnd=$([Int64]$ch) class=$cc rect=($($rr.Left),$($rr.Top))-($($rr.Right),$($rr.Bottom))")
      }
      return $true
    }
    [void][Tree]::EnumChildWindows($h, $childCb, [IntPtr]::Zero)
  }
  return $true
}
[void][Tree]::EnumWindows($topCb, [IntPtr]::Zero)
"=== Desktop window structure (top-level, Z-order front to back) ==="
$global:lines | ForEach-Object { $_ }
"=== total Progman/WorkerW: $($global:z) ==="
