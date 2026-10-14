<#
  Goes back to the version saved by upgrade.ps1: restores the program files, .env and (if saved) the
  test data as they were just before that upgrade. Anything done after the upgrade is lost.

    powershell -ExecutionPolicy Bypass -File C:\khb\staff-mobile-key\staff-mobile-key\scripts\windows\rollback.ps1 -Backup C:\khb\backups\staff-mobile-key-<version>-<date-time>
    ...\rollback.ps1 -Latest          # the most recent backup in C:\khb\backups
    ...\rollback.ps1 -Latest -FilesOnly   # program files only; keep today's data

  -Target      Installed project folder. Default C:\khb\staff-mobile-key\staff-mobile-key
  -BackupRoot  Default C:\khb\backups (used with -Latest)
#>
param(
  [string]$Backup = '',
  [switch]$Latest,
  [switch]$FilesOnly,
  [string]$Target = 'C:\khb\staff-mobile-key\staff-mobile-key',
  [string]$BackupRoot = 'C:\khb\backups',
  [switch]$Confirmed
)
$ErrorActionPreference = 'Continue'
function Write-Step([string]$t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { Write-Host ""; Write-Host $t -ForegroundColor Red; exit 1 }

if ($Latest) {
  $b = Get-ChildItem -Path $BackupRoot -Directory -Filter 'staff-mobile-key-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $b) { Fail "No backups found in $BackupRoot." }
  $Backup = $b.FullName
}
if (-not $Backup) { Fail "Say which backup to restore: -Backup <folder> or -Latest. Backups are in $BackupRoot." }
if (-not (Test-Path (Join-Path $Backup 'files\docker-compose.yml'))) { Fail "$Backup is not a backup made by upgrade.ps1 (files\docker-compose.yml missing)." }
$Backup = (Resolve-Path $Backup).Path
$Target = [IO.Path]::GetFullPath($Target)

# This script lives in the folder it restores, so it runs from a temporary copy.
if ($PSCommandPath -like "$Target*") {
  $tmp = Join-Path $env:TEMP 'smk-rollback.ps1'
  Copy-Item $PSCommandPath $tmp -Force
  $pass = @('-ExecutionPolicy', 'Bypass', '-File', $tmp, '-Backup', $Backup, '-Target', $Target)
  if ($FilesOnly) { $pass += '-FilesOnly' }
  if ($Confirmed) { $pass += '-Confirmed' }
  & powershell @pass
  exit $LASTEXITCODE
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running. Start it, then run this again." }
$restoreData = (-not $FilesOnly) -and (Test-Path (Join-Path $Backup 'data\smk.dump'))
Get-Content (Join-Path $Backup 'backup-info.txt') -ErrorAction SilentlyContinue | Select-Object -First 1 | Write-Host
Write-Host "Restore into: $Target"
Write-Host ("Data: " + $(if ($restoreData) { 'REPLACED with the backup (changes made since then are lost)' } else { 'kept as it is now' }))
if (-not $Confirmed) {
  $answer = Read-Host "Type YES to continue"
  if ($answer -ne 'YES') { Write-Host 'Cancelled. Nothing was changed.'; exit 0 }
}

$envFile = Join-Path $Target '.env'
function Invoke-Compose { & docker compose -f (Join-Path $Target 'docker-compose.yml') --env-file $envFile --project-directory $Target @args }

Write-Step "Stopping the current version"
if (Test-Path (Join-Path $Target 'docker-compose.yml')) { Invoke-Compose stop *> $null }

Write-Step "Restoring program files and .env"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
& robocopy (Join-Path $Backup 'files') $Target /MIR /XD node_modules .expo .git dist backups local-test (Join-Path $Target 'visionline-probe-report') /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Restoring the files failed (robocopy code $LASTEXITCODE)." }
Get-ChildItem -Path $Target -Recurse -Filter *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
Write-Host "  Done."

if ($restoreData) {
  Write-Step "Restoring the data"
  $cfg = @{}; foreach ($l in Get-Content $envFile) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim() } }
  $project = if ($cfg.COMPOSE_PROJECT_NAME) { $cfg.COMPOSE_PROJECT_NAME } else { 'khb-staffkey' }
  Invoke-Compose up -d db *> $null
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) { Invoke-Compose exec -T db pg_isready -U smk *> $null; if ($LASTEXITCODE -eq 0) { $ready = $true; break }; Start-Sleep -Seconds 2 }
  if (-not $ready) { Fail "The database did not start. Files are restored; run this again to restore the data." }
  Push-Location (Join-Path $Backup 'data')
  Invoke-Compose cp smk.dump db:/tmp/smk-restore.dump
  $cpOk = ($LASTEXITCODE -eq 0)
  Pop-Location
  if (-not $cpOk) { Fail "Copying the database backup into the container failed." }
  Invoke-Compose exec -T db psql -q -U smk -d smk -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" *> $null
  Invoke-Compose exec -T db pg_restore --no-owner -U smk -d smk /tmp/smk-restore.dump
  if ($LASTEXITCODE -ne 0) { Fail "Restoring the database reported errors (see above)." }
  Invoke-Compose exec -T db rm -f /tmp/smk-restore.dump *> $null
  Write-Host "  Database restored."
  $dataDir = Join-Path $Backup 'data'
  foreach ($vol in @('connector-data', 'certs')) {
    $tgz = Join-Path $dataDir "$vol.tgz"
    if (-not (Test-Path $tgz)) { continue }
    $name = "${project}_$vol"
    docker volume create $name *> $null
    docker run --rm -v "${name}:/v" -v "${dataDir}:/b:ro" postgres:16 sh -c "find /v -mindepth 1 -delete && tar xzf /b/$vol.tgz -C /v" *> $null
    if ($LASTEXITCODE -ne 0) { Fail "Restoring the $vol volume failed." }
    Write-Host "  Volume $vol restored."
  }
}

Write-Step "Starting the restored version"
Set-Location $Target
& (Join-Path $Target 'scripts\windows\start.ps1')
if ($LASTEXITCODE -ne 0) { Fail "The restored version did not start. Read the messages above." }
Write-Host ""
Write-Host "Rollback finished." -ForegroundColor Green
exit 0
