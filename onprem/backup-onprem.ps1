<#
  Staff Mobile Key - database backup (pg_dump, custom format). Run by the scheduled task "Staff Mobile Key
  backup" every day at 02:30 as SYSTEM; you can also run it yourself as administrator. Keeps the newest 14.
  Restore (stops the services first):  see README.txt, "Restoring a backup".
#>
param(
  [string]$PostgresBin = '',
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform'),
  [int]$Keep = 14
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
if (-not $PostgresBin) { $PostgresBin = Get-ChildItem (Join-Path $env:ProgramFiles 'PostgreSQL') -Directory | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | ForEach-Object { Join-Path $_.FullName 'bin' } | Select-Object -First 1 }
$entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')
$clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $DataDir 'platform.secrets')), $entropy, 'LocalMachine')
$url = ([Text.Encoding]::UTF8.GetString($clear) -split "`n" | Where-Object { $_ -like 'DATABASE_URL=*' }) -replace '^DATABASE_URL=', ''
[Array]::Clear($clear, 0, $clear.Length)
$u = [Uri](($url.Trim()) -replace '^postgres://', 'http://')
$dir = Join-Path $DataDir 'backups'
$file = Join-Path $dir ("smk-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
$env:PGPASSWORD = [Uri]::UnescapeDataString($u.UserInfo.Split(':')[1])
try { & (Join-Path $PostgresBin 'pg_dump.exe') -h 127.0.0.1 -p $u.Port -U smk -Fc -f $file smk; $code = $LASTEXITCODE }
finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
$log = Join-Path $DataDir 'logs\backup.log'
if ($code -ne 0) { Add-Content $log "$(Get-Date -Format s) FAILED (pg_dump exit $code)"; exit 1 }
Get-ChildItem $dir -Filter 'smk-*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep | Remove-Item -Force
Add-Content $log "$(Get-Date -Format s) OK $file $((Get-Item $file).Length) bytes"
