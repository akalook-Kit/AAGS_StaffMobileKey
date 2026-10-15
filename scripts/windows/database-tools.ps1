<#
  Database tools for the TEST environment on this PC (Docker). For the on-premises server use
  database-tools.ps1 in C:\Program Files\StaffMobileKey\Platform instead.

    .\scripts\windows\database-tools.ps1 -Action Size
    .\scripts\windows\database-tools.ps1 -Action Copy                    copy to C:\khb\backups\db-copies (checked after writing)
    .\scripts\windows\database-tools.ps1 -Action Copy -Destination E:\   copy to a USB disk
    .\scripts\windows\database-tools.ps1 -Action Optimize                VACUUM ANALYZE
    .\scripts\windows\database-tools.ps1 -Action Restore -File C:\khb\backups\db-copies\smk-copy-....dump
#>
param(
  [ValidateSet('Size', 'Copy', 'Optimize', 'Restore')][string]$Action = 'Size',
  [string]$Destination = 'C:\khb\backups\db-copies',
  [string]$File = ''
)
$ErrorActionPreference = 'Continue'  # docker writes progress to stderr; exit codes are checked instead
. "$PSScriptRoot\common.ps1"
Set-Location $Script:Root
function Fail([string]$t) { Write-Host $t -ForegroundColor Red; exit 1 }
docker compose exec -T db pg_isready -U smk *> $null
if ($LASTEXITCODE -ne 0) { Fail 'The test database is not running. Start it with .\scripts\windows\start.ps1' }
function Show-Size {
  Write-Host ("Database size: " + (docker compose exec -T db psql -U smk -d smk -tAc "SELECT pg_size_pretty(pg_database_size('smk'))").Trim()) -ForegroundColor Cyan
  docker compose exec -T db psql -U smk -d smk -c "SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, GREATEST(c.reltuples, 0)::bigint AS approx_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10"
  $c = Get-PSDrive -Name C -ErrorAction SilentlyContinue
  if ($c) { $gb = [math]::Round($c.Free / 1GB, 1); Write-Host "Free space on C: $gb GB" -ForegroundColor $(if ($gb -lt 50) { 'Red' } else { 'Green' }) }
}
switch ($Action) {
  'Size' { Show-Size }
  'Copy' {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $name = "smk-copy-$(Get-Date -Format 'yyyyMMdd-HHmm').dump"
    $target = Join-Path $Destination $name
    Show-Size
    Write-Host "Copying to $target ..."
    docker compose exec -T db pg_dump -U smk -d smk -Fc -f /tmp/smk-copy.dump
    if ($LASTEXITCODE -ne 0) { Fail 'pg_dump failed.' }
    # Relative file names: "C:\..." would be read by docker as a container name.
    $compose = Join-Path $Script:Root 'docker-compose.yml'
    Push-Location $Destination
    docker compose -f $compose --project-directory $Script:Root cp db:/tmp/smk-copy.dump $name
    $cpOk = $LASTEXITCODE -eq 0
    Pop-Location
    docker compose exec -T db rm -f /tmp/smk-copy.dump *> $null
    if (-not $cpOk -or -not (Test-Path $target)) { Fail 'Copying the file out of the container failed.' }
    $hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path "$target.sha256" -Value "$hash  $name" -Encoding ASCII
    # Check the copy can be read back: list its contents inside the container.
    Push-Location $Destination
    docker compose -f $compose --project-directory $Script:Root cp $name db:/tmp/smk-check.dump | Out-Null
    Pop-Location
    $tables = @(docker compose exec -T db pg_restore --list /tmp/smk-check.dump | Where-Object { $_ -match ' TABLE DATA ' }).Count
    docker compose exec -T db rm -f /tmp/smk-check.dump *> $null
    if ($tables -lt 1) { Fail 'The copy could not be read back.' }
    Write-Host "Copy ready and checked ($tables tables): $target ($([math]::Round((Get-Item $target).Length / 1MB, 1)) MB)" -ForegroundColor Green
  }
  'Optimize' { docker compose exec -T db vacuumdb -U smk -d smk --analyze; Show-Size }
  'Restore' {
    if (-not $File -or -not (Test-Path $File)) { Fail 'Give the copy with -File.' }
    if (Test-Path "$File.sha256") {
      $expected = (Get-Content "$File.sha256" -TotalCount 1).Split(' ')[0].Trim().ToLowerInvariant()
      if ((Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { Fail 'The copy was changed or damaged (fingerprint does not match). Nothing was changed.' }
    }
    $ok = Read-Host "Put back $File into the TEST database? Everything since is lost. Type YES"
    if ($ok -ne 'YES') { Write-Host 'Nothing changed.'; exit 1 }
    docker compose stop backend connector | Out-Null
    $compose = Join-Path $Script:Root 'docker-compose.yml'
    $full = (Resolve-Path $File).Path
    Push-Location (Split-Path $full -Parent)
    docker compose -f $compose --project-directory $Script:Root cp (Split-Path $full -Leaf) db:/tmp/smk-restore.dump | Out-Null
    Pop-Location
    docker compose exec -T db pg_restore -U smk -d smk --clean --if-exists --no-owner /tmp/smk-restore.dump
    docker compose exec -T db rm -f /tmp/smk-restore.dump *> $null
    docker compose start backend connector | Out-Null
    Write-Host 'Restored. The test platform is starting again.' -ForegroundColor Green
  }
}
