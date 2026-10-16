<#
  Runs the automated acceptance checks INSIDE the backend container (no Node.js needed on your PC).
    .\scripts\windows\test.ps1          # full run, about 4 minutes
    .\scripts\windows\test.ps1 -Fast    # skips the 2-minute expiry check
#>
param([switch]$Fast)
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
$fastValue = if ($Fast) { '1' } else { '0' }
docker compose exec -T -e API_URL=http://localhost:4000 -e SIM_URL=http://simulator:8444 -e E2E_FAST=$fastValue backend npx tsx /app/scripts/e2e.ts
exit $LASTEXITCODE
