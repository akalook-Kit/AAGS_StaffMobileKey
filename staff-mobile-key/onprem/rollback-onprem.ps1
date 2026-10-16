<#
  Staff Mobile Key - go back to the program files that were installed before the last upgrade.
  Run as administrator. With -RestoreDatabase, also restores the database backup taken just before that
  upgrade (everything entered since is lost; you are asked to confirm).
#>
param(
  [switch]$RestoreDatabase,
  [string]$PostgresBin = '',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
$prev = "$InstallDir.previous"
if (-not (Test-Path $prev)) { Write-Host "No previous version in $prev." -ForegroundColor Red; exit 1 }
$from = (Get-Content (Join-Path $InstallDir 'VERSION') -TotalCount 1).Trim(); $to = (Get-Content (Join-Path $prev 'VERSION') -TotalCount 1).Trim()
Write-Host "Going back from $from to $to."
foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform') { $s = Get-Service $svc -ErrorAction SilentlyContinue; if ($s -and $s.Status -ne 'Stopped') { Stop-Service $svc -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40)) } }
if ($RestoreDatabase) {
  $dump = Get-ChildItem (Join-Path $DataDir 'backups') -Filter "pre-upgrade-$from-*.dump" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $dump) { Write-Host "No pre-upgrade backup for $from found." -ForegroundColor Red; exit 1 }
  $ok = Read-Host "Restore $($dump.Name)? Everything entered since $($dump.LastWriteTime) is lost. Type YES"
  if ($ok -ne 'YES') { Write-Host 'Nothing changed.'; exit 1 }
  Add-Type -AssemblyName System.Security
  if (-not $PostgresBin) { $PostgresBin = Get-ChildItem (Join-Path $env:ProgramFiles 'PostgreSQL') -Directory | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | ForEach-Object { Join-Path $_.FullName 'bin' } | Select-Object -First 1 }
  $entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')
  $clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $DataDir 'platform.secrets')), $entropy, 'LocalMachine')
  $url = ([Text.Encoding]::UTF8.GetString($clear) -split "`n" | Where-Object { $_ -like 'DATABASE_URL=*' }) -replace '^DATABASE_URL=', ''
  [Array]::Clear($clear, 0, $clear.Length)
  $u = [Uri](($url.Trim()) -replace '^postgres://', 'http://')
  $env:PGPASSWORD = [Uri]::UnescapeDataString($u.UserInfo.Split(':')[1])
  try { & (Join-Path $PostgresBin 'pg_restore.exe') -h 127.0.0.1 -p $u.Port -U smk -d smk --clean --if-exists --no-owner $dump.FullName }
  finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
}
$bad = "$InstallDir.failed"
if (Test-Path $bad) { Remove-Item $bad -Recurse -Force }
Rename-Item $InstallDir (Split-Path $bad -Leaf)
Rename-Item $prev (Split-Path $InstallDir -Leaf)
Start-Service StaffMobileKeyPlatform; Start-Service StaffMobileKeyGateway
Write-Host "Back on $to. The newer files are kept in $bad." -ForegroundColor Green
