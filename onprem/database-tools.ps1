<#
  Staff Mobile Key - database tools for the on-premises server. Run as administrator (or right-click ->
  Run with PowerShell from an administrator session). Nothing else needs to be installed: they use the
  Node.js that came with Staff Mobile Key.

    .\database-tools.ps1 -Action Size                       size of the database and its largest tables, free disk space
    .\database-tools.ps1 -Action Copy -Destination E:\      a full copy (USB disk, network share ...), checked after writing
    .\database-tools.ps1 -Action Verify -File E:\smk-copy-20261016-0800.smkbak   check a copy: complete and unchanged
    .\database-tools.ps1 -Action Optimize                   clean up and refresh statistics (VACUUM ANALYZE), safe while running
    .\database-tools.ps1 -Action Restore -File <copy>       put a copy back (stops the platform; makes a copy of the current data first; asks first)
    .\database-tools.ps1 -Action List                       the copies kept on this server

  A copy is one .smkbak file (compressed, with its own check) plus a .sha256 file with its fingerprint.
  The platform also makes a copy every day at 02:30 (14 kept) and on "Back up now" (portal: Settings -> Backups).
#>
param(
  [ValidateSet('Size', 'Copy', 'Verify', 'Optimize', 'Restore', 'List')][string]$Action = 'Size',
  [string]$Destination = '',
  [string]$File = '',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'),
  [string]$RuntimeDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Runtime'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
function Fail([string]$t) { Write-Host $t -ForegroundColor Red; exit 1 }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator".' }
$node = Join-Path $RuntimeDir 'node\node.exe'
if (-not (Test-Path $node)) { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $node = $c.Source } else { Fail "Node.js not found ($node). Is Staff Mobile Key installed?" } }
$admin = Join-Path $InstallDir 'app\admin.mjs'
if (-not (Test-Path $admin)) { Fail "Staff Mobile Key is not installed in $InstallDir." }

# The platform's settings (database address, keys) from the encrypted file: never shown, handed to the tool
# in its environment only, for the time it runs.
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')
$clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $DataDir 'platform.secrets')), $entropy, 'LocalMachine')
$secrets = [ordered]@{}
foreach ($line in ([Text.Encoding]::UTF8.GetString($clear) -split "`n")) { $l = $line.Trim("`r", ' '); if ($l -and -not $l.StartsWith('#') -and $l.Contains('=')) { $i = $l.IndexOf('='); $secrets[$l.Substring(0, $i)] = $l.Substring($i + 1) } }
[Array]::Clear($clear, 0, $clear.Length)

function Invoke-Admin([string[]]$a) {
  foreach ($k in $secrets.Keys) { Set-Item "Env:\$k" $secrets[$k] }
  $env:SMK_MIGRATIONS_DIR = Join-Path $InstallDir 'migrations'; $env:NODE_ENV = 'production'; $env:CS_CALLBACKS = 'off'
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # messages on standard error are not failures
  try {
    $out = & $node $admin @a 2>&1 | ForEach-Object {
      if ($_ -is [Management.Automation.ErrorRecord]) {
        $line = "$_"
        if ($line -match '^PROGRESS (\d+) (.*)$') { Write-Progress -Activity "Database: $Action" -Status $Matches[2] -PercentComplete ([int]$Matches[1]) } else { Write-Host $line }
      } else { $_ }
    }
    $code = $LASTEXITCODE
  } finally {
    Write-Progress -Activity "Database: $Action" -Completed
    $ErrorActionPreference = $prev
    foreach ($k in $secrets.Keys) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
    Remove-Item Env:\SMK_MIGRATIONS_DIR, Env:\NODE_ENV, Env:\CS_CALLBACKS -ErrorAction SilentlyContinue
  }
  return @{ code = $code; out = ($out -join '') }
}
function Show-Disk {
  $drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
  if ($drive) { $gb = [math]::Round($drive.Free / 1GB, 1); Write-Host "Free space on $($env:SystemDrive): $gb GB" -ForegroundColor $(if ($gb -lt 50) { 'Red' } else { 'Green' }) }
}

switch ($Action) {
  'Size' { $r = Invoke-Admin @('size'); Show-Disk; exit $r.code }
  'List' {
    $dir = Join-Path $DataDir 'backups'
    $copies = @(Get-ChildItem $dir -Filter '*.smkbak' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    foreach ($c in $copies) { Write-Host ('{0,-48} {1:yyyy-MM-dd HH:mm}  {2,8:N1} MB' -f $c.Name, $c.LastWriteTime, ($c.Length / 1MB)) }
    if (-not $copies.Count) { Write-Host 'No copies yet.' }
    Write-Host "Folder: $dir"
  }
  'Copy' {
    if (-not $Destination) { Fail 'Give the folder for the copy with -Destination (for example E:\ or \\nas\backups\hotel).' }
    if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Force -Path $Destination | Out-Null }
    Invoke-Admin @('size') | Out-Null
    $r = Invoke-Admin @('backup', $Destination)
    if ($r.code -ne 0) { Fail 'The copy failed (see above). Nothing was changed in the database.' }
    $f = ($r.out | ConvertFrom-Json).file
    $v = Invoke-Admin @('verify', $f)
    if ($v.code -ne 0) { Fail 'The copy was written but cannot be read back. Do not rely on it.' }
    Write-Host "Copy ready and checked: $f" -ForegroundColor Green
  }
  'Verify' { if (-not $File) { Fail 'Give the copy with -File.' }; $r = Invoke-Admin @('verify', $File); exit $r.code }
  'Optimize' { $r = Invoke-Admin @('optimize'); if ($r.code -eq 0) { Invoke-Admin @('size') | Out-Null }; exit $r.code }
  'Restore' {
    if (-not $File) { Fail 'Give the copy to put back with -File.' }
    $v = Invoke-Admin @('verify', $File)
    if ($v.code -ne 0) { Fail 'This copy cannot be used (see above). Nothing was changed.' }
    $ok = Read-Host "Put back ${File}? Everything entered since it was made is LOST. A copy of the current data is made first. Type YES"
    if ($ok -ne 'YES') { Write-Host 'Nothing changed.'; exit 1 }
    $r = Invoke-Admin @('backup', '--dir', (Join-Path $DataDir 'backups'), '--reason', 'before-restore')
    if ($r.code -ne 0) { Fail 'Could not save the current data first; nothing was changed.' }
    Write-Host "  Current data saved: $(($r.out | ConvertFrom-Json).file)"
    foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform') { $s = Get-Service $svc -ErrorAction SilentlyContinue; if ($s -and $s.Status -ne 'Stopped') { Stop-Service $svc -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) } }
    $r = Invoke-Admin @('restore', $File)
    Start-Service StaffMobileKeyPlatform; Start-Service StaffMobileKeyGateway
    if ($r.code -ne 0) { Fail 'The copy was NOT put back (see above); the database is unchanged and the platform runs again.' }
    Write-Host 'Restored. The platform is running again.' -ForegroundColor Green
  }
}
