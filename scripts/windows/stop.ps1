<#
  Stops the test environment. Other apps and containers on your PC are not touched.
    .\scripts\windows\stop.ps1            # stop, keep data
    .\scripts\windows\stop.ps1 -Remove    # remove containers and network, keep data
    .\scripts\windows\stop.ps1 -Purge     # remove containers, network, data volumes and this project's image
#>
param([switch]$Remove, [switch]$Purge)
$ErrorActionPreference = 'Continue'  # native tools (docker) write progress to stderr; we check exit codes instead
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
Initialize-SmkEnv
if ($Purge) {
  $answer = Read-Host "Delete ALL test data of this project (keys, staff, audit)? Type YES"
  if ($answer -ne 'YES') { Write-Host "Cancelled."; exit 0 }
  docker compose down -v --rmi local
} elseif ($Remove) { docker compose down }
else { docker compose stop }
Write-Host "Done." -ForegroundColor Green
