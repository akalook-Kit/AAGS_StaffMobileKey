# Shows what is running for this project and where to open it.
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
Initialize-SmkEnv
$cfg = Read-SmkEnv
$ver = if (Test-Path (Join-Path $Script:Root 'VERSION')) { (Get-Content (Join-Path $Script:Root 'VERSION') -Raw).Trim() } else { 'unknown' }
Write-Host "Staff Mobile Key version $ver in $Script:Root" -ForegroundColor Cyan
docker compose ps
Write-Host ""
Write-Host ("Portal  http://localhost:{0}    Simulator  http://localhost:{1}    Connector  http://localhost:{2}" -f $cfg.SMK_PORTAL_PORT, $cfg.SMK_SIM_PORT, $cfg.SMK_CONNECTOR_PORT)
Write-Host ("Reachable from: {0}" -f $(if ($cfg.SMK_BIND -eq '0.0.0.0') { 'this PC and your Wi-Fi (phone testing)' } else { 'this PC only' }))
