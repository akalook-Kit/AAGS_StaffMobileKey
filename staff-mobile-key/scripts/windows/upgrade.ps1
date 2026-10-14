<#
  Upgrades an installed copy to THIS version, after saving a full backup of the installed one.
  Run it from the NEW version (the unzipped download), not from the installed folder:

    powershell -ExecutionPolicy Bypass -File <unzipped>\staff-mobile-key\scripts\windows\upgrade.ps1

  What it does:
    1. Saves the installed files (including .env) and the test data (database, connector keys,
       simulator certificates) to C:\khb\backups\staff-mobile-key-<old version>-<date-time>.
    2. Stops the containers, replaces the program files, keeps .env (adds any new settings).
    3. Starts the new version (the database updates itself) and shows the result.
  Undo with rollback.ps1 (the command is printed at the end and saved in the backup folder).

  -Target          Installed project folder. Default C:\khb\staff-mobile-key\staff-mobile-key
  -BackupRoot      Where backups go. Default C:\khb\backups
  -SkipDataBackup  Back up files only (faster; rollback then cannot restore the data)
  -NoStart         Replace the files but do not start
#>
param(
  [string]$Target = 'C:\khb\staff-mobile-key\staff-mobile-key',
  [string]$BackupRoot = 'C:\khb\backups',
  [switch]$SkipDataBackup,
  [switch]$NoStart
)
$ErrorActionPreference = 'Continue'  # docker writes progress to stderr; exit codes are checked instead
$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Write-Step([string]$t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { Write-Host ""; Write-Host $t -ForegroundColor Red; exit 1 }
function Get-Version([string]$dir) { $f = Join-Path $dir 'VERSION'; if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { '2.0' } }
function Read-EnvFile([string]$file) {
  $h = @{}
  if (Test-Path $file) { foreach ($l in Get-Content $file) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $h[$Matches[1]] = $Matches[2].Trim() } } }
  return $h
}
function Invoke-Robocopy([string]$from, [string]$to, [string[]]$extra) {
  $rcArgs = @($from, $to) + $extra + @('/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  & robocopy @rcArgs | Out-Null
  return ($LASTEXITCODE -lt 8)   # robocopy: 0-7 = success, 8+ = failure
}

# ---- Checks -------------------------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $Source 'docker-compose.yml'))) { Fail "This script must run from the unzipped new version (docker-compose.yml not found in $Source)." }
if (-not (Test-Path (Join-Path $Target 'docker-compose.yml'))) { Fail "No installed copy found in $Target. Pass the right folder with -Target, or for a first installation follow docs\WINDOWS-SETUP.md." }
$Target = (Resolve-Path $Target).Path
if ($Source.TrimEnd('\') -ieq $Target.TrimEnd('\')) { Fail "You are running the installed copy. Run upgrade.ps1 from the NEW unzipped version instead (see docs\UPGRADING.md)." }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running. Start it, wait for 'Engine running', then run this again." }

$oldVer = Get-Version $Target
$newVer = Get-Version $Source
$envFile = Join-Path $Target '.env'
$cfg = Read-EnvFile $envFile
$project = if ($cfg.COMPOSE_PROJECT_NAME) { $cfg.COMPOSE_PROJECT_NAME } else { 'khb-staffkey' }
Write-Host "Upgrade Staff Mobile Key $oldVer -> $newVer" -ForegroundColor Green
Write-Host "  Installed folder: $Target"
Write-Host "  New version from: $Source"

function Invoke-Compose { & docker compose -f (Join-Path $Target 'docker-compose.yml') --env-file $envFile --project-directory $Target @args }

# ---- 1. Backup ----------------------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$backup = Join-Path $BackupRoot "staff-mobile-key-$oldVer-$stamp"
Write-Step "Saving the installed version to $backup"
New-Item -ItemType Directory -Force -Path (Join-Path $backup 'files') | Out-Null
if (-not (Invoke-Robocopy $Target (Join-Path $backup 'files') @('/E', '/XD', 'node_modules', '.expo', '.git', (Join-Path $Target 'apps\portal\dist')))) { Fail "Copying the installed files to the backup failed. Nothing was changed." }
Write-Host "  Program files and .env saved."

$dataSaved = $false
if (-not $SkipDataBackup) {
  $dataDir = Join-Path $backup 'data'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Invoke-Compose up -d db *> $null
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) { Invoke-Compose exec -T db pg_isready -U smk *> $null; if ($LASTEXITCODE -eq 0) { $ready = $true; break }; Start-Sleep -Seconds 2 }
  if (-not $ready) { Fail "The database did not start, so the data could not be saved. Nothing was changed. Try again, or use -SkipDataBackup." }
  Invoke-Compose exec -T db pg_dump -U smk -d smk -Fc -f /tmp/smk-backup.dump
  if ($LASTEXITCODE -ne 0) { Fail "Saving the database failed. Nothing was changed." }
  Push-Location $dataDir
  Invoke-Compose cp db:/tmp/smk-backup.dump smk.dump
  $cpOk = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $dataDir 'smk.dump'))
  Pop-Location
  Invoke-Compose exec -T db rm -f /tmp/smk-backup.dump *> $null
  if (-not $cpOk) { Fail "Copying the database backup failed. Nothing was changed." }
  Write-Host "  Database saved ($([math]::Round((Get-Item (Join-Path $dataDir 'smk.dump')).Length / 1KB)) KB)."
  foreach ($vol in @('connector-data', 'certs')) {
    $name = "${project}_$vol"
    docker volume inspect $name *> $null
    if ($LASTEXITCODE -ne 0) { continue }
    docker run --rm -v "${name}:/v:ro" -v "${dataDir}:/b" postgres:16 tar czf "/b/$vol.tgz" -C /v . *> $null
    if ($LASTEXITCODE -ne 0) { Fail "Saving the $vol volume failed. Nothing was changed." }
    Write-Host "  Volume $vol saved."
  }
  $dataSaved = $true
}

$rollbackCmd = "powershell -ExecutionPolicy Bypass -File `"$Target\scripts\windows\rollback.ps1`" -Backup `"$backup`""
@(
  "Staff Mobile Key backup taken before upgrading $oldVer -> $newVer on $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
  "Installed folder: $Target",
  "files\  program files and .env of version $oldVer",
  $(if ($dataSaved) { "data\   database (smk.dump), connector keys (connector-data.tgz), simulator certificates (certs.tgz)" } else { "data\   not saved (-SkipDataBackup)" }),
  "",
  "To go back to version ${oldVer}:",
  "  $rollbackCmd"
) | Set-Content -Path (Join-Path $backup 'backup-info.txt') -Encoding ASCII

# ---- 2. Stop and replace -------------------------------------------------------------------------------
Write-Step "Stopping the running version"
Invoke-Compose stop *> $null
Write-Host "  Stopped (data kept)."

Write-Step "Installing version $newVer"
# /MIR makes the folder match the new version. Kept: .env, your git history (.git), the probe reports,
# local-test certificates, built packages (dist) and installed phone packages.
$ok = Invoke-Robocopy $Source $Target @('/MIR', '/XF', '.env', '/XD', 'node_modules', '.expo', '.git', 'dist', 'backups', 'local-test', (Join-Path $Target 'visionline-probe-report'), (Join-Path $Source 'visionline-probe-report'))
if (-not $ok) { Fail "Copying the new files failed. Restore the previous version with:`n  $rollbackCmd" }
Get-ChildItem -Path $Target -Recurse -Filter *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# New settings introduced by this version are added to .env with their defaults; your values are kept.
$example = Read-EnvFile (Join-Path $Target '.env.example')
$added = @()
foreach ($k in $example.Keys) { if (-not $cfg.ContainsKey($k)) { Add-Content -Path $envFile -Value "$k=$($example[$k])" -Encoding ASCII; $added += $k } }
if ($added.Count) { Write-Host "  New settings added to .env: $($added -join ', ')" } else { Write-Host "  .env kept unchanged." }
Write-Host "  Files replaced."

# ---- 3. Start ------------------------------------------------------------------------------------------
if ($NoStart) {
  Write-Host ""; Write-Host "Version $newVer installed (not started). Start with: $Target\scripts\windows\start.ps1" -ForegroundColor Green
} else {
  Write-Step "Starting version $newVer (rebuilds the image: a few minutes)"
  Set-Location $Target
  & (Join-Path $Target 'scripts\windows\start.ps1')
  if ($LASTEXITCODE -ne 0) { Fail "The new version did not start. Read the messages above. To go back:`n  $rollbackCmd" }
}

Write-Host ""
Write-Host "Upgrade to $newVer finished. Backup of $oldVer`: $backup" -ForegroundColor Green
Write-Host "If something is wrong, go back with:"
Write-Host "  $rollbackCmd" -ForegroundColor Yellow
Write-Host "You can delete the unzipped download folder now."
exit 0
