<#
  Read-only check of the hotel's Credential Services (SEOS) account: are the user and password accepted,
  and is the System ID reachable? GET requests only; nothing is created, changed or deleted.
  The password is typed into the check (not shown) and never stored. Runs inside the project's Docker image.

    .\scripts\windows\cs-check.ps1 -User k_-_hotel_bana-lhtgdm7qp6jsbsm -SystemId 3460

  -Url       Default https://hospitality.credential-services.api.assaabloy.com (from Visionline Options -> Mobile Access)
#>
param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$SystemId = '',
  [string]$Url = 'https://hospitality.credential-services.api.assaabloy.com'
)
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
$ErrorActionPreference = 'Continue'
$cfg = Read-SmkEnv
$image = "$($cfg.COMPOSE_PROJECT_NAME):dev"
docker image inspect $image *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "The image $image is not built yet. Run .\scripts\windows\start.ps1 once first." -ForegroundColor Red; exit 1 }
$a = @('run', '--rm', '-it', '-w', '/app/apps/backend', $image, 'npx', 'tsx', 'src/tools/cs-check.ts', '--url', $Url, '--user', $User)
if ($SystemId) { $a += @('--system', $SystemId) }
docker @a
exit $LASTEXITCODE
