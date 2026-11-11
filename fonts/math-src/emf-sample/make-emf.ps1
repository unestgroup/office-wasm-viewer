# Creates test.emf (ExtTextOutW with a dx array, as MathType's EMFs do) with GDI text records in MT Extra / Symbol / Euclid Math Two / Euclid Math One / Euclid Fraktur
param([string]$Out)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class G {
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateEnhMetaFileW(IntPtr dc, string file, IntPtr rc, string desc);
  [DllImport("gdi32.dll")] public static extern IntPtr CloseEnhMetaFile(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteEnhMetaFile(IntPtr h);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFontW(int h,int w,int e,int o,int wt,uint i,uint u,uint s,uint cs,uint op,uint cp,uint q,uint pf,string face);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] public static extern int SetBkMode(IntPtr dc, int m);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern bool ExtTextOutW(IntPtr dc,int x,int y,uint o,IntPtr rc,string s,uint n,int[] dx);
}
'@
$dc = [G]::CreateEnhMetaFileW([IntPtr]::Zero, $Out, [IntPtr]::Zero, $null)
[void][G]::SetBkMode($dc, 1)
function Row($y, $face, $charset, $text) {
  $f = [G]::CreateFontW(-48, 0, 0, 0, 400, 0, 0, 0, $charset, 0, 0, 0, 0, $face)
  $old = [G]::SelectObject($dc, $f)
  # per-character advances like MathType writes them (the real font is not needed to lay the text out)
  $dx = [int[]]::new($text.Length); for ($i = 0; $i -lt $dx.Length; $i++) { $dx[$i] = 60 }
  [void][G]::ExtTextOutW($dc, 10, $y, 0, [IntPtr]::Zero, $text, [uint32]$text.Length, $dx)
  [void][G]::SelectObject($dc, $old); [void][G]::DeleteObject($f)
}
$e = [string]::new(@([char]0xF072, [char]0xF073, [char]0xF074, [char]0xF041, [char]0xF042))   # arrows, estimates, approaches
Row 5   'MT Extra' 2 $e
Row 60  'MT Extra' 2 ([string]::new(@([char]0x41, [char]0x72, [char]0x56, [char]0x57)))
Row 115 'Symbol' 2 ([string]::new(@([char]0xF0A3, [char]0xF0B3, [char]0xF0A5, [char]0xF0E5)))
Row 170 'Euclid Math Two' 2 ([string]::new(@([char]0x84, [char]0x85, [char]0x41, [char]0x52, [char]0x6B, [char]0x21)))
Row 225 'Euclid Math One' 2 ([string]::new(@([char]0x41, [char]0x4C, [char]0x52, [char]0xB4, [char]0xB6, [char]0x21)))
Row 280 'Euclid Fraktur' 2 ([string]::new(@([char]0x41, [char]0x61, [char]0x62, [char]0x52, [char]0x68)))
$h = [G]::CloseEnhMetaFile($dc)
[void][G]::DeleteEnhMetaFile($h)
(Get-Item $Out).Length
