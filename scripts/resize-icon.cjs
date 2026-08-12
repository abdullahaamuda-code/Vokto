// Rebuilds build/icon.ico as a multi-size ico (16..256) from profile pic.ico,
// upscaling the source artwork so electron-builder's >=256px requirement is met.
// Run: node scripts/resize-icon.cjs
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..');
const src = join(root, 'profile pic.ico');
const dest = join(root, 'build', 'icon.ico');

const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src.replace(/\\/g, '\\\\')}')
$sizes = @(16,24,32,48,64,128,256)
$ms = New-Object System.IO.MemoryStream
$enc = [System.Drawing.Imaging.ImageFormat]::Png
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $m = New-Object System.IO.MemoryStream
  $bmp.Save($m, $enc)
  $pngs += ,$m.ToArray()
  $bmp.Dispose()
}
$src.Dispose()
$ms.Dispose()
$fs = [System.IO.File]::Create('${dest.replace(/\\/g, '\\\\')}')
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
for ($i = 0; $i -lt $pngs.Count; $i++) {
  $s = $sizes[$i]; $png = $pngs[$i]
  $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$png.Length)
  $bw.Write([uint32]$offset)
  $offset += $png.Length
}
foreach ($png in $pngs) { $bw.Write($png) }
$bw.Dispose(); $fs.Dispose()
Write-Output "wrote multi-size ico ($($sizes -join ',') px)"
`;

const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
  stdio: 'inherit',
  windowsHide: true
});
process.exit(r.status ?? 1);
