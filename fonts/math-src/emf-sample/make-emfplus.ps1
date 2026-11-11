# Creates a GDI+ metafile (EMF+ only, or dual) with System.Drawing: DrawString with the fonts the machine has.
# GDI+ writes the family it really used, so only installed fonts end up in the file (Symbol always; MT Extra with Office).
# Usage: powershell -File make-emfplus.ps1 -Out test-gdiplus.emf [-Type EmfPlusOnly|EmfPlusDual|EmfOnly]
param([string]$Out, [string]$Type = 'EmfPlusOnly')
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1, 1
$g0 = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g0.GetHdc()
$ms = New-Object System.IO.FileStream $Out, 'Create'
$mf = New-Object System.Drawing.Imaging.Metafile($ms, $hdc, [System.Drawing.Imaging.EmfType]::$Type)
$g0.ReleaseHdc($hdc)
$g = [System.Drawing.Graphics]::FromImage($mf)
$g.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
$brush = [System.Drawing.Brushes]::Black
function Row($y, $face, $text) {
  $f = New-Object System.Drawing.Font($face, 36, [System.Drawing.GraphicsUnit]::Pixel)
  Write-Output ("{0} -> {1}" -f $face, $f.FontFamily.Name)
  $g.DrawString($text, $f, $brush, 10, $y)
}
Row 5   'Symbol'   ([string]::new(@([char]0xF0A3, [char]0xF0B3, [char]0xF0A5, [char]0xF0E5, [char]0xF061, [char]0xF062)))
Row 60  'MT Extra' ([string]::new(@([char]0xF072, [char]0xF073, [char]0xF074, [char]0xF041, [char]0xF042)))
Row 115 'MT Extra' 'ArVW'
$g.Dispose(); $mf.Dispose(); $ms.Dispose(); $bmp.Dispose()
(Get-Item $Out).Length
