Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root "src-tauri\icons"
New-Item -ItemType Directory -Force -Path $icons | Out-Null
$bmp = New-Object System.Drawing.Bitmap(1024, 1024)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(16, 26, 36))
$ring = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 58, 72), 18)
$g.DrawEllipse($ring, 96, 96, 832, 832)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(72, 200, 130))
$points = [System.Drawing.Point[]]@(
  (New-Object System.Drawing.Point(390, 300)),
  (New-Object System.Drawing.Point(770, 512)),
  (New-Object System.Drawing.Point(390, 724))
)
$g.FillPolygon($brush, $points)
$out = Join-Path $icons "source.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $out
