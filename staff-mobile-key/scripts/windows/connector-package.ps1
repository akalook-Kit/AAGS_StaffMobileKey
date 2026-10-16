<#
  Rebuilds the Windows connector package from this project, inside the project's Docker image
  (no Node.js needed on this PC). Result: dist\connector\staff-mobile-key-connector-<version>.zip

    .\scripts\windows\connector-package.ps1
#>
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
$ErrorActionPreference = 'Continue'
$cfg = Read-SmkEnv
$image = "$($cfg.COMPOSE_PROJECT_NAME):dev"
docker compose build backend
if ($LASTEXITCODE -ne 0) { Write-Host 'Building the image failed.' -ForegroundColor Red; exit 1 }
$dist = Join-Path $Script:Root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
docker run --rm -v "${dist}:/app/dist" $image node scripts/package-connector.mjs
if ($LASTEXITCODE -ne 0) { Write-Host 'Packaging failed.' -ForegroundColor Red; exit 1 }
$folder = Join-Path $dist 'connector\staff-mobile-key-connector'
$ver = (Get-Content (Join-Path $folder 'VERSION') -TotalCount 1).Trim()
$zip = Join-Path $dist "connector\staff-mobile-key-connector-$ver.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $folder -DestinationPath $zip
Write-Host "Connector package: $zip" -ForegroundColor Green
