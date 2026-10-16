<#
  Pre-flight check: Docker is running, the chosen ports are free, and there is disk space.
  It changes nothing. Run:  .\scripts\windows\check.ps1
#>
$ErrorActionPreference = 'Continue'  # native tools (docker) write progress to stderr; we check exit codes instead
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
Initialize-SmkEnv
$cfg = Read-SmkEnv
$problems = 0

Write-Step "Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "  Docker is not installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/" -ForegroundColor Red; exit 1
}
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "  Docker Desktop is not running. Start it and wait for 'Engine running'." -ForegroundColor Red; exit 1 }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "  'docker compose' is missing. Update Docker Desktop." -ForegroundColor Red; exit 1 }
Write-Host "  OK  Docker is running" -ForegroundColor Green

Write-Step "Ports (project '$($cfg.COMPOSE_PROJECT_NAME)')"
if (Test-ProjectRunning $cfg) {
  Write-Host "  This project is already running; its own ports are in use by it, which is fine." -ForegroundColor Green
} else {
  $ports = [ordered]@{ 'Portal and API' = $cfg.SMK_PORTAL_PORT; 'Lock simulator' = $cfg.SMK_SIM_PORT; 'Connector admin page' = $cfg.SMK_CONNECTOR_PORT; 'Phone app dev server' = $cfg.SMK_EXPO_PORT; 'Simulated Visionline (local connector)' = $cfg.SMK_VL_PORT }
  foreach ($name in $ports.Keys) {
    $p = [int]$ports[$name]
    $conn = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
      $proc = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).ProcessName
      Write-Host ("  BUSY {0,-22} port {1} is used by '{2}'. Pick another number in .env." -f $name, $p, $proc) -ForegroundColor Red
      $problems++
    } else {
      Write-Host ("  OK   {0,-22} port {1} is free" -f $name, $p) -ForegroundColor Green
    }
  }
}

Write-Step "Disk space"
$drive = (Get-Item $Script:Root).PSDrive
$freeGb = [math]::Round($drive.Free / 1GB, 1)
if ($freeGb -lt 5) { Write-Host "  Only $freeGb GB free on $($drive.Name):. About 5 GB is needed the first time." -ForegroundColor Red; $problems++ }
else { Write-Host "  OK  $freeGb GB free on $($drive.Name):" -ForegroundColor Green }

Write-Step "Name clash check"
$other = docker ps -a --format '{{.Names}}' | Where-Object { $_ -like "$($cfg.COMPOSE_PROJECT_NAME)-*" }
if ($other -and -not (Test-ProjectRunning $cfg)) { Write-Host "  Stopped containers from an earlier run exist ($($other.Count)); they will be reused." }
else { Write-Host "  OK  Every container, volume and network is prefixed '$($cfg.COMPOSE_PROJECT_NAME)'" -ForegroundColor Green }

if ($problems -gt 0) { Write-Host ""; Write-Host "Fix the items above, then run start.ps1." -ForegroundColor Red; exit 1 }
Write-Host ""; Write-Host "All checks passed." -ForegroundColor Green
exit 0
