<#
  Staff Mobile Key - database tools for the on-premises server. Run as administrator.

    .\database-tools.ps1 -Action Size                         size of the database and its largest tables
    .\database-tools.ps1 -Action Copy -Destination E:\        a full copy (USB disk, network share ...), checked after writing
    .\database-tools.ps1 -Action Verify -File E:\smk-copy-20261015-0800.dump    check a copy can be read back
    .\database-tools.ps1 -Action Optimize                     clean up and refresh statistics (VACUUM ANALYZE), safe while running
    .\database-tools.ps1 -Action Restore -File E:\smk-copy-20261015-0800.dump   put a copy back (stops the platform; asks first)

  A copy is a PostgreSQL custom-format dump (pg_dump -Fc) plus a .sha256 file with its fingerprint.
  The daily automatic backup (02:30, 14 kept) is separate: backup-onprem.ps1.
#>
param(
  [ValidateSet('Size', 'Copy', 'Verify', 'Optimize', 'Restore')][string]$Action = 'Size',
  [string]$Destination = '',
  [string]$File = '',
  [string]$PostgresBin = '',
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
function Fail([string]$t) { Write-Host $t -ForegroundColor Red; exit 1 }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator".' }
if (-not $PostgresBin) { $PostgresBin = Get-ChildItem (Join-Path $env:ProgramFiles 'PostgreSQL') -Directory -ErrorAction SilentlyContinue | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | ForEach-Object { Join-Path $_.FullName 'bin' } | Where-Object { Test-Path (Join-Path $_ 'pg_dump.exe') } | Select-Object -First 1 }
if (-not $PostgresBin) { Fail 'PostgreSQL tools not found; pass -PostgresBin "C:\Program Files\PostgreSQL\16\bin".' }

# Database address and password from the encrypted settings (never shown).
Add-Type -AssemblyName System.Security
$entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')
$clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $DataDir 'platform.secrets')), $entropy, 'LocalMachine')
$url = ([Text.Encoding]::UTF8.GetString($clear) -split "`n" | Where-Object { $_ -like 'DATABASE_URL=*' }) -replace '^DATABASE_URL=', ''
[Array]::Clear($clear, 0, $clear.Length)
$u = [Uri](($url.Trim()) -replace '^postgres://', 'http://')
$port = $u.Port
$env:PGPASSWORD = [Uri]::UnescapeDataString($u.UserInfo.Split(':')[1])
function Tool([string]$name) { Join-Path $PostgresBin $name }
# PostgreSQL tools write progress to standard error; Windows PowerShell must not treat that as a failure.
# Every step checks the tool's exit code instead.
$ErrorActionPreference = 'Continue'
function Show-Size {
  $q = "SELECT pg_size_pretty(pg_database_size('smk'))"
  $total = & (Tool 'psql.exe') -h 127.0.0.1 -p $port -U smk -d smk -tAc $q
  Write-Host "Database size: $total" -ForegroundColor Cyan
  & (Tool 'psql.exe') -h 127.0.0.1 -p $port -U smk -d smk -c "SELECT c.relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, GREATEST(c.reltuples, 0)::bigint AS approx_rows FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10"
  $drive = Get-PSDrive -Name C -ErrorAction SilentlyContinue
  if ($drive) {
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    $color = if ($freeGb -lt 50) { 'Red' } else { 'Green' }
    Write-Host "Free space on C: $freeGb GB" -ForegroundColor $color
  }
}
function Test-Copy([string]$path) {
  if (-not (Test-Path $path)) { Fail "$path not found." }
  Write-Host "Checking $path ..."
  $list = & (Tool 'pg_restore.exe') --list $path 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "The copy cannot be read: $($list | Select-Object -First 3)" }
  $tables = @($list | Where-Object { $_ -match ' TABLE DATA ' }).Count
  $hashFile = "$path.sha256"
  if (Test-Path $hashFile) {
    $expected = (Get-Content $hashFile -TotalCount 1).Split(' ')[0].Trim().ToLowerInvariant()
    $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail 'The copy was changed or damaged after it was made (fingerprint does not match).' }
    Write-Host '  Fingerprint matches.' -ForegroundColor Green
  } else { Write-Host '  No .sha256 file next to it; fingerprint not checked.' -ForegroundColor Yellow }
  Write-Host "  Readable: $tables tables with data." -ForegroundColor Green
}

try {
  switch ($Action) {
    'Size' { Show-Size }
    'Copy' {
      if (-not $Destination) { Fail 'Give the folder for the copy with -Destination (for example E:\ or \\nas\backups\hotel).' }
      if (-not (Test-Path $Destination)) { New-Item -ItemType Directory -Force -Path $Destination | Out-Null }
      $name = "smk-copy-$(Get-Date -Format 'yyyyMMdd-HHmm').dump"
      $target = Join-Path $Destination $name
      $tableCount = [int](& (Tool 'psql.exe') -h 127.0.0.1 -p $port -U smk -d smk -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
      Show-Size
      Write-Host "Copying to $target ..."
      $done = 0
      # pg_dump reports each table it dumps (--verbose, on standard error): shown as a progress bar.
      & (Tool 'pg_dump.exe') -h 127.0.0.1 -p $port -U smk -Fc --verbose -f $target smk 2>&1 | ForEach-Object {
        $line = "$_"
        if ($line -match 'dumping contents of table "?(?:public\.)?([^" ]+)') {
          $done++
          $pct = [math]::Min(100, [int](100 * $done / [math]::Max(1, $tableCount)))
          Write-Progress -Activity 'Copying the database' -Status "$done of $tableCount tables: $($Matches[1])" -PercentComplete $pct
        }
      }
      Write-Progress -Activity 'Copying the database' -Completed
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $target)) { Fail 'The copy failed (see the messages above). Nothing was changed in the database.' }
      $hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
      Set-Content -Path "$target.sha256" -Value "$hash  $name" -Encoding ASCII
      Test-Copy $target
      Write-Host "Copy ready: $target ($([math]::Round((Get-Item $target).Length / 1MB, 1)) MB)" -ForegroundColor Green
    }
    'Verify' { if (-not $File) { Fail 'Give the copy with -File.' }; Test-Copy $File }
    'Optimize' {
      Show-Size
      Write-Host 'Cleaning up and refreshing statistics (VACUUM ANALYZE) - the platform keeps running ...'
      & (Tool 'vacuumdb.exe') -h 127.0.0.1 -p $port -U smk -d smk --analyze --verbose 2>&1 | Where-Object { "$_" -match 'vacuuming "' } | ForEach-Object { Write-Host "  $_" }
      if ($LASTEXITCODE -ne 0) { Fail 'VACUUM failed (see above).' }
      Show-Size
    }
    'Restore' {
      if (-not $File) { Fail 'Give the copy to put back with -File.' }
      Test-Copy $File
      $ok = Read-Host "Put back $File? Everything entered since it was made is LOST. A copy of the current database is made first. Type YES"
      if ($ok -ne 'YES') { Write-Host 'Nothing changed.'; exit 1 }
      $safety = Join-Path $DataDir "backups\before-restore-$(Get-Date -Format 'yyyyMMdd-HHmm').dump"
      & (Tool 'pg_dump.exe') -h 127.0.0.1 -p $port -U smk -Fc -f $safety smk
      if ($LASTEXITCODE -ne 0) { Fail 'Could not save the current database first; nothing was changed.' }
      Write-Host "  Current database saved to $safety"
      foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform') { $s = Get-Service $svc -ErrorAction SilentlyContinue; if ($s -and $s.Status -ne 'Stopped') { Stop-Service $svc -Force } }
      & (Tool 'pg_restore.exe') -h 127.0.0.1 -p $port -U smk -d smk --clean --if-exists --no-owner $File
      $code = $LASTEXITCODE
      Start-Service StaffMobileKeyPlatform; Start-Service StaffMobileKeyGateway
      if ($code -ne 0) { Write-Host "pg_restore reported problems (exit $code). Check the portal; the previous database is in $safety." -ForegroundColor Yellow } else { Write-Host 'Restored. The platform is running again.' -ForegroundColor Green }
    }
  }
} finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
