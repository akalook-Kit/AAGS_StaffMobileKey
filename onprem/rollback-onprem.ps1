<#
  Access Monitoring Tool - go back to the program files that were installed before the last upgrade.
  Run as administrator. With -RestoreDatabase, also puts back the copy of the database made just before that
  upgrade (everything entered since is lost; you are asked to confirm).
#>
param(
  [switch]$RestoreDatabase,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'),
  [string]$RuntimeDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Runtime'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Open PowerShell with "Run as administrator".' -ForegroundColor Red; exit 1 }
$prev = "$InstallDir.previous"
if (-not (Test-Path $prev)) { Write-Host "No previous version in $prev." -ForegroundColor Red; exit 1 }
$from = (Get-Content (Join-Path $InstallDir 'VERSION') -TotalCount 1).Trim(); $to = (Get-Content (Join-Path $prev 'VERSION') -TotalCount 1).Trim()
Write-Host "Going back from $from to $to."
$copy = $null
if ($RestoreDatabase) {
  $copy = Get-ChildItem (Join-Path $DataDir 'backups') -Filter 'smk-*-pre-upgrade.smkbak' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $copy) { Write-Host 'No copy made before an upgrade was found.' -ForegroundColor Red; exit 1 }
  $ok = Read-Host "Put back $($copy.Name)? Everything entered since $($copy.LastWriteTime) is lost. Type YES"
  if ($ok -ne 'YES') { Write-Host 'Nothing changed.'; exit 1 }
}
foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform') { $s = Get-Service $svc -ErrorAction SilentlyContinue; if ($s -and $s.Status -ne 'Stopped') { Stop-Service $svc -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) } }
if ($copy) {
  # The newer version's tool puts the copy back exactly as it was (without its own newer database changes).
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')
  $clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $DataDir 'platform.secrets')), $entropy, 'LocalMachine')
  $secrets = [ordered]@{}
  foreach ($line in ([Text.Encoding]::UTF8.GetString($clear) -split "`n")) { $l = $line.Trim("`r", ' '); if ($l -and -not $l.StartsWith('#') -and $l.Contains('=')) { $i = $l.IndexOf('='); $secrets[$l.Substring(0, $i)] = $l.Substring($i + 1) } }
  [Array]::Clear($clear, 0, $clear.Length)
  foreach ($k in $secrets.Keys) { Set-Item "Env:\$k" $secrets[$k] }
  $env:SMK_MIGRATIONS_DIR = Join-Path $InstallDir 'migrations'; $env:NODE_ENV = 'production'; $env:CS_CALLBACKS = 'off'
  $p = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & (Join-Path $RuntimeDir 'node\node.exe') (Join-Path $InstallDir 'app\admin.mjs') restore $copy.FullName --exact 2>&1 | ForEach-Object { if ("$_" -notmatch '^(PROGRESS |\{)') { Write-Host "  $_" } }; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $p; foreach ($k in $secrets.Keys) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }; Remove-Item Env:\SMK_MIGRATIONS_DIR, Env:\NODE_ENV, Env:\CS_CALLBACKS -ErrorAction SilentlyContinue }
  if ($code -ne 0) { Start-Service StaffMobileKeyPlatform; Start-Service StaffMobileKeyGateway; Write-Host 'The database copy could not be put back; nothing was changed.' -ForegroundColor Red; exit 1 }
}
$bad = "$InstallDir.failed"
if (Test-Path $bad) { Remove-Item $bad -Recurse -Force }
Rename-Item $InstallDir (Split-Path $bad -Leaf)
Rename-Item $prev (Split-Path $InstallDir -Leaf)
Start-Service StaffMobileKeyPlatform; Start-Service StaffMobileKeyGateway
Write-Host "Back on $to. The newer files are kept in $bad." -ForegroundColor Green
