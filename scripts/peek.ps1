Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Drawing;
public class Peek {
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string win);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string ClassOf(IntPtr h){ var sb=new StringBuilder(256); GetClassName(h,sb,256); return sb.ToString(); }
}
"@ -ReferencedAssemblies System.Drawing

$found = New-Object System.Collections.ArrayList

$childCb = [Peek+EnumProc]{
  param($h,$l)
  if ([Peek]::ClassOf($h) -eq 'Chrome_WidgetWin_1') {
    $r = New-Object Peek+RECT
    [void][Peek]::GetWindowRect($h, [ref]$r)
    $parent = [Peek]::GetParent($h)
    [void]$found.Add([pscustomobject]@{
      Hwnd=$h; Parent=$parent; ParentClass=[Peek]::ClassOf($parent);
      W=($r.Right-$r.Left); H=($r.Bottom-$r.Top); Rect=$r
    })
  }
  return $true
}

$topCb = [Peek+EnumProc]{
  param($h,$l)
  $c = [Peek]::ClassOf($h)
  if ($c -eq 'WorkerW' -or $c -eq 'Progman') { [void][Peek]::EnumChildWindows($h, $childCb, [IntPtr]::Zero) }
  return $true
}

[void][Peek]::EnumWindows($topCb, [IntPtr]::Zero)

"Wallpaper-layer Chrome windows found: $($found.Count)"
$found | Format-Table Hwnd, ParentClass, W, H -AutoSize | Out-String | Write-Host

# PrintWindow the largest one (our wallpaper) with PW_RENDERFULLCONTENT
$wp = $found | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
if ($wp) {
  $bmp = New-Object System.Drawing.Bitmap $wp.W, $wp.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][Peek]::PrintWindow($wp.Hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc); $g.Dispose()
  $out = "c:\programming\movingwallpapers\.claude\wp-content.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "Captured wallpaper window $($wp.Hwnd) ($($wp.W)x$($wp.H)) -> $out"
}
