<#
  Access Monitoring Tool - ON-PREMISES installation on the Visionline (Vingcard) server of ANY hotel.
  Easiest: double-click Install.cmd (it asks for administrator rights and runs this script).

  Everything it needs is inside this package: its own Node.js and PostgreSQL, used only by Access Monitoring Tool.
  Nothing is installed system-wide, nothing is downloaded, and no questions are asked. At the end the portal
  opens on the first-run setup page, where the hotel's details and the first administrator are entered.

  Re-run it (Install.cmd) to UPGRADE: settings, secrets, the database, the external access and the
  certificate are kept, and a copy of the database is made first.

  What it installs (nothing listens on the internet except the gateway's external port, and only for the
  addresses you allow):
    StaffMobileKeyDatabase  (service) -> PostgreSQL 16 (bundled), 127.0.0.1 only, data in ProgramData
    StaffMobileKeyPlatform  (service) -> the platform and portal, on 127.0.0.1 only (port 47300, or the next free one)
    StaffMobileKeyGateway   (service) -> HTTPS for the hotel network (LAN) and, optionally, an external port
    StaffMobileKeyConnector (service) -> the hotel connector, talking to Visionline and to the platform on 127.0.0.1
    A daily database copy (made by the platform, 02:30)

  Options (all optional):
    -ServerName      Name (or IP) staff use for this server on the hotel network (default: this computer's name).
    -LanPort         HTTPS port for the hotel network. Default 8443 (kept on upgrade).
    -PlatformPort    Internal port of the platform on 127.0.0.1 (not reachable from other computers). Default: 47300,
                     or the next free port. Kept on upgrade; installations from before 2.11 that used 4000 (often
                     used by PMS interfaces) are moved off it automatically.
    -ExternalPort / -AllowExternal / -RemoveExternal   Outside access (see set-external-access.ps1 to change later).
    -CertPfx         A real certificate (PFX) for -ServerName. Without it a self-signed certificate is made.
    -VisionlineUrl   Visionline Web API. Default https://localhost/api/v1 (Visionline on this server).
    -CaFile          Visionline's certificate (or its CA), if it cannot be read from this server automatically.
    -ReadOnly -NoWatch  ONLY for testing against a Visionline that is not the hotel's own.
    -SkipConnector   Do not install the connector (it runs on another computer: see set-connector-access.ps1).
    -ConnectorFrom   Address of that connector computer, e.g. 192.168.1.50 (also kept on upgrades).
    -NoBrowser       Do not open the portal at the end.
  Older installations that used a separately installed PostgreSQL keep using it; nothing to do.
#>
param(
  [string]$ServerName = '',
  [int]$LanPort = 8443,
  [int]$PlatformPort = 0,
  [int]$ExternalPort = 0,
  [string]$AllowExternal = '',
  [switch]$RemoveExternal,
  [string]$CertPfx = '',
  [switch]$SkipConnector,
  # 2.16 Address of a connector on another computer of the hotel network (see set-connector-access.ps1).
  [string]$ConnectorFrom = '',
  [string]$VisionlineUrl = '',
  [string]$CaFile = '',
  [switch]$ReadOnly,
  [switch]$NoWatch,
  [switch]$NoBrowser,
  # Kept for scripted installations; normally the hotel is entered in the portal.
  [string]$HotelName = '', [string]$HotelCode = '', [string]$TimeZone = '', [string]$Country = '', [string]$SystemId = '',
  [string]$SupportEmail = '', [string]$SupportPhone = '',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'),
  [string]$RuntimeDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Runtime'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$log = $null
function Write-Step([string]$t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) {
  Write-Host ""; Write-Host $t -ForegroundColor Red
  if ($log) { Write-Host "Installation log: $log" -ForegroundColor Yellow }
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
function New-RandomText([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function New-SetupCode {
  # 12 characters without look-alikes (no 0/O, 1/I/L), shown as XXXX-XXXX-XXXX. About 59 bits.
  $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  $b = New-Object byte[] 12
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  $c = -join ($b | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  return "$($c.Substring(0,4))-$($c.Substring(4,4))-$($c.Substring(8,4))"
}
function Get-Sha256Hex([string]$text) {
  $h = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($text))
  return ([BitConverter]::ToString($h)).Replace('-', '').ToLowerInvariant()
}
Add-Type -AssemblyName System.Security
$Entropy = [Text.Encoding]::UTF8.GetBytes('StaffMobileKey.OnPrem.v1')   # same as service\NodeService.cs
function Read-Protected([string]$path) {
  $map = [ordered]@{}
  if (-not (Test-Path $path)) { return $map }
  $clear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $Entropy, 'LocalMachine')
  foreach ($line in ([Text.Encoding]::UTF8.GetString($clear) -split "`n")) {
    $l = $line.Trim("`r", ' ')
    if ($l -and -not $l.StartsWith('#') -and $l.Contains('=')) { $i = $l.IndexOf('='); $map[$l.Substring(0, $i)] = $l.Substring($i + 1) }
  }
  [Array]::Clear($clear, 0, $clear.Length)
  return $map
}
function Write-Protected([string]$path, $map, [switch]$AdminsOnly) {
  $text = ($map.Keys | ForEach-Object { "$_=$($map[$_])" }) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  [IO.File]::WriteAllBytes($path, [Security.Cryptography.ProtectedData]::Protect($bytes, $Entropy, 'LocalMachine'))
  [Array]::Clear($bytes, 0, $bytes.Length)
  # SYSTEM and Administrators full control, the service account (LOCAL SERVICE) read; nobody else.
  if ($AdminsOnly) { & icacls $path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null }
  else { & icacls $path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null }
}
function Write-Utf8NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }
function Read-EnvFile([string]$path) {
  $map = [ordered]@{}
  if (Test-Path $path) { foreach ($line in (Get-Content $path)) { $l = $line.Trim(); if ($l -and -not $l.StartsWith('#') -and $l.Contains('=')) { $i = $l.IndexOf('='); $map[$l.Substring(0, $i)] = $l.Substring($i + 1) } } }
  return $map
}
function Stop-Svc([string]$name) {
  $s = Get-Service $name -ErrorAction SilentlyContinue
  if ($s -and $s.Status -ne 'Stopped') { Stop-Service $name -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
}
function Test-Port([int]$port) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true } catch { return $false }
}
function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) { if (Test-Port $port) { return $true }; Start-Sleep -Seconds 1 }
  return $false
}

# ---- Checks ---------------------------------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Run Install.cmd (or open PowerShell with "Run as administrator") and try again.' }
if (-not (Test-Path (Join-Path $here 'app\platform.mjs'))) { Fail "Run this from the unzipped package folder (app\platform.mjs not found next to install-onprem.ps1)." }
$version = (Get-Content (Join-Path $here 'VERSION') -TotalCount 1).Trim()
$os = [Environment]::OSVersion.Version
if ($os.Major -lt 10) { Fail 'Windows Server 2016 / Windows 10 or newer is needed.' }
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'A 64-bit Windows is needed.' }
New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir 'logs') | Out-Null
# SYSTEM and Administrators only; the platform account (LOCAL SERVICE) may read, and write its logs.
& icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
& icacls (Join-Path $DataDir 'logs') /grant '*S-1-5-19:(OI)(CI)M' | Out-Null
# The database service (NETWORK SERVICE) may look into this folder itself (no rights on the files in it).
& icacls $DataDir /grant '*S-1-5-20:(RX)' | Out-Null
$log = Join-Path $DataDir "logs\install-$version-$(Get-Date -Format yyyyMMdd-HHmmss).log"
try { Start-Transcript -Path $log -Force | Out-Null } catch { $log = $null }
Write-Host "Access Monitoring Tool on-premises $version" -ForegroundColor Green

$pkgNode = Join-Path $here 'runtime\node\node.exe'
$pkgPg = Join-Path $here 'runtime\pgsql\bin'
foreach ($f in $pkgNode, (Join-Path $pkgPg 'postgres.exe'), (Join-Path $pkgPg 'initdb.exe'), (Join-Path $pkgPg 'pg_ctl.exe')) {
  if (-not (Test-Path $f)) { Fail "The package is incomplete ($f is missing). Unzip the whole package again." }
}
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { Fail "The .NET Framework 4.8 C# compiler (part of Windows) was not found. Enable '.NET Framework 4.8' in Windows Features." }
$free = (Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free
if ($free -lt 2GB) { Fail "Less than 2 GB free on $env:SystemDrive. Free some space first." }

$oldEnv = Read-EnvFile (Join-Path $DataDir 'platform.env')
$gwCfgFile = Join-Path $DataDir 'gateway.config.json'
$oldGw = if (Test-Path $gwCfgFile) { Get-Content $gwCfgFile -Raw | ConvertFrom-Json } else { $null }
$secretsFile = Join-Path $DataDir 'platform.secrets'
$upgrade = Test-Path $secretsFile
$secrets = Read-Protected $secretsFile
$bundledDb = (-not $upgrade) -or ($secrets['SMK_DB'] -eq 'bundled')
Write-Host "  $(if ($upgrade) { 'Upgrading the existing installation' } else { 'New installation' })"
Write-Host "  Program:  $InstallDir"
Write-Host "  Runtime:  $RuntimeDir (Node.js and PostgreSQL used only by Access Monitoring Tool)"
Write-Host "  Data:     $DataDir"

# Hotel: only for scripted installations (normally entered in the portal), or remembered from an older version.
$hotel = [ordered]@{}
foreach ($k in 'HOTEL_NAME', 'PROVISION_HOTEL', 'HOTEL_TIMEZONE', 'HOTEL_COUNTRY', 'HOTEL_SYSTEM_ID', 'HOTEL_SUPPORT_EMAIL', 'HOTEL_SUPPORT_PHONE') { if ($oldEnv[$k]) { $hotel[$k] = $oldEnv[$k] } }
if ($HotelName) {
  $hotel['HOTEL_NAME'] = $HotelName.Trim()
  if ($HotelCode) { $hotel['PROVISION_HOTEL'] = $HotelCode.Trim().ToLowerInvariant() }
  if (-not $TimeZone -or $Country -notmatch '^[A-Za-z]{2}$') { Fail 'With -HotelName also give -TimeZone (e.g. Africa/Nairobi) and -Country (e.g. KE). Or leave all three out and enter them in the portal.' }
  $hotel['HOTEL_TIMEZONE'] = $TimeZone.Trim(); $hotel['HOTEL_COUNTRY'] = $Country.Trim().ToUpperInvariant()
  if ($SystemId) { if ($SystemId -notmatch '^\d+$') { Fail '-SystemId must be a number.' }; $hotel['HOTEL_SYSTEM_ID'] = $SystemId.Trim() }
  if ($SupportEmail) { $hotel['HOTEL_SUPPORT_EMAIL'] = $SupportEmail.Trim() }
  if ($SupportPhone) { $hotel['HOTEL_SUPPORT_PHONE'] = $SupportPhone.Trim() }
}

# Network: given now, or kept from the last installation.
if (-not $ServerName) { $ServerName = if ($oldEnv['SMK_SERVER_NAME']) { $oldEnv['SMK_SERVER_NAME'] } else { $env:COMPUTERNAME.ToLowerInvariant() } }
$oldLan = if ($oldGw) { @($oldGw.listeners | Where-Object { $_.name -eq 'lan' })[0] } else { $null }
$oldExt = if ($oldGw) { @($oldGw.listeners | Where-Object { $_.name -eq 'external' })[0] } else { $null }
if (-not $PSBoundParameters.ContainsKey('LanPort') -and $oldLan) { $LanPort = [int]$oldLan.port }
if ($RemoveExternal) { $ExternalPort = 0; $AllowExternal = '' }
elseif ($oldExt) {
  if ($ExternalPort -le 0) { $ExternalPort = [int]$oldExt.port }
  if (-not $AllowExternal) { $AllowExternal = (@($oldExt.allow) -join ',') }
}
if ($ExternalPort -gt 0 -and -not $AllowExternal) { Fail 'With -ExternalPort, give the public addresses allowed in with -AllowExternal (for example "41.202.219.10/32").' }
if ($ExternalPort -gt 0 -and $ExternalPort -eq $LanPort) { Fail '-ExternalPort must differ from -LanPort.' }
foreach ($a in ($AllowExternal.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  if ($a -notmatch '^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$' -and $a -notmatch '^[0-9a-fA-F:]+(/\d{1,3})?$') { Fail "-AllowExternal: '$a' is not an IP address or range (for example 41.202.219.10 or 41.202.219.0/24)." }
}
if (-not $upgrade -and (Test-Port $LanPort)) { Fail "Port $LanPort on this server is already used by another program. Choose another with -LanPort, or stop that program." }
# The platform's own port (127.0.0.1 only). 4000, the default before 2.11, is often used by PMS interfaces: never kept.
$oldPlatformPort = if ($oldEnv['PORT']) { [int]$oldEnv['PORT'] } else { 0 }
if ($PlatformPort -le 0) {
  if ($oldPlatformPort -gt 0 -and $oldPlatformPort -ne 4000) { $PlatformPort = $oldPlatformPort }
  else { $PlatformPort = 47300; while ((Test-Port $PlatformPort) -and $PlatformPort -lt 47399) { $PlatformPort++ } }
} elseif ($PlatformPort -ne $oldPlatformPort -and (Test-Port $PlatformPort)) { Fail "-PlatformPort $PlatformPort is already used by another program on this server." }
if ($PlatformPort -eq $LanPort) { Fail '-PlatformPort must differ from -LanPort.' }
$platformUrl = "http://127.0.0.1:$PlatformPort"
if ($oldPlatformPort -and $oldPlatformPort -ne $PlatformPort) { Write-Host "  The platform moves from port $oldPlatformPort to $PlatformPort (127.0.0.1 only)." -ForegroundColor Yellow }

# ---- Copy of the database before upgrading (while everything still runs) ------------------------------------
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'backups'), (Join-Path $DataDir 'tls') | Out-Null
function Invoke-Admin([string]$node, [string]$adminJs, [string[]]$adminArgs, [string]$stdin, $envMap) {
  foreach ($k in $envMap.Keys) { Set-Item "Env:\$k" $envMap[$k] }
  $env:SMK_MIGRATIONS_DIR = Join-Path (Split-Path (Split-Path $adminJs -Parent) -Parent) 'migrations'; $env:NODE_ENV = 'production'; $env:CS_CALLBACKS = 'off'
  $prevEnc = $OutputEncoding; $OutputEncoding = New-Object Text.UTF8Encoding $false
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # progress lines on standard error are not failures
  try {
    $out = $stdin | & $node $adminJs @adminArgs 2>&1 | ForEach-Object {
      if ($_ -is [Management.Automation.ErrorRecord]) {
        $line = "$_"
        if ($line -match '^PROGRESS (\d+) (.*)$') { Write-Progress -Activity 'Database' -Status $Matches[2] -PercentComplete ([int]$Matches[1]) } else { Write-Host "  $line" }
      } else { $_ }
    }
    $code = $LASTEXITCODE
  } finally {
    Write-Progress -Activity 'Database' -Completed
    $ErrorActionPreference = $prevEap; $OutputEncoding = $prevEnc
    foreach ($k in $envMap.Keys) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
    Remove-Item Env:\SMK_MIGRATIONS_DIR, Env:\NODE_ENV, Env:\CS_CALLBACKS -ErrorAction SilentlyContinue
  }
  return @{ out = ($out -join ''); code = $code }
}
$pkgAdmin = Join-Path $here 'app\admin.mjs'
if ($upgrade) {
  Write-Step 'Copy of the database before upgrading'
  $dbSvc = Get-Service StaffMobileKeyDatabase -ErrorAction SilentlyContinue
  if ($bundledDb -and $dbSvc -and $dbSvc.Status -ne 'Running') { Start-Service StaffMobileKeyDatabase; $null = Wait-Port ([int]([Uri]($secrets['DATABASE_URL'] -replace '^postgres://', 'http://')).Port) 60 }
  $r = Invoke-Admin $pkgNode $pkgAdmin @('backup', '--dir', (Join-Path $DataDir 'backups'), '--reason', 'pre-upgrade') '' $secrets
  if ($r.code -ne 0) { Fail 'The copy of the database failed; nothing was changed. See the messages above.' }
  Write-Host "  $((($r.out | ConvertFrom-Json).file))"
}

# ---- Stop the running services (upgrade) ------------------------------------------------------------------------
foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform', 'StaffMobileKeyConnector') { Stop-Svc $svc }
if ($bundledDb) { Stop-Svc 'StaffMobileKeyDatabase' }

# ---- Runtime (Node.js and PostgreSQL, private to Access Monitoring Tool) ----------------------------------------------
Write-Step 'Runtime'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
foreach ($d in 'node', 'pgsql') {
  $target = Join-Path $RuntimeDir $d
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Copy-Item (Join-Path $here "runtime\$d") $target -Recurse
}
Copy-Item (Join-Path $here 'runtime\VERSIONS.txt') $RuntimeDir -Force -ErrorAction SilentlyContinue
$NodePath = Join-Path $RuntimeDir 'node\node.exe'
$PgBin = Join-Path $RuntimeDir 'pgsql\bin'
$nodeVer = (& $NodePath --version).Trim()
$pgVer = ((& (Join-Path $PgBin 'postgres.exe') -V) -replace '^.*[)] ', '').Trim()
Write-Host "  Node.js $nodeVer, PostgreSQL $pgVer"

# ---- Secrets ----------------------------------------------------------------------------------------------------
foreach ($k in 'JWT_SECRET', 'CALLBACK_SECRET') { if (-not $secrets[$k]) { $secrets[$k] = New-RandomText 48 } }
# Key that seals the passwords entered in the portal (Credential Services, SMTP, SMS). Never changes once made.
if (-not $secrets['SMK_SECRET_KEY']) { $secrets['SMK_SECRET_KEY'] = New-RandomText 32 }
# The connector on this server: a token made here, so nothing has to be copied from the portal.
$connCfgDir = Join-Path $env:ProgramData 'StaffMobileKey\Connector'
$connJson = Join-Path $connCfgDir 'connector.config.json'
$installConnector = (-not $SkipConnector) -and (Test-Path (Join-Path $here 'connector\install.ps1'))
# 2.16 A connector that was switched off here (it runs on another computer) stays off through upgrades.
$localConnSvc = Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue
if ($installConnector -and $localConnSvc -and $localConnSvc.StartType -eq 'Disabled') { $installConnector = $false; $SkipConnector = $true }
# A connector reporting to this server (any local port, including the old 4000) keeps its token; it is only re-pointed.
$pointsHere = (Test-Path $connJson) -and ((Get-Content $connJson -Raw | ConvertFrom-Json).platformUrl -match '^http://(127\.0\.0\.1|localhost):\d+/?$')
$newConnectorToken = $null
if ($installConnector -and (-not (Test-Path (Join-Path $connCfgDir 'secrets.enc')) -or -not $pointsHere)) {
  $newConnectorToken = "smkc_$(New-RandomText 32)"
  $secrets['SMK_LOCAL_CONNECTOR_TOKEN'] = $newConnectorToken
}

# ---- Database (bundled PostgreSQL) -------------------------------------------------------------------------------
$dbRoot = Join-Path $DataDir 'database'
$pgData = Join-Path $dbRoot 'data'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($bundledDb) {
  Write-Step 'Database'
  New-Item -ItemType Directory -Force -Path $dbRoot | Out-Null
  # PostgreSQL runs as NETWORK SERVICE and owns its data; this administrator needs explicit rights for initdb,
  # which drops administrator rights itself. LOCAL SERVICE (platform) and users have no access.
  & icacls $dbRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)F' "*$($me):(OI)(CI)F" | Out-Null
  $dbSecretsFile = Join-Path $DataDir 'database.secrets'
  $dbSecrets = Read-Protected $dbSecretsFile
  if (-not (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
    # initdb drops administrator rights before it runs and then checks every folder on the way to the data
    # folder. Let this administrator account and NETWORK SERVICE see the data folder itself (this folder only,
    # not its files), and create the (empty) database folder here, so initdb has nothing to create above it.
    & icacls $DataDir /grant "*$($me):(RX)" '*S-1-5-20:(RX)' | Out-Null
    if (Test-Path $pgData) { Remove-Item $pgData -Recurse -Force }   # left over from an attempt that failed
    New-Item -ItemType Directory -Force -Path $pgData | Out-Null
    $port = 5433
    while ((Test-Port $port) -and $port -lt 5450) { $port++ }
    $dbSecrets['PG_SUPERUSER_PASSWORD'] = New-RandomText 24
    $dbSecrets['PG_PORT'] = "$port"
    Write-Protected $dbSecretsFile $dbSecrets -AdminsOnly
    $pwFile = Join-Path $dbRoot 'initdb.pw'
    Write-Utf8NoBom $pwFile $dbSecrets['PG_SUPERUSER_PASSWORD']
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      & (Join-Path $PgBin 'initdb.exe') -D $pgData -U postgres "--pwfile=$pwFile" -A scram-sha-256 -E UTF8 --locale-provider=icu --icu-locale=und --locale=C 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match 'error|warning|Success' } | ForEach-Object { Write-Host "  $_" }
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prevEap; Remove-Item $pwFile -Force -ErrorAction SilentlyContinue }
    if ($code -ne 0 -or -not (Test-Path (Join-Path $pgData 'PG_VERSION'))) { Fail 'Creating the database failed (see above).' }
    Add-Content -Path (Join-Path $pgData 'postgresql.conf') -Encoding ASCII -Value @(
      '', '# Access Monitoring Tool', "listen_addresses = '127.0.0.1'", "port = $port", 'max_connections = 50', 'shared_buffers = 256MB',
      'logging_collector = on', "log_directory = 'log'", "log_filename = 'postgresql-%a.log'", 'log_truncate_on_rotation = on', 'log_rotation_age = 1d', 'log_rotation_size = 0',
      "log_line_prefix = '%m [%p] '", "timezone = 'UTC'"
    )
    Write-Host "  Database created in $pgData (port $port, this server only)."
  }
  $port = [int]$dbSecrets['PG_PORT']
  if (-not $port) {
    # Settings of the database kept, its small secrets file lost: read the port from its configuration.
    $m = Select-String -Path (Join-Path $pgData 'postgresql.conf') -Pattern '^\s*port\s*=\s*(\d+)' | Select-Object -Last 1
    $port = if ($m) { [int]$m.Matches[0].Groups[1].Value } else { 5433 }
  }
  if (-not (Get-Service StaffMobileKeyDatabase -ErrorAction SilentlyContinue)) {
    & (Join-Path $PgBin 'pg_ctl.exe') register -N StaffMobileKeyDatabase -U 'NT AUTHORITY\NetworkService' -D $pgData -S auto -w | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'Registering the database service failed.' }
    & sc.exe description StaffMobileKeyDatabase 'Access Monitoring Tool database (PostgreSQL 16, 127.0.0.1 only).' | Out-Null
  } else {
    # Same service, new program path (runtime folder may have moved).
    $bin = "`"$(Join-Path $PgBin 'pg_ctl.exe')`" runservice -N `"StaffMobileKeyDatabase`" -D `"$pgData`" -w"
    Get-CimInstance Win32_Service -Filter "Name='StaffMobileKeyDatabase'" | Invoke-CimMethod -MethodName Change -Arguments @{ PathName = $bin } | Out-Null
  }
  & sc.exe failure StaffMobileKeyDatabase reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
  Start-Service StaffMobileKeyDatabase
  if (-not (Wait-Port $port 90)) { Fail "The database did not start. See $(Join-Path $pgData 'log') and the Windows Event Viewer (Application)." }
  if (-not $secrets['DATABASE_URL']) {
    $appPw = New-RandomText 24
    $json = @{ superUrl = "postgres://postgres:$([Uri]::EscapeDataString($dbSecrets['PG_SUPERUSER_PASSWORD']))@127.0.0.1:$port/postgres"; appPassword = $appPw } | ConvertTo-Json -Compress
    $r = Invoke-Admin $pkgNode $pkgAdmin @('db-init') $json $secrets
    $json = $null
    if ($r.code -ne 0) { Fail 'Preparing the database failed (see above).' }
    $secrets['DATABASE_URL'] = "postgres://smk:$appPw@127.0.0.1:$port/smk"
    $secrets['SMK_DB'] = 'bundled'
    $appPw = $null
  }
  Write-Host '  StaffMobileKeyDatabase is running (NETWORK SERVICE, 127.0.0.1 only, starts with Windows).'
}

# ---- Program files ----------------------------------------------------------------------------------------------
Write-Step 'Program files'
if (Test-Path $InstallDir) {
  $prev = "$InstallDir.previous"
  if (Test-Path $prev) { Remove-Item $prev -Recurse -Force }
  Copy-Item $InstallDir $prev -Recurse   # rollback-onprem.ps1 puts this back
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($d in 'app', 'migrations', 'portal', 'brand', 'service') {
  $target = Join-Path $InstallDir $d
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Copy-Item (Join-Path $here $d) $target -Recurse
}
Copy-Item (Join-Path $here 'VERSION') $InstallDir -Force
foreach ($f in 'database-tools.ps1', 'set-platform-secrets.ps1', 'set-external-access.ps1', 'set-connector-access.ps1', 'rollback-onprem.ps1', 'uninstall-onprem.ps1', 'Uninstall.cmd', 'README.txt') { Copy-Item (Join-Path $here $f) $InstallDir -Force }
$exe = Join-Path $InstallDir 'StaffMobileKeyHost.exe'
& $csc /nologo /target:exe /optimize+ "/out:$exe" /reference:System.ServiceProcess.dll /reference:System.Security.dll (Join-Path $InstallDir 'service\NodeService.cs')
if ($LASTEXITCODE -ne 0) { Fail 'Building the service host failed (see the compiler messages above).' }
& icacls $InstallDir /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null
Write-Host "  Installed $version in $InstallDir"

# ---- Settings -----------------------------------------------------------------------------------------------------
Write-Step 'Settings'
# Database copies: made by the platform (LOCAL SERVICE), which can read the whole database anyway; nobody else.
& icacls (Join-Path $DataDir 'backups') /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
if ($bundledDb) { & icacls $dbRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-20:(OI)(CI)F' "*$($me):(OI)(CI)F" | Out-Null }

# First-run setup in the portal: a one-time code, shown below and kept for administrators only.
$codeFile = Join-Path $DataDir 'setup-code.txt'
$setupCode = $null
$hotelGiven = [bool]$hotel['HOTEL_NAME']
if (-not $hotelGiven) {
  $status = $null
  if ($upgrade) {
    $statusEnv = [ordered]@{}; foreach ($k in $secrets.Keys) { $statusEnv[$k] = $secrets[$k] }; $statusEnv['SMK_SETUP_MODE'] = '1'
    $r = Invoke-Admin $NodePath (Join-Path $InstallDir 'app\admin.mjs') @('status') '' $statusEnv
    if ($r.code -eq 0) { $status = $r.out | ConvertFrom-Json }
  }
  if (-not $status -or $status.setupNeeded) {
    if ((Test-Path $codeFile) -and $secrets['SMK_SETUP_CODE_SHA256']) { $setupCode = (Get-Content $codeFile -TotalCount 1).Trim() }
    else {
      $setupCode = New-SetupCode
      $secrets['SMK_SETUP_CODE_SHA256'] = Get-Sha256Hex ($setupCode -replace '-', '')
      Write-Utf8NoBom $codeFile "$setupCode`r`nOne-time code for the first-run setup page of Access Monitoring Tool. Not needed once the hotel is set up.`r`n"
      & icacls $codeFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    }
  } else { Remove-Item $codeFile -Force -ErrorAction SilentlyContinue }
}

$envLines = @(
  '# Non-secret settings of the platform service. Secrets are in platform.secrets (encrypted).',
  'HOST=127.0.0.1', "PORT=$PlatformPort", "PORTAL_DIST=$(Join-Path $InstallDir 'portal')", "SMK_MIGRATIONS_DIR=$(Join-Path $InstallDir 'migrations')",
  "SMK_BRAND_DIR=$(Join-Path $InstallDir 'brand')", 'PROVISION_ON_START=1', 'SMK_SETUP_MODE=1', 'SMK_LICENSING=on', 'CS_CALLBACKS=off',
  "PUBLIC_URL=https://$($ServerName):$LanPort", 'LOG_LEVEL=info', "CORS_ORIGINS=https://$($ServerName):$LanPort", "SMK_SERVER_NAME=$ServerName",
  "SMK_BACKUP_DIR=$(Join-Path $DataDir 'backups')", "SMK_BACKUP_LOG=$(Join-Path $DataDir 'logs\backup.log')", 'SMK_BACKUP_AT=02:30', 'SMK_BACKUP_KEEP=14',
  '# The hotel is entered in the portal (first-run setup); older installations kept it here.'
)
foreach ($k in $hotel.Keys) { $envLines += "$k=$($hotel[$k])" }
# 2.33 Edition package (for example La Falaise light): edition.json next to this script sets the edition, the hotel
# preset and the reports without sign-in on the hotel network. Only known names and values are accepted.
$editionFile = Join-Path $here 'edition.json'
if (Test-Path $editionFile) {
  $ed = Get-Content $editionFile -Raw | ConvertFrom-Json
  $allowed = @{ 'SMK_EDITION' = '^(full|light)$'; 'SMK_OPEN_ACCESS' = '^(off|lan)$'; 'SMK_OPEN_ACCESS_DIRECT' = '^(0|1)$'; 'SMK_TENANT' = '^[a-z0-9-]{1,40}$' }
  $envLines += '# Edition of this installation (from edition.json of the installer).'
  foreach ($p in $ed.env.PSObject.Properties) {
    if ($allowed.ContainsKey($p.Name) -and ([string]$p.Value) -match $allowed[$p.Name]) { $envLines += "$($p.Name)=$($p.Value)" }
    else { Write-Warning "edition.json: $($p.Name) ignored (unknown name or value)." }
  }
  Write-Host "Edition: $($ed.title)"
}
Write-Utf8NoBom (Join-Path $DataDir 'platform.env') ($envLines -join "`r`n")
Write-Protected $secretsFile $secrets

# Gateway: the secret path and cookie key are created once and kept.
$gwSecrets = Read-Protected (Join-Path $DataDir 'gateway.secrets')
if (-not $gwSecrets['GATEWAY_COOKIE_KEY']) { $gwSecrets['GATEWAY_COOKIE_KEY'] = New-RandomText 32 }
$secretPath = if ($oldGw -and $oldGw.secretPath) { $oldGw.secretPath } else { '/k-' + (New-RandomText 24) }

# Certificate (self-signed unless -CertPfx): for the server name, localhost and this server's IPv4 addresses.
$pfx = Join-Path $DataDir 'tls\gateway.pfx'
if ($CertPfx) {
  Copy-Item $CertPfx $pfx -Force
  $s = Read-Host -Prompt "  Password of $CertPfx" -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { $gwSecrets['GATEWAY_PFX_PASSPHRASE'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
} elseif (-not (Test-Path $pfx)) {
  $pass = New-RandomText 24
  $names = @("DNS=$ServerName", 'DNS=localhost')
  if ([Net.IPAddress]::TryParse($ServerName, [ref]$null)) { $names = @("IPAddress=$ServerName", 'DNS=localhost') }
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress })
  foreach ($ip in $ips) { if ("IPAddress=$ip" -notin $names) { $names += "IPAddress=$ip" } }
  $names += 'IPAddress=127.0.0.1'
  $san = "2.5.29.17={text}$($names -join '&')"
  $cert = New-SelfSignedCertificate -Subject "CN=$ServerName" -TextExtension @($san) -CertStoreLocation 'Cert:\LocalMachine\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3) -FriendlyName 'Access Monitoring Tool gateway'
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pass -AsPlainText -Force) | Out-Null
  $gwSecrets['GATEWAY_PFX_PASSPHRASE'] = $pass; $pass = $null
  Write-Host "  Self-signed certificate for $ServerName$(if ($ips) { " and $($ips -join ', ')" }) (3 years). Browsers warn until a real one is installed (-CertPfx)." -ForegroundColor Yellow
}
& icacls $pfx /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null
$certObj = New-Object Security.Cryptography.X509Certificates.X509Certificate2($pfx, $gwSecrets['GATEWAY_PFX_PASSPHRASE'])
$fingerprint = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($certObj.RawData))).Replace('-', ':')
Write-Protected (Join-Path $DataDir 'gateway.secrets') $gwSecrets

$listeners = @([ordered]@{ name = 'lan'; host = '0.0.0.0'; port = $LanPort; tls = [ordered]@{ pfx = $pfx; passphraseEnv = 'GATEWAY_PFX_PASSPHRASE' }; allow = @('private'); requireSecretPath = $false })
# 2.16 A connector on another computer keeps its access through upgrades.
$connFrom = @()
if ($ConnectorFrom) { $connFrom = @($ConnectorFrom.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
elseif ($oldGw) { $oldLan = @($oldGw.listeners | Where-Object { $_.name -eq 'lan' })[0]; if ($oldLan -and $oldLan.connectorFrom) { $connFrom = @($oldLan.connectorFrom) } }
if ($connFrom.Count) { $listeners[0]['connectorFrom'] = $connFrom }
$allowList = @()
if ($ExternalPort -gt 0) {
  $allowList = @($AllowExternal.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $listeners += [ordered]@{ name = 'external'; host = '0.0.0.0'; port = $ExternalPort; tls = [ordered]@{ pfx = $pfx; passphraseEnv = 'GATEWAY_PFX_PASSPHRASE' }; allow = $allowList; requireSecretPath = $true }
}
# 2.20 The Cloudflare Tunnel entrance (set-tunnel-access.ps1) is kept on upgrade.
$oldTun = if ($oldGw) { @($oldGw.listeners | Where-Object { $_.name -eq 'tunnel' })[0] } else { $null }
if ($oldTun) {
  $listeners += [ordered]@{ name = 'tunnel'; host = '127.0.0.1'; port = [int]$oldTun.port; allow = @('127.0.0.1', '::1'); requireSecretPath = [bool]$oldTun.requireSecretPath; clientIpHeader = 'cf-connecting-ip'; publicHttps = $true }
}
$gw = [ordered]@{ upstream = $platformUrl; secretPath = $secretPath; cookieKeyEnv = 'GATEWAY_COOKIE_KEY'; passHours = 12; banAfter = 20; banMinutes = 30
  logFile = (Join-Path $DataDir 'logs\gateway-access.log'); listeners = $listeners }
Write-Utf8NoBom $gwCfgFile ($gw | ConvertTo-Json -Depth 6)
Write-Utf8NoBom (Join-Path $DataDir 'gateway.env') "GATEWAY_CONFIG=$gwCfgFile"

# ---- Windows Firewall -------------------------------------------------------------------------------------------
Write-Step 'Windows Firewall'
Get-NetFirewallRule -Group 'Staff Mobile Key','Access Monitoring Tool' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Access Monitoring Tool - hotel network ($LanPort)" -Group 'Access Monitoring Tool' -Direction Inbound -Protocol TCP -LocalPort $LanPort -RemoteAddress LocalSubnet -Action Allow | Out-Null
if ($ExternalPort -gt 0) {
  New-NetFirewallRule -DisplayName "Access Monitoring Tool - external ($ExternalPort)" -Group 'Access Monitoring Tool' -Direction Inbound -Protocol TCP -LocalPort $ExternalPort -RemoteAddress $allowList -Action Allow | Out-Null
}
Write-Host "  Inbound TCP $LanPort from the local subnet$(if ($ExternalPort -gt 0) { "; TCP $ExternalPort from $($allowList -join ', ') only" }). The platform ($PlatformPort) and the database stay closed."

# ---- Services ---------------------------------------------------------------------------------------------------
Write-Step 'Windows services'
function Install-NodeService([string]$name, [string]$display, [string]$script, [string]$envFile, [string]$secretsFile, [string]$logName, [string[]]$dependsOn) {
  $bin = "`"$exe`" --name $name --node `"$NodePath`" --script `"$script`" --env `"$envFile`" --secrets `"$secretsFile`" --logs `"$(Join-Path $DataDir 'logs')`" --logname $logName"
  $existing = Get-CimInstance Win32_Service -Filter "Name='$name'"
  if (-not $existing) {
    New-Service -Name $name -BinaryPathName $bin -DisplayName $display -StartupType Automatic -Description 'Access Monitoring Tool (on-premises). Logs: C:\ProgramData\StaffMobileKey\Platform\logs.' -DependsOn $dependsOn | Out-Null
  } else {
    $r = $existing | Invoke-CimMethod -MethodName Change -Arguments @{ PathName = $bin }
    if ($r.ReturnValue -ne 0) { Fail "Updating the service $name failed (code $($r.ReturnValue))." }
    # Dependencies may change (older versions depended on a separately installed PostgreSQL).
    & sc.exe config $name depend= $(if ($dependsOn) { $dependsOn -join '/' } else { '/' }) | Out-Null
  }
  $svc = Get-CimInstance Win32_Service -Filter "Name='$name'"
  $svc | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' } | Out-Null
  & sc.exe config $name start= delayed-auto | Out-Null
  & sc.exe failure $name reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
}
$deps = @()
if ($bundledDb) { $deps += 'StaffMobileKeyDatabase' } else { $pgService = Get-Service | Where-Object { $_.Name -like 'postgresql*' } | Select-Object -First 1; if ($pgService) { $deps += $pgService.Name } }
Install-NodeService 'StaffMobileKeyPlatform' 'Access Monitoring Tool Platform' (Join-Path $InstallDir 'app\platform.mjs') (Join-Path $DataDir 'platform.env') $secretsFile 'platform' $deps
Install-NodeService 'StaffMobileKeyGateway' 'Access Monitoring Tool Gateway' (Join-Path $InstallDir 'app\gateway.mjs') (Join-Path $DataDir 'gateway.env') (Join-Path $DataDir 'gateway.secrets') 'gateway' @('StaffMobileKeyPlatform')
Start-Service StaffMobileKeyPlatform
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) { Start-Sleep -Seconds 2; try { $ok = (Invoke-RestMethod -Uri "$platformUrl/healthz" -TimeoutSec 3).ok } catch { } }
if (-not $ok) { Fail "The platform did not start. See $(Join-Path $DataDir 'logs\platform.log'). Go back with rollback-onprem.ps1 in $InstallDir" }
Start-Service StaffMobileKeyGateway
Write-Host '  Platform and gateway running (LOCAL SERVICE, start with Windows, restart on failure).'
# The daily copy is made by the platform itself now; the scheduled task of older versions is not needed.
Unregister-ScheduledTask -TaskName 'Access Monitoring Tool backup' -Confirm:$false -ErrorAction SilentlyContinue

# ---- Connector ---------------------------------------------------------------------------------------------------
$connectorNote = $null
if ($installConnector) {
  Write-Step 'Hotel connector'
  $cargs = @{ PlatformUrl = $platformUrl; NodePath = $NodePath }
  # Status page of the connector (127.0.0.1 only): 8090 unless another program has it.
  if (-not (Test-Path $connJson) -and (Test-Port 8090)) { $ap = 47390; while ((Test-Port $ap) -and $ap -lt 47399) { $ap++ }; $cargs.AdminPort = $ap }
  if ($VisionlineUrl) { $cargs.VisionlineUrl = $VisionlineUrl }
  if ($ReadOnly) { $cargs.ReadOnly = $true }
  if ($NoWatch) { $cargs.NoWatch = $true }
  if ($CaFile) { $cargs.CaFile = $CaFile }
  else {
    # Visionline on this server: read its certificate here (trust on first use, on this machine only) unless the
    # connector already has one. Verification stays on: only exactly this certificate is trusted afterwards.
    $hasCa = $false
    if (Test-Path $connJson) { try { $hasCa = [bool]((Get-Content $connJson -Raw | ConvertFrom-Json).visionline.caFile) } catch { } }
    if (-not $hasCa) {
      $vlUrl = if ($VisionlineUrl) { $VisionlineUrl } elseif (Test-Path $connJson) { (Get-Content $connJson -Raw | ConvertFrom-Json).visionline.baseUrl } else { 'https://localhost/api/v1' }
      $probe = Join-Path $here 'connector\app\probe.mjs'
      $tmpCert = Join-Path $DataDir 'visionline-certificate.crt'
      $reportDir = Join-Path $DataDir 'logs\visionline-probe'
      $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & $NodePath $probe --url $vlUrl --tls-only --save-cert $tmpCert --out $reportDir *> $null
      if (Test-Path $tmpCert) {
        & $NodePath $probe --url $vlUrl --tls-only --ca $tmpCert --out $reportDir *> $null
        $trusted = ($LASTEXITCODE -eq 0)
      } else { $trusted = $false }
      $ErrorActionPreference = $prevEap
      if ($trusted) {
        $cargs.CaFile = $tmpCert
        Write-Host "  Visionline certificate read from $vlUrl and trusted (only this exact certificate)."
      } else {
        $connectorNote = "Visionline at $vlUrl could not be reached or its certificate needs to be given by hand. The connector is installed; see 'Visionline certificate' in README.txt."
        Write-Host "  $connectorNote" -ForegroundColor Yellow
      }
    }
  }
  if ($newConnectorToken) {
    if (Test-Path (Join-Path $connCfgDir 'secrets.enc')) { $cargs.ResetSecrets = $true }
    $env:SMK_CONNECTOR_TOKEN = $newConnectorToken
    $env:SMK_CONNECTOR_ADMIN_PASSWORD = New-RandomText 18
  }
  try { & (Join-Path $here 'connector\install.ps1') @cargs }
  finally { Remove-Item Env:\SMK_CONNECTOR_TOKEN, Env:\SMK_CONNECTOR_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0) { $connectorNote = 'The connector installation reported a problem (see above). The platform runs; install the connector again with this package later.' }
} elseif ((Get-Service StaffMobileKeyConnector -ErrorAction SilentlyContinue) -and (Get-Service StaffMobileKeyConnector).StartType -ne 'Disabled') {
  try { Start-Service StaffMobileKeyConnector } catch { $connectorNote = 'The connector did not start again; see C:\ProgramData\StaffMobileKey\Connector\logs.' }
}

# ---- Shortcut ------------------------------------------------------------------------------------------------------
# The local address of the portal, for Open-StaffMobileKey.cmd (Start menu, end of the .msi installation).
try { Write-Utf8NoBom (Join-Path $DataDir 'portal-url.txt') "$platformUrl`r`n" } catch { }
$portal = "https://$($ServerName):$LanPort/"
try {
  $lnk = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Access Monitoring Tool.url'
  Write-Utf8NoBom $lnk "[InternetShortcut]`r`nURL=$portal`r`n"
} catch { }

# ---- Done ----------------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Access Monitoring Tool $version is installed and running." -ForegroundColor Green
Write-Host "  Portal (hotel network): $portal"
if ($ExternalPort -gt 0) {
  Write-Host "  From outside:  https://<hotel public IP>:<forwarded port>$secretPath/   only from $($allowList -join ', ')" -ForegroundColor Yellow
  Write-Host "                 Keep this address in the hotel's password manager; anyone without it gets 'Not found'."
} else { Write-Host "  From outside:  closed. Open it later with set-external-access.ps1" }
Write-Host "  Certificate SHA-256: $fingerprint"
$cPort = try { (Get-Content $connJson -Raw | ConvertFrom-Json).localAdmin.port } catch { $null }
$dbPortShown = if ($bundledDb) { try { ([Uri]($secrets['DATABASE_URL'] -replace '^postgres://', 'http://')).Port } catch { '?' } } else { 'external' }
Write-Host "  Ports: $LanPort hotel network$(if ($ExternalPort -gt 0) { ", $ExternalPort external" }); on 127.0.0.1 only: platform $PlatformPort, database $dbPortShown$(if ($cPort) { ", connector status page $cPort" })"
Write-Host "  Logs: $(Join-Path $DataDir 'logs')    Database copies: $(Join-Path $DataDir 'backups') (daily 02:30)"
if ($connectorNote) { Write-Host "  Connector: $connectorNote" -ForegroundColor Yellow }
# The installation log ends here: the setup code below is not written to it.
try { Stop-Transcript | Out-Null } catch { }
if ($setupCode) {
  Write-Host ""
  Write-Host "  NEXT: enter the hotel's details in the portal (first-run setup)." -ForegroundColor Cyan
  Write-Host "        Setup code:  $setupCode" -ForegroundColor Cyan
  Write-Host "        On this server: $platformUrl/   (or from a PC on the hotel network: $portal)"
  Write-Host "        The code is also in $codeFile (administrators only)."
  if (-not $NoBrowser) { try { Start-Process "$platformUrl/#code=$setupCode" } catch { } }
} elseif (-not $NoBrowser -and -not $upgrade) { try { Start-Process "$platformUrl/" } catch { } }

exit 0
