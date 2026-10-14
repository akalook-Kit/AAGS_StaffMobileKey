<#
  Builds and starts the K Hotel staff key test environment, then opens the portal.
    .\scripts\windows\start.ps1           # this PC only (recommended)
    .\scripts\windows\start.ps1 -Phone    # also reachable from a phone on the same Wi-Fi
    .\scripts\windows\start.ps1 -Local    # switch back to this-PC-only
    .\scripts\windows\start.ps1 -NativeConnector   # use the connector installed on this PC as a Windows service
    .\scripts\windows\start.ps1 -DockerConnector   # back to the built-in connector container
#>
param([switch]$Phone, [switch]$Local, [switch]$NoBrowser, [switch]$NativeConnector, [switch]$DockerConnector)
$ErrorActionPreference = 'Continue'  # native tools (docker) write progress to stderr; we check exit codes instead
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
Initialize-SmkEnv
if ($Phone) { Set-SmkEnvValue 'SMK_BIND' '0.0.0.0'; Write-Host "Phone testing on: portal and simulator reachable from your Wi-Fi." -ForegroundColor Yellow }
if ($Local) { Set-SmkEnvValue 'SMK_BIND' '127.0.0.1' }
if ($NativeConnector) { Set-SmkEnvValue 'SMK_CONNECTOR' 'native' }
if ($DockerConnector) { Set-SmkEnvValue 'SMK_CONNECTOR' 'docker' }
$cfg = Read-SmkEnv
$native = ($cfg.SMK_CONNECTOR -eq 'native')

& "$PSScriptRoot\check.ps1"
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Step "Building and starting (first run: 5-10 minutes)"
if ($native) {
  # Two connectors for one hotel would both take commands: keep the container stopped.
  docker compose up -d --build db simulator backend
  $code = $LASTEXITCODE
  docker compose stop connector 2>$null | Out-Null
} else {
  docker compose up -d --build
  $code = $LASTEXITCODE
}
if ($code -ne 0) { Write-Host "docker compose failed. See the messages above." -ForegroundColor Red; exit 1 }

Write-Step "Waiting for the portal"
$url = "http://localhost:$($cfg.SMK_PORTAL_PORT)"
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { $r = Invoke-WebRequest "$url/healthz" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
  Start-Sleep -Seconds 2
  Write-Host -NoNewline "."
}
Write-Host ""
if (-not $ok) { Write-Host "The portal did not answer yet. Check: docker compose logs backend" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Ready." -ForegroundColor Green
Write-Host ("  Portal           {0}   (admin@khb.test / ChangeMe!2026)" -f $url)
Write-Host ("  Lock simulator   http://localhost:{0}" -f $cfg.SMK_SIM_PORT)
if ($native) {
  # Give the Windows-service connector the simulator's certificate authority, so it can verify "Visionline".
  $lt = Join-Path $Script:Root 'local-test'
  New-Item -ItemType Directory -Force -Path $lt | Out-Null
  Push-Location $lt
  docker compose cp simulator:/certs/ca.crt visionline-sim-ca.crt 2>$null | Out-Null
  Pop-Location
  Write-Host  "  Connector        the Windows service on this PC (built-in connector container stopped)"
  Write-Host ("  Simulated Visionline for it: https://localhost:{0}/api/v1   certificate: {1}" -f $cfg.SMK_VL_PORT, (Join-Path $lt 'visionline-sim-ca.crt'))
  Write-Host  "  Install/upgrade it: see docs\CONNECTOR-LOCAL-TEST.md"
} else {
  Write-Host ("  Connector page   http://localhost:{0}   (admin / local-admin)" -f $cfg.SMK_CONNECTOR_PORT)
}
Write-Host "  Stop with:       .\scripts\windows\stop.ps1"
if (-not $NoBrowser) { Start-Process $url }
