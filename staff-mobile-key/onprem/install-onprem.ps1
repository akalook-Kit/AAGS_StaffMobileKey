<#
  Staff Mobile Key - ON-PREMISES installation on the Visionline (Vingcard) server.
  Run in PowerShell opened with "Run as administrator", in the folder of this package. Re-run it to UPGRADE:
  settings, secrets, the secret path and the certificate are kept, and the database is backed up first.

  What it installs (nothing listens on the internet except the gateway's external port, and only for the
  addresses you allow):
    PostgreSQL (already installed by you)  -> database "smk", reachable on 127.0.0.1 only
    StaffMobileKeyPlatform  (service)      -> the platform and portal, on http://127.0.0.1:4000 only
    StaffMobileKeyGateway   (service)      -> HTTPS entrances: hotel network (LAN) and, optionally, external
    StaffMobileKeyConnector (service)      -> the hotel connector, talking to Visionline and to 127.0.0.1:4000
    Daily database backup  (scheduled task)

    .\install-onprem.ps1 -ServerName vingcard01.khotel.local -LanPort 8443 `
        -ExternalPort 9443 -AllowExternal "41.202.219.10/32,102.244.1.0/28" `
        -VisionlineUrl https://localhost/api/v1 -CaFile C:\khb\visionline-ca.crt

  -ServerName      Name (or IP) staff use for this server on the hotel network; used for the certificate.
  -LanPort         HTTPS port for the hotel network. Default 8443.
  -ExternalPort    HTTPS port that the hotel firewall forwards from the public IP. Omit to have no external entrance.
  -AllowExternal   Comma-separated public addresses/ranges allowed through the external entrance (the hotel's
                   own offices, the head office, a VPN exit). Required with -ExternalPort.
  -CertPfx         A real certificate (PFX) for -ServerName. Without it a self-signed certificate is made.
  -PostgresBin     PostgreSQL bin folder, if not found automatically.
  -NodePath        node.exe, if not the one on PATH (must be installed for all users).
  -SkipConnector   Do not install/upgrade the hotel connector from .\connector.
  -VisionlineUrl / -CaFile / -ReadOnly / -NoWatch   Passed to the connector installer.
#>
param(
  [string]$ServerName = $env:COMPUTERNAME,
  [int]$LanPort = 8443,
  [int]$ExternalPort = 0,
  [string]$AllowExternal = '',
  [string]$CertPfx = '',
  [string]$PostgresBin = '',
  [int]$PgPort = 5432,
  [string]$NodePath = '',
  [switch]$SkipConnector,
  [string]$VisionlineUrl = '',
  [string]$CaFile = '',
  [switch]$ReadOnly,
  [switch]$NoWatch,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'StaffMobileKey\Platform'),
  [string]$DataDir = (Join-Path $env:ProgramData 'StaffMobileKey\Platform')
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
function Write-Step([string]$t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Fail([string]$t) { Write-Host ""; Write-Host $t -ForegroundColor Red; exit 1 }
function Read-Secret([string]$prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function New-RandomText([int]$bytes = 32) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
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
function Write-Protected([string]$path, $map) {
  $text = ($map.Keys | ForEach-Object { "$_=$($map[$_])" }) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  [IO.File]::WriteAllBytes($path, [Security.Cryptography.ProtectedData]::Protect($bytes, $Entropy, 'LocalMachine'))
  [Array]::Clear($bytes, 0, $bytes.Length)
  # SYSTEM and Administrators full control, the service account (LOCAL SERVICE) read; nobody else.
  & icacls $path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null
}
function Write-Utf8NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

# ---- Checks ---------------------------------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator" and run this again.' }
$version = (Get-Content (Join-Path $here 'VERSION') -TotalCount 1).Trim()
Write-Host "Staff Mobile Key on-premises $version" -ForegroundColor Green
if ($ExternalPort -gt 0 -and -not $AllowExternal) { Fail 'With -ExternalPort, give the public addresses allowed in with -AllowExternal (for example "41.202.219.10/32").' }
if ($ExternalPort -gt 0 -and $ExternalPort -eq $LanPort) { Fail '-ExternalPort must differ from -LanPort.' }

if (-not $NodePath) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $NodePath = $cmd.Source } }
if (-not $NodePath -or -not (Test-Path $NodePath)) { Fail 'Node.js 22 LTS was not found. Install it for all users (https://nodejs.org or: winget install OpenJS.NodeJS.LTS), open a new PowerShell, run again.' }
if ($NodePath -like "$env:USERPROFILE*" -or $NodePath -like '*\nvm\*') { Fail "Node.js at $NodePath is in a user profile; a service cannot use it. Install Node.js 22 for all users, or pass -NodePath." }
$nodeVer = (& $NodePath --version).TrimStart('v')
if ([int]($nodeVer.Split('.')[0]) -lt 22) { Fail "Node.js $nodeVer is too old; install 22 LTS." }

if (-not $PostgresBin) {
  $pgRoot = Join-Path $env:ProgramFiles 'PostgreSQL'
  if (Test-Path $pgRoot) { $PostgresBin = Get-ChildItem $pgRoot -Directory | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | ForEach-Object { Join-Path $_.FullName 'bin' } | Where-Object { Test-Path (Join-Path $_ 'psql.exe') } | Select-Object -First 1 }
}
if (-not $PostgresBin -or -not (Test-Path (Join-Path $PostgresBin 'psql.exe'))) {
  Fail "PostgreSQL was not found. Install PostgreSQL 16 for Windows (https://www.postgresql.org/download/windows/), keep the port 5432, note the 'postgres' password, then run again (or pass -PostgresBin 'C:\Program Files\PostgreSQL\16\bin')."
}
$psql = Join-Path $PostgresBin 'psql.exe'; $pgDump = Join-Path $PostgresBin 'pg_dump.exe'
$pgService = Get-Service | Where-Object { $_.Name -like 'postgresql*' } | Select-Object -First 1
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { Fail "The .NET Framework 4 C# compiler was not found. Enable '.NET Framework 4.8' in Windows Features." }

$upgrade = Test-Path (Join-Path $DataDir 'platform.secrets')
Write-Host "  $(if ($upgrade) { 'Upgrading the existing installation' } else { 'New installation' })"
Write-Host "  Program: $InstallDir"
Write-Host "  Data:    $DataDir"
Write-Host "  Node.js: $NodePath ($nodeVer); PostgreSQL: $PostgresBin"
New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir 'logs'), (Join-Path $DataDir 'backups'), (Join-Path $DataDir 'tls') | Out-Null
& icacls $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
& icacls (Join-Path $DataDir 'logs') /grant '*S-1-5-19:(OI)(CI)M' | Out-Null
# Backups hold the whole database: SYSTEM and Administrators only.
& icacls (Join-Path $DataDir 'backups') /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

# ---- Database -------------------------------------------------------------------------------------------------
$secrets = Read-Protected (Join-Path $DataDir 'platform.secrets')
if (-not $upgrade) {
  Write-Step 'Database'
  $su = Read-Secret "  Password of the PostgreSQL superuser 'postgres' (used once, not stored)"
  $dbPw = New-RandomText 24
  $env:PGPASSWORD = $su
  try {
    $exists = & $psql -h 127.0.0.1 -p $PgPort -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='smk'"
    if ($LASTEXITCODE -ne 0) { Fail 'Could not sign in to PostgreSQL as postgres. Check the password and that the service is running.' }
    if ($exists -eq '1') { & $psql -h 127.0.0.1 -p $PgPort -U postgres -qc "ALTER ROLE smk WITH LOGIN PASSWORD '$dbPw'" | Out-Null }
    else { & $psql -h 127.0.0.1 -p $PgPort -U postgres -qc "CREATE ROLE smk WITH LOGIN PASSWORD '$dbPw'" | Out-Null }
    $db = & $psql -h 127.0.0.1 -p $PgPort -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='smk'"
    if ($db -ne '1') { & $psql -h 127.0.0.1 -p $PgPort -U postgres -qc "CREATE DATABASE smk OWNER smk ENCODING 'UTF8'" | Out-Null }
    $listen = & $psql -h 127.0.0.1 -p $PgPort -U postgres -tAc "SHOW listen_addresses"
    if ($listen -and $listen.Trim() -notin @('localhost', '127.0.0.1', '127.0.0.1,::1', 'localhost,127.0.0.1')) {
      Write-Host "  Note: PostgreSQL listens on '$listen'. For this server, set listen_addresses = 'localhost' in postgresql.conf and restart PostgreSQL." -ForegroundColor Yellow
    }
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue; $su = $null }
  $secrets['DATABASE_URL'] = "postgres://smk:$dbPw@127.0.0.1:$PgPort/smk"
  $secrets['JWT_SECRET'] = New-RandomText 48
  $secrets['CALLBACK_SECRET'] = New-RandomText 48
  $dbPw = $null
  Write-Host '  Database "smk" and role "smk" ready (password generated and stored encrypted).'
  Write-Step 'Credential Services (ASSA ABLOY) - press Enter to set later with .\set-platform-secrets.ps1'
  $csUser = Read-Host '  Credential Services user (e.g. k_-_hotel_bana-...)'
  if ($csUser) { $secrets['SECRET_CS_TENANT_USER'] = $csUser; $secrets['SECRET_CS_TENANT_PASSWORD'] = Read-Secret '  Credential Services password (not shown)' }
} else {
  Write-Step 'Backup before upgrading'
  $dump = Join-Path $DataDir "backups\pre-upgrade-$version-$(Get-Date -Format yyyyMMdd-HHmm).dump"
  $u = [Uri]($secrets['DATABASE_URL'] -replace '^postgres://', 'http://')
  $env:PGPASSWORD = [Uri]::UnescapeDataString($u.UserInfo.Split(':')[1])
  try { & $pgDump -h 127.0.0.1 -p $u.Port -U smk -Fc -f $dump smk; if ($LASTEXITCODE -ne 0) { Fail 'The database backup failed; nothing was changed.' } }
  finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
  Write-Host "  $dump"
}

# ---- Program files ----------------------------------------------------------------------------------------------
Write-Step 'Program files'
foreach ($svc in 'StaffMobileKeyGateway', 'StaffMobileKeyPlatform') {
  $s = Get-Service $svc -ErrorAction SilentlyContinue
  if ($s -and $s.Status -ne 'Stopped') { Stop-Service $svc -Force; $s.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(40)) }
}
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
foreach ($f in 'backup-onprem.ps1', 'set-platform-secrets.ps1', 'rollback-onprem.ps1', 'uninstall-onprem.ps1') { Copy-Item (Join-Path $here $f) $InstallDir -Force }
$exe = Join-Path $InstallDir 'StaffMobileKeyHost.exe'
& $csc /nologo /target:exe /optimize+ "/out:$exe" /reference:System.ServiceProcess.dll /reference:System.Security.dll (Join-Path $InstallDir 'service\NodeService.cs')
if ($LASTEXITCODE -ne 0) { Fail 'Building the service host failed (see the compiler messages above).' }
& icacls $InstallDir /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null
Write-Host "  Installed $version in $InstallDir"

# ---- Settings ----------------------------------------------------------------------------------------------------
Write-Step 'Settings'
$envLines = @(
  '# Non-secret settings of the platform service. Secrets are in platform.secrets (encrypted).',
  'HOST=127.0.0.1', 'PORT=4000', "PORTAL_DIST=$(Join-Path $InstallDir 'portal')", "SMK_MIGRATIONS_DIR=$(Join-Path $InstallDir 'migrations')",
  "SMK_BRAND_DIR=$(Join-Path $InstallDir 'brand')", 'PROVISION_ON_START=1', 'CS_CALLBACKS=off', 'HOTEL_TIMEZONE=Africa/Douala',
  "PUBLIC_URL=https://$($ServerName):$LanPort", 'LOG_LEVEL=info', "CORS_ORIGINS=https://$($ServerName):$LanPort"
)
Write-Utf8NoBom (Join-Path $DataDir 'platform.env') ($envLines -join "`r`n")
Write-Protected (Join-Path $DataDir 'platform.secrets') $secrets

# Gateway: the secret path and cookie key are created once and kept.
$gwSecrets = Read-Protected (Join-Path $DataDir 'gateway.secrets')
if (-not $gwSecrets['GATEWAY_COOKIE_KEY']) { $gwSecrets['GATEWAY_COOKIE_KEY'] = New-RandomText 32 }
$gwCfgFile = Join-Path $DataDir 'gateway.config.json'
$oldGw = if (Test-Path $gwCfgFile) { Get-Content $gwCfgFile -Raw | ConvertFrom-Json } else { $null }
$secretPath = if ($oldGw -and $oldGw.secretPath) { $oldGw.secretPath } else { '/k-' + (New-RandomText 24) }

# Certificate
$pfx = Join-Path $DataDir 'tls\gateway.pfx'
if ($CertPfx) {
  Copy-Item $CertPfx $pfx -Force
  $gwSecrets['GATEWAY_PFX_PASSPHRASE'] = Read-Secret "  Password of $CertPfx"
} elseif (-not (Test-Path $pfx)) {
  $pass = New-RandomText 24
  $isIp = [Net.IPAddress]::TryParse($ServerName, [ref]$null)
  $san = if ($isIp) { "2.5.29.17={text}IPAddress=$ServerName" } else { "2.5.29.17={text}DNS=$ServerName&DNS=localhost" }
  $cert = New-SelfSignedCertificate -Subject "CN=$ServerName" -TextExtension @($san) -CertStoreLocation 'Cert:\LocalMachine\My' -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3) -FriendlyName 'Staff Mobile Key gateway'
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pass -AsPlainText -Force) | Out-Null
  $gwSecrets['GATEWAY_PFX_PASSPHRASE'] = $pass; $pass = $null
  Write-Host "  Self-signed certificate made for $ServerName (3 years). Browsers will warn until you install a real one (-CertPfx)." -ForegroundColor Yellow
}
& icacls $pfx /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-19:R' | Out-Null
$certObj = New-Object Security.Cryptography.X509Certificates.X509Certificate2($pfx, $gwSecrets['GATEWAY_PFX_PASSPHRASE'])
$fingerprint = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($certObj.RawData))).Replace('-', ':')
Write-Protected (Join-Path $DataDir 'gateway.secrets') $gwSecrets

$listeners = @([ordered]@{ name = 'lan'; host = '0.0.0.0'; port = $LanPort; tls = [ordered]@{ pfx = $pfx; passphraseEnv = 'GATEWAY_PFX_PASSPHRASE' }; allow = @('private'); requireSecretPath = $false })
$allowList = @()
if ($ExternalPort -gt 0) {
  $allowList = @($AllowExternal.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $listeners += [ordered]@{ name = 'external'; host = '0.0.0.0'; port = $ExternalPort; tls = [ordered]@{ pfx = $pfx; passphraseEnv = 'GATEWAY_PFX_PASSPHRASE' }; allow = $allowList; requireSecretPath = $true }
}
$gw = [ordered]@{ upstream = 'http://127.0.0.1:4000'; secretPath = $secretPath; cookieKeyEnv = 'GATEWAY_COOKIE_KEY'; passHours = 12; banAfter = 20; banMinutes = 30
  logFile = (Join-Path $DataDir 'logs\gateway-access.log'); listeners = $listeners }
Write-Utf8NoBom $gwCfgFile ($gw | ConvertTo-Json -Depth 6)
Write-Utf8NoBom (Join-Path $DataDir 'gateway.env') "GATEWAY_CONFIG=$gwCfgFile"

# ---- Windows Firewall -------------------------------------------------------------------------------------------
Write-Step 'Windows Firewall'
Get-NetFirewallRule -Group 'Staff Mobile Key' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Staff Mobile Key - hotel network ($LanPort)" -Group 'Staff Mobile Key' -Direction Inbound -Protocol TCP -LocalPort $LanPort -RemoteAddress LocalSubnet -Action Allow | Out-Null
if ($ExternalPort -gt 0) {
  New-NetFirewallRule -DisplayName "Staff Mobile Key - external ($ExternalPort)" -Group 'Staff Mobile Key' -Direction Inbound -Protocol TCP -LocalPort $ExternalPort -RemoteAddress $allowList -Action Allow | Out-Null
}
Write-Host "  Inbound TCP $LanPort from the local subnet$(if ($ExternalPort -gt 0) { "; TCP $ExternalPort from $($allowList -join ', ') only" }). Port 4000 (platform) and the database stay closed."

# ---- First administrator ------------------------------------------------------------------------------------
function Invoke-Admin([string[]]$adminArgs, [string]$stdin) {
  foreach ($k in $secrets.Keys) { Set-Item "Env:\$k" $secrets[$k] }
  $env:SMK_MIGRATIONS_DIR = Join-Path $InstallDir 'migrations'; $env:SMK_BRAND_DIR = Join-Path $InstallDir 'brand'; $env:NODE_ENV = 'production'; $env:CS_CALLBACKS = 'off'
  $prevEnc = $OutputEncoding; $OutputEncoding = New-Object Text.UTF8Encoding $false
  try { if ($stdin) { $out = $stdin | & $NodePath (Join-Path $InstallDir 'app\admin.mjs') @adminArgs } else { $out = '' | & $NodePath (Join-Path $InstallDir 'app\admin.mjs') @adminArgs } ; $code = $LASTEXITCODE }
  finally { $OutputEncoding = $prevEnc; foreach ($k in $secrets.Keys) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }; Remove-Item Env:\SMK_MIGRATIONS_DIR, Env:\SMK_BRAND_DIR, Env:\NODE_ENV, Env:\CS_CALLBACKS -ErrorAction SilentlyContinue }
  return @{ out = $out; code = $code }
}
if (-not $upgrade) {
  Write-Step 'First administrator'
  $email = Read-Host '  E-mail of the first administrator'
  do {
    $pw = Read-Secret '  Password (at least 12 characters)'
    $again = Read-Secret '  Same password again'
    if ($pw -ne $again -or $pw.Length -lt 12) { Write-Host '  The passwords differ or are shorter than 12 characters.' -ForegroundColor Yellow }
  } while ($pw -ne $again -or $pw.Length -lt 12)
  $r = Invoke-Admin @('create-admin') (@{ email = $email; password = $pw } | ConvertTo-Json -Compress)
  $pw = $null; $again = $null
  if ($r.code -ne 0) { Fail 'Creating the administrator failed (see above).' }
}

# ---- Services --------------------------------------------------------------------------------------------------
Write-Step 'Windows services'
function Install-NodeService([string]$name, [string]$display, [string]$script, [string]$envFile, [string]$secretsFile, [string]$logName, [string[]]$dependsOn) {
  $bin = "`"$exe`" --name $name --node `"$NodePath`" --script `"$script`" --env `"$envFile`" --secrets `"$secretsFile`" --logs `"$(Join-Path $DataDir 'logs')`" --logname $logName"
  $existing = Get-CimInstance Win32_Service -Filter "Name='$name'"
  if (-not $existing) {
    New-Service -Name $name -BinaryPathName $bin -DisplayName $display -StartupType Automatic -Description 'Staff Mobile Key (on-premises). See C:\ProgramData\StaffMobileKey\Platform\logs.' -DependsOn $dependsOn | Out-Null
  } else { $existing | Invoke-CimMethod -MethodName Change -Arguments @{ PathName = $bin } | Out-Null }
  $svc = Get-CimInstance Win32_Service -Filter "Name='$name'"
  $svc | Invoke-CimMethod -MethodName Change -Arguments @{ StartName = 'NT AUTHORITY\LocalService'; StartPassword = '' } | Out-Null
  & sc.exe config $name start= delayed-auto | Out-Null
  & sc.exe failure $name reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
}
$deps = @(); if ($pgService) { $deps += $pgService.Name }
Install-NodeService 'StaffMobileKeyPlatform' 'Staff Mobile Key Platform' (Join-Path $InstallDir 'app\platform.mjs') (Join-Path $DataDir 'platform.env') (Join-Path $DataDir 'platform.secrets') 'platform' $deps
Install-NodeService 'StaffMobileKeyGateway' 'Staff Mobile Key Gateway' (Join-Path $InstallDir 'app\gateway.mjs') (Join-Path $DataDir 'gateway.env') (Join-Path $DataDir 'gateway.secrets') 'gateway' @('StaffMobileKeyPlatform')
Start-Service StaffMobileKeyPlatform
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) { Start-Sleep -Seconds 2; try { $ok = (Invoke-RestMethod -Uri 'http://127.0.0.1:4000/healthz' -TimeoutSec 3).ok } catch { } }
if (-not $ok) { Fail "The platform did not start. See $(Join-Path $DataDir 'logs\platform.log'). Roll back with .\rollback-onprem.ps1" }
Start-Service StaffMobileKeyGateway
Write-Host '  Platform and gateway running (LOCAL SERVICE, start with Windows, restart on failure).'

# ---- Daily backup ------------------------------------------------------------------------------------------------
Write-Step 'Daily database backup'
$task = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'backup-onprem.ps1')`" -PostgresBin `"$PostgresBin`""
Register-ScheduledTask -TaskName 'Staff Mobile Key backup' -Action $task -Trigger (New-ScheduledTaskTrigger -Daily -At 2:30am) -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Write-Host "  Every day at 02:30 to $(Join-Path $DataDir 'backups') (14 kept). Copy that folder off the server regularly."

# ---- Connector -------------------------------------------------------------------------------------------------
if (-not $SkipConnector -and (Test-Path (Join-Path $here 'connector\install.ps1'))) {
  Write-Step 'Hotel connector'
  $connCfg = Join-Path $env:ProgramData 'StaffMobileKey\Connector\secrets.enc'
  $cargs = @{ PlatformUrl = 'http://127.0.0.1:4000' }
  if ($VisionlineUrl) { $cargs.VisionlineUrl = $VisionlineUrl }
  if ($CaFile) { $cargs.CaFile = $CaFile }
  if ($ReadOnly) { $cargs.ReadOnly = $true }
  if ($NoWatch) { $cargs.NoWatch = $true }
  $connJson = Join-Path $env:ProgramData 'StaffMobileKey\Connector\connector.config.json'
  $pointsHere = (Test-Path $connJson) -and ((Get-Content $connJson -Raw | ConvertFrom-Json).platformUrl -eq 'http://127.0.0.1:4000')
  if (-not (Test-Path $connCfg) -or -not $pointsHere) {
    # New connector, or one that reported to another platform before (Render, a test PC): give it a token for this one.
    if (Test-Path $connCfg) { $cargs.ResetSecrets = $true }
    $r = Invoke-Admin @('register-connector', 'Visionline server (on-premises)') ''
    if ($r.code -ne 0) { Fail 'Registering the connector failed (see above).' }
    $env:SMK_CONNECTOR_TOKEN = ($r.out | ConvertFrom-Json).token
  }
  try { & (Join-Path $here 'connector\install.ps1') @cargs } finally { Remove-Item Env:\SMK_CONNECTOR_TOKEN -ErrorAction SilentlyContinue }
}

# ---- Done ------------------------------------------------------------------------------------------------------
Write-Host ""
Write-Host "Staff Mobile Key $version is running on this server." -ForegroundColor Green
Write-Host "  Hotel network:   https://$($ServerName):$LanPort/"
if ($ExternalPort -gt 0) {
  Write-Host "  From outside:    https://<hotel public IP>:<forwarded port>$secretPath/" -ForegroundColor Yellow
  Write-Host "                   Only from: $($allowList -join ', '). Keep this address in the hotel's password manager;"
  Write-Host "                   anyone without it gets 'Not found'. Forward the public port to this server's port $ExternalPort."
}
Write-Host "  Certificate SHA-256: $fingerprint"
Write-Host "  Logs:     $(Join-Path $DataDir 'logs')"
Write-Host "  Backups:  $(Join-Path $DataDir 'backups')"
Write-Host "  Credential Services: polling mode (nothing comes in from the internet). Set the account later with .\set-platform-secrets.ps1"
