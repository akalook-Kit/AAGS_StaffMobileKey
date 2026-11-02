# Opens the Staff Mobile Key portal on this server (Start menu shortcut and the end of the .msi installation).
$data = Join-Path $env:ProgramData 'StaffMobileKey\Platform'
$url = 'http://127.0.0.1:47300'
$f = Join-Path $data 'portal-url.txt'
if (Test-Path $f) { $u = (Get-Content $f -TotalCount 1).Trim(); if ($u -match '^http://127\.0\.0\.1:\d+$') { $url = $u } }
$target = "$url/"
$code = Join-Path $data 'setup-code.txt'
if (Test-Path $code) {
  # Wait up to a minute for the platform after an installation, then see whether the setup page is still open.
  for ($i = 0; $i -lt 30; $i++) { try { $s = Invoke-RestMethod "$url/api/v1/setup" -TimeoutSec 3; break } catch { Start-Sleep 2 } }
  if ($s -and $s.needed) { $c = (Get-Content $code -TotalCount 1).Trim(); if ($c) { $target = "$url/#code=$c" } }
}
Start-Process $target
